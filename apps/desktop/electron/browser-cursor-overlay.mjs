import { BrowserWindow } from 'electron';
import { BROWSER_CURSOR_SCRIPT } from './browser-cursor-runtime.mjs';

// App-owned transparent child window: unlike an overlay inside a page, it
// survives navigation and cannot be removed or captured as page content.
export function createBrowserCursorOverlay({ getWindow, resolveTarget }) {
  let overlay=null, ready=null, owner=null, generation=0;
  const positions=new Map();
  const arrivals=new Map();
  function hide() { generation++; owner=null; overlay?.hide(); }
  async function bounded(promise, mine) {
    let timer;
    try {
      const result=await Promise.race([Promise.resolve(promise).then(value=>({completed:true,value})),new Promise(resolve=>{timer=setTimeout(()=>resolve({completed:false,reason:"host-timeout"}),2200);})]);
      if(!result.completed&&mine===generation){hide();void overlay?.webContents.executeJavaScript('window.__sofiaAgentCursor?.hide()').catch(()=>{});}
      return result;
    } finally {clearTimeout(timer);}
  }
  async function command(targetId, state) {
    const target=await resolveTarget(targetId), parent=getWindow();
    if(!target) return {host:true,arrived:false,reason:"target-unavailable"};
    if(!parent||parent.isDestroyed()) return {host:true,arrived:false,reason:"parent-unavailable"};
    if(state.action==='hide') {
      if(owner===state.owner)hide();
      return {host:true};
    }
    if(state.action==='ready') return {host:true};
    const key=state.owner+':'+targetId;
    if(state.action==='moveTo' && Number.isSafeInteger(state.moveSequence)) {
      const previous=arrivals.get(key);
      if(previous && state.moveSequence<=previous.moveSequence) return {...previous,arrived:state.moveSequence===previous.moveSequence};
    }
    if(!target.visible){if(owner===state.owner)hide();return {host:true,arrived:false,reason:"target-hidden"};}
    if(!overlay||overlay.isDestroyed()) {
      overlay=new BrowserWindow({parent,show:false,frame:false,transparent:true,hasShadow:false,focusable:false,skipTaskbar:true,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
      overlay.setIgnoreMouseEvents(true);
      const view=overlay;
      ready=view.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><title>Sofia browser cursor</title><style>html,body{margin:0;background:transparent;overflow:hidden}</style>'))
        .then(()=>view.webContents.executeJavaScript(BROWSER_CURSOR_SCRIPT));
      parent.on('move',hide); parent.on('hide',hide); parent.once('closed',()=>{view.destroy();});
    }
    const mine=++generation; owner=state.owner;
    const loaded=await bounded(ready,mine);
    if(!loaded.completed)return {host:true,arrived:false,reason:loaded.reason||"host-overlay-timeout",overlayVisible:overlay?.isVisible()===true,targetVisible:target.visible};
    if(mine!==generation)return {host:true,arrived:false,reason:"superseded",overlayVisible:overlay?.isVisible()===true,targetVisible:target.visible};
    const content=parent.getContentBounds(),bounds=target.bounds;
    overlay.setBounds({x:content.x+bounds.x,y:content.y+bounds.y,width:Math.max(1,bounds.width),height:Math.max(1,bounds.height)});
    if(!overlay.isVisible())overlay.showInactive();
    const zoom=target.zoom;
    const previous=positions.get(targetId);
    if(previous&&state.action==='present') {
      const presented=await bounded(overlay.webContents.executeJavaScript(`window.__sofiaAgentCursor.moveTo(${previous.x*zoom},${previous.y*zoom},false)`),mine);
      if(!presented.completed||presented.value?.arrived!==true)return {host:true,arrived:false,reason:presented.value?.reason||"host-timeout"};
    } else if(state.action==='present') {
      const presented=await bounded(overlay.webContents.executeJavaScript('window.__sofiaAgentCursor.present()'),mine);
      if(!presented.completed)return {host:true,arrived:false,reason:'host-timeout'};
    } else if(state.action==='moveTo'||state.action==='flash') {
      if(!Number.isFinite(state.x)||!Number.isFinite(state.y))throw new Error('Invalid cursor coordinates');
      positions.set(targetId,{x:state.x,y:state.y});
      const animation=await bounded(overlay.webContents.executeJavaScript(`window.__sofiaAgentCursor.${state.action}(${state.x*zoom},${state.y*zoom},${state.animate!==false})`),mine);
      if(!animation.completed||animation.value?.arrived!==true)return {host:true,arrived:false,reason:animation.value?.reason||"host-timeout",moveSequence:state.moveSequence,overlayVisible:overlay.isVisible(),targetVisible:target.visible,animationCompleted:animation.completed};
    }
    // A completed move/flash is the authoritative signal. A subsequent hide or
    // panel repaint may bump the generation after the animation settled; that
    // must not turn a successful presentation into a false action failure.
    const completedAnimation=state.action==='moveTo'||state.action==='flash';
    const result={host:true,arrived:completedAnimation||mine===generation,moveSequence:state.moveSequence};
    if(state.action==='moveTo' && result.arrived && Number.isSafeInteger(state.moveSequence)) {
      arrivals.set(key,result);
      if(arrivals.size>64)arrivals.delete(arrivals.keys().next().value);
    }
    return result;
  }
  return {command,hide,close(){hide();overlay?.destroy();overlay=null;positions.clear();arrivals.clear();}};
}
