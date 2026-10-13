import { createServer } from 'node:http';
import { createAndSelectWorkspace, evalIn } from '@sofia/behaviors';
import { connect, debuggerUrlFor, evaluate, listTargets, captureScreenshot } from '@sofia/cdp';
import { desktop } from '@sofia/hosts';
import { needs, test, eventually } from '@sofia/testkit';
import { expect, onTestFinished } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('production browser cursor stays outside page content and human takeover blocks agent commands', {timeout:180_000}, async ({evidence}) => {
  needs({optIn:['SOFIA_EVAL_E2E_TESTS'],placement:'local'});
  await using app=await desktop({name:'browser-control-parity'});
  const fixture=createServer((request,response)=>{
    if(request.url==='/empty-error'){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'content-type':'text/html'});
    response.end('<!doctype html><title>Control parity fixture</title><button id="target" style="margin:100px" onclick="window.clicked=event.isTrusted">Fixture action</button>');
  });
  await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  onTestFinished(()=>fixture.close());
  const address=fixture.address();if(!address||typeof address==='string')throw new Error('Fixture did not bind');
  const workspace=await createAndSelectWorkspace(app,{path:`/tmp/sofia-control-parity-${Date.now()}`});
  await app.client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await app.client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await evalIn(app,`window.__SOFIA_ELECTRON__.browser.setScope(${JSON.stringify("workspace:")}+${JSON.stringify(workspace.workspaceId)})`,{awaitPromise:true});
  const opened=await evalIn(app,`window.__SOFIA_ELECTRON__.browser.openUrl('http://127.0.0.1:${address.port}/','builtin')`,{awaitPromise:true});
  if(!opened||typeof opened!=='object'||!('browser_url' in opened)||!('target_id' in opened)||!('tab_id' in opened)||typeof opened.browser_url!=='string'||typeof opened.target_id!=='string')throw new Error('Real broker target missing');
  await evalIn(app,"document.querySelector('button[aria-label=\"Browser\"]')?.click()");
  await evalIn(app,"window.__SOFIA_ELECTRON__.browser.setPresentation('docked')",{awaitPromise:true});
  const target=await eventually(async()=>{
    const found=(await listTargets(opened.browser_url)).find(entry=>entry.id===opened.target_id);
    if(!found)throw new Error('Browser target not ready');return found;
  },{within:10_000});
  const agent=await connect(debuggerUrlFor(opened.browser_url,target));
  const observer=await connect(debuggerUrlFor(app.handle.cdpUrl,target));
  onTestFinished(()=>agent.close());onTestFinished(()=>observer.close());
  expect(await evaluate(agent,'document.title')).toBe('Control parity fixture');
  const overlayTarget=await eventually(async()=>{
    const found=(await listTargets(app.handle.cdpUrl)).find(entry=>entry.title==='Sofia browser cursor');
    if(!found)throw new Error('Host cursor not ready');return found;
  },{within:15_000});
  const overlay=await connect(debuggerUrlFor(app.handle.cdpUrl,overlayTarget));onTestFinished(()=>overlay.close());
  expect(await evaluate(observer,"document.querySelector('#__sofia-agent-cursor')===null && window.__sofiaAgentCursor===undefined")).toBe(true);
  expect(await agent.send('Sofia.cursor',{action:'moveTo',x:130,y:120,moveSequence:1})).toMatchObject({host:true,arrived:true,moveSequence:1});
  expect(await evaluate(overlay,"document.querySelector('#__sofia-agent-cursor').getBoundingClientRect().width")).toBeGreaterThan(0);
  const arrivedPosition=await evaluate(overlay,"document.querySelector('#__sofia-agent-cursor').style.transform");
  expect(await agent.send('Sofia.cursor',{action:'moveTo',x:500,y:400,moveSequence:1})).toMatchObject({arrived:true,moveSequence:1});
  expect(await evaluate(overlay,"document.querySelector('#__sofia-agent-cursor').style.transform")).toBe(arrivedPosition);

  const point=await evaluate(observer,"(()=>{const r=document.querySelector('#target').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await agent.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await agent.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  expect(await evaluate(observer,'window.clicked')).toBe(true);
  await evalIn(app,`window.__SOFIA_ELECTRON__.browser.agentLease('pause',{tabId:${JSON.stringify(opened.tab_id)}})`,{awaitPromise:true});
  await expect(agent.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1})).rejects.toThrow(/control belongs to the user/);
  await expect(evaluate(agent,'window.clicked=false')).rejects.toThrow(/control belongs to the user/);
  expect(await evaluate(observer,'window.clicked')).toBe(true);
  const paused=await evalIn(app,'window.__SOFIA_ELECTRON__.browser.listTabs()',{awaitPromise:true});
  expect(paused.find((tab:{id:string})=>tab.id===opened.tab_id).agentState.status).toBe('paused');
  await evalIn(app,`window.__SOFIA_ELECTRON__.browser.agentLease('resume',{tabId:${JSON.stringify(opened.tab_id)}})`,{awaitPromise:true});
  expect(await agent.send('Sofia.cursor',{action:'moveTo',x:180,y:130,moveSequence:2})).toMatchObject({host:true,arrived:true});
  await agent.send('Page.navigate',{url:`http://127.0.0.1:${address.port}/next`});
  await eventually(async()=>{expect(await evaluate(observer,'location.pathname')).toBe('/next');return true;},{within:5000});
  expect(await evaluate(observer,"document.querySelector('#__sofia-agent-cursor')===null")).toBe(true);
  await mkdir(evidence.dir,{recursive:true});
  await writeFile(join(evidence.dir,'host-cursor.png'),await captureScreenshot(overlay));
  await agent.send('Page.navigate',{url:`http://127.0.0.1:${address.port}/empty-error`});
  await eventually(async()=>{
    const tabs=await evalIn(app,'window.__SOFIA_ELECTRON__.browser.listTabs()',{awaitPromise:true});
    expect(tabs.find((tab:{id:string})=>tab.id===opened.tab_id).pageState).toMatchObject({status:'error',error:{code:404}});
    return true;
  },{within:5000});
  await evalIn(app,'window.__SOFIA_ELECTRON__.browser.reload()',{awaitPromise:true});
  await eventually(async()=>{
    const tabs=await evalIn(app,'window.__SOFIA_ELECTRON__.browser.listTabs()',{awaitPromise:true});
    expect(tabs.find((tab:{id:string})=>tab.id===opened.tab_id).pageState.status).toBe('error');return true;
  },{within:5000});
  await agent.send('Page.navigate',{url:`http://127.0.0.1:${address.port}/recovered`});
  await eventually(async()=>{
    const tabs=await evalIn(app,'window.__SOFIA_ELECTRON__.browser.listTabs()',{awaitPromise:true});
    expect(tabs.find((tab:{id:string})=>tab.id===opened.tab_id).pageState.status).toBe('ready');return true;
  },{within:5000});
  await evalIn(app,`window.__SOFIA_ELECTRON__.browser.setAgentScope(${JSON.stringify('workspace:')}+${JSON.stringify(workspace.workspaceId)})`,{awaitPromise:true});
  await evalIn(app,"window.__SOFIA_ELECTRON__.browser.setAgentScope('')",{awaitPromise:true});
  await expect(agent.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1})).rejects.toThrow();
  await agent.close();
  await eventually(async()=>{
    const tabs=await evalIn(app,'window.__SOFIA_ELECTRON__.browser.listTabs()',{awaitPromise:true});
    expect(tabs.find((tab:{id:string})=>tab.id===opened.tab_id).agentState.status).toBe('detached');
    return true;
  },{within:5000});
  evidence.recordAssertionEvidence('App-owned cursor and takeover', 'The production broker renders its cursor in an app-owned transparent surface, never in the fixture DOM; movement arrival is acknowledged, trusted clicks work, takeover blocks input and page evaluation, resume restores input, navigation preserves host rendering, completed-run scope revokes further agent commands, and disconnect releases the lease while retaining the tab.',true);
});
