// Reconstructed from the shipped cursor contract. Host rendering keeps page
// content untouched; the standalone broker retains a document overlay adapter.
export const BROWSER_CURSOR_ELEMENT_ID = "__sofia-agent-cursor";
export const BROWSER_CURSOR_APPROACH = { dx: -26, dy: -20 };

export function cursorPath(start, end, bounds) {
  const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance <= 196) return { segments: [[start, {x:start.x+(end.x-start.x)/3,y:start.y+(end.y-start.y)/3}, {x:start.x+2*(end.x-start.x)/3,y:start.y+2*(end.y-start.y)/3}, end]], response: .19, damping: .94 };
  const direction = { x: (end.x - start.x) / distance, y: (end.y - start.y) / distance };
  const normal = { x: -direction.y, y: direction.x };
  const tangent = { x: Math.sin(-44 * Math.PI / 180), y: -Math.cos(-44 * Math.PI / 180) };
  const add = (a, b, scale) => ({ x: a.x + b.x * scale, y: a.y + b.y * scale });
  const ray = (point, vector, length) => {
    let limit = length;
    if (vector.x > 0) limit = Math.min(limit, (bounds.width - point.x) / vector.x);
    if (vector.x < 0) limit = Math.min(limit, -point.x / vector.x);
    if (vector.y > 0) limit = Math.min(limit, (bounds.height - point.y) / vector.y);
    if (vector.y < 0) limit = Math.min(limit, -point.y / vector.y);
    return Math.max(0, limit);
  };
  const startHandle = ray(start, tangent, Math.max(48, Math.min(640, distance * .41960295031576633, distance * .9)));
  const reverse = { x: -tangent.x, y: -tangent.y };
  const endHandle = ray(end, reverse, Math.max(48, Math.min(640, distance * .15, distance * .9)));
  const candidates = [1, .65].map(scale => [[start, add(start, tangent, startHandle * scale), add(end, reverse, endHandle * scale), end]]);
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const preferred = normal.x * tangent.x + normal.y * tangent.y >= 0 ? 1 : -1;
  for (const sign of [preferred, -preferred]) for (const arcScale of [.55, .8, 1.05]) for (const flowScale of [.65, 1, 1.35]) {
    const arc = add(add(midpoint, normal, sign * arcScale * Math.max(50, Math.min(520, distance * .2765523188064277))), tangent, startHandle * .16);
    const flow = flowScale * Math.max(38, Math.min(440, distance * .5783555327868779));
    candidates.push([[start, add(start, tangent, startHandle), add(arc, direction, -flow), arc], [arc, add(arc, direction, flow), add(end, reverse, endHandle), end]]);
  }
  const sample = (segment, t) => {
    const [a,b,c,d] = segment, u = 1-t;
    return { x:u*u*u*a.x+3*u*u*t*b.x+3*u*t*t*c.x+t*t*t*d.x, y:u*u*u*a.y+3*u*u*t*b.y+3*u*t*t*c.y+t*t*t*d.y };
  };
  const orientation = clamp((-direction.x*tangent.x-direction.y*tangent.y-.08)/.92,0,1);
  const scored = candidates.map(segments => {
    let length=0, energy=0, headingMax=0, totalTurn=0, previous=start, previousHeading=null, inside=true;
    for (const segment of segments) for(let i=1;i<=24;i++) {
      const point=sample(segment,i/24), dx=point.x-previous.x, dy=point.y-previous.y;
      length+=Math.hypot(dx,dy);
      const heading=Math.atan2(dy,dx);
      if(previousHeading!==null) {
        const delta=Math.atan2(Math.sin(heading-previousHeading),Math.cos(heading-previousHeading));
        energy+=delta*delta; headingMax=Math.max(headingMax,Math.abs(delta)); totalTurn+=Math.abs(delta);
      }
      previousHeading=heading; previous=point;
      inside &&= point.x>=20 && point.y>=20 && point.x<=bounds.width-20 && point.y<=bounds.height-20;
    }
    const arc=segments.length>1;
    const cost=length+320*Math.max(0,length/Math.max(1,distance)-1)+140*energy+180*headingMax+18*totalTurn+90*orientation+(arc?45:0);
    const combined=clamp(.42*clamp(Math.max(0,length/Math.max(1,distance)-1)/.55,0,1)+.38*clamp(totalTurn/(1.4*Math.PI),0,1)+.2*clamp(energy/1.25,0,1),0,1);
    const response=clamp((.42+.22*clamp((length-180)/760,0,1)+.12*combined+.28*orientation+(arc?.04:0))*.7*(arc?.9:1),.12,2.2);
    return {segments,cost,inside,response,damping:.9};
  });
  const eligible=scored.filter(c=>c.inside);
  return (eligible.length?eligible:scored).sort((a,b)=>a.cost-b.cost)[0];
}

