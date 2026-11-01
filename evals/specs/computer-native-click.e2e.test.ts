import { execFile, spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, onTestFinished } from 'vitest';
import { needs, test, eventually } from '@sofia/testkit';
const execute=promisify(execFile);
type Reply={id:number;result:{isError?:boolean;content:Array<{type:string;text?:string}>}};

test('native click delivers a click to a focusable control instead of reporting focus as success', {timeout:90_000},async({evidence})=>{
  needs({optIn:['SOFIA_EVAL_E2E_TESTS','SOFIA_NATIVE_COMPUTER_PROOF'],placement:'local'});
  if(process.platform!=='darwin')throw new Error('needs: macOS Accessibility');
  const helper=resolve(import.meta.dirname,'../../apps/desktop/resources/helpers/Sofia Computer Use.app');
  const root=await mkdtemp(join(tmpdir(),'sofia-native-click-'));
  let fixtureOutput='';
  onTestFinished(async()=>{
    await mkdir(evidence.dir,{recursive:true});
    for(const [source,name] of [['mcp.stdout','native-mcp.stdout.log'],['mcp.stderr','native-mcp.stderr.log']]){
      const contents=await readFile(join(root,source),'utf8').catch(error=>String(error));
      await writeFile(join(evidence.dir,name),contents);
    }
    await writeFile(join(evidence.dir,'fixture-output.log'),fixtureOutput);
    await rm(root,{recursive:true,force:true});
  });
  // LaunchServices attributes privacy checks to the granted helper bundle. Raw
  // exec inherits the invoking terminal's TCC responsibility and tests another identity.
  const permissionFile=join(root,'permissions.json');
  await writeFile(permissionFile,'');
  await execute('/usr/bin/open',['-W','-n','-g','--stdout',permissionFile,helper,'--args','--check'],{timeout:15_000});
  const permission=JSON.parse(await readFile(permissionFile,'utf8'));
  const helperSHA256=createHash('sha256').update(await readFile(join(helper,'Contents/MacOS/ComputerUse'))).digest('hex');
  await mkdir(evidence.dir,{recursive:true});
  await writeFile(join(evidence.dir,'helper-permissions.json'),JSON.stringify({helper,helperSHA256,launch:'LaunchServices',...permission},null,2));
  if(!permission.ok)throw new Error(`needs: grant Accessibility and Screen Recording to ruut.sofia.computer-use at ${helper}; LaunchServices accessibility=${permission.accessibility}, screenRecording=${permission.screenRecording}`);
  const entry=join(root,'fixture.cjs'),ready=join(root,'ready.json');
  await writeFile(join(root,'package.json'),JSON.stringify({name:'sofia-native-click-fixture',main:'fixture.cjs'}));
  await writeFile(entry,`const {app,BrowserWindow}=require('electron');const {writeFile}=require('node:fs/promises');(async()=>{app.setName('Sofia Native Proof');app.setPath('userData',${JSON.stringify(join(root,'profile'))});await app.whenReady();app.setAccessibilitySupportEnabled(true);const view=new BrowserWindow({width:520,height:300,show:false});await view.loadURL('data:text/html,'+encodeURIComponent('<title>Sofia Native Proof</title><div role="group" tabindex="0" id="click-target" aria-label="Click target" style="width:160px;height:60px;background:lightblue">Click target</div><p id="count">Clicks: 0</p><script>document.addEventListener("click",event=>{if(event.target.id==="click-target")document.getElementById("count").textContent="Clicks: 1";});</script>'));view.showInactive();await writeFile(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));})().catch(error=>{console.error(error);app.exit(1);});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const fixture=spawn(resolve(import.meta.dirname,'../../apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),[root],{env,stdio:['ignore','pipe','pipe']});
  fixture.stdout.on('data',chunk=>{fixtureOutput+=chunk;});fixture.stderr.on('data',chunk=>{fixtureOutput+=chunk;});
  onTestFinished(()=>fixture.kill());
  const identity=await eventually(async()=>{
    if(fixture.exitCode!==null)throw new Error(`Fixture exited ${fixture.exitCode}: ${fixtureOutput}`);
    try{return JSON.parse(await readFile(ready,'utf8'));}catch(error){throw new Error(`Fixture not ready: ${String(error)}; stdout/stderr: ${fixtureOutput}`);}
  },{within:15_000});
  const stdinFile=join(root,'mcp.stdin'),stdoutFile=join(root,'mcp.stdout'),stderrFile=join(root,'mcp.stderr');
  await execute('/usr/bin/mkfifo',[stdinFile]);
  // O_RDWR keeps both FIFO ends open while LaunchServices opens the child's stdin.
  const input=await open(stdinFile,constants.O_RDWR);
  await writeFile(stdoutFile,'');await writeFile(stderrFile,'');
  const helperCommand=join(helper,'Contents/MacOS/ComputerUse')+' mcp';
  const helperPIDs=async()=>{
    const output=(await execute('/bin/ps',['-axo','pid=,command='])).stdout;
    return output.split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(.+)$/.exec(line);return match&&match[2]===helperCommand?[Number(match[1])]:[];});
  };
  const existingPIDs=new Set(await helperPIDs());
  const transport=spawn('/usr/bin/open',['-W','-n','-g','--env','SOFIA_COMPUTER_USE_CURSOR_OVERLAY=0','--stdin',stdinFile,'--stdout',stdoutFile,'--stderr',stderrFile,helper,'--args','mcp'],{stdio:'ignore'});
  const stopped=new Promise<void>((resolveStop,rejectStop)=>{transport.once('error',rejectStop);transport.once('exit',()=>resolveStop());});
  let helperPID:number|undefined;
  onTestFinished(async()=>{
    await input.close(); // EOF ends this MCP instance without stopping another helper.
    await Promise.race([stopped,new Promise<void>(resolveStop=>setTimeout(resolveStop,3000))]);
    if(transport.exitCode===null)transport.kill();
    if(helperPID!==undefined){
      const ownPID=helperPID;
      await eventually(()=>{
        try{process.kill(ownPID,0);}catch(error){if(error instanceof Error&&'code' in error&&error.code==='ESRCH')return true;throw error;}
        throw new Error(`LaunchServices MCP helper ${ownPID} did not exit after FIFO EOF`);
      },{within:3000});
      await writeFile(join(evidence.dir,'helper-lifecycle.json'),JSON.stringify({helper,helperPID:ownPID,boundVia:'new exact helper MCP process launched through LaunchServices',exitedAfterStdinEOF:true},null,2));
    }
  });

  let id=0;
  const calls:Array<{name:string;arguments:unknown;result:unknown}>=[];
  onTestFinished(async()=>{await writeFile(join(evidence.dir,'native-click-fixture-calls.json'),JSON.stringify(calls,null,2));await writeFile(join(evidence.dir,'fixture-output.log'),fixtureOutput);});
  const call=async(name:string,args:Record<string,unknown>)=>{
    const request=++id;
    await input.write(JSON.stringify({jsonrpc:'2.0',id:request,method:'tools/call',params:{name,arguments:args}})+'\n');
    const response=await eventually(async()=>{
      const output=await readFile(stdoutFile,'utf8');
      // Only parse complete lines: a reply can be observed during its write.
      const lines=output.slice(0,output.lastIndexOf('\n')+1).split('\n').filter(Boolean);
      const reply:Reply|undefined=lines.map(line=>JSON.parse(line)).find((message:Reply)=>message.id===request);
      if(!reply)throw new Error(`Native tool has no reply yet: ${name}; launcher exit=${transport.exitCode}; ${await readFile(stderrFile,'utf8')}`);
      return reply;
    },{within:15_000});
    const text=response.result.content.find(block=>block.type==='text')?.text;
    if(!text)throw new Error('Native response has no structured text');
    const result=JSON.parse(text);calls.push({name,arguments:args,result});
    expect(response.result.isError,result.error).not.toBe(true);return result;
  };
  const before=await call('snapshot',{pid:identity.pid,window_title:'Sofia Native Proof',wait_for:'Click target',wait_milliseconds:3000});
  const launchedPIDs=(await helperPIDs()).filter(pid=>!existingPIDs.has(pid));
  expect(launchedPIDs).toHaveLength(1);
  helperPID=launchedPIDs[0];
  await writeFile(join(evidence.dir,'helper-process.json'),JSON.stringify({helperPID,existingPIDs:[...existingPIDs],launcherPID:transport.pid,launcherExit:transport.exitCode},null,2));
  const target=before.elements.find((element:{label:string})=>element.label==='Click target');
  expect(target).toBeDefined();
  expect(target.capabilities).toMatchObject({focus:true,press:false});
  const beforeCount=await call('snapshot_elements',{snapshot_id:before.snapshot_id,query:'Clicks:'});
  expect(JSON.stringify(beforeCount.elements)).toContain('Clicks: 0');
  const action=await call('click',{snapshot_id:before.snapshot_id,ref:target.ref});
  expect(action).toMatchObject({ok:true,path:'background_cgevent',fallbackUsed:true});
  const after=await eventually(async()=>{
    const snapshot=await call('snapshot',{pid:identity.pid,window_title:'Sofia Native Proof'});
    const counter=await call('snapshot_elements',{snapshot_id:snapshot.snapshot_id,query:'Clicks:'});
    expect(JSON.stringify(counter.elements)).toContain('Clicks: 1');
    expect(JSON.stringify(counter.elements)).not.toContain('Clicks: 0');
    return snapshot;
  },{within:5000});
  expect(after.snapshot_id).not.toBe(before.snapshot_id);
  evidence.recordAssertionEvidence('Focus is not click completion','The signed helper clicks a disposable focusable, non-AXPress control through validated background pointer input, then a fresh snapshot proves its click handler ran instead of merely focusing the element.',true);
});