function cursorRuntime(path, icon) {
  if (window.__sofiaAgentCursor) return;
  let element=null, image=null, frame=0, generation=0, position=null, resolveMove=null;
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const ensure=()=>{
    if(element?.isConnected)return element;
    element=document.createElement('div'); element.id='__sofia-agent-cursor'; element.setAttribute('aria-hidden','true');
    Object.assign(element.style,{position:'fixed',top:'0',left:'0',width:'24px',height:'24px',zIndex:'2147483647',pointerEvents:'none',opacity:'0',transformOrigin:'12px 12px',willChange:'transform,opacity'});
    image=document.createElement('img'); image.src=icon;
    Object.assign(image.style,{position:'absolute',width:'23px',height:'24px',transform:'translate(12px,-2.5px) rotate(44deg)',filter:'drop-shadow(0 0 6px rgba(99,102,241,.9)) drop-shadow(0 0 15px rgba(99,102,241,.48))'});
    element.append(image); (document.documentElement||document).append(element);
    image.animate([{opacity:0,filter:'blur(5px)',transform:'translate(12px,-2.5px) rotate(44deg) scale(.4)'},{opacity:1,filter:'blur(0px)',transform:'translate(12px,-2.5px) rotate(44deg) scale(1)'}],{duration:420,easing:'cubic-bezier(.2,.9,.4,1)'});
    return element;
  };
  const paint=(point,rotation=-44,stretch=1)=>{
    const e=ensure(); e.style.opacity='1';
    e.style.transform=`translate(${Math.round((point.x-12)*1000)/1000}px,${Math.round((point.y-12)*1000)/1000}px) rotate(${rotation}deg) scaleY(${stretch})`;
  };
  const stop=()=>{generation++;cancelAnimationFrame(frame);resolveMove?.({arrived:false});resolveMove=null;};
  const pointAt=(segments,progress)=>{
    const t=clamp(progress,0,1)*segments.length, index=Math.min(segments.length-1,Math.floor(t));
    const local=index===segments.length-1&&t===segments.length?1:t-index;
    const [a,b,c,d]=segments[index],u=1-local;
    return {x:u*u*u*a.x+3*u*u*local*b.x+3*u*local*local*c.x+local*local*local*d.x,y:u*u*u*a.y+3*u*u*local*b.y+3*u*local*local*c.y+local*local*local*d.y};
  };
  window.__sofiaAgentCursor={
    present(){
      if(position){paint(position);return;}
      position={x:Math.round(innerWidth*.58),y:Math.round(innerHeight*.55)};paint(position);
      const began=performance.now(),mine=++generation;
      const wobble=now=>{if(mine!==generation)return;paint(position,-44+Math.sin((now-began)/660*Math.PI*2)*12.5*Math.max(0,1-(now-began)/1410));if(now-began<1410)frame=requestAnimationFrame(wobble);};
      frame=requestAnimationFrame(wobble);
    },
    moveTo(x,y,animate=true){
      if(!Number.isFinite(x)||!Number.isFinite(y))return Promise.resolve({arrived:false});
      stop(); const target={x:clamp(x,0,innerWidth),y:clamp(y,0,innerHeight)};
      const start=position||target;
      if(!animate||matchMedia('(prefers-reduced-motion: reduce)').matches||Math.hypot(target.x-start.x,target.y-start.y)<.85){position=target;paint(target);return Promise.resolve({arrived:true});}
      const plan=path(start,target,{width:innerWidth,height:innerHeight});
      const omega=2*Math.PI/plan.response, damping=plan.damping;
      let progress=0,velocity=0,last=performance.now(),began=last,previous=start,rotation=-44,rotationVelocity=0,stretch=1,stretchVelocity=0;
      const short=Math.hypot(target.x-start.x,target.y-start.y)<=196;
      const rotationOmega=2*Math.PI/(short?.055:.12),rotationDamping=short?.82:.9;
      const stretchOmega=2*Math.PI/(short?.12:.2),stretchDamping=short?.86:.85;
      const mine=generation;
      return new Promise(resolve=>{resolveMove=resolve;
        const tick=now=>{
          if(mine!==generation)return;
          const frameDuration=Math.max(1/240,(now-last)/1000);
          let elapsed=Math.min(.05,frameDuration);last=now;
          while(elapsed>0){const dt=Math.min(1/240,elapsed);velocity+=(-omega*omega*(progress-1)-2*damping*omega*velocity)*dt;progress+=velocity*dt;elapsed-=dt;}
          const point=pointAt(plan.segments,progress),speed=Math.hypot(point.x-previous.x,point.y-previous.y)/frameDuration;
          const lookAhead=pointAt(plan.segments,Math.min(1,progress+.001));
          let targetRotation=progress>.995?-44:Math.atan2(lookAhead.y-point.y,lookAhead.x-point.x)*180/Math.PI+90;
          targetRotation=rotation+Math.atan2(Math.sin((targetRotation-rotation)*Math.PI/180),Math.cos((targetRotation-rotation)*Math.PI/180))*180/Math.PI;
          const targetStretch=clamp(1-speed/5500,.65,1);
          let remaining=Math.min(.05,frameDuration);
          while(remaining>0){const dt=Math.min(1/240,remaining);rotationVelocity+=(-rotationOmega*rotationOmega*(rotation-targetRotation)-2*rotationDamping*rotationOmega*rotationVelocity)*dt;rotation+=rotationVelocity*dt;stretchVelocity+=(-stretchOmega*stretchOmega*(stretch-targetStretch)-2*stretchDamping*stretchOmega*stretchVelocity)*dt;stretch+=stretchVelocity*dt;remaining-=dt;}
          position=point;paint(point,rotation,clamp(stretch,.65,1));previous=point;
          if((Math.hypot(target.x-point.x,target.y-point.y)<=.85&&Math.abs(velocity)<.01&&progress>=.999)||now-began>=1500){position=target;paint(target);resolveMove=null;resolve({arrived:true});return;}
          frame=requestAnimationFrame(tick);
        };frame=requestAnimationFrame(tick);
      });
    },
    flash(x,y){const e=ensure();const pulse=e.animate([{opacity:1},{opacity:.65},{opacity:1}],{duration:200});return pulse.finished.catch(()=>{});},
    hide(){stop();if(element)element.style.opacity='0';},
    fade(){this.hide();},
  };
}

export const BROWSER_CURSOR_SCRIPT = `(${cursorRuntime.toString()})(${cursorPath.toString()},'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC4AAAAwCAYAAABuZUjcAAAG+klEQVR4Ae1ZW2xUVRS982qnj+lzSh9UrLWosVFq+TAkRmpi0URJSBogqRggavyF1Cj6Q0P94A+iURJDQrH6Q2OxIF/EEE0a0hqBEBKRQihSIYHQxwzTTtuZua51e/Z4GeZxh85MP2AnJ/d1HuvsvfY++5yraU/kiTzeYtN1PVq6u7vtvPK9fNOWSZzxXhIQhFfjecuWLfa7d+/a+vr6GvB+bPPmzXpzc7O+WHWxLu+15RTRLG7tbW1tzps3b64OhUKDeD+pK8Hzb4FA4MNr166tZh2pLxaRCedaqD4Ccfl8vo/MgOOJTOLcuXNVaCOTiFIpJ3RSgxigL168+EIq0DEyOT8///29e/fa165d6wKdHCwm8FKyAtpG0zc0NLjn5uZ+EETXr1/X8d7gNL7pu3btMt4lkkgkMsZJTE1NvclJoJ2DljA5d2aBs2M4XZ7X6/Vg8CkBsmnTJgN0bGlpadF7e3tTTgJK6IE/PIc2hiW0RatmzAI21an75MmTa8yDxwMdW2gRTmJyMjG7Yp1aJhFDpfQmw8bsDLdFe/bsaTIPSHpYAS9lx44d+vHjx/VkIpMYGhpagTbGJOJQKfUkVANXdXV1Ea7V6PSsDIIO0wIuhRPmJM6cOZNsDpOgUp84tab8wWQFTU/mF6JxAi8uLl5x9erVfdIzB34U4LGTSNepJSppyTSvKjjq6+sLcPVu27btAZ5LVMlEserUpJKyQuJoxA+cYVNTUz4eywsKCp7CAjS8VLqkKqmcemZm5hNGOpP2HwIe5XlFRUVJYWFh3YULFz6LEhEdZwO4ZsGpYZlXCV5bDKPxtU6e19XVFYLnVZ2dnS3hcHg6G3TRUviDmUagzLeKwk7ReuwMCC4CbYedTucCZj8Bb/9VPmIh0nIhY2Nj2s6dO6PPbrf7nWAw6ATfJRONKzblEJ6ioqIaLEbvmelSVlaWM62LIOb/g3flTEVUEvcwZ8j1xsbGCG7DmF0YTnEWHu7jN4DWEBG0XAgsH70HXX0ej8cBSyQPixJdALSM0eXWrVu9MvtMxPRUhb5k5jjo2g/gXvoevjsSAtcWA76zqqqqGNfqU6dOdWaTLuyPYA8cOPBQbGdw2L9//2uoV4niVsATat7QOj25pKSkAs7xDJblcemMK+BSwcpKSgsmS8xGRkY+p9VpfXI8ocZFlBPkl5eXl6JhPfj11VLpkkir8QTL/h+HDh3qyM/Pf5ZWR/GooGFLCVxli8XMXXp6etrMHadLlyNHjiQFisjhu3Hjxi9QSveGDRteR5tmgobSVoq2VRqcHLiunJQNFF0apqenR2SgdFIAajqeTExM/Hnp0qXvjh49+rHL5WpF3ZdRXkRpwnhP41pD0HRKpcQoaHsi4Az0PIKorKwMOxwOhsYFRJfT8n39+vWaVdm+fXv03u/3j0Kr+9rb299AavFBa2vr1/j+u91u9wGsH1WmsX748/Ly/NiJBUCZYG1t7QIXRkuD6WqTK5sL0oUpgFljVlMAM6cHBwe7AOol0OB5xd9VzIvYP0JeJX2K0YyBQVJbLU52mEzjHJQLQQR0odYXBgYGJqGxEaljXiQSCdoaReTw4cND0G4A5T4ila+0tNQPTd+HlgOwbgARJghLB9etWze/cePG8LFjx6jpiOCxJPr/xxXGBhrXuvPnz38q2rOSMTLjE6GPKC3XULPctHCho2Zj96D6Uk8DVAekSyFXr46OjlfSyRjN27bLly9/iXcroWUj7xCw+oNnL5kR0ToH4oAIT6vu3LkzIGAOHjyYFLhZED3eZbqs9rVGTNazeVzHmE5zki5wpFqrGaM5DHLlZUgVbVuKyRmQ6AaDng8AjVboYl50YKWfuJjgfQmKsZtZCo/tFuvpCFE6NxiIKiEk9Qu3b9/+WT7u3bs3biNz1Lly5crp2dnZEG7DmqJQWpHiUUTx0NA6Yyw3GOaMkRJ7aMSdvFm2bt26Bu+9sgXTckATAW84qRqYdGnADvwvAcZFhmeMcghkXnR4WiAZnjpFsGrpjADnxa5228wYV544ceJ93YLAudtgpWpay1KGlwXw0RQApYpOOjo6+k0iwMz4hoeHv2DCxEQNbWitnESTWDFOu6h1mh33dVgJV+/evfttOOsgHPdvgoXz/guq/NjV1fUW6jSh1KB4SBPZ7GYCSNptoHUHokQessV8RJoChMZCKDgP535OpKc2FS1CeJ7DdRZznEEJgv8hrKThTEQTp5a+GGcv0O4CH+Cg3K2EwXkXKMH+qFEdWmfomwPgeayWc9hBhWCFcNZDYAqxmXZIbjodkybFYy+vkp5qixtcmVDGuP3IHcmqBw0avwrBXzv4bWMZHx+XJT/Mhau/v5/P1jYCuRLd9NcZjw7572n657lsf5/TlZyA/Q9N3TljZhaAsAAAAABJRU5ErkJggg==');`;

export function createBrowserCursor({send}) {
  let ready=null,shown=false,host=false,sequence=0;
  const evaluate=expression=>Promise.resolve(send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).catch(()=>undefined);
  const control=async(action,x,y)=>{
    if(host)return send('Sofia.cursor',{action,x,y,moveSequence:++sequence});
    return evaluate(`window.__sofiaAgentCursor?.${action}(${x??''}${y===undefined?'':','+y})`);
  };
  const ensure=()=>ready??=Promise.resolve(send('Sofia.cursor',{action:'ready'})).then(result=>{host=result?.host===true;if(!host)return Promise.all([Promise.resolve(send('Page.addScriptToEvaluateOnNewDocument',{source:BROWSER_CURSOR_SCRIPT})),evaluate(BROWSER_CURSOR_SCRIPT)]);}).catch(()=>evaluate(BROWSER_CURSOR_SCRIPT));
  return {
    isShown:()=>shown,
    ready:ensure,
    async move(x,y){await ensure();shown=true;await control('moveTo',Math.round(x),Math.round(y));},
    async click(x,y){await this.move(x,y);await control('flash',Math.round(x),Math.round(y));},
    async doubleClick(x,y){await this.click(x,y);await this.click(x,y);},
    async fade(){shown=false;await ensure();await control('hide');},
    forget(){shown=false;},
  };
}
