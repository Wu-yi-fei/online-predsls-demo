'use strict';
// Run actual interface event handlers against the real engine. Rendering is
// intentionally replaced with noops; browser tests cover SVG and pointer layout.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const PowerDemo=require('./simulation.js');
const ALGORITHM_ID='opredsls-window-ridge-v1';
assert.equal(PowerDemo.constants.algorithmId,ALGORITHM_ID);
const d3=require('../assets/d3.v7.min.js');
const TopologyTimeline=require('./topology-timeline.js');
const html=fs.readFileSync(path.join(__dirname,'interface.html'),'utf8');
const original=fs.readFileSync(path.join(__dirname,'interface.js'),'utf8');
const anchor="  announce('Ready');";
assert.equal(original.split(anchor).length,2,'Interface initialization anchor must be unique');
// Event cards and transient flashes are rendered and checked in the browser.
// Keep the actual history state and controls in this lightweight DOM harness.
const cardStart="    const cards=d3.select($('topology-events'))";
const cardEnd="    $('topology-events').hidden=total===0;";
assert.equal(original.split(cardStart).length,2,'Topology cards anchor must be unique');
const withoutCards=original.slice(0,original.indexOf(cardStart))+original.slice(original.indexOf(cardEnd));
const source=withoutCards.replace(anchor,
  '  drawNetwork=renderNetworkInspection;drawCost=drawStage=drawVoltage=drawConvergence=highlightTopology=()=>{};\n'+
  '  drawMatrix=drawTopologyHistory;\n'+
  '  root.bindTestBus=(element,bus)=>bindAttackTarget(element,()=>bus);\n'+
  '  root.testSummary=()=>comparisonSummary();\n'+
  '  root.testCodesign=()=>codesignMetrics();\n'+
  '  root.testProgress=()=>experimentProgress();root.testRenderProgress=renderExperimentProgress;\n'+
  '  root.testInspectPredictionLink=(receiver,source)=>inspectPredictionLink(receiver,source);\n'+
  '  root.testInspection=()=>predictionInspection();\n'+
  '  root.testProtocol=()=>protocolStatus();\n'+
  '  root.testForecastSettings=()=>forecastSettings();\n'+
  '  root.testForecastObservation=()=>inspectedForecastObservation();\n'+
  '  root.testSourceHistory=()=>inspectedSourceHistory();\n'+
  '  root.testErrorWindow=forecastErrorWindow;\n'+
  '  root.testInspectedCommand=()=>inspectedCommand();\n'+
  '  root.testDecompose=commandContributions;\n'+
  '  root.testIssuedForecasts=()=>simulation.forecasts;\n'+
  '  root.testDrawSeries=drawSeries;\n'+
  '  root.testInterventionEvents=interventionEvents;root.testInterventionGroups=interventionGroups;\n'+
  '  root.testPin=(value)=>{if(value!==undefined)pin=value;return pin;};\n'+
  '  root.testPowerContext=()=>powerRecoveryContext();\n'+
  '  root.testShownReference=()=>[...topologyFrame().reference];\n'+
  '  root.testComparison=()=>({active:activeSeries().map(item=>item.key),plotted:plottedSeries().map(item=>item.key),sameSparseSupport:sameSparseSupport()});\n'+anchor);
const plain=value=>JSON.parse(JSON.stringify(value));

class Clock {
  now=0;
  serial=0;
  tasks=new Map();
  setTimeout=(fn,delay=0)=>{const id=++this.serial;this.tasks.set(id,{fn,at:this.now+Math.max(0,Number(delay)||0)});return id;};
  clearTimeout=id=>this.tasks.delete(id);
  next(){return [...this.tasks].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];}
  async runNext(){
    const next=this.next();assert.ok(next,'Expected a scheduled callback');
    const [id,task]=next;this.tasks.delete(id);this.now=Math.max(this.now,task.at);task.fn();
    // Let the real async comparison handler resume after its zero delay yield.
    await Promise.resolve();await Promise.resolve();
  }
  async advance(milliseconds){
    const target=this.now+milliseconds;let count=0;
    while(this.next()&&this.next()[1].at<=target){assert.ok(++count<10000,'Timer loop must be bounded');await this.runNext();}
    this.now=target;
  }
  async until(predicate){for(let i=0;!predicate();i++){assert.ok(i<2000,'Condition did not become true');await this.runNext();}}
}

function target(tagName='DIV') {
  const listeners=new Map();
  return {tagName,style:{},dataset:{},children:[],value:'',textContent:'',hidden:false,disabled:false,checked:false,
    addEventListener(type,handler){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(handler);},
    dispatch(type,detail={}){
      const event={target:this,defaultPrevented:false,repeat:false,altKey:false,ctrlKey:false,metaKey:false,
        button:0,pointerId:1,detail:0,preventDefault(){this.defaultPrevented=true;},stopPropagation(){},...detail};
      return (listeners.get(type)||[]).map(handler=>handler(event)).at(-1);
    },
    setAttribute(name,value){this[name]=String(value);},
    getAttribute(name){return this[name]??null;},
    removeAttribute(name){delete this[name];},
    append(...children){this.children.push(...children);},
    replaceChildren(...children){this.children=children;},
    querySelectorAll(){return this.children;},
    querySelector(selector){return this.children.find(child=>selector==='.pr-swatch'&&child.className?.startsWith('pr-swatch'))||null;},
    getBoundingClientRect(){return {width:550};},
    setPointerCapture(id){this.capturedPointer=id;},
    closest(){return null;}
  };
}

function harness(saved,experiment='prediction',reducedMotion=true) {
  const clock=new Clock(),nodes=new Map(),savedStates=[],captures=new Map();
  function element(tagName='DIV') {
    const node=target(tagName);
    node.setPointerCapture=id=>{node.capturedPointer=id;captures.set(id,node);};
    node.releasePointerCapture=id=>{if(captures.get(id)===node){captures.delete(id);node.dispatch('lostpointercapture',{pointerId:id});}};
    node.hasPointerCapture=id=>captures.get(id)===node;
    return node;
  }
  for(const match of html.matchAll(/<(\w+)[^>]*\bid="(pr-[^"]+)"/g)){
    const node=element(match[1].toUpperCase());node.id=match[2];nodes.set(node.id,node);
  }
  for(const name of ['network','matrix']) nodes.get('pr-'+name).parentElement=target();
  for(const input of html.matchAll(/<input\b[^>]*\bid="(pr-[^"]+)"[^>]*>/g)){
    const node=nodes.get(input[1]);
    node.checked=/\bchecked\b/.test(input[0]);
    node.hidden=/\bhidden(?:\s|>)/.test(input[0]);
    node.value=input[0].match(/\bvalue="([^"]*)"/)?.[1]||'';
  }
  // Read actual selected defaults so the harness cannot hide an HTML speed bug.
  for(const select of html.matchAll(/<select\b[^>]*\bid="(pr-[^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
    const options=[...select[2].matchAll(/<option\b([^>]*)>/g)];
    const selected=options.find(option=>/\bselected\b/.test(option[1]))||options[0];
    if(selected)nodes.get(select[1]).value=selected[1].match(/\bvalue="([^"]*)"/)[1];
  }
  // Legacy cases explicitly keep the reference physics and beta. Passing null
  // exercises the actual shipped HTML defaults, including the new scenario.
  if(experiment!==null) {
    nodes.get('pr-experiment').value=experiment;
    nodes.get('pr-power-scenario').value='reference';
    nodes.get('pr-noise').value='1';
    nodes.get('pr-view').value=experiment==='communication'?'learning':'cost';
  }
  const seriesButtons=new Map();
  for(const match of html.matchAll(/<button\b[^>]*\bdata-series="([^"]+)"[^>]*>/g)){
    const button=element('BUTTON');button.dataset.series=match[1];
    const swatch=element('SPAN');swatch.className='pr-swatch '+match[1];button.append(swatch);seriesButtons.set(match[1],button);
  }
  const root=target();root.querySelector=selector=>nodes.get(selector.slice(1));
  root.querySelectorAll=selector=>selector==='[data-series]'?[...seriesButtons.values()]:[];
  const document=Object.assign(target(),{getElementById:()=>root,createElement:tag=>target(tag.toUpperCase()),createTextNode:text=>({textContent:text})});
  const window=Object.assign(target(),{d3,PowerDemo,TopologyTimeline,matchMedia:()=>({matches:reducedMotion}),
    openai:{widgetState:saved,setWidgetState:state=>{savedStates.push(plain(state));return Promise.resolve();}}});
  vm.runInNewContext(source,{window,document,PowerDemo,d3,TopologyTimeline,console,
    performance:{now:()=>clock.now},setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,
    ResizeObserver:class{observe(){}},getComputedStyle:()=>({getPropertyValue:()=>''})},
    {filename:'interface.js'});
  const node=id=>nodes.get('pr-'+id);
  return {clock,document,window,node,drawSeries:(...args)=>root.testDrawSeries(...args),pin:value=>root.testPin(value),
    interventionEvents:(view=root.powerDemo.getSnapshot())=>plain(root.testInterventionEvents(view)),interventionGroups:(view,domain=[0,20],scale=10)=>plain(root.testInterventionGroups(view,domain,v=>v*scale,{x:0,w:600})),
    comparison:()=>plain(root.testComparison()),summary:()=>root.testSummary(),codesign:()=>plain(root.testCodesign()),progress:()=>plain(root.testProgress()),renderProgress:()=>root.testRenderProgress(),powerContext:()=>root.testPowerContext(),shownReference:()=>plain(root.testShownReference()),seriesButton:key=>seriesButtons.get(key),
    samples:count=>clock.advance(count*1000/Number(node('speed').value)),
    bus:bus=>{const svg=element('g');svg.dataset.bus=String(bus);root.bindTestBus(svg,bus);return svg;},
    pointer(type,underPointer,detail={}){
      const id=detail.pointerId??1,recipient=captures.get(id)||underPointer;
      const result=recipient.dispatch(type,{pointerId:id,pointerType:'mouse',...detail});
      if(type==='pointerup'||type==='pointercancel')recipient.releasePointerCapture(id);
      return result;
    },
    inspectLink:(receiver,source)=>root.testInspectPredictionLink(receiver,source),inspection:()=>plain(root.testInspection()),protocol:()=>plain(root.testProtocol()),forecastSettings:()=>plain(root.testForecastSettings()),forecastObservation:()=>plain(root.testForecastObservation()),sourceHistory:()=>plain(root.testSourceHistory()),errorWindow:(...args)=>plain(root.testErrorWindow(...args)),commandInspection:()=>plain(root.testInspectedCommand()),decompose:(...args)=>plain(root.testDecompose(...args)),issuedForecasts:()=>plain(root.testIssuedForecasts()),
    linkEvidence:()=>plain(root.powerDemo.getLinkEvidence()),snapshot:()=>root.powerDemo.getSnapshot(),state:()=>plain(root.powerDemo.getState()),
    saved:()=>savedStates.at(-1),
    event:(id,type,detail)=>node(id).dispatch(type,detail),
    click:(id,detail=0)=>node(id).dispatch('click',{detail}),
    change:(id,value)=>{node(id).value=String(value);return node(id).dispatch('change');},
    check:(id,checked)=>{node(id).checked=checked;return node(id).dispatch('change');},
    quickClick(){node('pulse').dispatch('pointerdown');node('pulse').dispatch('pointerup');node('pulse').dispatch('click',{detail:1});},
    key:(type,key,detail={})=>document.dispatch(type,{key,...detail})
  };
}
const pulses=h=>h.snapshot().eventLog.filter(event=>event.type==='pulse');

test('Space preserves native summary link and command scroller behavior including descendants',()=>{
  for(const selector of ['summary','a[href]','[data-command-scroll]'])for(const descendant of [false,true])for(const playing of [false,true]){
    const h=harness();if(playing)h.click('run');
    const initialTime=h.snapshot().t;
    const control=target(selector==='summary'?'SUMMARY':selector==='a[href]'?'A':'DIV');
    const origin=descendant?target('SPAN'):control;
    origin.closest=selectors=>selectors.split(',').some(value=>value.trim()===selector)?control:null;
    let prevented=false;
    h.key('keydown',' ',{target:origin,preventDefault(){prevented=true;this.defaultPrevented=true;}});
    const context=selector+(descendant?' descendant':'')+(playing?' during playback':' while paused');
    assert.equal(prevented,false,context+' must retain its native Space behavior');
    assert.equal(h.state().playing,playing,context+' must not toggle playback');
    assert.equal(h.snapshot().t,initialTime,context+' must not advance the simulation');
  }
});

test('Space on the page background starts and pauses ordinary playback',async()=>{
  const h=harness(),background=target('DIV');
  let prevented=0;
  const press=()=>h.key('keydown',' ',{target:background,preventDefault(){prevented++;this.defaultPrevented=true;}});
  press();assert.equal(h.state().playing,true);assert.equal(prevented,1);
  const initialTime=h.snapshot().t;
  await h.samples(2);assert.equal(h.snapshot().t,initialTime+2);
  press();assert.equal(h.state().playing,false);assert.equal(prevented,2);
  await h.samples(2);assert.equal(h.snapshot().t,initialTime+2,'Paused playback must stop sampling');
});

test('pointer activation queues once and a paused attack starts playback without advancing time',async()=>{
  const h=harness();h.change('attack-mode','pulse');h.event('pulse','pointerdown');h.event('pulse','pointerup');h.click('pulse',1);
  assert.equal(pulses(h).length,1);assert.equal(h.snapshot().pendingPulses.length,1);
  assert.equal(h.snapshot().t,0);assert.equal(h.state().playing,true);
  await h.samples(1);assert.equal(h.snapshot().t,1);assert.equal(pulses(h).length,1);
  assert.equal(h.snapshot().activePulses.length,1);
});

test('holding Attack adds one pulse per physical sample and release preserves playback',async()=>{
  const h=harness();h.change('attack-mode','pulse');h.event('pulse','pointerdown');await h.samples(3);
  assert.equal(h.snapshot().t,3);assert.deepEqual(pulses(h).map(event=>event.t),[0,1,2]);
  assert.equal(h.node('pulse').dataset.holding,'true');
  h.event('pulse','pointerup');h.click('pulse',1);await h.samples(2);
  assert.equal(h.snapshot().t,5);assert.equal(pulses(h).length,3);assert.equal(h.state().playing,true);
  assert.equal(h.node('pulse').dataset.holding,'false');assert.ok(h.snapshot().activePulses.length>0);
});

test('D hold ignores keyboard repeats and keyup stops only new attacks',async()=>{
  const h=harness();h.change('attack-mode','pulse');h.key('keydown','d');h.key('keydown','d',{repeat:true});
  await h.samples(4);assert.deepEqual(pulses(h).map(event=>event.t),[0,1,2,3]);
  h.key('keyup','D');await h.samples(2);
  assert.equal(pulses(h).length,4);assert.equal(h.snapshot().t,6);assert.equal(h.state().playing,true);
});

test('quick clicks preserve every pending and active pulse and do not reset time',async()=>{
  const h=harness();h.change('attack-mode','pulse');for(let i=0;i<5;i++)h.quickClick();
  assert.equal(pulses(h).length,5);assert.equal(h.snapshot().pendingPulses.length,5);assert.equal(h.snapshot().t,0);
  await h.samples(1);assert.equal(h.snapshot().activePulses.length,5);
  h.quickClick();h.quickClick();assert.equal(h.snapshot().activePulses.length,5);assert.equal(h.snapshot().pendingPulses.length,2);
  await h.samples(1);assert.equal(h.snapshot().t,2);assert.equal(h.snapshot().activePulses.length,7);
  assert.deepEqual(pulses(h).map(event=>event.t),[0,0,0,0,0,1,1]);
});

test('pointer cancellation and window blur release attacks without pausing playback',async()=>{
  for(const kind of ['pointercancel','lostpointercapture','blur']){
    const h=harness();h.change('attack-mode','pulse');h.event('pulse','pointerdown');await h.samples(1);
    if(kind==='blur')h.window.dispatch(kind);else h.event('pulse',kind);
    await h.samples(2);assert.equal(pulses(h).length,1,kind);assert.equal(h.snapshot().t,3,kind);assert.equal(h.state().playing,true,kind);
  }
});

test('hidden document pauses playback and clears the hold',async()=>{
  const h=harness();h.change('attack-mode','pulse');h.key('keydown','d');await h.samples(1);
  h.document.hidden=true;h.document.dispatch('visibilitychange');await h.samples(4);
  assert.equal(h.snapshot().t,1);assert.equal(h.state().playing,false);assert.equal(h.node('pulse').dataset.holding,'false');
});

test('late timers do not burst through missed physical samples',async()=>{
  const h=harness();h.change('attack-mode','pulse');h.quickClick();h.clock.now=10000;await h.clock.runNext();
  assert.equal(h.snapshot().t,1);const recoveryDelay=1000/Number(h.node('speed').value)*.15;
  assert.ok(h.clock.next()[1].at>=10000+recoveryDelay);
  await h.clock.advance(recoveryDelay-.01);assert.equal(h.snapshot().t,1);
  await h.clock.advance(.01);assert.equal(h.snapshot().t,2);
});

test('attacks interleave safely with comparison batches and continue after the batch',async()=>{
  const h=harness();h.check('auto-compare',false);h.change('attack-mode','pulse');const comparison=h.click('compare');assert.equal(h.node('run').disabled,true);
  h.event('pulse','pointerdown');await h.clock.runNext();
  assert.equal(h.snapshot().t,12);assert.equal(pulses(h).length,12);
  h.event('pulse','pointerup');h.click('pulse',1);await h.clock.runNext();
  assert.equal(h.snapshot().t,24);assert.equal(pulses(h).length,12);
  h.event('pulse','pointerdown');await h.clock.until(()=>!h.node('compare').disabled);await comparison;
  assert.equal(h.snapshot().t,180);assert.equal(pulses(h).length,168);assert.equal(h.state().playing,true);
  assert.equal(new Set(pulses(h).map(event=>event.t)).size,168);
  await h.samples(1);assert.equal(h.snapshot().t,181);assert.equal(pulses(h).length,169);
  h.event('pulse','pointerup');await h.samples(1);assert.equal(h.snapshot().t,182);assert.equal(pulses(h).length,169);
});

test('matrix reference survives pulses, forecast changes and exact saved replay',async()=>{
  const h=harness();h.change('attack-mode','pulse');h.quickClick();const initialReference=h.saved().privateContent.matrixReference;
  await h.samples(35);h.click('run');
  const reference=h.saved().privateContent.matrixReference;assert.equal(reference.t,0);
  assert.deepEqual(reference,initialReference);h.quickClick();h.click('fault');
  assert.deepEqual(h.saved().privateContent.matrixReference,reference);
  await h.samples(3);h.click('run');
  const restored=harness(h.saved());
  assert.deepEqual(restored.snapshot().cumulative,h.snapshot().cumulative);
  assert.deepEqual(restored.snapshot().states,h.snapshot().states);
  assert.deepEqual(restored.snapshot().eventLog,h.snapshot().eventLog);
  assert.equal(restored.state().playing,false);
  restored.click('fault');assert.deepEqual(restored.saved().privateContent.matrixReference,reference);
});

test('deployment replay is exact and Rebuild prediction links starts a fresh discovery trial',async()=>{
  const h=harness();h.check('auto-compare',false);h.change('attack-mode','pulse');const comparison=h.click('compare');await h.clock.until(()=>!h.node('compare').disabled);await comparison;
  assert.equal(h.snapshot().canDeploy,true);h.click('deploy');assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().t,0);
  assert.equal(h.node('deploy').textContent,'Rebuild prediction links');assert.equal(h.node('deploy').disabled,false);
  h.key('keydown','d');await h.samples(3);h.key('keyup','d');h.click('run');
  const restored=harness(h.saved());assert.equal(restored.snapshot().phase,'deployment');
  assert.deepEqual(restored.snapshot().deployedSupport,h.snapshot().deployedSupport);
  assert.deepEqual(restored.snapshot().cumulative,h.snapshot().cumulative);
  h.click('deploy');assert.equal(h.snapshot().phase,'discovery');assert.equal(h.snapshot().t,0);
  assert.equal(h.snapshot().deployedSupport,null);assert.equal(h.snapshot().eventLog.length,0);assert.equal(h.state().playing,false);
  assert.equal(h.node('matrix-view').value,'links');assert.equal(h.snapshot().preset,'mixed');
});

test('fixed slack rejects pointer and keyboard attacks',()=>{
  const h=harness();h.change('attack-mode','pulse');h.change('bus',1);h.event('pulse','pointerdown');h.click('pulse',0);h.key('keydown','d');
  assert.equal(pulses(h).length,0);assert.equal(h.state().playing,false);assert.equal(h.node('pulse').disabled,true);
});

test('default playback advances sixteen physical samples per wall second',async()=>{
  const h=harness();h.change('attack-mode','pulse');assert.equal(h.node('speed').value,'16');
  h.quickClick();await h.clock.advance(1000);
  assert.equal(h.snapshot().t,16);assert.equal(pulses(h).length,1);
});

test('SVG bus press captures the pointer and holds that bus at the default speed',async()=>{
  const h=harness();h.change('attack-mode','pulse');const bus=h.bus(14);
  h.pointer('pointerdown',bus,{pointerId:41});
  assert.equal(bus.capturedPointer,41);assert.equal(bus.hasPointerCapture(41),true);
  assert.equal(bus.dataset.holding,'true');assert.equal(h.state().selectedBus,14);
  assert.equal(pulses(h).length,1);assert.equal(h.snapshot().t,0);
  await h.clock.advance(1000);
  assert.equal(h.snapshot().t,16);assert.deepEqual(pulses(h).map(event=>event.t),Array.from({length:16},(_,i)=>i));
  assert.ok(pulses(h).every(event=>event.bus===14));
  h.pointer('pointerup',bus,{pointerId:41});bus.dispatch('click',{detail:1});
  assert.equal(pulses(h).length,16);assert.equal(bus.dataset.holding,'false');
  await h.samples(2);assert.equal(h.snapshot().t,18);assert.equal(pulses(h).length,16);assert.equal(h.state().playing,true);
});

test('releasing outside a captured SVG bus ends the hold without stopping playback',async()=>{
  const h=harness();h.change('attack-mode','pulse');const bus=h.bus(8),outside=target();
  h.pointer('pointerdown',bus,{pointerId:17});await h.samples(3);
  h.pointer('pointermove',outside,{pointerId:17});
  h.pointer('pointerup',outside,{pointerId:17});
  assert.equal(bus.hasPointerCapture(17),false);assert.equal(bus.dataset.holding,'false');
  await h.samples(3);assert.equal(h.snapshot().t,6);assert.equal(pulses(h).length,3);assert.equal(h.state().playing,true);
});

test('touch cancellation on a captured SVG bus preserves previously applied attacks',async()=>{
  const h=harness();h.change('attack-mode','pulse');const bus=h.bus(12);
  h.pointer('pointerdown',bus,{pointerId:32,pointerType:'touch'});await h.samples(2);
  const attacks=h.snapshot().activePulses.length;
  h.pointer('pointercancel',target(),{pointerId:32,pointerType:'touch'});
  assert.equal(bus.dataset.holding,'false');assert.equal(bus.hasPointerCapture(32),false);
  assert.equal(h.snapshot().activePulses.length,attacks);
  await h.samples(2);assert.equal(pulses(h).length,2);assert.equal(h.snapshot().t,4);assert.equal(h.state().playing,true);
});

test('repeated SVG clicks add one pulse per gesture with no compatibility click duplication',()=>{
  const h=harness();h.change('attack-mode','pulse');const bus=h.bus(21);
  for(let i=0;i<4;i++){
    h.pointer('pointerdown',bus);h.pointer('pointerup',bus);bus.dispatch('click',{detail:i+1});
  }
  bus.dispatch('dblclick',{detail:2});
  assert.equal(pulses(h).length,4);assert.equal(h.snapshot().pendingPulses.length,4);
  assert.ok(pulses(h).every(event=>event.bus===21));assert.equal(h.snapshot().t,0);
});

test('Enter and Space hold an SVG bus and ignore repeated keyboard events',async()=>{
  for(const key of ['Enter',' ']){
    const h=harness();h.change('attack-mode','pulse');const bus=h.bus(18);
    bus.dispatch('keydown',{key});bus.dispatch('keydown',{key,repeat:true});await h.samples(4);
    assert.equal(pulses(h).length,4,key);assert.ok(pulses(h).every(event=>event.bus===18));
    bus.dispatch('keyup',{key});await h.samples(2);
    assert.equal(pulses(h).length,4,key);assert.equal(h.snapshot().t,6,key);assert.equal(bus.dataset.holding,'false');
  }
});

test('all playback modes preserve one held bus pulse per physical sample',async()=>{
  for(const rate of [2,4,8,16,32]){
    const h=harness();h.change('attack-mode','pulse');const bus=h.bus(5);h.change('speed',rate);h.pointer('pointerdown',bus);
    await h.clock.advance(1000);assert.equal(h.snapshot().t,rate);assert.equal(pulses(h).length,rate);
    assert.equal(new Set(pulses(h).map(event=>event.t)).size,rate);
    h.pointer('pointerup',bus);await h.clock.advance(1000);
    assert.equal(h.snapshot().t,2*rate);assert.equal(pulses(h).length,rate);assert.equal(h.state().playing,true);
  }
});

test('changing speed during a hold replaces the timer without losing or doubling attacks',async()=>{
  const h=harness();h.change('attack-mode','pulse');const bus=h.bus(7);h.pointer('pointerdown',bus);await h.samples(1);
  h.change('speed',32);assert.equal(h.clock.tasks.size,1);await h.clock.advance(1000);
  assert.equal(h.snapshot().t,33);assert.deepEqual(pulses(h).map(event=>event.t),Array.from({length:33},(_,i)=>i));
});

test('old algorithm saves start a clean paused trial instead of replaying incompatible controls',async()=>{
  const h=harness();h.change('attack-mode','pulse');h.quickClick();await h.samples(3);h.click('run');
  for(const version of [7,8,9,10,11,12,13]){
    const old=plain(h.saved());old.privateContent.version=version;
    const restored=harness(old);
    assert.equal(restored.snapshot().t,0);assert.equal(restored.snapshot().phase,'discovery');
    assert.ok(Object.values(restored.snapshot().cumulative).every(value=>value===0));
    assert.equal(restored.snapshot().eventLog.length,0);assert.equal(restored.state().playing,false);
    assert.equal(restored.node('attack-mode').value,'continuous');assert.equal(restored.node('view').value,'cost');
    restored.quickClick();assert.equal(restored.saved().privateContent.version,14);
  }
});

test('version fourteen replay retains speed, attack mode and matrix view',async()=>{
  const h=harness();h.change('attack-mode','pulse');h.change('speed',16);h.change('matrix-view','change');h.quickClick();await h.samples(3);h.click('run');
  assert.equal(h.saved().privateContent.version,14);
  const restored=harness(h.saved());assert.equal(restored.node('speed').value,'16');assert.equal(restored.node('matrix-view').value,'change');
  assert.equal(restored.node('attack-mode').value,'pulse');
  assert.deepEqual(restored.snapshot().cumulative,h.snapshot().cumulative);assert.deepEqual(restored.snapshot().eventLog,h.snapshot().eventLog);
});

// A seeded integration fixture. Topology observations must agree across stepping,
// batch advancement and saved replay under the current learning algorithm.
function topologyHarness(){
  return harness({privateContent:{version:14,algorithmId:ALGORITHM_ID,phase:'discovery',preset:'mixed',
    initialOptions:{seed:7,preset:'mixed'},t:0,events:[],selectedBus:7,
    automaticComparison:false,speed:'8',pulseStrength:'100',view:'cost',matrixView:'links'}});
}
async function compare(h){
  const completion=h.click('compare');await h.clock.until(()=>!h.node('compare').disabled);await completion;
}

test('Advance 180 retains every actual topology change observed by single stepping',async()=>{
  const fast=topologyHarness();await compare(fast);
  const timeline=fast.state().topology;
  assert.equal(fast.snapshot().t,180);assert.equal(timeline.lastT,180);
  assert.ok(timeline.events.length>0,'The fixture must contain actual learned connectivity changes');
  assert.deepEqual(timeline.current,timeline.events.at(-1).after);
  assert.equal(fast.node('topology-history').max,String(timeline.events.length));assert.equal(fast.node('topology-history').disabled,false);
  assert.equal(fast.node('history-count').textContent,timeline.events.length+' link updates');
  const single=topologyHarness();for(let i=0;i<180;i++)single.click('step');
  assert.deepEqual(single.state().topology,timeline);
  assert.deepEqual(single.snapshot().cumulative,fast.snapshot().cumulative);
});

test('version fourteen replay reconstructs topology events from every physical sample',async()=>{
  const h=topologyHarness();await compare(h);
  const bus=h.bus(14);h.pointer('pointerdown',bus);await h.samples(7);h.pointer('pointerup',bus);h.click('run');
  const restored=harness(h.saved());
  assert.equal(restored.saved(),undefined,'Restoration must not rewrite the saved trial');
  assert.deepEqual(restored.state().topology,h.state().topology);
  assert.deepEqual(restored.snapshot().eventLog,h.snapshot().eventLog);
  assert.deepEqual(restored.snapshot().cumulative,h.snapshot().cumulative);
  assert.equal(restored.state().historyIndex,null);
});

test('deployment preserves discovery history and primary restart clears the whole trial',async()=>{
  const h=topologyHarness();await compare(h);const discovery=h.state().topology;
  h.click('deploy');const frozen=h.state().topology;
  assert.deepEqual(frozen,{...discovery,phase:'deployment'});assert.equal(h.snapshot().t,0);
  await compare(h);assert.equal(h.snapshot().t,180);assert.deepEqual(h.state().topology,frozen);
  const restored=harness(h.saved());assert.deepEqual(restored.state().topology,frozen);
  assert.equal(restored.snapshot().phase,'deployment');
  h.node('topology-history').value='1';h.event('topology-history','input');
  h.click('restart');assert.equal(h.snapshot().t,0);assert.equal(h.snapshot().phase,'discovery');
  assert.equal(h.snapshot().deployedSupport,null);assert.equal(h.snapshot().discoveryRecord,null);
  assert.equal(h.state().historyIndex,null);
  assert.equal(h.state().topology.events.length,0);assert.equal(h.state().topology.lastT,0);
  assert.equal(h.state().topology.phase,'discovery');assert.equal(h.state().historyIndex,null);
});

test('Discovery reset discards old topology observations and starts from the new initial support',async()=>{
  const h=topologyHarness();await compare(h);assert.ok(h.state().topology.events.length>0);
  h.node('topology-history').value='2';h.event('topology-history','input');h.click('restart');
  const timeline=h.state().topology;
  assert.equal(h.snapshot().t,0);assert.equal(timeline.events.length,0);assert.equal(timeline.initialT,0);assert.equal(timeline.lastT,0);
  assert.deepEqual(timeline.initial,timeline.current);assert.equal(h.state().historyIndex,null);
  assert.equal(h.node('topology-history').disabled,true);assert.equal(h.node('history-count').textContent,'0 link updates');
});

test('history slider and Show latest change only the view, never the current engine state',async()=>{
  const h=topologyHarness();await compare(h);
  const before=h.snapshot(),timeline=h.state().topology;
  for(const index of [0,1,timeline.events.length]){
    h.node('topology-history').value=String(index);h.event('topology-history','input');
    assert.equal(h.state().historyIndex,index);assert.equal(h.node('history-live').textContent,'Show latest');
    assert.deepEqual(h.snapshot(),before);assert.deepEqual(h.state().topology,timeline);assert.equal(h.state().playing,false);
  }
  h.click('history-live');assert.equal(h.state().historyIndex,null);assert.equal(h.node('history-live').textContent,'Latest');
  assert.deepEqual(h.snapshot(),before);assert.deepEqual(h.state().topology,timeline);
  h.node('topology-history').value='1';h.event('topology-history','input');h.click('step');
  assert.equal(h.snapshot().t,181);assert.equal(h.state().historyIndex,1,'Reviewing history must not block live progression');
});

test('keyboard hold ends when its toolbar or bus loses focus, while unrelated blur leaves it active',async()=>{
  for(const kind of ['toolbar','bus'])for(const key of ['Enter',' ']){
    const h=harness();h.change('attack-mode','pulse');const owner=kind==='toolbar'?h.node('pulse'):h.bus(8);
    const other=kind==='toolbar'?h.bus(12):h.node('pulse');
    owner.dispatch('keydown',{key});await h.samples(2);
    other.dispatch('blur',{relatedTarget:owner});await h.samples(1);
    assert.equal(pulses(h).length,3,kind+' should ignore another target losing focus');
    assert.equal(owner.dataset.holding,'true');
    owner.dispatch('keydown',{key:'Tab'});owner.dispatch('blur',{relatedTarget:other});
    h.key('keyup',key,{target:other});await h.samples(2);
    assert.equal(owner.dataset.holding,'false',kind+' should release when focus moves');
    assert.equal(h.node('pulse').dataset.holding,'false');
    assert.equal(pulses(h).length,3,kind+' should not add attacks after blur');
    assert.equal(h.snapshot().t,5);assert.equal(h.state().playing,true);
  }
});

function pointerClick(h,element,pointerId=1){
  h.pointer('pointerdown',element,{pointerId});
  h.pointer('pointerup',element,{pointerId});
  element.dispatch('click',{detail:1});
}

test('Continuous is the default and a released bus click repeats one pulse per sample',async()=>{
  const h=harness(),bus=h.bus(14);
  assert.equal(h.node('attack-mode').value,'continuous');assert.equal(h.node('speed').value,'16');
  pointerClick(h,bus,51);
  assert.equal(bus.hasPointerCapture(51),false,'Native pointer release also delivers lostpointercapture');
  assert.equal(pulses(h).length,1,'Compatibility click must not toggle or duplicate activation');
  assert.equal(h.node('pulse-label').textContent,'Stop bus '+h.state().selectedBus);assert.equal(h.node('pulse')['aria-pressed'],'true');
  await h.clock.advance(1000);
  assert.equal(h.snapshot().t,16);assert.equal(pulses(h).length,16);
  assert.deepEqual(pulses(h).map(event=>event.t),Array.from({length:16},(_,i)=>i));
  assert.ok(pulses(h).every(event=>event.bus===14));
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+' kW target per bus · Maintained until stopped');
});

test('clicking the same bus stops a continuous attack without adding a final pulse',async()=>{
  const h=harness(),bus=h.bus(7);pointerClick(h,bus);await h.samples(4);
  const active=h.snapshot().activePulses.length;pointerClick(h,bus);
  assert.equal(h.node('pulse-label').textContent,'Attack bus 7');assert.equal(h.node('pulse')['aria-pressed'],'false');
  assert.equal(h.snapshot().activePulses.length,active);assert.equal(pulses(h).length,4);
  await h.samples(3);assert.equal(h.snapshot().t,7);assert.equal(pulses(h).length,4);assert.equal(h.state().playing,true);
});

test('the toolbar targets the selected bus without stopping a different active bus',async()=>{
  const h=harness(),bus=h.bus(8);pointerClick(h,bus);await h.samples(3);
  h.change('bus',1);assert.equal(h.node('pulse').disabled,true);assert.equal(h.node('pulse-label').textContent,'Fixed substation');
  pointerClick(h,h.node('pulse'),23);await h.samples(2);
  assert.equal(pulses(h).length,5);assert.deepEqual(h.state().activeAttackBuses,[8]);assert.equal(h.state().selectedBus,1);
  h.change('bus',14);pointerClick(h,h.node('pulse'));await h.samples(2);
  assert.deepEqual(h.state().activeAttackBuses,[8,14]);assert.equal(h.node('pulse-label').textContent,'Stop bus 14');
  pointerClick(h,h.node('pulse'));await h.samples(2);
  assert.deepEqual(h.state().activeAttackBuses,[8]);
  assert.equal(pulses(h).filter(event=>event.bus===8).length,9);
  assert.equal(pulses(h).filter(event=>event.bus===14).length,2);
});

test('three continuous bus attacks repeat independently and stopping one preserves the others',async()=>{
  const h=harness(),buses=[20,22,23];
  for(const bus of buses)pointerClick(h,h.bus(bus),bus);
  assert.deepEqual(h.state().activeAttackBuses,buses);
  await h.samples(4);
  assert.equal(h.state().selectedBus,23,'Repeated requests must not change the selected bus');
  for(const bus of buses)assert.deepEqual(pulses(h).filter(event=>event.bus===bus).map(event=>event.t),[0,1,2,3]);
  const tails=plain(h.snapshot().activePulses);
  pointerClick(h,h.bus(22),22);
  assert.deepEqual(h.snapshot().activePulses,tails,'Stopping repetition must not erase its existing physical tail');
  assert.deepEqual(h.state().activeAttackBuses,[20,23]);
  await h.samples(3);
  assert.equal(pulses(h).filter(event=>event.bus===22).length,4);
  for(const bus of [20,23])assert.deepEqual(pulses(h).filter(event=>event.bus===bus).map(event=>event.t),[0,1,2,3,4,5,6]);
  assert.equal(h.state().selectedBus,22);assert.equal(h.node('pulse-label').textContent,'Attack bus 22');
});

test('Stop all reports the active bus count and stops requests while preserving physical tails',async()=>{
  const h=harness();assert.equal(h.node('stop-attacks').hidden,true);
  for(const bus of [20,22,23])pointerClick(h,h.bus(bus),bus);
  assert.equal(h.node('stop-attacks').hidden,false);assert.equal(h.node('attack-count').textContent,'3');
  assert.equal(h.node('stop-attacks')['aria-label'],'Stop all 3 active buses');
  await h.samples(4);const tails=plain(h.snapshot().activePulses),count=pulses(h).length;
  h.change('bus',1);h.click('stop-attacks');
  assert.deepEqual(h.state().activeAttackBuses,[]);assert.equal(h.node('stop-attacks').hidden,true);
  assert.equal(h.node('attack-count').textContent,'0');assert.deepEqual(h.snapshot().activePulses,tails);
  assert.equal(h.state().selectedBus,1);assert.equal(h.state().playing,true);
  await h.samples(3);assert.equal(pulses(h).length,count);
  for(const bus of [20,22,23])pointerClick(h,h.bus(bus),bus);
  h.document.hidden=true;h.document.dispatch('visibilitychange');
  assert.deepEqual(h.state().activeAttackBuses,[]);assert.equal(h.state().playing,false);
  h.click('restart');assert.deepEqual(h.state().activeAttackBuses,[]);assert.equal(h.snapshot().activePulses.length,0);
});

test('touch cancellation stops a continuous attack while normal release keeps it active',async()=>{
  const h=harness(),bus=h.bus(12);
  h.pointer('pointerdown',bus,{pointerId:8,pointerType:'touch'});await h.samples(2);
  h.pointer('pointercancel',target(),{pointerId:8,pointerType:'touch'});await h.samples(2);
  assert.equal(pulses(h).length,2);assert.equal(h.node('pulse')['aria-pressed'],'false');assert.equal(h.state().playing,true);
  h.pointer('pointerdown',bus,{pointerId:9,pointerType:'touch'});
  h.pointer('pointerup',target(),{pointerId:9,pointerType:'touch'});bus.dispatch('click',{detail:1});
  await h.samples(3);assert.equal(pulses(h).length,5);assert.equal(h.node('pulse')['aria-pressed'],'true');
});

test('losing capture before pointer release cancels continuous attacks',async()=>{
  const h=harness(),bus=h.bus(21);h.pointer('pointerdown',bus,{pointerId:17});await h.samples(2);
  bus.releasePointerCapture(17);await h.samples(2);
  assert.equal(pulses(h).length,2);assert.equal(h.node('pulse')['aria-pressed'],'false');assert.equal(h.state().playing,true);
});

test('Enter and Space toggle continuous bus and toolbar attacks and ignore keyup and repeats',async()=>{
  for(const kind of ['bus','toolbar'])for(const key of ['Enter',' ']){
    const h=harness(),owner=kind==='bus'?h.bus(18):h.node('pulse');
    owner.dispatch('keydown',{key});owner.dispatch('keydown',{key,repeat:true});owner.dispatch('keyup',{key});
    await h.samples(3);assert.equal(pulses(h).length,3,kind+' '+key);assert.equal(h.node('pulse')['aria-pressed'],'true');
    owner.dispatch('keydown',{key});owner.dispatch('keyup',{key});await h.samples(2);
    assert.equal(pulses(h).length,3,kind+' should stop on the second activation');assert.equal(h.state().playing,true);
  }
});

test('continuous attacks survive ordinary focus changes but stop on window blur',async()=>{
  const h=harness(),bus=h.bus(18);pointerClick(h,bus);await h.samples(2);
  bus.dispatch('blur',{relatedTarget:h.node('speed')});await h.samples(2);
  assert.equal(pulses(h).length,4);assert.equal(h.node('pulse')['aria-pressed'],'true');
  h.window.dispatch('blur');
  assert.equal(h.node('pulse').dataset.attackState,'fading','Window blur must repaint the released attack before another physical sample');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+(h.node('attack-mode').value==='continuous'&&h.node('pulse').dataset.attackState!=='held'?' kW target per bus · ':' kW per pulse · ')+'Disturbance fading');
  assert.equal(h.node('pulse')['aria-pressed'],'false');
  await h.samples(2);
  assert.equal(pulses(h).length,4);assert.equal(h.node('pulse')['aria-pressed'],'false');assert.equal(h.state().playing,true);
});

test('assistive clicks toggle continuous attacks exactly once per activation',async()=>{
  for(const kind of ['bus','toolbar']){
    const h=harness(),owner=kind==='bus'?h.bus(5):h.node('pulse');
    owner.dispatch('click',{detail:0});await h.samples(3);
    assert.equal(pulses(h).length,3);owner.dispatch('click',{detail:0});await h.samples(2);
    assert.equal(pulses(h).length,3);assert.equal(h.node('pulse')['aria-pressed'],'false');
  }
});

test('Pause ends a continuous attack and Run resumes only the plant',async()=>{
  const h=harness(),bus=h.bus(14);pointerClick(h,bus);await h.samples(4);h.click('run');
  await h.samples(3);assert.equal(h.snapshot().t,4);assert.equal(h.state().playing,false);assert.equal(h.node('pulse')['aria-pressed'],'false');
  h.click('run');await h.samples(2);assert.equal(h.snapshot().t,7);assert.equal(pulses(h).length,4);assert.equal(h.state().playing,true);
});

test('reloading an active continuous trial restores physical history but never restarts the attack',async()=>{
  const h=harness(),bus=h.bus(14);pointerClick(h,bus);await h.samples(4);
  h.change('speed',32);const saved=h.saved();assert.equal(saved.privateContent.version,14);assert.equal(saved.privateContent.attackMode,'continuous');
  const restored=harness(saved);assert.equal(restored.node('attack-mode').value,'continuous');assert.equal(restored.node('speed').value,'32');
  assert.equal(restored.state().playing,false);assert.equal(restored.node('pulse')['aria-pressed'],'false');
  assert.deepEqual(restored.snapshot().cumulative,h.snapshot().cumulative);assert.deepEqual(restored.snapshot().eventLog,h.snapshot().eventLog);
  await restored.samples(2);assert.equal(restored.snapshot().t,4);
  restored.click('run');await restored.samples(2);assert.equal(restored.snapshot().t,7);assert.equal(pulses(restored).length,4);
});

test('D remains an explicit hold shortcut in either attack mode',async()=>{
  for(const mode of ['continuous','pulse']){
    const h=harness();h.change('attack-mode',mode);h.key('keydown','d');h.key('keydown','d',{repeat:true});
    await h.samples(3);assert.equal(pulses(h).length,3);h.key('keyup','d');await h.samples(2);
    assert.equal(pulses(h).length,3);assert.equal(h.snapshot().t,5);assert.equal(h.node('pulse')['aria-pressed'],'false');
  }
});

test('changing attack mode stops repetition without deleting pending or applied disturbances',async()=>{
  const h=harness(),bus=h.bus(7);pointerClick(h,bus);await h.samples(3);
  h.change('attack-mode','pulse');await h.samples(2);assert.equal(pulses(h).length,3);assert.equal(h.state().playing,true);
  h.pointer('pointerdown',bus);await h.samples(2);h.change('attack-mode','continuous');h.pointer('pointerup',bus);bus.dispatch('click',{detail:1});
  await h.samples(2);assert.equal(pulses(h).length,5);assert.equal(h.node('pulse')['aria-pressed'],'false');
  assert.ok(h.snapshot().activePulses.length>0);
});

test('attack feedback separates continuous requests from fading and paused physical disturbances',async()=>{
  const h=harness(),bus=h.bus(7);
  assert.equal(h.node('pulse').dataset.attackState,'idle');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+(h.node('attack-mode').value==='continuous'&&h.node('pulse').dataset.attackState!=='held'?' kW target per bus · ':' kW per pulse · ')+'Click to start or stop');
  pointerClick(h,bus);
  assert.equal(h.snapshot().pendingPulses.length,1);
  assert.equal(h.node('pulse').dataset.attackState,'continuous','Active repetition takes precedence over its queued request');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+' kW target per bus · Maintained until stopped');
  await h.samples(4);
  const tails=plain(h.snapshot().activePulses);
  pointerClick(h,bus);
  assert.deepEqual(h.snapshot().activePulses,tails,'Stopping new requests must preserve the applied disturbance');
  assert.equal(h.node('pulse').dataset.attackState,'fading');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+(h.node('attack-mode').value==='continuous'&&h.node('pulse').dataset.attackState!=='held'?' kW target per bus · ':' kW per pulse · ')+'Disturbance fading');
  h.click('run');
  assert.equal(h.node('pulse').dataset.attackState,'paused');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+(h.node('attack-mode').value==='continuous'&&h.node('pulse').dataset.attackState!=='held'?' kW target per bus · ':' kW per pulse · ')+'Paused · Disturbance remains');
  await h.samples(3);
  assert.deepEqual(h.snapshot().activePulses,tails,'Pause holds the physical disturbance at its current age');
  h.click('run');
  assert.equal(h.node('pulse').dataset.attackState,'fading');
  assert.equal(pulses(h).length,4,'Resume must not reactivate repetition');
  const remaining=Math.max(...h.snapshot().activePulses.map(event=>event.steps-event.age));
  await h.samples(remaining-1);
  assert.equal(h.node('pulse').dataset.attackState,'fading');
  assert.ok(h.snapshot().activePulses.length>0);
  await h.samples(1);
  assert.equal(h.snapshot().activePulses.length,0);
  assert.ok(h.snapshot().lastPulseApplications.some(item=>item.bus===7&&item.appliedKw>0));
  assert.equal(h.node('pulse').dataset.attackState,'fading','The last applied power is still the current physical sample');
  await h.samples(1);
  assert.equal(h.snapshot().lastPulseApplications.length,0);
  assert.equal(h.node('pulse').dataset.attackState,'idle');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+(h.node('attack-mode').value==='continuous'&&h.node('pulse').dataset.attackState!=='held'?' kW target per bus · ':' kW per pulse · ')+'Click to start or stop');
});

test('pulse feedback distinguishes a held gesture from pending requests and fading tails',async()=>{
  const h=harness();h.change('attack-mode','pulse');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+' kW per pulse · Click or hold');
  h.event('pulse','pointerdown');
  assert.equal(h.node('pulse').dataset.attackState,'held');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+' kW per pulse · Release to stop');
  assert.equal(h.snapshot().pendingPulses.length,1);
  h.event('pulse','pointerup');h.click('pulse',1);
  assert.equal(h.node('pulse').dataset.attackState,'pending');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+(h.node('attack-mode').value==='continuous'&&h.node('pulse').dataset.attackState!=='held'?' kW target per bus · ':' kW per pulse · ')+'Queued for next sample');
  await h.samples(1);
  assert.equal(h.node('pulse').dataset.attackState,'fading');
  h.quickClick();
  assert.equal(h.snapshot().activePulses.length,1);assert.equal(h.snapshot().pendingPulses.length,1);
  assert.equal(h.node('pulse').dataset.attackState,'pending','A fresh pending request takes precedence over an older fading tail');
  h.key('keydown','d');
  assert.equal(h.node('pulse').dataset.attackState,'held','An explicit keyboard hold takes precedence over pending requests');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+' kW per pulse · Release to stop');
  h.key('keyup','d');
  assert.equal(h.node('pulse').dataset.attackState,'pending');
  await h.samples(1);
  assert.equal(h.node('pulse').dataset.attackState,'fading');
  assert.equal(h.snapshot().activePulses.length,3);
});

test('attack feedback belongs to the selected bus while other continuous attacks keep running',async()=>{
  const h=harness();pointerClick(h,h.bus(7));await h.samples(2);
  h.change('bus',14);
  assert.equal(h.node('pulse').dataset.attackState,'idle');
  assert.equal(h.node('pulse-label').textContent,'Attack bus 14');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+(h.node('attack-mode').value==='continuous'&&h.node('pulse').dataset.attackState!=='held'?' kW target per bus · ':' kW per pulse · ')+'Click to start or stop');
  pointerClick(h,h.node('pulse'));
  assert.deepEqual(h.state().activeAttackBuses,[7,14]);assert.equal(h.node('pulse').dataset.attackState,'continuous');
  assert.equal(h.state().selectedBus,14);assert.ok(h.snapshot().activePulses.every(event=>event.bus===7));
  h.change('bus',7);
  assert.equal(h.node('pulse').dataset.attackState,'continuous');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+' kW target per bus · Maintained until stopped');
});

test('switching attack mode updates feedback while retaining queued and applied disturbances',async()=>{
  const h=harness();pointerClick(h,h.bus(7));
  h.change('attack-mode','pulse');
  assert.equal(h.snapshot().pendingPulses.length,1);
  assert.equal(h.node('pulse').dataset.attackState,'pending');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+(h.node('attack-mode').value==='continuous'&&h.node('pulse').dataset.attackState!=='held'?' kW target per bus · ':' kW per pulse · ')+'Queued for next sample');
  await h.samples(2);
  h.key('keydown','d');await h.samples(1);
  const tails=plain(h.snapshot().activePulses);
  h.change('attack-mode','continuous');
  assert.deepEqual(h.snapshot().activePulses,tails);
  assert.equal(h.node('pulse').dataset.attackState,'fading');
  assert.equal(h.node('attack-hint').textContent,h.node('strength').value+(h.node('attack-mode').value==='continuous'&&h.node('pulse').dataset.attackState!=='held'?' kW target per bus · ':' kW per pulse · ')+'Disturbance fading');
  assert.equal(h.node('pulse')['aria-pressed'],'false');
});

test('legacy fixed data controls remain hidden and cannot pause the actual plant',async()=>{
  const h=harness();h.check('auto-compare',false);h.click('run');await h.samples(40);
  pointerClick(h,h.bus(7));await h.samples(2);pointerClick(h,h.bus(7));
  const physicalTime=h.snapshot().t;
  assert.equal(h.node('freeze').hidden,true);assert.equal(h.node('freeze').disabled,true);
  h.click('freeze');assert.equal(h.snapshot().mode,'running');assert.equal(h.state().playing,true);
  await h.samples(1);assert.equal(h.snapshot().t,physicalTime+1);
  assert.equal(h.node('pulse').dataset.attackState,'fading');
});

test('discovery exposes four executing controllers and cannot hide the last curve',async()=>{
  const h=harness();h.check('auto-compare',false);
  const all=['online','scalar','static','causal'];
  assert.deepEqual(h.comparison(),{active:all,plotted:all,sameSparseSupport:false});
  for(const key of all)assert.equal(h.seriesButton(key).hidden,false);
  assert.equal(h.node('cost-metric').hidden,true);assert.equal(h.node('cost-metric').value,'total');
  for(const key of ['online','scalar','static'])h.seriesButton(key).dispatch('click');
  assert.deepEqual(h.comparison().plotted,['causal']);
  h.seriesButton('causal').dispatch('click');assert.deepEqual(h.comparison().plotted,['causal']);
  assert.equal(h.seriesButton('causal')['aria-pressed'],'true');
  await compare(h);
  assert.deepEqual(h.comparison().active,all);assert.equal(h.node('deploy').disabled,false);
  assert.notEqual(h.snapshot().cumulative.online,h.snapshot().cumulative.static,'Matrix learning must affect executed discovery costs');
  assert.notEqual(h.snapshot().cumulative.scalar,h.snapshot().cumulative.static,'Scalar learning must affect executed discovery costs');
});

test('Compare controllers clears discovery attacks and schedules a fresh visible four controller trial',async()=>{
  const h=harness(),bus=h.bus(7);h.check('auto-compare',false);pointerClick(h,bus);await h.samples(40);
  assert.equal(h.snapshot().canDeploy,true);assert.equal(pulses(h).length,40);
  const discoveryOptions=plain(h.snapshot().initialOptions);
  for(const key of ['online','scalar','static'])h.seriesButton(key).dispatch('click');
  assert.deepEqual(h.comparison().plotted,['causal']);
  h.click('deploy');
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().t,0);assert.equal(h.state().playing,true);
  assert.equal(h.clock.tasks.size,1,'Exactly one playback timer must be scheduled');
  assert.ok(Object.values(h.snapshot().cumulative).every(value=>value===0));
  assert.equal(h.snapshot().eventLog.length,0);assert.equal(h.snapshot().pendingPulses.length,0);
  assert.equal(h.snapshot().activePulses.length,0);assert.equal(h.state().journal.length,0);
  assert.equal(h.node('pulse')['aria-pressed'],'false');assert.equal(h.node('cost-metric').hidden,true);
  assert.notEqual(h.snapshot().initialOptions.seed,discoveryOptions.seed,'Deployment uses an independent disturbance seed');
  assert.deepEqual(h.comparison().active,['online','scalar','static','causal']);
  assert.deepEqual(h.comparison().plotted,h.comparison().active);
  for(const key of h.comparison().active){assert.equal(h.seriesButton(key).hidden,false);assert.equal(h.seriesButton(key)['aria-pressed'],'true');}
  await h.samples(1);assert.equal(h.snapshot().t,1);assert.equal(pulses(h).length,0);
  assert.ok(Object.values(h.snapshot().cumulative).some(value=>value>0));
  await h.samples(3);assert.equal(pulses(h).length,0,'Continuous discovery attacks must not leak into the comparison');
  for(const key of ['online','scalar','static'])h.seriesButton(key).dispatch('click');
  assert.deepEqual(h.comparison().plotted,['causal']);
  h.seriesButton('causal').dispatch('click');assert.deepEqual(h.comparison().plotted,['causal']);
});

test('Rebuild prediction links cancels comparison playback and attacks and restores the discovery cost view',async()=>{
  const h=harness();h.check('auto-compare',false);await compare(h);h.click('deploy');h.click('cost-gap');
  pointerClick(h,h.bus(14));await h.samples(3);assert.ok(pulses(h).length>0);
  h.click('deploy');
  assert.equal(h.snapshot().phase,'discovery');assert.equal(h.snapshot().t,0);assert.equal(h.state().playing,false);
  assert.equal(h.clock.tasks.size,0);assert.equal(h.node('pulse')['aria-pressed'],'false');
  assert.equal(h.snapshot().eventLog.length,0);assert.equal(h.snapshot().activePulses.length,0);
  assert.deepEqual(h.comparison().active,['online','scalar','static','causal']);assert.deepEqual(h.comparison().plotted,['online','scalar','static','causal']);
  assert.equal(h.node('cost-metric').hidden,true);assert.equal(h.node('cost-metric').value,'total');
  assert.equal(h.node('deploy').textContent,'Compare now');assert.equal(h.node('deploy').disabled,true);
  await h.samples(3);assert.equal(h.snapshot().t,0);
});

test('comparison gap measure survives saved replay without resuming playback or changing costs',async()=>{
  const h=harness();h.check('auto-compare',false);await compare(h);h.click('deploy');await h.samples(5);h.click('cost-gap');
  const saved=h.saved();assert.equal(saved.privateContent.version,14);assert.equal(saved.privateContent.costMetric,'gap');
  const restored=harness(saved);
  assert.equal(restored.snapshot().phase,'deployment');assert.equal(restored.node('cost-metric').value,'gap');
  assert.equal(restored.node('cost-metric').hidden,true);assert.equal(restored.state().playing,false);
  assert.equal(restored.node('cost-gap')['aria-pressed'],'true');assert.equal(restored.node('cost-total')['aria-pressed'],'false');
  assert.equal(restored.clock.tasks.size,0);assert.deepEqual(restored.snapshot().cumulative,h.snapshot().cumulative);
  assert.deepEqual(restored.snapshot().deployedSupport,h.snapshot().deployedSupport);
  assert.deepEqual(restored.comparison().active,['online','scalar','static','causal']);
  for(const value of [undefined,'invalid']){
    const legacy=plain(saved);if(value===undefined)delete legacy.privateContent.costMetric;else legacy.privateContent.costMetric=value;
    const old=harness(legacy);assert.equal(old.node('cost-metric').value,'total');assert.equal(old.state().playing,false);
    assert.equal(old.node('cost-total')['aria-pressed'],'true');assert.equal(old.node('cost-gap')['aria-pressed'],'false');
    assert.deepEqual(old.snapshot().cumulative,h.snapshot().cumulative);
  }
  const discovery=harness({privateContent:{version:14,algorithmId:ALGORITHM_ID,phase:'discovery',t:0,events:[],costMetric:'gap'}});
  assert.equal(discovery.node('cost-metric').value,'gap');assert.equal(discovery.node('cost-metric').hidden,true);
  assert.equal(discovery.node('cost-gap')['aria-pressed'],'true');assert.equal(discovery.node('cost-total')['aria-pressed'],'false');
});

test('comparison reports measured costs without treating support equality as controller equality',async()=>{
  const h=harness();h.check('auto-compare',false);await compare(h);h.click('deploy');
  const support=h.snapshot().deployedSupport;
  assert.equal(h.comparison().sameSparseSupport,JSON.stringify(support.learned)===JSON.stringify(support.fixed));
  await h.samples(40);
  assert.notEqual(h.snapshot().cumulative.online,h.snapshot().cumulative.scalar,'Deployed learned weights must influence real costs');
  assert.ok(!h.summary().includes('curves coincide'));
  assert.match(h.summary(),/Online SLS cost is|Online SLS and scalar costs/);
  if(h.comparison().sameSparseSupport)assert.match(h.summary(),/Same links · Weights adapt independently/);
  h.click('deploy');assert.equal(h.comparison().sameSparseSupport,false);
});

test('automatic comparison keeps the four controller cost view visible during learning',()=>{
  const h=harness();
  assert.equal(h.node('auto-compare').checked,true);
  assert.equal(h.node('deploy').hidden,true);assert.equal(h.node('view').hidden,false);
  assert.equal(h.node('cost-content').hidden,false);assert.equal(h.node('learning-content').hidden,true);
  assert.equal(h.node('learning-title').textContent,'Controller comparison');
  assert.equal(h.node('phase').textContent,'Learning 0 / 180 s');
  h.change('view','learning');assert.equal(h.node('cost-content').hidden,true);assert.equal(h.node('learning-content').hidden,false);
  assert.equal(h.node('learning-title').textContent,'Forecast learning');assert.equal(h.node('freeze').hidden,true);
  h.change('view','cost');h.check('auto-compare',false);
  assert.equal(h.node('deploy').hidden,false);assert.equal(h.node('cost-content').hidden,false);
  assert.equal(h.saved().privateContent.automaticComparison,false);
});

test('playback hands off exactly after 180 discovery samples and starts comparison costs at zero',async()=>{
  const h=harness();h.click('run');await h.samples(178);
  assert.equal(h.snapshot().phase,'discovery');assert.equal(h.snapshot().t,179);
  assert.ok(h.snapshot().cumulative.static>0);assert.equal(h.node('cost-content').hidden,false);
  const learningSeed=h.snapshot().initialOptions.seed;
  h.click('cost-gap');assert.equal(h.node('cost-gap')['aria-pressed'],'true');
  await h.samples(1);
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().t,0);
  assert.equal(h.node('cost-total')['aria-pressed'],'true');assert.equal(h.node('cost-gap')['aria-pressed'],'false');
  assert.equal(h.snapshot().discoveryRecord.t,180);
  assert.ok(Object.values(h.snapshot().cumulative).every(value=>value===0));
  assert.notEqual(h.snapshot().initialOptions.seed,learningSeed);
  assert.equal(h.snapshot().eventLog.length,0);assert.equal(h.state().journal.length,0);
  assert.equal(h.state().playing,true);assert.equal(h.clock.tasks.size,1);
  assert.deepEqual(h.comparison().active,['online','scalar','static','causal']);
  assert.equal(h.node('cost-content').hidden,false);assert.equal(h.node('learning-content').hidden,true);
  assert.equal(h.node('deploy').textContent,'Rebuild prediction links');assert.equal(h.node('deploy').hidden,false);
  assert.equal(h.saved().privateContent.phase,'deployment');assert.equal(h.saved().privateContent.t,0);
  await h.samples(2);assert.equal(h.snapshot().t,2);assert.ok(h.snapshot().cumulative.static>0);
});

test('held and continuous attacks survive the automatic handoff with one fresh pulse and no old tails',async()=>{
  for(const mode of ['pulse','continuous']){
    const h=harness(),bus=h.bus(7);h.change('attack-mode',mode);
    if(mode==='pulse')h.pointer('pointerdown',bus,{pointerId:61});else pointerClick(h,bus,61);
    await h.samples(179);assert.equal(h.snapshot().t,179);if(mode==='continuous')assert.equal(h.snapshot().activePulses.length,1);else assert.ok(h.snapshot().activePulses.length>1);
    await h.samples(1);
    assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().t,0);
    assert.equal(h.node('pulse')['aria-pressed'],'true');
    assert.equal(h.node('pulse').dataset.attackState,mode==='pulse'?'held':'continuous');
    assert.equal(h.node('attack-hint').textContent,h.node('strength').value+(h.node('attack-mode').value==='continuous'&&h.node('pulse').dataset.attackState!=='held'?' kW target per bus · ':' kW per pulse · ')+(mode==='pulse'?'Release to stop':'Maintained until stopped'));
    assert.equal(h.snapshot().activePulses.length,0,'The comparison plant must not inherit discovery pulse tails');
    assert.equal(h.snapshot().pendingPulses.length,1);assert.equal(pulses(h).length,1);
    assert.deepEqual(pulses(h).map(event=>[event.t,event.bus]),[[0,7]]);
    assert.deepEqual(h.state().journal,[{t:0,type:'pulse',bus:7,strength:100,...(mode==='continuous'?{protocol:'held-target-v1'}:{})}]);
    assert.ok(Object.values(h.snapshot().cumulative).every(value=>value===0));
    if(mode==='pulse'){
      assert.equal(bus.dataset.holding,'true');assert.equal(bus.hasPointerCapture(61),true);
    }else assert.equal(h.node('pulse-label').textContent,'Stop bus '+h.state().selectedBus);
    await h.samples(1);assert.equal(h.snapshot().t,1);assert.equal(pulses(h).length,1);
    await h.samples(1);assert.equal(h.snapshot().t,2);assert.deepEqual(pulses(h).map(event=>event.t),[0,1]);
    if(mode==='pulse')h.pointer('pointerup',bus,{pointerId:61});else pointerClick(h,bus,62);
    await h.samples(2);assert.equal(pulses(h).length,2);assert.equal(h.snapshot().t,4);
    assert.equal(h.state().playing,true);
    assert.equal(h.node('pulse').dataset.attackState,'fading');
  }
});

test('every simultaneous continuous attack crosses automatic comparison once per sample',async()=>{
  const h=harness(undefined,'communication');h.change('intervention','power');
  const buses=[20,22,23];for(const bus of buses)pointerClick(h,h.bus(bus),bus);
  await h.samples(180);
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().t,0);
  assert.deepEqual(h.state().activeAttackBuses,buses);
  assert.equal(h.snapshot().activePulses.length,0);
  assert.deepEqual(pulses(h).map(event=>[event.t,event.bus]),buses.map(bus=>[0,bus]));
  await h.samples(4);
  for(const bus of buses)assert.deepEqual(pulses(h).filter(event=>event.bus===bus).map(event=>event.t),[0,1,2,3]);
  assert.equal(h.clock.tasks.size,1);
  h.click('run');assert.deepEqual(h.state().activeAttackBuses,[]);
  const count=pulses(h).length;await h.samples(2);assert.equal(pulses(h).length,count);
  h.click('run');await h.samples(2);assert.equal(pulses(h).length,count,'Resume must not restart cleared attacks');
});

test('transient D hold is independent of other continuous attacks and cannot duplicate its own bus',async()=>{
  const h=harness();pointerClick(h,h.bus(20));pointerClick(h,h.bus(23));
  h.key('keydown','d');h.key('keydown','d',{repeat:true});h.key('keyup','d');
  await h.samples(3);
  for(const bus of [20,23])assert.equal(pulses(h).filter(event=>event.bus===bus).length,3);
  h.change('bus',22);h.key('keydown','d');await h.samples(2);h.key('keyup','d');await h.samples(2);
  assert.deepEqual(h.state().activeAttackBuses,[20,23]);
  assert.equal(pulses(h).filter(event=>event.bus===22).length,2);
  for(const bus of [20,23])assert.equal(pulses(h).filter(event=>event.bus===bus).length,7);
});

test('canceling one pointer leaves unrelated continuous attacks active',async()=>{
  const h=harness();pointerClick(h,h.bus(20));pointerClick(h,h.bus(23));
  const bus=h.bus(22);h.pointer('pointerdown',bus,{pointerId:22,pointerType:'touch'});await h.samples(2);
  h.pointer('pointercancel',bus,{pointerId:22,pointerType:'touch'});await h.samples(2);
  assert.deepEqual(h.state().activeAttackBuses,[20,23]);
  assert.equal(pulses(h).filter(event=>event.bus===22).length,2);
  for(const other of [20,23])assert.equal(pulses(h).filter(event=>event.bus===other).length,4);
  h.window.dispatch('blur');assert.deepEqual(h.state().activeAttackBuses,[]);
});

test('pausing after automatic handoff clears continuous attack intent and resume never reactivates it',async()=>{
  const h=harness();pointerClick(h,h.bus(14));await h.samples(180);
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().pendingPulses.length,1);
  h.click('run');assert.equal(h.state().playing,false);assert.equal(h.node('pulse')['aria-pressed'],'false');
  const events=pulses(h).length;
  h.click('run');await h.samples(3);
  assert.equal(h.snapshot().t,4);assert.equal(pulses(h).length,events);
});

test('Step can finish discovery and enter comparison while remaining paused',()=>{
  const h=harness();for(let sample=0;sample<179;sample++)h.click('step');
  assert.equal(h.snapshot().phase,'discovery');assert.equal(h.snapshot().t,179);
  h.click('step');
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().t,0);
  assert.equal(h.state().playing,false);assert.equal(h.clock.tasks.size,0);
  assert.equal(h.snapshot().pendingPulses.length,0);
  h.click('step');assert.equal(h.snapshot().t,1);assert.equal(h.state().playing,false);assert.equal(h.clock.tasks.size,0);
});

test('Advance 180 counts physical samples across the automatic boundary and remains paused',async()=>{
  const h=harness();for(let sample=0;sample<130;sample++)h.click('step');
  await compare(h);
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().discoveryRecord.t,180);
  assert.equal(h.snapshot().t,130,'50 discovery and 130 comparison samples must total exactly 180');
  assert.equal(h.state().playing,false);assert.equal(h.clock.tasks.size,0);
  assert.match(h.node('event').textContent,/Discovery complete.*t = 130 s/);
  await compare(h);assert.equal(h.snapshot().t,310);
  assert.match(h.node('event').textContent,/180 samples added.*t = 310 s/);
});

test('Advance 180 preserves an already continuous attack across handoff and resumes exactly one timer',async()=>{
  const h=harness(),bus=h.bus(7);pointerClick(h,bus);await h.samples(40);
  assert.equal(h.clock.tasks.size,1);assert.equal(pulses(h).length,40);
  await compare(h);
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().discoveryRecord.t,180);
  assert.equal(h.snapshot().t,40);assert.equal(pulses(h).length,40);
  assert.deepEqual(pulses(h).map(event=>event.t),Array.from({length:40},(_,i)=>i));
  assert.ok(pulses(h).every(event=>event.bus===7));
  assert.equal(h.node('pulse-label').textContent,'Stop bus '+h.state().selectedBus);
  assert.equal(h.state().playing,true);assert.equal(h.clock.tasks.size,1);
  await h.samples(1);assert.equal(h.snapshot().t,41);assert.equal(pulses(h).length,41);
  pointerClick(h,bus);await h.samples(2);
  assert.equal(h.snapshot().t,43);assert.equal(pulses(h).length,41);
  assert.equal(h.node('pulse')['aria-pressed'],'false');
  assert.equal(h.state().playing,true);assert.equal(h.clock.tasks.size,1);
});

test('Rebuild prediction links retains the automatic preference and returns to paused controller costs',async()=>{
  const h=harness();await compare(h);
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().t,0);
  pointerClick(h,h.bus(7));await h.samples(2);h.click('deploy');
  assert.equal(h.snapshot().phase,'discovery');assert.equal(h.snapshot().t,0);
  assert.equal(h.node('auto-compare').checked,true);assert.equal(h.node('deploy').hidden,true);
  assert.equal(h.node('cost-content').hidden,false);assert.equal(h.node('learning-content').hidden,true);
  assert.equal(h.state().playing,false);assert.equal(h.clock.tasks.size,0);
  assert.equal(h.node('pulse')['aria-pressed'],'false');assert.equal(h.snapshot().pendingPulses.length,0);
});

test('saved discovery replays past the automatic threshold exactly and transitions only on a new sample',async()=>{
  const h=harness();h.check('auto-compare',false);await compare(h);h.click('step');
  const legacy=plain(h.saved());delete legacy.privateContent.automaticComparison;
  const restored=harness(legacy);
  assert.equal(restored.node('auto-compare').checked,true);assert.equal(restored.snapshot().phase,'discovery');
  assert.equal(restored.snapshot().t,181);assert.deepEqual(restored.snapshot().cumulative,h.snapshot().cumulative);
  assert.deepEqual(restored.snapshot().eventLog,h.snapshot().eventLog);assert.equal(restored.state().playing,false);
  assert.equal(restored.saved(),undefined,'Restoration must not mutate or replace a historical trial');
  restored.click('step');assert.equal(restored.snapshot().phase,'deployment');assert.equal(restored.snapshot().t,1);
  assert.equal(restored.snapshot().discoveryRecord.t,181);assert.equal(restored.state().playing,false);
});

test('pending requests survive legacy discovery handoff without copying applied pulse tails',async()=>{
  const h=harness();h.check('auto-compare',false);await compare(h);h.change('attack-mode','pulse');
  h.quickClick();await h.samples(1);h.quickClick();h.click('run');
  assert.ok(h.snapshot().activePulses.length>0);assert.equal(h.snapshot().pendingPulses.length,1);
  const legacy=plain(h.saved());delete legacy.privateContent.automaticComparison;
  const restored=harness(legacy);assert.equal(restored.snapshot().pendingPulses.length,1);
  restored.click('run');
  assert.equal(restored.snapshot().phase,'deployment');assert.equal(restored.snapshot().t,1);
  assert.deepEqual(pulses(restored).map(event=>[event.t,event.bus]),[[0,7]]);
  assert.equal(restored.snapshot().activePulses.length,1);assert.equal(restored.snapshot().pendingPulses.length,0);
  await restored.samples(2);assert.equal(pulses(restored).length,1);
});

test('automatic handoff does not duplicate a same bus request queued at the legacy boundary',async()=>{
  const h=harness();h.check('auto-compare',false);await compare(h);
  h.check('auto-compare',true);pointerClick(h,h.bus(8));
  assert.equal(h.snapshot().phase,'discovery');assert.equal(h.snapshot().pendingPulses.length,1);
  await h.samples(1);
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().t,1);
  assert.equal(pulses(h).length,1);assert.equal(h.snapshot().activePulses.length,1);
  assert.deepEqual(h.state().journal,[{t:0,type:'pulse',bus:8,strength:100,protocol:'held-target-v1'}]);
  await h.samples(1);assert.deepEqual(pulses(h).map(event=>event.t),[0,1]);
});

test('hidden diagnostic controls cannot defer the automatic comparison transition',async()=>{
  const h=harness();h.check('auto-compare',false);await compare(h);
  h.click('freeze');assert.equal(h.snapshot().mode,'running');
  h.check('auto-compare',true);const restored=harness(h.saved());
  assert.equal(restored.snapshot().phase,'discovery');assert.equal(restored.snapshot().mode,'running');
  restored.click('step');assert.equal(restored.snapshot().phase,'deployment');assert.equal(restored.snapshot().t,1);
  assert.equal(restored.state().playing,false);assert.equal(restored.clock.tasks.size,0);
});


test('communication starts in learning and preserves the chosen noise across reset and learn again',async()=>{
  assert.match(html,/<option value="communication" selected>/);
  const h=harness(undefined,'communication');
  assert.equal(h.snapshot().experiment,'communication');assert.equal(h.snapshot().beta,1);assert.equal(h.snapshot().horizon,180);
  assert.equal(h.node('view').value,'learning');assert.equal(h.node('noise-control').hidden,false);
  assert.equal(h.node('preset-control').hidden,true);
  h.change('noise',2);assert.equal(h.snapshot().beta,2);assert.equal(h.snapshot().t,0);
  await compare(h);assert.equal(h.snapshot().phase,'deployment');assert.equal(h.node('view').value,'cost');
  assert.equal(h.node('view').hidden,true);assert.equal(h.snapshot().calibration.updates,0);
  h.click('restart');assert.equal(h.snapshot().phase,'discovery');assert.equal(h.snapshot().beta,2);
  assert.equal(h.node('view').value,'learning');assert.equal(h.node('experiment').value,'communication');
});

test('communication comparison keeps all policies and reports actual gains or losses against both references',async()=>{
  const h=harness(undefined,'communication');await compare(h);h.click('run');await h.samples(15);h.click('run');
  assert.deepEqual(h.comparison().active,['online','scalar','static','causal']);
  assert.deepEqual(h.comparison().plotted,['online','scalar','static','causal']);
  assert.match(h.summary(),/fixed sparse/);assert.match(h.summary(),/dense prediction/);
  const c=h.snapshot().cumulative;
  for(const [reference,label] of [['scalar','fixed sparse'],['static','dense prediction']]){
    const percent=100*(c.online-c[reference])/c[reference];
    if(Math.abs(percent)>.05)assert.match(h.summary(),new RegExp((percent<0?'lower':'higher')+' than '+label));
  }
  assert.deepEqual(h.shownReference().sort(),h.snapshot().deployedSupport.fixedLinks.map(e=>e.to+','+e.from).sort());
  assert.equal(h.seriesButton('online').children.at(-1).textContent,'Learned sparse');
  assert.equal(h.seriesButton('scalar').children.at(-1).textContent,'Fixed sparse');
});

test('communication design shows actual cost and deployed prediction budgets independently of chart visibility',async()=>{
  const h=harness(undefined,'communication');
  assert.equal(h.codesign(),null,'Candidate links cannot be presented as a deployed cost tradeoff');
  await compare(h);
  assert.equal(h.snapshot().phase,'deployment');
  assert.ok(h.codesign().points.every(point=>point.cost===0),'The fresh comparison must not borrow discovery costs');
  h.click('run');await h.samples(20);h.click('run');
  const before=plain(h.snapshot()),view=h.codesign(),keys=['online','scalar','static','causal'];
  const learned=before.deployedSupport.links.filter(link=>link.from!==link.to).length;
  const fixed=before.deployedSupport.fixedLinks.filter(link=>link.from!==link.to).length;
  const dense=PowerDemo.constants.inverterBuses.reduce((sum,bus)=>sum+Array.from({length:23},(_,index)=>index+2).filter(source=>source!==bus).length,0);
  assert.deepEqual(view.points.map(point=>point.key),keys);
  assert.deepEqual(view.points.map(point=>point.links),[learned,fixed,dense,0]);
  assert.deepEqual(view.points.map(point=>point.cost),keys.map(key=>before.cumulative[key]));
  assert.equal(view.denseLinks,176);assert.equal(view.learnedLinks,24);assert.equal(view.fixedLinks,24);
  assert.equal(view.savedPercent,100*(dense-learned)/dense);assert.equal(view.sameBudget,true);
  assert.equal(view.sameSupport,JSON.stringify(before.deployedSupport.learned)===JSON.stringify(before.deployedSupport.fixed));
  for(const key of ['online','scalar','static'])h.seriesButton(key).dispatch('click');
  assert.deepEqual(h.comparison().plotted,['causal']);
  assert.deepEqual(h.codesign(),view,'Hiding a time curve cannot hide a design or change its measured cost');
  h.click('cost-gap');assert.deepEqual(h.codesign(),view,'Measured method budgets and total costs are independent of the selected chart metric');
  assert.deepEqual(plain(h.snapshot()),before,'Read only design summaries cannot affect the experiment');
  const restored=harness(h.saved());assert.deepEqual(restored.codesign(),view);assert.equal(restored.state().playing,false);
  h.click('restart');assert.equal(h.codesign(),null);assert.equal(h.snapshot().t,0);
});

test('communication design acknowledges identical supports and a winning feedback controller',async()=>{
  const equal=harness(undefined,'communication');equal.change('noise',0);
  await compare(equal);await compare(equal);
  const ties=equal.codesign();
  assert.equal(ties.sameBudget,true);assert.equal(ties.sameSupport,true);
  assert.equal(ties.points.find(point=>point.key==='online').cost,ties.points.find(point=>point.key==='scalar').cost);
  const allNoisy=harness({privateContent:{version:14,algorithmId:ALGORITHM_ID,phase:'discovery',t:0,events:[],automaticComparison:true,
    initialOptions:{experiment:'communication',powerScenario:'forecasted-demand',seed:21,beta:16,horizon:180,faultBuses:Array.from({length:23},(_,i)=>i+2)}}},'communication');
  await compare(allNoisy);await compare(allNoisy);
  const view=allNoisy.codesign(),minimum=Math.min(...view.points.map(point=>point.cost));
  assert.equal(view.points.find(point=>point.key==='causal').cost,minimum,'The declared all noisy fixture makes feedback cheapest');
  assert.deepEqual(view.winnerKeys,['causal']);assert.match(view.status,/Feedback only/i);
  assert.doesNotMatch(view.status,/learned.*(?:wins|best|optimal)|guaranteed|always better/i);
  const prediction=harness();assert.equal(prediction.codesign(),null);await compare(prediction);
  assert.equal(prediction.codesign(),null,'Prediction adaptation is not the isolated communication experiment');
});

test('forecast stress starts a clean trial and reports the configured source error in physical units',async()=>{
  const h=harness(undefined,'communication');h.change('intervention','power');
  for(const bus of [20,22,23])pointerClick(h,h.bus(bus));
  await h.samples(5);
  assert.ok(h.snapshot().cumulative.online>0);assert.equal(h.state().activeAttackBuses.length,3);
  for(const beta of [4,8,16]) {
    h.change('noise',beta);
    assert.equal(h.snapshot().beta,beta);assert.equal(h.snapshot().phase,'discovery');assert.equal(h.snapshot().t,0);
    assert.equal(h.state().playing,false);assert.equal(h.state().intervention,'forecast');
    assert.deepEqual(h.state().activeAttackBuses,[]);assert.deepEqual(h.snapshot().pendingPulses,[]);
    assert.deepEqual(h.snapshot().activePulses,[]);assert.equal(h.state().journal.length,0);
    assert.ok(Object.values(h.snapshot().cumulative).every(value=>value===0));
    assert.match(h.node('noise-caption').textContent,/Bus \d+ · SD [\d.e+-]+ mpu/);
  }
  h.change('noise',8);h.change('bus',7);
  const configured=()=>Number(h.node('noise-caption').dataset.sdMpu);
  assert.equal(h.snapshot().faults.includes(7),false);
  assert.ok(Math.abs(configured()-.10646)<.001,'Quiet source uses its physical forcing scale');
  pointerClick(h,h.bus(7));
  assert.equal(h.snapshot().faults.includes(7),true);
  assert.ok(Math.abs(configured()-8.51677)<.01,'Corrupting this source increases its configured noise SD eightyfold');
  h.change('noise',1);assert.equal(h.snapshot().beta,1);
  assert.doesNotMatch(h.node('noise-caption').textContent,/stress/i);
  assert.deepEqual(PowerDemo.constants.communicationBetas,[0,.25,.5,1,2],'Reference benchmark levels remain separate');
});

test('extended forecast stress replays its actual comparison without reverting to reference noise',async()=>{
  const h=harness(undefined,'communication');h.change('noise',16);
  await compare(h);h.click('run');await h.samples(5);h.click('run');
  const restored=harness(h.saved(),'communication');
  assert.equal(restored.snapshot().phase,'deployment');assert.equal(restored.snapshot().beta,16);
  assert.equal(restored.node('noise').value,'16');assert.equal(restored.state().playing,false);
  assert.deepEqual(restored.snapshot().states,h.snapshot().states);
  assert.deepEqual(restored.snapshot().cumulative,h.snapshot().cumulative);
  assert.deepEqual(restored.snapshot().deployedSupport,h.snapshot().deployedSupport);
  assert.deepEqual(restored.comparison().plotted,['online','scalar','static','causal']);
});

test('continuous attacks survive communication handoff and saved trial replays paused with frozen control',async()=>{
  const h=harness(undefined,'communication');h.change('noise',2);h.change('intervention','power');
  const bus=h.bus(23);pointerClick(h,bus);await h.samples(185);h.click('run');
  assert.equal(h.snapshot().phase,'deployment');assert.ok(h.snapshot().eventLog.filter(e=>e.type==='pulse').length>=5);
  h.click('cost-gap');const saved=h.saved(),r=harness(saved,'communication');
  assert.equal(r.snapshot().experiment,'communication');assert.equal(r.snapshot().beta,2);
  assert.equal(r.node('noise').value,'2');assert.equal(r.node('cost-metric').value,'gap');
  assert.equal(r.state().playing,false);assert.equal(r.snapshot().calibration.updates,0);
  assert.deepEqual(r.snapshot().cumulative,h.snapshot().cumulative);
  assert.deepEqual(r.snapshot().deployedSupport,h.snapshot().deployedSupport);
});

test('switching experiments resets the trial without carrying topology or attack state',async()=>{
  const h=harness(undefined,'communication');pointerClick(h,h.bus(7));await h.samples(3);
  h.change('experiment','prediction');assert.equal(h.snapshot().experiment,'prediction');
  assert.equal(h.snapshot().t,0);assert.equal(h.state().playing,false);assert.equal(h.node('noise-control').hidden,true);
  assert.equal(h.node('preset-control').hidden,false);assert.equal(h.node('view').value,'cost');
  h.change('preset','uniform');assert.equal(h.snapshot().preset,'uniform');
  h.change('experiment','communication');assert.equal(h.snapshot().preset,'mixed');assert.equal(h.snapshot().beta,1);
  assert.equal(h.snapshot().deployedSupport,null);assert.equal(h.node('view').value,'learning');
});


const forecastEvents=h=>h.snapshot().eventLog.filter(event=>event.type==='forecast');

test('new sessions default to the relevant bus interaction and hide irrelevant controls',()=>{
  const communication=harness(undefined,'communication'),prediction=harness();
  assert.equal(communication.node('intervention').value,'forecast');
  assert.equal(communication.node('attack-mode').hidden,true);assert.equal(communication.node('strength').hidden,true);
  assert.equal(prediction.node('intervention').value,'power');
  assert.equal(prediction.node('attack-mode').hidden,false);assert.equal(prediction.node('strength').hidden,false);
  assert.match(communication.node('pulse-label').textContent,/Corrupt bus 7/);
});

test('forecast bus pointer gesture toggles once and never creates a power pulse',async()=>{
  const h=harness(undefined,'communication'),bus=h.bus(7);
  assert.equal(h.snapshot().faults.includes(7),false);
  pointerClick(h,bus);assert.equal(h.snapshot().faults.includes(7),true);
  assert.equal(forecastEvents(h).length,1);assert.equal(pulses(h).length,0);
  assert.equal(h.snapshot().pendingPulses.length,0);assert.equal(h.snapshot().activePulses.length,0);
  assert.equal(h.snapshot().t,0);assert.equal(h.state().playing,true);
  assert.equal(h.state().selectedBus,7);assert.equal(h.node('pulse-label').textContent,'Repair bus 7');
  await h.samples(6);assert.equal(forecastEvents(h).length,1);assert.equal(pulses(h).length,0);
  pointerClick(h,bus);assert.equal(h.snapshot().faults.includes(7),false);
  assert.equal(forecastEvents(h).length,2);assert.equal(h.node('pulse-label').textContent,'Corrupt bus 7');
  assert.ok(Object.values(h.snapshot().cumulative).every(Number.isFinite));
});

test('forecast Enter, Space and D toggle once despite key repeats and key release',async()=>{
  for(const key of ['Enter',' ','d']){
    const h=harness(undefined,'communication'),bus=h.bus(7);
    if(key==='d') {h.key('keydown',key);h.key('keydown',key,{repeat:true});}
    else {bus.dispatch('keydown',{key});bus.dispatch('keydown',{key,repeat:true});}
    await h.samples(4);
    if(key==='d')h.key('keyup',key);else bus.dispatch('keyup',{key});
    assert.equal(forecastEvents(h).length,1,key);assert.equal(h.snapshot().faults.includes(7),true,key);
    assert.equal(pulses(h).length,0,key);assert.equal(h.node('pulse').dataset.holding,'false',key);
    if(key==='d')h.key('keydown',key);else bus.dispatch('keydown',{key});
    assert.equal(forecastEvents(h).length,2,key);assert.equal(h.snapshot().faults.includes(7),false,key);
  }
});

test('forecast primary action and assistive click toggle the selected bus without power requests',()=>{
  const h=harness(undefined,'communication');h.change('bus',14);
  h.quickClick();assert.equal(h.snapshot().faults.includes(14),true);assert.equal(forecastEvents(h).length,1);
  h.click('pulse',0);assert.equal(h.snapshot().faults.includes(14),false);assert.equal(forecastEvents(h).length,2);
  assert.equal(pulses(h).length,0);assert.equal(h.node('attack-mode').hidden,true);
});

test('switching interaction ends continuous power requests and preserves physical tails and costs',async()=>{
  const h=harness(undefined,'communication');h.change('intervention','power');
  pointerClick(h,h.bus(23));await h.samples(4);
  const before=h.snapshot(),count=pulses(h).length;
  h.change('intervention','forecast');
  assert.equal(h.node('pulse').dataset.holding,'false');assert.equal(h.node('attack-mode').hidden,true);
  assert.deepEqual(h.snapshot().cumulative,before.cumulative);assert.deepEqual(h.snapshot().activePulses,before.activePulses);
  await h.samples(4);assert.equal(pulses(h).length,count);assert.ok(h.snapshot().activePulses.length>0);
  pointerClick(h,h.bus(7));assert.equal(forecastEvents(h).length,1);assert.equal(pulses(h).length,count);
  assert.equal(h.powerContext(),'Includes load recovery · Clicked power disturbances are not forecast');
  h.change('intervention','power');assert.equal(h.node('attack-mode').hidden,false);
  pointerClick(h,h.bus(23));await h.samples(2);assert.ok(pulses(h).length>count);
});

test('forecast interaction save restores the exact paused trial and selected action',async()=>{
  const h=harness(undefined,'communication');pointerClick(h,h.bus(7));await h.samples(45);
  pointerClick(h,h.bus(12));await h.samples(5);h.click('run');
  const saved=h.saved(),r=harness(saved);
  assert.equal(saved.privateContent.version,14);assert.equal(saved.privateContent.intervention,'forecast');
  assert.equal(r.node('intervention').value,'forecast');assert.equal(r.node('attack-mode').hidden,true);
  assert.deepEqual(r.snapshot().cumulative,h.snapshot().cumulative);
  assert.deepEqual(r.snapshot().states,h.snapshot().states);assert.deepEqual(r.snapshot().faults,h.snapshot().faults);
  assert.deepEqual(r.snapshot().eventLog,h.snapshot().eventLog);assert.equal(r.state().playing,false);
  assert.equal(pulses(r).length,0);assert.equal(r.powerContext(),'');
});

test('forecast source settings survive automatic comparison and deployed replay',async()=>{
  const h=harness(undefined,'communication');pointerClick(h,h.bus(7));
  await h.samples(185);h.click('run');
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().faults.includes(7),true);
  assert.equal(h.node('intervention').value,'forecast');assert.equal(pulses(h).length,0);
  assert.equal(h.snapshot().calibration.updates,0);assert.equal(h.node('view').value,'cost');
  const r=harness(h.saved());assert.equal(r.node('intervention').value,'forecast');
  assert.deepEqual(r.snapshot().cumulative,h.snapshot().cumulative);
  assert.deepEqual(r.snapshot().deployedSupport,h.snapshot().deployedSupport);
  assert.deepEqual(r.snapshot().faults,h.snapshot().faults);assert.equal(r.state().playing,false);
});

test('reliability changes leave deployed links fixed and Rebuild prediction links retains the current source map',async()=>{
  const h=harness(undefined,'communication');await compare(h);
  const support=plain(h.snapshot().deployedSupport.learned);
  pointerClick(h,h.bus(7));assert.equal(h.snapshot().faults.includes(7),true);
  assert.match(h.node('event').textContent,/Links remain fixed/);
  await h.samples(4);assert.deepEqual(h.snapshot().deployedSupport.learned,support);
  const currentFaults=plain(h.snapshot().faults);
  h.click('deploy');assert.equal(h.snapshot().phase,'discovery');assert.equal(h.snapshot().t,0);
  assert.deepEqual(h.snapshot().faults,currentFaults);assert.equal(h.node('intervention').value,'forecast');
  assert.equal(h.snapshot().deployedSupport,null);assert.equal(h.state().playing,false);
});

test('zero noise forecast configuration is explicit and never claims active corruption',()=>{
  const h=harness(undefined,'communication');h.change('noise',0);pointerClick(h,h.bus(7));
  assert.equal(h.snapshot().faults.includes(7),true);assert.equal(pulses(h).length,0);
  assert.equal(h.node('pulse').dataset.attackState,'quiet');
  assert.match(h.node('attack-hint').textContent,/No noise at β 0/);
  assert.match(h.node('pulse').title,/disabled at β 0/);assert.match(h.node('event').textContent,/No noise at β 0/);
});


test('switching cost quantities during playback clears stale readings without changing the experiment',async()=>{
  const h=harness(undefined,'communication');h.click('run');await h.samples(20);
  const initial=h.snapshot(),tasks=h.clock.tasks.size;
  for(const metric of ['gap','total','gap','total']){
    h.node('tooltip').style.display='block';h.pin('pr-cost');h.click('cost-'+metric);
    assert.equal(h.pin(),null,'Pinned values from the former quantity must be dismissed');
    assert.equal(h.node('tooltip').style.display,'none');
    assert.equal(h.state().playing,true);assert.equal(h.clock.tasks.size,tasks);
    assert.equal(h.snapshot().t,initial.t);assert.deepEqual(h.snapshot().cumulative,initial.cumulative);
    assert.equal(h.node('cost-metric').hidden,true);assert.equal(h.node('cost-metric').value,metric);
    assert.equal(h.node('cost-'+metric)['aria-pressed'],'true');
    assert.equal(h.node('cost-'+(metric==='gap'?'total':'gap'))['aria-pressed'],'false');
    assert.equal(h.node('cost-gap')['aria-label'],'Difference from scalar adaptation');
    assert.equal(h.saved().privateContent.costMetric,metric);
  }
  await h.samples(2);assert.equal(h.snapshot().t,initial.t+2);
});

test('sample paths and latest markers use the current scale immediately when quantity and sample count change',()=>{
  const h=harness(undefined,'prediction',false),selections=new Map();
  function selection(selector){
    if(selections.has(selector))return selections.get(selector);
    const value={dataValues:[],attributes:new Map(),interruptions:[],
      data(values){this.dataValues=values;return this;},join(){return this;},order(){return this;},remove(){return this;},
      attr(name,value){this.attributes.set(name,this.dataValues.map(item=>typeof value==='function'?value(item):value));return this;},
      interrupt(name){this.interruptions.push(name??'default');return this;},
      transition(){assert.fail('Measured curves must not morph between incompatible scales');}
    };selections.set(selector,value);return value;
  }
  const items=[{key:'online',color:'blue'},{key:'scalar',color:'purple'}];
  const chart={marks:{selectAll:selection},x:value=>value*10,y:value=>100-value*20};
  h.drawSeries(chart,[{x:0,online:0,scalar:0},{x:1,online:2,scalar:3}],items,true);
  assert.deepEqual(plain(selection('path.data-series').attributes.get('d')),['M0,100L10,40','M0,100L10,60']);
  // The next frame has both a different quantity and an extra measured sample.
  const gapChart={...chart,y:value=>50-value*30};
  h.drawSeries(gapChart,[{x:0,online:0,scalar:0},{x:1,online:-1,scalar:0},{x:2,online:-2,scalar:0}],items,true);
  assert.deepEqual(plain(selection('path.data-series').attributes.get('d')),['M0,50L10,50L20,50','M0,50L10,80L20,110']);
  assert.deepEqual(plain(selection('circle.latest-value').attributes.get('cy')),[50,110]);
  assert.ok(selection('path.data-series').interruptions.includes('update'));
  assert.ok(selection('circle.latest-value').interruptions.includes('update'));
});


test('touch clicks with zero detail do not toggle a forecast twice after pointer activation',()=>{
  const h=harness(undefined,'communication'),bus=h.bus(7);
  function touchTap(id){
    h.pointer('pointerdown',bus,{pointerId:id,pointerType:'touch'});
    bus.dispatch('gotpointercapture',{pointerId:id,pointerType:'touch'});
    // Pointer release delivers lostpointercapture before the synthesized click.
    h.pointer('pointerup',bus,{pointerId:id,pointerType:'touch'});
    bus.dispatch('click',{detail:0,pointerId:id,pointerType:'touch'});
  }
  touchTap(41);
  assert.equal(h.snapshot().faults.includes(7),true);assert.equal(forecastEvents(h).length,1);
  touchTap(42);
  assert.equal(h.snapshot().faults.includes(7),false);assert.equal(forecastEvents(h).length,2);
  // Assistive and keyboard clicks have no pointer source and remain supported.
  bus.dispatch('click',{detail:0,pointerType:''});
  assert.equal(h.snapshot().faults.includes(7),true);assert.equal(forecastEvents(h).length,3);
  bus.dispatch('click',{detail:0});
  assert.equal(h.snapshot().faults.includes(7),false);assert.equal(forecastEvents(h).length,4);
});

test('zero detail touch clicks preserve a latched power attack until the next tap',async()=>{
  const h=harness(undefined,'communication');h.change('intervention','power');const bus=h.bus(23);
  const tap=id=>{
    h.pointer('pointerdown',bus,{pointerId:id,pointerType:'touch'});
    h.pointer('pointerup',bus,{pointerId:id,pointerType:'touch'});
    bus.dispatch('click',{detail:0,pointerId:id,pointerType:'touch'});
  };
  tap(51);assert.equal(h.node('pulse')['aria-pressed'],'true');
  await h.samples(3);assert.equal(pulses(h).length,3);
  tap(52);assert.equal(h.node('pulse')['aria-pressed'],'false');
  const count=pulses(h).length;await h.samples(2);assert.equal(pulses(h).length,count);
});

test('prediction link inspection uses current support without changing plant or forecast state',async()=>{
  const h=harness(undefined,'communication');
  const verify=()=>{
    const before=plain(h.snapshot());
    const edge=before.recommendations.find(edge=>edge.from!==edge.to);
    assert.ok(edge,'Actual candidate or deployed support exists');
    h.inspectLink(edge.to,edge.from);
    assert.deepEqual(h.inspection(),{source:edge.from,receiver:edge.to,local:false,connected:true,
      label:'Source bus '+edge.from+' → inverter '+edge.to+' · Selected link · '+(before.phase==='deployment'?'Deployed · Learned sparse':'Candidate · Online SLS')});
    const absent=Array.from({length:23},(_,i)=>i+2).find(bus=>bus!==edge.to&&!before.recommendations.some(e=>e.to===edge.to&&e.from===bus));
    h.inspectLink(edge.to,absent);
    assert.equal(h.inspection().connected,false,'An absent source must not fabricate a link');
    h.inspectLink(edge.to,edge.to);
    assert.equal(h.inspection().local,true);
    assert.equal(h.inspection().connected,true);
    assert.deepEqual(plain(h.snapshot()),before,'Inspection cannot change samples, faults, controls or deployed support');
    assert.equal(h.state().playing,false,'Inspection cannot start playback');
    assert.equal(h.state().journal.length,0,'Inspection cannot inject interventions');
  };
  verify();
  h.check('auto-compare',false);await compare(h);h.click('deploy');h.click('run');
  assert.equal(h.snapshot().phase,'deployment');
  verify();
  h.change('bus',2);
  assert.equal(h.inspection(),null,'Selecting a nonreceiver clears stale inspection');
});

test('inspected source action toggles reliability without selecting the receiver as the fault target',()=>{
  const h=harness(undefined,'communication');h.inspectLink(5,7);
  const before=plain(h.snapshot());
  assert.equal(h.node('source-controls').hidden,false);assert.equal(h.node('source-fault').textContent,'Corrupt source 7');
  h.click('source-fault');
  assert.equal(h.state().selectedBus,5);assert.equal(h.state().inspectedSource,7);
  assert.equal(h.state().playing,false);assert.equal(h.snapshot().t,before.t);
  assert.deepEqual(plain(h.snapshot().faults),before.faults.concat(7).sort((a,b)=>a-b));
  assert.deepEqual(plain(h.snapshot().cumulative),before.cumulative);
  assert.deepEqual(plain(h.snapshot().states),before.states);
  assert.deepEqual(plain(h.snapshot().pendingPulses),before.pendingPulses);
  assert.equal(h.state().journal.at(-1).bus,7);assert.equal(h.state().journal.at(-1).type,'fault');
  assert.equal(h.node('source-fault').textContent,'Repair source 7');
  const restored=harness(h.saved());
  assert.equal(restored.state().selectedBus,5);assert.equal(restored.state().inspectedSource,7);
  assert.deepEqual(restored.snapshot().faults,h.snapshot().faults);
  assert.deepEqual(restored.snapshot().eventLog,h.snapshot().eventLog);
  assert.deepEqual(restored.snapshot().states,h.snapshot().states);
  restored.click('source-fault');assert.deepEqual(plain(restored.snapshot().faults),before.faults);
  assert.equal(restored.state().playing,false);
});

test('inspected reliability action changes only newly issued forecasts at its source',()=>{
  const changed=harness(undefined,'communication'),reference=harness(undefined,'communication');
  for(const h of [changed,reference]) {h.click('step');h.inspectLink(5,7);}
  const issued=changed.issuedForecasts();assert.ok(issued.length>0);
  changed.click('source-fault');
  assert.deepEqual(changed.issuedForecasts(),issued,'Already issued forecasts cannot be rewritten');
  for(let i=0;i<7;i++) {changed.click('step');reference.click('step');}
  const actual=changed.issuedForecasts(),control=reference.issuedForecasts();
  assert.equal(actual.length,control.length);
  let different=0;
  for(let i=0;i<actual.length;i++) {
    assert.deepEqual(actual[i].base,control[i].base,'Physical disturbance generator stays paired');
    for(let j=0;j<24;j++) {
      if(j===6&&i>=issued.length) {if(actual[i].forecast[j]!==control[i].forecast[j])different++;}
      else assert.equal(actual[i].forecast[j],control[i].forecast[j],'Other sources and issued forecasts stay identical');
    }
  }
  assert.ok(different>0,'Future source 7 forecasts actually change');
});

test('inspected source action preserves deployed support, replay and Rebuild prediction links reliability',async()=>{
  const h=harness(undefined,'communication');h.check('auto-compare',false);await compare(h);h.click('deploy');h.click('run');
  h.inspectLink(5,7);
  const before=plain(h.snapshot());h.click('source-fault');
  assert.deepEqual(plain(h.snapshot().deployedSupport),before.deployedSupport);
  assert.deepEqual(plain(h.snapshot().predictionDiagnostics),before.predictionDiagnostics);
  assert.deepEqual(plain(h.snapshot().cumulative),before.cumulative);
  assert.deepEqual(plain(h.snapshot().states),before.states);
  assert.match(h.node('source-status').textContent,/Links fixed/);
  const restored=harness(h.saved());
  assert.equal(restored.state().inspectedSource,7);
  assert.deepEqual(restored.snapshot().deployedSupport,h.snapshot().deployedSupport);
  assert.deepEqual(restored.snapshot().cumulative,h.snapshot().cumulative);
  assert.deepEqual(restored.snapshot().eventLog,h.snapshot().eventLog);
  const faults=plain(h.snapshot().faults);
  h.click('deploy');assert.equal(h.snapshot().phase,'discovery');assert.deepEqual(plain(h.snapshot().faults),faults);
});

test('source actions cannot mutate reliability in saved history or with zero forecast noise',()=>{
  const h=harness(undefined,'communication');h.inspectLink(5,7);
  const before=plain(h.snapshot());h.event('topology-history','input');
  assert.equal(h.node('source-fault').disabled,true);h.click('source-fault');
  assert.deepEqual(plain(h.snapshot()),before);
  h.click('history-live');assert.equal(h.node('source-fault').disabled,false);
  h.change('noise',0);h.inspectLink(5,7);
  assert.equal(h.node('source-fault').disabled,true);const quiet=plain(h.snapshot());h.click('source-fault');
  assert.deepEqual(plain(h.snapshot()),quiet);
  h.change('bus',2);assert.equal(h.node('source-controls').hidden,true);
});

test('power scenario selection preserves exact replay and Rebuild prediction links while keeping reference available',async()=>{
  const h=harness(undefined,'communication');
  assert.equal(h.snapshot().powerScenario,'reference');
  h.change('power-scenario','solar-outage');await compare(h);
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().powerScenario,'solar-outage');
  for(let i=0;i<55;i++)h.click('step');
  const restored=harness(h.saved());
  assert.equal(restored.node('power-scenario').value,'solar-outage');
  assert.deepEqual(restored.snapshot().states,h.snapshot().states);
  assert.deepEqual(restored.snapshot().cumulative,h.snapshot().cumulative);
  assert.deepEqual(restored.snapshot().eventLog,h.snapshot().eventLog);
  h.click('deploy');assert.equal(h.snapshot().powerScenario,'solar-outage');
  h.change('power-scenario','reference');assert.equal(h.snapshot().powerScenario,'reference');
  assert.equal(h.snapshot().phase,'discovery');assert.equal(h.snapshot().t,0);assert.equal(h.state().playing,false);
});


test('source observation uses only the last revealed forcing pair with exact issue timing and replay',()=>{
  const h=harness(undefined,'communication');h.inspectLink(5,7);
  assert.equal(h.forecastObservation(),null);
  assert.equal(h.node('forecast-values').hidden,true);
  assert.match(h.node('forecast-timing').textContent,/Run or step/);
  for(let i=0;i<12;i++) {
    h.click('step');
    const snapshot=h.snapshot(),sample=snapshot.lastSample,issued=h.issuedForecasts()[sample.t];
    const expected={source:7,receiver:5,action:sample.t,issuedAt:issued.issuedAt,observedAt:snapshot.t,
      forecast:sample.forecast[6],realized:sample.disturbance[6],error:sample.forecast[6]-sample.disturbance[6]};
    assert.deepEqual(h.forecastObservation(),expected);
    assert.ok(expected.issuedAt<=expected.action&&expected.observedAt===expected.action+1);
    assert.equal(expected.forecast,issued.forecast[6]);
    assert.equal(h.node('forecast-observation').dataset.observedAt,String(snapshot.t));
    assert.equal(h.node('observed-error').textContent,(1000*expected.error).toFixed(3));
    assert.equal(h.state().playing,false);
  }
  const before=plain(h.snapshot()),observation=h.forecastObservation();
  h.inspectLink(5,14);assert.equal(h.forecastObservation().forecast,before.lastSample.forecast[13]);
  assert.deepEqual(plain(h.snapshot()),before,'Inspection never changes the experiment');
  h.inspectLink(5,7);
  const restored=harness(h.saved());
  assert.deepEqual(restored.forecastObservation(),observation,'Version 14 replay recreates the exact revealed observation');
});

test('source reliability toggles do not rewrite observed or already issued forecasts',()=>{
  const changed=harness(undefined,'communication'),reference=harness(undefined,'communication');
  for(const h of [changed,reference]){h.click('step');h.inspectLink(5,7);}
  const observation=changed.forecastObservation(),issued=changed.issuedForecasts();
  changed.click('source-fault');
  assert.deepEqual(changed.forecastObservation(),observation,'Current reliability is not retroactive');
  assert.deepEqual(changed.issuedForecasts(),issued);
  let observedDifference=false;
  for(let i=0;i<8;i++){
    changed.click('step');reference.click('step');
    const actual=changed.forecastObservation(),control=reference.forecastObservation();
    if(actual.action<issued.length)assert.equal(actual.forecast,control.forecast,'Sealed preview remains unchanged');
    else if(actual.forecast!==control.forecast)observedDifference=true;
    assert.ok(Math.abs(actual.realized-control.realized)<1e-12,'Only source reliability changed, not physical forcing');
  }
  assert.equal(observedDifference,true,'Changed source error becomes observable after the sealed preview');
});

test('source observation distinguishes dense discovery from frozen deployed support and saved history',async()=>{
  const h=harness(undefined,'communication');h.inspectLink(5,7);h.click('step');
  assert.match(h.node('forecast-support').textContent,/Dense messages · Candidate links/);
  h.event('topology-history','input');
  assert.equal(h.forecastObservation(),null);assert.equal(h.node('forecast-values').hidden,true);
  assert.equal(h.node('forecast-observation').dataset.forecast,'','History must not carry stale current values');
  assert.match(h.node('forecast-timing').textContent,/Return to Latest/);
  h.click('history-live');assert.ok(h.forecastObservation());
  h.check('auto-compare',false);await compare(h);h.click('deploy');h.click('run');
  h.inspectLink(5,7);assert.equal(h.forecastObservation(),null,'Fresh comparison has no revealed samples');
  h.click('step');const snapshot=plain(h.snapshot());
  const edge=snapshot.recommendations.find(edge=>edge.from!==edge.to);
  h.inspectLink(edge.to,edge.from);assert.match(h.node('forecast-support').textContent,/^Selected · Inverter/);
  const absent=Array.from({length:23},(_,i)=>i+2).find(bus=>bus!==edge.to&&!snapshot.recommendations.some(e=>e.to===edge.to&&e.from===bus));
  h.inspectLink(edge.to,absent);assert.match(h.node('forecast-support').textContent,/^Excluded · Inverter/);
  assert.equal(h.node('matrix-title').dataset.controller,'Learned sparse','The adjacent matrix title identifies the controller for this support');
  assert.equal(h.forecastObservation().forecast,snapshot.lastSample.forecast[absent-1],'Excluded source can be audited, not sent on a fabricated link');
  assert.deepEqual(plain(h.snapshot()),snapshot);
});


test('command inspection uses actual deployed response rows once and preserves raw-source attribution',()=>{
  const h=harness(undefined,'communication'),keys=['online','scalar','static','causal'];
  const matrix=PowerDemo.math.eye(23);matrix[0][5]=2;
  const L=Array.from({length:8},()=>Array(23).fill(0));L[0][0]=3;
  const block={k:1,L},actual=PowerDemo.math.multiply(L,matrix),forecast=Array(24).fill(0);forecast[6]=.02;
  const view={lastSample:{t:0},phase:'discovery',experiment:'communication',calibration:{matrix:matrix.map(row=>row.map(value=>1000*value)),scalar:1000},
    lastResponseRows:{online:[{k:1,L:actual}],scalar:[block],static:[block],causal:[]},
    costStates:Object.fromEntries(keys.map(key=>[key,PowerDemo.model.baseDrop.slice()])),
    commandQ:Object.fromEntries(keys.map(key=>[key,Array(24).fill(0)])),
    saturation:Object.fromEntries(keys.map(key=>[key,Array(24).fill(false)]))};
  view.commandQ.online[4]=70;view.saturation.online[4]=true;
  const segments=[{start:0,end:5,designs:Object.fromEntries(keys.filter(key=>key!=='causal').map(key=>[key,{rows:[[block]]}]))}];
  const messages=[{forecast}],before=JSON.stringify({view,segments,messages});
  const reading=h.decompose(view,segments,messages,7,5),online=reading.rows[0];
  assert.equal(online.gainNorm,6,'Use actual L of the raw source without applying the correction again');
  assert.equal(online.sourceKvar,120);assert.equal(online.otherKvar,0);assert.equal(online.feedbackKvar,0);
  assert.equal(online.requestedKvar,120);assert.equal(online.commandKvar,70);assert.equal(online.limited,true);
  assert.equal(reading.rows[3].sourceKvar,0);assert.equal(reading.rows[3].gainNorm,0);
  assert.equal(JSON.stringify({view,segments,messages}),before,'Inspection is pure');
  forecast[6]=0;
  const zeroMessage=h.decompose(view,segments,messages,7,5).rows[0];
  assert.equal(zeroMessage.sourceKvar,0);assert.equal(zeroMessage.gainNorm,6,'Zero message contribution does not remove the actual source gain');
});

test('command decomposition reconstructs actual requests and bounded commands for all twenty seeds',()=>{
  const h=harness(undefined,'communication'),near=(a,b,message)=>assert.ok(Math.abs(a-b)<1e-8,message+' '+a+' '+b);
  const verify=sim=>{
    const snapshot=sim.snapshot(),receiver=PowerDemo.constants.inverterBuses[(snapshot.seed>>>0)%8];
    const reading=h.decompose(snapshot,sim.segments,sim.forecasts,7,receiver);
    assert.ok(reading);assert.equal(reading.action,snapshot.lastSample.t);
    const rowIndex=PowerDemo.constants.inverterBuses.indexOf(receiver),source=5;
    for(const item of reading.rows){
      near(item.sourceKvar+item.otherKvar+item.feedbackKvar,item.requestedKvar,'Parts sum before limiting');
      near(Math.max(-70,Math.min(70,item.requestedKvar)),snapshot.commandQ[item.key][receiver-1],'Reconstruct actual command');
      assert.equal(item.commandKvar,snapshot.commandQ[item.key][receiver-1]);
      assert.equal(item.limited,snapshot.saturation[item.key][receiver-1]);
      if(item.key==='causal'){assert.equal(item.gainNorm,0);assert.equal(item.sourceKvar,0);assert.equal(item.otherKvar,0);}
      if(snapshot.phase==='deployment'&&['online','scalar'].includes(item.key)){
        const support=item.key==='online'?snapshot.deployedSupport.learned:snapshot.deployedSupport.fixed;
        if(!support[rowIndex][source])assert.ok(item.gainNorm<1e-8,'Forbidden actual source gain remains zero');
      }
    }
    if(snapshot.phase==='deployment'){
      const sourceTotals=Object.fromEntries(reading.rows.map(item=>[item.key,0]));
      for(let sourceBus=2;sourceBus<=24;sourceBus++)
        for(const item of h.decompose(snapshot,sim.segments,sim.forecasts,sourceBus,receiver).rows)sourceTotals[item.key]+=item.sourceKvar;
      for(const item of reading.rows)near(sourceTotals[item.key],item.sourceKvar+item.otherKvar,'Every raw source accounts for full prediction');
    }
  };
  for(let seed=1;seed<=20;seed++){
    const sim=new PowerDemo.Simulation({experiment:'communication',beta:1,seed,horizon:180});
    for(let i=0;i<180;i++){sim.step();if([0,30,179].includes(i))verify(sim);}
    assert.equal(sim.deployTopology().phase,'deployment');
    for(let i=0;i<5;i++)sim.step();verify(sim);
  }
});

test('inspected command remains exact through reliability actions, saved replay and history review',async()=>{
  const h=harness(undefined,'communication');h.inspectLink(5,7);
  assert.equal(h.commandInspection(),null);assert.equal(h.node('command-rows').children.length,0);
  for(let i=0;i<35;i++)h.click('step');
  const snapshot=plain(h.snapshot()),reading=h.commandInspection();assert.equal(reading.rows.length,4);
  assert.equal(h.node('command-rows').children.length,4);
  h.click('source-fault');assert.deepEqual(h.commandInspection(),reading,'Paused action cannot rewrite prior executed coefficients or preview');
  assert.deepEqual(plain(h.snapshot().states),snapshot.states);assert.deepEqual(plain(h.snapshot().cumulative),snapshot.cumulative);
  const restored=harness(h.saved());assert.deepEqual(restored.commandInspection(),reading,'Replay retains exact decomposition');
  h.event('topology-history','input');assert.equal(h.commandInspection(),null);
  assert.equal(h.node('command-rows').children.length,0,'History clears stale current command rows');
  h.click('history-live');assert.deepEqual(h.commandInspection(),reading);
  h.check('auto-compare',false);await compare(h);h.click('deploy');h.click('run');
  h.inspectLink(5,7);assert.equal(h.commandInspection(),null,'Fresh comparison cannot reuse discovery commands');
  h.click('step');assert.equal(h.commandInspection().action,0);assert.equal(h.state().playing,false);
});

test('prediction adaptation and segment extension keep command inspection tied to the executed row',()=>{
  const h=harness(),sim=new PowerDemo.Simulation({experiment:'prediction',seed:3,horizon:40});
  for(let i=0;i<38;i++)sim.step();
  const verify=()=>{
    const snapshot=sim.snapshot(),reading=h.decompose(snapshot,sim.segments,sim.forecasts,12,8);
    for(const item of reading.rows)assert.ok(Math.abs(Math.max(-70,Math.min(70,item.requestedKvar))-item.commandKvar)<1e-8);
  };
  verify();sim.extend(12);for(let i=0;i<8;i++)sim.step();verify();
  sim.deployTopology();for(let i=0;i<35;i++)sim.step();verify();
});


test('rolling source errors use only revealed pairs with a bounded window and signed raw bias',()=>{
  const h=harness(undefined,'communication');
  const samples=Array.from({length:65},(_,t)=>({t,forecast:Array(24).fill(0),disturbance:Array(24).fill(0)}));
  for(const sample of samples)sample.forecast[6]=sample.t%2?4:3;
  const future={t:65,get forecast(){throw Error('Future forecast accessed');},get disturbance(){throw Error('Future truth accessed');}};
  assert.equal(h.errorWindow(samples,7,0),null);
  const pair=h.errorWindow(samples,7,2);
  assert.equal(pair.count,2);assert.equal(pair.bias,3.5);assert.equal(pair.rmse,Math.sqrt(12.5));
  const before=JSON.stringify(samples),window=h.errorWindow([...samples,future],7,65);
  const values=samples.slice(-60).map(sample=>sample.forecast[6]);
  assert.equal(window.count,60);assert.equal(window.firstAction,5);assert.equal(window.lastAction,64);
  assert.equal(window.firstObservedAt,6);assert.equal(window.lastObservedAt,65);
  assert.equal(window.bias,values.reduce((sum,v)=>sum+v,0)/60);
  assert.equal(window.rmse,Math.sqrt(values.reduce((sum,v)=>sum+v*v,0)/60));
  assert.equal(JSON.stringify(samples),before,'Computing error cannot mutate observations');
});

test('reliability timing follows the actual sealed prefix at zero, one and later sample times',()=>{
  for(const time of [0,1,35]){
    const h=harness(undefined,'communication');for(let i=0;i<time;i++)h.click('step');
    h.inspectLink(5,7);const issued=h.issuedForecasts(),before=h.sourceHistory().stats;
    for(let i=0;i<3;i++)h.click('source-fault');
    const change=h.sourceHistory().change;
    assert.equal(change.firstAction,issued.length,'First affected target starts beyond the actual sealed prefix');
    assert.equal(change.issuedAt,Math.max(1,time));assert.equal(change.pairAt,issued.length+1);
    assert.equal(change.issued,false);assert.equal(change.observed,false);assert.equal(change.pairsInWindow,0);
    assert.deepEqual(h.sourceHistory().stats,before,'Changing a setting cannot rewrite observed errors');
    assert.deepEqual(h.issuedForecasts(),issued);
    while(h.snapshot().t<=change.issuedAt)h.click('step');
    const message=h.issuedForecasts()[change.firstAction];
    assert.equal(message.issuedAt,change.issuedAt);assert.equal(h.sourceHistory().change.issued,true);
    assert.equal(h.sourceHistory().change.observed,false);
    while(h.snapshot().t<change.pairAt)h.click('step');
    assert.equal(h.sourceHistory().change.observed,true);assert.equal(h.sourceHistory().change.pairsInWindow,1);
    assert.equal(h.sourceHistory().stats.lastAction,change.firstAction);
    assert.equal(h.state().playing,false);
  }
});

test('new source messages affect preview commands before their targets enter observed errors',()=>{
  const changed=harness(undefined,'communication'),reference=harness(undefined,'communication');
  for(const h of [changed,reference])h.inspectLink(5,7);
  changed.click('source-fault');
  for(const h of [changed,reference])h.click('step');
  assert.deepEqual(changed.snapshot().commandQ,reference.snapshot().commandQ,'Initial preview was already sealed');
  for(const h of [changed,reference])h.click('step');
  const first=changed.sourceHistory().change;
  assert.equal(first.firstAction,5);assert.equal(first.issuedAt,1);assert.equal(first.issued,true);assert.equal(first.observed,false);
  assert.notDeepEqual(changed.snapshot().commandQ.static,reference.snapshot().commandQ.static,'Issued future message is available to the current preview controller');
  assert.deepEqual(changed.snapshot().lastSample.forecast,reference.snapshot().lastSample.forecast,'Current observed target still belongs to the sealed prefix');
  assert.ok(Math.abs(changed.sourceHistory().stats.rmse-reference.sourceHistory().stats.rmse)<1e-12,'Control changes cannot masquerade as newly observed source error');
  assert.deepEqual(changed.issuedForecasts()[5].base,reference.issuedForecasts()[5].base,'Physical background stays paired');
});

test('rolling error history preserves exact replay, phase resets, saved history guards and unforecast physical error',async()=>{
  const h=harness(undefined,'communication');h.inspectLink(5,7);h.click('source-fault');
  const errors=[];
  for(let i=0;i<65;i++){h.click('step');const sample=h.snapshot().lastSample;errors.push(sample.forecast[6]-sample.disturbance[6]);}
  const history=h.sourceHistory(),values=errors.slice(-60),before=plain(h.snapshot());
  assert.equal(history.stats.count,60);assert.equal(history.stats.firstObservedAt,6);
  assert.equal(history.stats.rmse,Math.sqrt(values.reduce((sum,v)=>sum+v*v,0)/60));
  assert.equal(history.stats.bias,values.reduce((sum,v)=>sum+v,0)/60);
  h.click('source-fault');assert.deepEqual(h.sourceHistory().stats,history.stats);
  assert.deepEqual(plain(h.snapshot().states),before.states);assert.deepEqual(plain(h.snapshot().cumulative),before.cumulative);
  const restored=harness(h.saved());assert.deepEqual(restored.sourceHistory(),h.sourceHistory());
  h.event('topology-history','input');assert.equal(h.sourceHistory(),null);
  assert.equal(h.node('forecast-window').dataset.rmse,'');assert.equal(h.node('forecast-change').dataset.firstAction,'');
  h.click('history-live');assert.ok(h.sourceHistory().stats);
  h.check('auto-compare',false);await compare(h);h.click('deploy');h.click('run');h.inspectLink(5,7);
  assert.equal(h.sourceHistory().stats,null);assert.equal(h.sourceHistory().change,null,'Phase reset keeps source setting, not old message events');
  assert.match(h.node('forecast-change').textContent,/Initial setting/);
  const physical=harness(undefined,'communication');physical.change('noise',0);physical.change('intervention','power');
  physical.change('attack-mode','pulse');physical.change('bus',23);physical.quickClick();physical.click('run');physical.inspectLink(5,24);
  physical.click('step');assert.ok(physical.sourceHistory().stats.rmse>1e-7,'Unexpected physical forcing still produces error at zero forecast noise');
  assert.match(physical.node('forecast-change').textContent,/Noise disabled.*Unforecast power/);
});


test('protocol receipt follows automatic discovery selection synthesis and fixed comparison with retained source settings',async()=>{
  const h=harness(undefined,'communication');h.inspectLink(5,7);
  assert.deepEqual(h.protocol(),{phase:'discovery',view:'discovery',discoverySamples:0,comparisonSamples:0,
    selection:'pending',synthesis:'pending',links:'candidates',predictionWeights:'adaptive',historyAt:null});
  assert.match(h.node('phase-note').textContent,/Discovery · Dense messages · Candidate sparse links/);
  h.click('source-fault');h.click('run');await h.samples(179);h.click('run');
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().t,0);
  assert.equal(h.snapshot().faults.includes(7),true);
  const receipt=h.protocol();
  assert.deepEqual(receipt,{phase:'deployment',view:'comparison',discoverySamples:180,comparisonSamples:0,
    selection:'complete',synthesis:'complete',links:'fixed',predictionWeights:'fixed',historyAt:null});
  assert.equal(h.node('phase').dataset.discoverySamples,'180');
  assert.match(h.node('phase-note').textContent,/Sparse comparison · 180 learning samples · Fixed links and gains/);
  assert.equal(Object.values(h.snapshot().cumulative).every(value=>value===0),true);
  const support=plain(h.snapshot().deployedSupport),calibration=plain(h.snapshot().calibration);
  for(let i=0;i<8;i++)h.click('step');
  assert.deepEqual(plain(h.snapshot().deployedSupport),support);assert.deepEqual(plain(h.snapshot().calibration),calibration);
  assert.equal(h.protocol().comparisonSamples,8);
  const restored=harness(h.saved());assert.deepEqual(restored.protocol(),h.protocol());
  h.click('deploy');assert.equal(h.protocol().selection,'pending');assert.equal(h.protocol().discoverySamples,0);
  assert.equal(h.snapshot().faults.includes(7),true);assert.match(h.node('phase').textContent,/Learning/);
});

test('manual comparison receipt reports actual sample count and separates prediction adaptation from fixed topology evaluation',()=>{
  for(const experiment of ['communication','prediction']){
    const h=harness(undefined,experiment);h.check('auto-compare',false);
    for(let i=0;i<31;i++)h.click('step');
    assert.equal(h.protocol().discoverySamples,31);assert.equal(h.protocol().selection,'pending');
    assert.match(h.node('phase').textContent,/Learning 31 s/);
    h.click('deploy');h.click('run');
    assert.equal(h.protocol().discoverySamples,31,'Never invent an automatic 180 sample discovery for manual comparison');
    assert.equal(h.protocol().selection,experiment==='communication'?'complete':'not-applicable');assert.equal(h.protocol().synthesis,'complete');
    assert.equal(h.protocol().predictionWeights,experiment==='communication'?'fixed':'adaptive');
    assert.match(h.node('phase-note').textContent,experiment==='communication'?/Sparse comparison.*Fixed links and gains/:/Fresh dense comparison · Updates restart at 30 s/);
    const before=plain(h.snapshot());
    h.event('topology-history','input');
    assert.equal(h.protocol().view,'saved-discovery');assert.equal(h.node('phase').dataset.phase,'deployment');
    assert.match(h.node('phase-note').textContent,/Saved links at .* · Trial continues in comparison/);
    assert.deepEqual(plain(h.snapshot()),before,'Archive view cannot reselect links or change the plant');
    h.click('history-live');assert.equal(h.protocol().view,'comparison');
    assert.deepEqual(plain(h.snapshot()),before);
  }
});

test('leaving saved discovery through matrix mode restores live source controls without a plant step or autoplay',async()=>{
  const h=harness(undefined,'communication');await compare(h);if(h.state().playing)h.click('run');
  h.click('step');h.inspectLink(5,7);
  const before=plain(h.snapshot());assert.ok(h.sourceHistory().stats);
  h.event('topology-history','input');
  assert.equal(h.protocol().view,'saved-discovery');assert.equal(h.node('source-fault').disabled,true);
  assert.equal(h.sourceHistory(),null);assert.equal(h.node('matrix-title').textContent,'Online SLS links');
  assert.match(h.node('matrix-title').title,/Saved discovery links at/);assert.equal(h.node('matrix-title').dataset.context,'saved-discovery');
  h.change('matrix-view','change');
  assert.equal(h.state().historyIndex,null);assert.equal(h.protocol().view,'comparison');
  assert.equal(h.node('source-fault').disabled,false);assert.ok(h.sourceHistory().stats);
  assert.ok(h.commandInspection());assert.equal(h.state().playing,false);
  assert.equal(h.node('matrix-title').textContent,'Learned sparse links');
  assert.match(h.node('matrix-title').title,/Fixed deployed prediction links/);assert.equal(h.node('matrix-title').dataset.context,'comparison');
  assert.deepEqual(plain(h.snapshot()),before);
});

test('temporal source gain norms are visible for every controller without hover and remain read only',()=>{
  const h=harness(undefined,'communication');h.inspectLink(5,7);h.click('step');
  const before=plain(h.snapshot()),reading=h.commandInspection(),rows=h.node('command-rows').children;
  assert.equal(rows.length,4);
  for(let i=0;i<4;i++){
    assert.equal(rows[i].children.length,7,'Controller plus five kvar terms and source gain');
    const cell=rows[i].children.at(-1);
    assert.equal(cell.className,'source-gain');assert.equal(cell.textContent,reading.rows[i].gainNorm.toPrecision(4));
  }
  assert.equal(rows[3].children.at(-1).textContent,'0.000','Feedback has no forecast source gain');
  assert.deepEqual(plain(h.snapshot()),before);
  h.click('source-fault');
  assert.deepEqual(h.commandInspection(),reading,'Paused reliability toggle cannot rewrite executed source gains');
  h.event('topology-history','input');assert.equal(h.node('command-rows').children.length,0);
  h.click('history-live');assert.equal(h.node('command-rows').children.length,4);
  const restored=harness(h.saved());
  assert.deepEqual(restored.commandInspection(),h.commandInspection(),'Replay preserves the same executed gains');
});

test('forecast markers show paused changes at their actual setting time and preserve repeated actions and replay',()=>{
  const h=harness(undefined,'communication');h.inspectLink(5,7);
  const before=plain(h.snapshot());h.click('source-fault');h.click('source-fault');h.click('source-fault');
  const events=h.interventionEvents();
  assert.equal(events.length,3);assert.deepEqual(events.map(e=>e.at),[0,0,0]);
  assert.deepEqual(events.map(e=>e.faulty),[true,false,true]);
  assert.deepEqual(plain(h.snapshot().states),before.states);assert.deepEqual(plain(h.snapshot().cumulative),before.cumulative);
  const groups=h.interventionGroups(h.snapshot());assert.equal(groups[0].forecasts,3);assert.equal(groups[0].attacks,0);
  assert.match(groups[0].description,/marked noisy at 0 s.*First eligible issue 1 s.*Target 5 s.*Pair 6 s/);
  assert.match(groups[0].description,/marked quiet at 0 s/);
  const restored=harness(h.saved());assert.deepEqual(restored.interventionEvents(),events,'Use immutable log equally before and after replay');
  h.click('step');const history=h.interventionEvents();assert.deepEqual(history,events,'A later sample cannot rewrite setting times or actions');
});

test('mixed event groups count power forecasts and solar changes independently without showing pending physical events',()=>{
  const h=harness(undefined,'communication'),view={t:6,experiment:'communication',beta:1,eventLog:[
    {t:0,type:'pulse',bus:23,strength:100},{t:0,type:'forecast',bus:7,faulty:true},
    {t:1,type:'forecast',bus:7,faulty:false},{t:1,type:'scenario',message:'Solar outage restored'},
    {t:6,type:'forecast',bus:8,faulty:true},{t:6,type:'pulse',bus:23,strength:50},
    {t:7,type:'forecast',bus:9,faulty:true},{t:0,type:'extend',steps:20}]};
  const before=JSON.stringify(view),events=h.interventionEvents(view),groups=h.interventionGroups(view);
  assert.deepEqual(events.map(e=>e.at),[0,1,1,2,6]);
  assert.equal(groups.length,1);assert.equal(groups[0].attacks,1);assert.equal(groups[0].forecasts,3);assert.equal(groups[0].scenarios,1);
  assert.equal(groups[0].label,'Events ×5');assert.match(groups[0].accessible,/1 power request.*3 forecast setting changes.*1 solar event.*Solar outage restored/);
  assert.match(groups[0].description,/100 kW requested.*Applied power is bounded/);
  assert.equal(JSON.stringify(view),before);
  const separate=h.interventionGroups(view,[1,2],200);
  assert.equal(separate.reduce((n,g)=>n+g.items.length,0),3,'Domain filtering uses displayed event time, not a blanket next sample offset');
  const zero=h.interventionGroups({...view,beta:0})[0];assert.match(zero.description,/Noise disabled at β 0/);
});

test('comparison resets marker history while retaining source reliability and exact held out replay',async()=>{
  const h=harness(undefined,'communication');h.inspectLink(5,7);h.click('source-fault');
  h.check('auto-compare',false);for(let i=0;i<31;i++)h.click('step');
  h.click('deploy');h.click('run');assert.equal(h.snapshot().phase,'deployment');
  assert.equal(h.snapshot().faults.includes(7),true);assert.deepEqual(h.interventionEvents(),[]);
  h.inspectLink(5,7);h.click('source-fault');
  assert.deepEqual(h.interventionEvents().map(e=>[e.at,e.faulty]),[[0,false]]);
  const restored=harness(h.saved());assert.deepEqual(restored.interventionEvents(),h.interventionEvents());
});


test('the shipped default runs demand and solar discovery then pauses the complete comparison',async()=>{
  const h=harness(undefined,null);
  assert.equal(h.snapshot().experiment,'communication');
  assert.equal(h.snapshot().powerScenario,'forecasted-demand');assert.equal(h.snapshot().beta,4);
  assert.equal(h.node('auto-compare').checked,true);assert.equal(h.node('new-scenario').hidden,true);
  assert.match(h.node('scenario-description').title,/compare four controllers automatically/);
  assert.match(h.node('scenario-description').textContent,/^Forecast noise SD \(mpu\) · quiet .* · noisy /);
  assert.equal(h.node('scenario-description').dataset.quiet,'8');assert.equal(h.node('scenario-description').dataset.noisy,'15');
  h.click('run');await h.clock.until(()=>h.snapshot().phase==='deployment');
  assert.equal(h.snapshot().t,0);assert.equal(h.state().playing,true);
  await h.clock.until(()=>h.state().comparisonComplete);
  assert.equal(h.snapshot().t,180);assert.equal(h.state().playing,false);assert.equal(h.node('run').textContent,'Continue');
  assert.equal(h.node('phase').textContent,'Comparison complete');
  assert.deepEqual(h.comparison().plotted,['online','scalar','static','causal']);
  const finished=h.snapshot();await h.samples(30);assert.deepEqual(h.snapshot(),finished,'Finished result remains still');
  const restored=harness(h.saved());assert.equal(restored.snapshot().powerScenario,'forecasted-demand');assert.equal(restored.snapshot().beta,4);
  assert.equal(restored.state().comparisonComplete,true);assert.deepEqual(restored.snapshot().cumulative,finished.cumulative);
  h.click('run');assert.equal(h.snapshot().t,181);assert.equal(h.state().playing,true);assert.equal(h.state().comparisonContinued,true);
  await h.samples(3);h.click('run');assert.ok(h.snapshot().t>181);assert.equal(h.state().comparisonComplete,false);
  for(const key of ['online','scalar','static','causal'])assert.ok(h.snapshot().cumulative[key]>=finished.cumulative[key]);
  const continued=harness(h.saved());assert.equal(continued.state().comparisonContinued,true);assert.equal(continued.state().comparisonComplete,false);
});

test('the new scenario action preserves a restored trial until an explicit fresh start',async()=>{
  const old=harness(undefined,'communication');old.change('intervention','power');pointerClick(old,old.bus(23));
  await old.samples(8);old.click('run');const saved=old.saved(),restored=harness(saved);
  assert.equal(restored.snapshot().powerScenario,'reference');assert.equal(restored.node('new-scenario').hidden,false);
  assert.match(restored.node('scenario-description').title,/Restored run/);
  assert.match(restored.node('trial-context').textContent,/unforecast power requests/);
  assert.deepEqual(restored.snapshot().cumulative,old.snapshot().cumulative);
  restored.change('intervention','forecast');assert.deepEqual(restored.snapshot().cumulative,old.snapshot().cumulative,'Mode selection never silently removes old costs');
  restored.click('new-scenario');assert.equal(restored.snapshot().powerScenario,'forecasted-demand');assert.equal(restored.snapshot().beta,4);
  assert.equal(restored.snapshot().phase,'discovery');assert.equal(restored.state().playing,true);assert.equal(restored.state().intervention,'forecast');
  assert.deepEqual(restored.state().activeAttackBuses,[]);assert.equal(restored.snapshot().eventLog.some(event=>event.type==='pulse'),false);
  assert.ok(restored.snapshot().t<=1,'Explicit action starts only the new trial');
  assert.equal(restored.node('trial-context').hidden,true);
});

test('new scenario attacks cross handoff and stop honestly at the reviewed endpoint',async()=>{
  const h=harness(undefined,null);h.change('intervention','power');
  for(const bus of [20,22,23])pointerClick(h,h.bus(bus));
  await h.clock.until(()=>h.snapshot().phase==='deployment');
  assert.deepEqual(h.state().activeAttackBuses,[20,22,23]);
  await h.clock.until(()=>h.state().comparisonComplete);
  assert.equal(h.snapshot().t,180);assert.equal(h.state().playing,false);assert.deepEqual(h.state().activeAttackBuses,[]);
  const count=pulses(h).length;await h.samples(5);assert.equal(pulses(h).length,count);
  assert.ok(h.snapshot().activePulses.length>0,'Pausing preserves the residual physical disturbance');
  assert.equal(h.node('new-scenario').hidden,false);assert.match(h.node('trial-context').textContent,/unforecast power requests/);
  h.click('step');assert.equal(h.snapshot().t,181);assert.equal(h.state().playing,false);assert.equal(h.state().comparisonComplete,false);
  pointerClick(h,h.bus(23));assert.equal(h.state().playing,true);await h.samples(2);assert.ok(pulses(h).length>count);
});

test('scheduled cycle markers distinguish forecasted power from surprise attacks',async()=>{
  const h=harness(undefined,null);h.click('step');
  const scheduled=h.interventionGroups(h.snapshot()).filter(group=>group.items.some(event=>event.type==='scenario'));
  assert.ok(scheduled.length>0);assert.match(scheduled[0].label,/Scheduled cycle/);
  assert.match(scheduled[0].description,/Included in issued forecasts/);
  assert.doesNotMatch(scheduled[0].description,/Absent from forecasts/);
  const sum=h.snapshot().lastScenarioApplications.reduce((total,item)=>total+item.appliedKw,0);
  assert.ok(Math.abs(Number(h.node('scheduled-power').dataset.appliedKw)-sum)<1e-8);
  const view={t:250,beta:4,experiment:'communication',eventLog:[
    ...[0,60,120].map(t=>({type:'scenario',t,forecasted:true,message:'Recorded cycle at '+t})),
    {type:'forecast',t:180,bus:7,faulty:true},
    {type:'pulse',t:240,bus:7,strength:100}
  ]};
  const before=JSON.stringify(view),trial=JSON.stringify(h.snapshot()),state=h.state();
  const groups=h.interventionGroups(view,[0,250],3);
  assert.deepEqual(groups.map(group=>group.labelVisible),[true,false,false,true,true],'Only repeated pure forecasted cycle labels are compacted');
  assert.deepEqual(groups.flatMap(group=>group.items.map(item=>item.at)),[1,61,121,180,241],'Every actual event and timestamp remains');
  assert.ok(groups.every(group=>group.description&&group.accessible),'Every marker retains full event details');
  assert.equal(groups[0].label,'Scheduled ×3');
  for(const group of groups.slice(0,3))assert.ok(groups[0].badgeDescription.includes(group.description),'The single visible cycle badge retains every original cycle detail');
  assert.ok(groups.slice(3).every(group=>group.badgeDescription===group.description),'Other event tooltips are unchanged');
  const windowed=h.interventionGroups(view,[60,180],3);
  assert.deepEqual(windowed.map(group=>group.labelVisible),[true,false,true],'The first cycle in the current visible window is labeled');
  assert.equal(windowed[0].label,'Scheduled ×2');
  assert.ok(windowed.slice(0,2).every(group=>windowed[0].badgeDescription.includes(group.description)));
  const solar=h.interventionGroups({...view,eventLog:[{type:'scenario',t:0,forecasted:false,message:'Unforecast outage'},{type:'scenario',t:60,forecasted:false,message:'Unforecast recovery'}]},[0,180],3);
  assert.deepEqual(solar.map(group=>group.labelVisible),[true,true],'Unforecast outages and recovery keep every label');
  const long=h.interventionGroups({...view,t:600,eventLog:Array.from({length:9},(_,i)=>({type:'scenario',t:i*60,forecasted:true,message:'Recorded cycle '+i}))},[0,600],1);
  assert.equal(long[0].label,'Scheduled ×9');assert.equal(long[0].items.length,9);assert.equal(long[0].details.length,8);
  assert.match(long[0].badgeDescription,/Latest 8 events shown/,'Retain the original explicit detail cap without dropping event records or inventing older details');
  assert.equal(JSON.stringify(view),before);assert.equal(JSON.stringify(h.snapshot()),trial);assert.deepEqual(h.state(),state);
});


test('corrupting every scenario source reports the missing reliable alternatives and offers a fresh start',()=>{
  const h=harness(undefined,null);
  for(let bus=2;bus<=24;bus++)if(!h.snapshot().faults.includes(bus)) {h.change('bus',bus);h.click('fault');}
  assert.equal(h.snapshot().faults.length,23);assert.equal(h.snapshot().t,0);
  assert.equal(h.node('trial-context').hidden,false);assert.equal(h.node('trial-context').dataset.allSourcesNoisy,'true');
  assert.match(h.node('trial-context').textContent,/All forecast sources are noisy.*No reliable alternative to select/);
  assert.equal(h.node('new-scenario').hidden,false);
  h.click('new-scenario');assert.equal(h.snapshot().powerScenario,'forecasted-demand');assert.equal(h.snapshot().beta,4);
  assert.equal(h.snapshot().faults.length,15);assert.equal(h.node('trial-context').hidden,true);
  assert.deepEqual(h.snapshot().faults,PowerDemo.constants.busProfiles.filter(profile=>profile.role==='Homes').map(profile=>profile.bus));
  assert.equal(h.snapshot().eventLog.some(event=>event.type==='forecast'||event.type==='pulse'),false);
});


test('Advance 180 reports an early comparison endpoint honestly and can explicitly continue it',async()=>{
  const h=harness(undefined,null);await compare(h);
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.snapshot().t,0);
  for(let i=0;i<100;i++)h.click('step');
  await compare(h);assert.equal(h.snapshot().t,180);assert.equal(h.state().comparisonComplete,true);
  assert.match(h.node('event').textContent,/Comparison complete/);assert.doesNotMatch(h.node('event').textContent,/180 samples added/);
  const finished=h.snapshot().cumulative;await compare(h);
  assert.equal(h.snapshot().t,360);assert.equal(h.state().comparisonContinued,true);
  assert.match(h.node('event').textContent,/180 samples added/);
  for(const key of ['online','scalar','static','causal'])assert.ok(h.snapshot().cumulative[key]>finished[key]);
});


test('paused completed source actions retain reviewed results and continue with exact replay and first issue timing',async()=>{
  const h=harness(undefined,null);h.click('run');
  await h.clock.until(()=>h.state().comparisonComplete);
  h.inspectLink(5,7);
  const finished=plain(h.snapshot()),issued=h.issuedForecasts();
  for(const faulty of [true,false,true]){
    h.click('source-fault');
    const current=h.snapshot();
    assert.equal(current.faults.includes(7),faulty);
    assert.equal(current.t,180);assert.equal(current.mode,'completed');assert.equal(current.horizon,finished.horizon);
    assert.equal(h.state().comparisonComplete,true);assert.equal(h.state().comparisonContinued,false);
    assert.equal(h.state().playing,false);assert.equal(h.node('run').textContent,'Continue');
    assert.equal(h.state().selectedBus,5);assert.equal(h.state().inspectedSource,7);
    assert.deepEqual(current.cumulative,finished.cumulative);assert.deepEqual(current.states,finished.states);
    assert.deepEqual(current.segments,finished.segments);assert.deepEqual(current.deployedSupport,finished.deployedSupport);
    assert.deepEqual(h.issuedForecasts(),issued);
    assert.equal(current.eventLog.some(event=>event.type==='extend'),false);
    assert.equal(h.sourceHistory().change.issued,false);
  }
  const saved=h.saved(),direct=harness(saved),bus=harness(saved);
  assert.deepEqual(direct.snapshot(),h.snapshot(),'Version 14 restores the pending endpoint settings exactly');
  assert.equal(direct.state().comparisonComplete,true);assert.equal(direct.node('run').textContent,'Continue');
  // A paused repair followed by Continue must match an explicit bus repair that starts playback.
  direct.click('source-fault');assert.equal(direct.state().comparisonComplete,true);direct.click('run');
  pointerClick(bus,bus.bus(7));assert.equal(bus.state().playing,true);assert.equal(bus.state().comparisonContinued,true);
  assert.equal(bus.snapshot().t,180);await bus.samples(1);
  assert.deepEqual(bus.snapshot(),direct.snapshot(),'Click-to-play applies the setting before the first extended preview is issued');
  assert.deepEqual(bus.issuedForecasts(),direct.issuedForecasts());
  assert.equal(bus.snapshot().t,181);assert.equal(bus.snapshot().faults.includes(7),false);
  bus.click('run');assert.equal(bus.state().playing,false);
  assert.deepEqual(harness(bus.saved()).snapshot(),bus.snapshot());
});


test('the final applied pulse sample stays visible after its request expires and replays exactly',async()=>{
  for(const [bus,steps] of [[23,12],[7,24],[8,8]]){
    const h=harness(undefined,'communication');h.check('auto-compare',false);
    h.change('intervention','power');h.change('attack-mode','pulse');h.change('bus',bus);h.quickClick();
    await h.samples(steps);h.click('run');
    const finished=plain(h.snapshot());
    assert.equal(finished.t,steps);assert.equal(finished.activePulses.length,0,'No request remains for the next sample');
    assert.ok(finished.lastPulseApplications.some(item=>item.bus===bus&&item.appliedKw>0),'The current sample still includes actual applied power');
    assert.equal(h.node('pulse').dataset.attackState,'paused','Do not report idle while the displayed sample contains attack power');
    h.change('bus',bus===23?7:23);h.change('bus',bus);
    h.change('intervention','forecast');h.change('intervention','power');
    assert.equal(h.node('pulse').dataset.attackState,'paused');
    assert.deepEqual(plain(h.snapshot()),finished,'Selection and interaction mode cannot rewrite physical results');
    const restored=harness(h.saved());
    assert.deepEqual(plain(restored.snapshot()),finished);
    assert.equal(restored.node('pulse').dataset.attackState,'paused','Replay keeps the final applied sample visible');
    h.click('step');assert.equal(h.snapshot().lastPulseApplications.length,0);
    assert.equal(h.node('pulse').dataset.attackState,'idle','Clear only after a new sample has no applied request');
    assert.equal(pulses(h).length,1,'No display operation adds physical requests');
  }
});


test('every completed segment defers source settings until explicit continuation without stale first issuance',async()=>{
  for(const phase of ['discovery','deployment','continued-default']){
    const h=harness(undefined,phase==='continued-default'?null:'communication');
    h.check('auto-compare',false);
    if(phase!=='discovery'){
      for(let i=0;i<31;i++)h.click('step');
      h.click('deploy');h.click('run');
      for(let i=0;i<180;i++)h.click('step');
      if(phase==='continued-default')h.click('step');
    }
    while(h.snapshot().t<h.snapshot().horizon)h.click('step');
    assert.equal(h.snapshot().mode,'completed');
    h.inspectLink(5,7);
    const finished=plain(h.snapshot()),sealed=h.issuedForecasts(),wasNoisy=finished.faults.includes(7);
    h.click('source-fault');
    const pending=h.snapshot();
    assert.equal(pending.faults.includes(7),!wasNoisy);
    assert.equal(pending.mode,'completed',phase+' setting must not reopen the planning segment');
    assert.equal(pending.horizon,finished.horizon,phase+' setting must not seal a new preview');
    assert.equal(pending.t,finished.t);assert.equal(h.state().playing,false);
    for(const key of ['segments','states','cumulative','deployedSupport'])assert.deepEqual(pending[key],finished[key],phase+' preserves '+key);
    assert.deepEqual(h.issuedForecasts(),sealed,phase+' preserves every already issued message');
    const saved=h.saved(),direct=harness(saved),bus=harness(saved),unchanged=harness(saved);
    assert.deepEqual(direct.snapshot(),pending,phase+' pending setting replays exactly');
    // Repair back to the original state only in the paired unchanged branch.
    unchanged.click('source-fault');
    direct.click('run');unchanged.click('run');
    pointerClick(bus,bus.bus(7));assert.equal(bus.state().playing,true);
    await bus.samples(1);
    assert.deepEqual(bus.snapshot(),unchanged.snapshot(),phase+' explicit bus repair matches paused repair followed by Run');
    assert.deepEqual(bus.issuedForecasts(),unchanged.issuedForecasts());
    const changed=direct.issuedForecasts(),baseline=unchanged.issuedForecasts(),target=finished.t+4;
    assert.deepEqual(changed.slice(0,sealed.length),sealed,'Issued history remains immutable');
    assert.equal(changed[target].issuedAt,finished.t,'The extension issues at the boundary');
    assert.equal(direct.snapshot().faults.includes(7),!wasNoisy);
    assert.equal(unchanged.snapshot().faults.includes(7),wasNoisy);
    assert.deepEqual(changed[target].base,baseline[target].base,'Paired physical realization is unchanged');
    assert.notEqual(changed[target].forecast[6],baseline[target].forecast[6],'Positive noise changes the selected newly issued source');
    for(let j=0;j<24;j++)if(j!==6)assert.equal(changed[target].forecast[j],baseline[target].forecast[j],'Other issued sources are identical');
    direct.click('run');
    assert.deepEqual(harness(direct.saved()).snapshot(),direct.snapshot(),phase+' continued replay stays exact');
  }
});


test('pending boundary settings preserve paired physical power for all original and reserved seeds',()=>{
  const template=harness(undefined,'communication');template.check('auto-compare',false);
  const record=plain(template.saved());
  record.privateContent.initialOptions.horizon=6; // Short finite segment for the boundary-only regression.
  for(const seed of [...Array.from({length:40},(_,i)=>i+1),20261013]){
    record.privateContent.initialOptions.seed=seed;record.privateContent.initialOptions.beta=4;
    const changed=harness(record),baseline=harness(record);
    for(const surface of [changed,baseline]){
      for(let i=0;i<6;i++)surface.click('step');
      surface.inspectLink(5,7);
    }
    const before=plain(changed.snapshot()),sealed=changed.issuedForecasts();
    changed.click('source-fault');
    assert.equal(changed.snapshot().mode,'completed','Seed '+seed+' keeps the closed segment');
    assert.equal(changed.snapshot().horizon,6);
    assert.deepEqual(changed.issuedForecasts(),sealed);
    for(const key of ['states','cumulative','segments'])assert.deepEqual(changed.snapshot()[key],before[key]);
    for(const surface of [changed,baseline])surface.click('step');
    const message=changed.issuedForecasts()[10],counterfactual=baseline.issuedForecasts()[10];
    assert.equal(message.issuedAt,6);assert.equal(counterfactual.issuedAt,6);
    assert.deepEqual(message.base,counterfactual.base,'Seed '+seed+' keeps paired realized power');
    assert.notEqual(message.forecast[6],counterfactual.forecast[6],'Seed '+seed+' applies the selected source setting on first issuance');
    for(let j=0;j<24;j++)if(j!==6)assert.equal(message.forecast[j],counterfactual.forecast[j],'Seed '+seed+' leaves all other sources identical');
  }
});


test('restored guided trials with wider horizons keep the 180 sample review pending',async()=>{
  const template=harness(undefined,null);template.check('auto-compare',true);
  const saved=plain(template.saved());saved.privateContent.initialOptions.horizon=480;
  const h=harness(saved);h.click('run');await h.clock.until(()=>h.state().comparisonComplete);
  assert.equal(h.snapshot().t,180);assert.equal(h.snapshot().mode,'running','The guided stop can precede the engine horizon');
  h.inspectLink(5,7);const before=plain(h.snapshot()),sealed=h.issuedForecasts();
  h.click('source-fault');
  assert.equal(h.state().comparisonComplete,true);assert.equal(h.state().comparisonContinued,false);
  assert.equal(h.state().playing,false);assert.equal(h.node('run').textContent,'Continue');
  for(const key of ['t','horizon','mode','segments','states','cumulative','deployedSupport'])assert.deepEqual(h.snapshot()[key],before[key]);
  assert.deepEqual(h.issuedForecasts(),sealed);
  assert.deepEqual(harness(h.saved()).snapshot(),h.snapshot(),'The wider legacy horizon replays exactly');
});


test('primary restart clears comparison, attacks and custom source changes while preserving selected experiment settings',async()=>{
  const h=harness(undefined,'communication');
  h.change('noise','8');h.change('power-scenario','solar-outage');h.change('speed','32');
  h.change('attack-mode','continuous');h.change('strength','150');
  await compare(h);assert.equal(h.snapshot().phase,'deployment');
  h.change('intervention','power');pointerClick(h,h.bus(23));await h.samples(4);
  h.change('bus','7');h.click('fault');h.click('cost-gap');h.change('matrix-view','change');
  assert.ok(Object.values(h.snapshot().cumulative).some(value=>value>0));
  assert.ok(h.snapshot().eventLog.length>0);assert.ok(h.state().activeAttackBuses.length>0);
  h.click('restart');const restarted=h.snapshot();
  assert.equal(restarted.phase,'discovery');assert.equal(restarted.t,0);assert.equal(restarted.deployedSupport,null);
  assert.equal(restarted.discoveryRecord,null);assert.equal(restarted.experiment,'communication');
  assert.equal(restarted.beta,8);assert.equal(restarted.powerScenario,'solar-outage');
  assert.equal(h.node('speed').value,'32');assert.equal(h.node('attack-mode').value,'continuous');assert.equal(h.node('strength').value,'150');
  assert.equal(h.node('auto-compare').checked,true);assert.equal(h.node('view').value,'learning');
  assert.equal(h.node('matrix-view').value,'links');assert.equal(h.node('cost-metric').value,'total');
  assert.equal(h.node('cost-total')['aria-pressed'],'true');assert.equal(h.node('cost-gap')['aria-pressed'],'false');
  assert.deepEqual(restarted.faults,new PowerDemo.Simulation({experiment:'communication',beta:8,powerScenario:'solar-outage'}).snapshot().faults);
  assert.ok(Object.values(restarted.cumulative).every(value=>value===0));
  assert.equal(restarted.eventLog.length,0);assert.equal(restarted.activePulses.length,0);assert.equal(restarted.pendingPulses.length,0);
  assert.deepEqual(h.state().activeAttackBuses,[]);assert.equal(h.state().playing,false);assert.equal(h.clock.tasks.size,0);
  assert.equal(h.state().topology.events.length,0);assert.equal(h.state().historyIndex,null);assert.equal(h.state().inspectedSource,null);
  assert.deepEqual(h.comparison().plotted,['online','scalar','static','causal']);
  await h.samples(3);assert.equal(h.snapshot().t,0,'Restart stays paused until the next explicit Run');
  h.click('run');await h.clock.until(()=>h.snapshot().phase==='deployment');
  assert.equal(h.snapshot().discoveryRecord.t,180);assert.equal(h.snapshot().t,0);
  assert.ok(Object.values(h.snapshot().cumulative).every(value=>value===0),'Automatic comparison still starts fresh');
});


test('primary attack hint exposes the configured units even while advanced strength is closed',()=>{
  const h=harness();
  for(const strength of ['50','150','100']){
    h.change('strength',strength);
    assert.equal(h.node('attack-hint').textContent,strength+' kW target per bus · Click to start or stop');
    assert.equal(h.snapshot().t,0);assert.equal(h.snapshot().eventLog.length,0);
  }
});

test('bounded continuous targets maintain independent buses, change strength and replay exactly',async()=>{
  const h=harness(),buses=[7,8,23];h.change('strength',150);
  for(const bus of buses)pointerClick(h,h.bus(bus),bus);
  await h.samples(20);
  for(const bus of buses){
    const item=h.snapshot().lastPulseApplications.find(p=>p.bus===bus);
    assert.equal(item.requestedKw,150);assert.ok(item.appliedKw<=150+1e-9);
    assert.equal(h.snapshot().activePulses.filter(p=>p.bus===bus&&p.protocol==='held-target-v1').length,1);
  }
  pointerClick(h,h.bus(8),8);h.change('strength',50);await h.samples(2);
  for(const bus of [7,23])assert.equal(h.snapshot().lastPulseApplications.find(p=>p.bus===bus).requestedKw,50);
  assert.ok(h.snapshot().lastPulseApplications.find(p=>p.bus===8).requestedKw<150);
  h.click('run');const saved=h.saved(),restored=harness(saved);
  for(const key of ['states','cumulative','history','eventLog','lastPulseApplications','activePulses'])assert.deepEqual(restored.snapshot()[key],h.snapshot()[key],'Bounded protocol replay '+key);
  assert.deepEqual(restored.state().activeAttackBuses,[]);
});

test('version fourteen retains explicitly additive pulses without confusing them with continuous targets',()=>{
  const options={preset:'mixed',seed:20261013,horizon:40};
  const current=new PowerDemo.Simulation(options);
  for(let t=0;t<8;t++){current.queuePulse(23,100);current.queuePulse(7,150);current.step();}
  const before=current.snapshot();
  const saved={privateContent:{version:14,algorithmId:ALGORITHM_ID,phase:'discovery',initialOptions:options,t:before.t,events:before.eventLog,attackMode:'pulse',intervention:'power',selectedBus:23,pulseStrength:'100'}};
  const restored=harness(saved);
  for(const key of ['states','cumulative','history','eventLog','lastPulseApplications','activePulses'])assert.deepEqual(restored.snapshot()[key],before[key],'Current additive pulse replay '+key);
  assert.ok(before.lastPulseApplications.find(p=>p.bus===23).requestedKw>100);
  assert.equal(restored.state().playing,false);assert.deepEqual(restored.state().activeAttackBuses,[]);
});

function linkEvidenceFixture(){
  const h=harness(undefined,'communication');h.check('auto-compare',false);
  for(let i=0;i<35;i++)h.click('step');
  h.inspectLink(5,7);h.click('deploy');h.click('run');
  assert.equal(h.snapshot().phase,'deployment');assert.equal(h.state().playing,false);return h;
}
test('link receipt compares actual same-budget supports and discovery scores with resynthesized commands for every cell',()=>{
  const h=linkEvidenceFixture();h.click('step');const snapshot=plain(h.snapshot()),support=snapshot.deployedSupport;
  for(const receiver of PowerDemo.constants.inverterBuses)for(let source=2;source<=24;source++){
    h.inspectLink(receiver,source);const reading=h.linkEvidence(),command=h.commandInspection();
    const row=PowerDemo.constants.inverterBuses.indexOf(receiver),column=source-2;
    assert.equal(reading.source,source);assert.equal(reading.receiver,receiver);
    assert.equal(reading.discoverySamples,35);assert.equal(reading.scoreSamples,support.scoreSamples);
    assert.equal(reading.action,snapshot.lastSample.t);
    assert.equal(h.node('link-receipt').hidden,false);
    for(const item of reading.rows){
      const links=item.key==='scalar'?support.fixedLinks:support.links;
      const scores=item.key==='scalar'?support.discoveryDiagnostics.baselineScores:support.discoveryDiagnostics.learnedScores;
      const actual=command.rows.find(actual=>actual.key===item.key);
      assert.equal(item.budget,links.filter(link=>link.from!==link.to).length);assert.equal(item.budget,24);
      assert.equal(item.selection,source===receiver?'Local':links.some(link=>link.from===source&&link.to===receiver)?'Selected':'Excluded');
      assert.equal(item.score,scores[row][column]);
      for(const key of ['gainNorm','sourceKvar','commandKvar','limited'])assert.equal(item[key],actual[key]);
      assert.equal(item.commandKvar,snapshot.commandQ[item.key][receiver-1]);
      if(item.selection==='Excluded'){assert.ok(Math.abs(item.gainNorm)<1e-8);assert.ok(Math.abs(item.sourceKvar)<1e-8);}
    }
    const discovery=h.node('link-receipt-rows').children,execution=h.node('link-receipt-execution').children;
    assert.deepEqual(plain(discovery.map(row=>row.dataset.measure)),['selection','score']);
    assert.equal(execution[0],h.node('link-receipt-execution-time'),'Keep the actual execution header across repeated inspection');
    assert.deepEqual(plain(execution.slice(1).map(row=>row.dataset.measure)),['gainNorm','sourceKvar','commandKvar']);
    for(const rendered of [...discovery,...execution.slice(1)])for(const cell of rendered.children.slice(1)){
      const item=reading.rows.find(item=>item.key===cell.dataset.controller);
      assert.equal(cell.dataset.value,String(item[rendered.dataset.measure]),'Both groups retain every actual measured value');
    }
  }
  assert.deepEqual(plain(h.snapshot()),snapshot,'Every receipt is read only');
});
test('link receipt distinguishes pending execution and saved history and preserves frozen evidence across reliability and replay',()=>{
  const initial=harness(undefined,'communication');initial.inspectLink(5,7);
  assert.equal(initial.linkEvidence(),null);assert.equal(initial.node('link-receipt').hidden,true);
  const h=linkEvidenceFixture(),pending=h.linkEvidence();
  assert.equal(pending.action,null);for(const row of pending.rows)for(const key of ['gainNorm','sourceKvar','commandKvar'])assert.equal(row[key],null);
  assert.match(h.node('link-receipt-action').textContent,/Step to reveal/);
  h.click('step');const evidence=h.linkEvidence(),before=plain(h.snapshot());
  h.click('source-fault');assert.deepEqual(h.linkEvidence(),evidence,'A paused source setting cannot change past execution or frozen selection');
  assert.deepEqual(plain(h.snapshot().states),before.states);assert.deepEqual(plain(h.snapshot().cumulative),before.cumulative);
  const restored=harness(h.saved());assert.deepEqual(restored.linkEvidence(),evidence,'Version 14 replay recovers actual evidence');
  h.event('topology-history','input');assert.equal(h.linkEvidence(),null);assert.equal(h.node('link-receipt').hidden,true);
  assert.equal(h.node('link-receipt-rows').children.length,0,'Historical view hides current executed values');
  assert.equal(h.node('link-receipt-execution').children.length,1,'Historical view clears all executed rows and retains only its hidden timing header');
  h.click('history-live');assert.deepEqual(h.linkEvidence(),evidence);
  h.change('experiment','prediction');assert.equal(h.linkEvidence(),null,'Adaptive prediction is not a fixed sparse deployment comparison');
});

test('persistent experiment stages explain the automatic reset without stopping ongoing attacks',async()=>{
  const h=harness(undefined,'communication');
  assert.equal(h.node('experiment-progress').hidden,false);
  assert.equal(h.node('progress-learning').dataset.status,'active');
  assert.equal(h.node('progress-learning')['aria-current'],'step');
  assert.equal(h.node('progress-comparison').dataset.status,'pending');
  assert.equal(h.node('progress-comparison')['aria-current'],undefined);
  assert.match(h.node('progress-learning-count').textContent,/^0\b/);
  assert.match(h.node('transition-note').textContent,/fresh/i);
  assert.match(h.node('transition-note').textContent,/fresh trial/i);
  assert.equal(h.node('learning-title').textContent,'Experiment results');
  assert.equal(h.node('results-stage').textContent,'Learning progress');
  assert.equal(h.node('phase').hidden,true,'Communication uses one visible progress explanation');
  const stageBefore=plain(h.progress());
  h.change('intervention','power');pointerClick(h,h.bus(23));
  await h.clock.until(()=>h.snapshot().phase==='deployment');
  assert.equal(h.state().playing,true,'Automatic handoff introduces no confirmation or pause');
  assert.deepEqual(h.state().activeAttackBuses,[23]);
  assert.equal(h.snapshot().t,0);
  assert.ok(Object.values(h.snapshot().cumulative).every(cost=>cost===0),'Fresh comparison excludes discovery costs');
  assert.equal(h.node('progress-learning').dataset.status,'complete');
  assert.equal(h.node('progress-learning')['aria-current'],undefined);
  assert.equal(h.node('progress-comparison').dataset.status,'active');
  assert.equal(h.node('progress-comparison')['aria-current'],'step');
  assert.match(h.node('progress-learning-count').textContent,/^180\b/);
  assert.match(h.node('progress-comparison-count').textContent,/^0\b/);
  assert.match(h.node('transition-note').textContent,/fresh/i);
  assert.match(h.node('transition-note').textContent,/Learning costs excluded/i);
  assert.match(h.node('transition-note').textContent,/fixed/i);
  assert.equal(h.node('learning-title').textContent,'Experiment results');
  assert.equal(h.node('results-stage').textContent,'Controller comparison');
  const support=plain(h.snapshot().deployedSupport);
  await h.samples(8);
  assert.ok(h.snapshot().t>=8,'Playback continues through the explained handoff');
  assert.deepEqual(plain(h.snapshot().deployedSupport),support);
  assert.ok(h.snapshot().eventLog.some(event=>event.type==='pulse'&&event.bus===23),'The attack executes in the comparison');
  assert.match(h.node('transition-note').textContent,/Learning costs excluded/i,'Reset explanation remains after the first comparison samples');
  h.click('run');
  const restored=harness(h.saved());
  assert.deepEqual(restored.progress(),h.progress());
  assert.equal(restored.node('learning-title').textContent,'Experiment results');
  assert.equal(restored.node('results-stage').textContent,'Controller comparison');
  assert.equal(restored.state().playing,false);
  h.click('restart');
  assert.deepEqual(h.progress(),stageBefore);
  assert.equal(h.node('progress-comparison').dataset.status,'pending');
});

test('persistent stages report short discovery honestly and ignore historical topology inspection',()=>{
  const h=linkEvidenceFixture();
  const inspect=()=>{
    const before=plain(h.snapshot()),progress=h.progress();h.renderProgress();
    assert.match(h.node('progress-learning-count').textContent,new RegExp('^'+before.discoveryRecord.t+'\\b'));
    assert.match(h.node('progress-comparison-count').textContent,new RegExp('^'+before.t+'\\b'));
    assert.equal(h.node('progress-learning').dataset.status,'complete');
    assert.equal(h.node('progress-comparison').dataset.status,'active');
    assert.equal(h.node('progress-comparison')['aria-current'],'step');
    assert.deepEqual(plain(h.snapshot()),before,'The persistent explanation does not alter physical execution');
    return progress;
  };
  const initial=inspect();assert.equal(h.snapshot().discoveryRecord.t,35);
  h.click('step');const first=inspect();assert.notDeepEqual(first,initial);
  h.click('source-fault');assert.deepEqual(inspect(),first,'A source toggle cannot rewrite completed learning');
  h.event('topology-history','input');assert.deepEqual(inspect(),first,'Historical links do not rewind the live experiment stage');
  h.click('history-live');assert.deepEqual(harness(h.saved()).progress(),first);
  h.click('restart');assert.equal(h.node('progress-learning').dataset.status,'active');
  assert.equal(h.node('progress-comparison').dataset.status,'pending');
  const prediction=harness();
  assert.equal(prediction.node('experiment-progress').hidden,true,'The specialized communication explanation is not shown for adapting prediction coefficients');
  assert.equal(prediction.node('phase').hidden,false);
});

test('forecast heading reports current synthetic source settings without rewriting sealed messages, discovery or replay',async()=>{
  const h=harness(undefined,null);
  const inspect=()=>{
    const before=plain(h.snapshot()),settings=h.forecastSettings();
    assert.equal(settings.sourceCount,23);assert.equal(settings.noisy,before.faults.filter(bus=>bus>=2&&bus<=24).length);
    assert.equal(settings.quiet,23-settings.noisy);assert.equal(settings.beta,before.beta);
    assert.equal(h.node('scenario-description').dataset.noisy,String(settings.noisy));
    assert.equal(h.node('scenario-description').dataset.quiet,String(settings.quiet));
    assert.match(h.node('scenario-description').title,/SD is the configured additive-noise standard deviation in forcing coordinates/);
    assert.deepEqual(plain(h.snapshot()),before,'Reading settings is not an intervention');
    return settings;
  };
  assert.equal(inspect().quiet,8);assert.equal(inspect().noisy,15);
  h.check('auto-compare',false);assert.match(h.node('scenario-description').title,/Manual comparison enabled/);h.check('auto-compare',true);
  h.inspectLink(5,7);const issued=h.issuedForecasts(),before=plain(h.snapshot());
  h.click('source-fault');assert.equal(inspect().quiet,7);assert.equal(inspect().noisy,16);
  assert.deepEqual(h.issuedForecasts(),issued,'A paused configuration label cannot rewrite sealed messages');
  assert.deepEqual(plain(h.snapshot().states),before.states);assert.deepEqual(plain(h.snapshot().cumulative),before.cumulative);
  h.click('source-fault');const current=inspect();
  h.click('run');await h.clock.until(()=>h.snapshot().phase==='deployment');h.click('run');
  assert.deepEqual(inspect(),current);assert.match(h.node('scenario-description').title,/Deployed links and prediction correction stay fixed/);
  h.event('topology-history','input');assert.deepEqual(inspect(),current,'The heading stays current configuration rather than past discovery labels');
  h.click('history-live');const restored=harness(h.saved());assert.deepEqual(restored.forecastSettings(),current);
});
test('forecast heading distinguishes noise disabled and all noisy settings from measured accuracy',async()=>{
  const h=harness(undefined,null);h.change('noise',0);
  assert.equal(h.forecastSettings().noiseEnabled,false);
  assert.equal(h.node('scenario-description').textContent,'Forecast noise SD (mpu) · quiet 0 · noisy 0');
  assert.ok(h.node('scenario-description').dataset.quietSd.split(',').every(value=>Number(value)===0));assert.ok(h.node('scenario-description').dataset.noisySd.split(',').every(value=>Number(value)===0));
  assert.match(h.node('scenario-description').title,/Observed error ŵ − w can also include gain bias and unforecast power/);
  const all=harness({privateContent:{version:14,algorithmId:ALGORITHM_ID,phase:'discovery',t:0,events:[],automaticComparison:true,
    initialOptions:{experiment:'communication',powerScenario:'forecasted-demand',seed:20261013,beta:4,horizon:180,faultBuses:Array.from({length:23},(_,i)=>i+2)}}},'communication');
  assert.equal(all.forecastSettings().quiet,0);assert.equal(all.forecastSettings().noisy,23);
  assert.match(all.node('scenario-description').textContent,/quiet — · noisy /);
  assert.equal(all.node('scenario-description').dataset.quietSd,'');assert.equal(all.node('scenario-description').dataset.noisySd.split(',').length,23);
  assert.match(all.node('trial-context').textContent,/No reliable alternative/);
  h.change('experiment','prediction');assert.equal(h.forecastSettings(),null);
  assert.equal(h.node('scenario-description').dataset.forecastSettings,'false');assert.equal(h.node('scenario-description').dataset.beta,'');
  await compare(h);assert.equal(h.snapshot().phase,'deployment');
  assert.match(h.node('scenario-description').title,/Dense prediction messages.*Adaptation restarts at 30 s/);
});

test('shared controller key precedes every panel and toggles only visibility',()=>{
  const group=html.match(/<div id="pr-controller-key"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(group);assert.match(group[0],/role="group" aria-label="Controller curves"/);
  assert.equal((html.match(/class="pr-legend/g)||[]).length,1,'Reuse one key rather than duplicate controls');
  assert.ok(html.indexOf('id="pr-controller-key"')<html.indexOf('class="pr-dashboard"'),'Methods are identifiable before any panel on a phone');
  assert.deepEqual(Array.from(group[1].matchAll(/data-series="([^"]+)"/g),match=>match[1]),['online','scalar','static','causal']);
  for(const experiment of [null,'prediction']){
    const h=harness(undefined,experiment),before=plain(h.snapshot());
    for(const key of ['online','scalar','static'])h.seriesButton(key).dispatch('click');
    assert.deepEqual(h.comparison().plotted,['causal']);
    h.seriesButton('causal').dispatch('click');assert.equal(h.seriesButton('causal')['aria-pressed'],'true','At least one measured curve remains');
    for(const key of ['online','scalar','static'])h.seriesButton(key).dispatch('click');
    assert.deepEqual(h.comparison().plotted,['online','scalar','static','causal']);
    assert.deepEqual(plain(h.snapshot()),before,'The shared key cannot change physics, forecasts, support or costs');
    assert.equal(h.state().playing,false);
  }
});

test('network role caption traces actual candidate deployed local absent and history links without changing the trial',async()=>{
  const h=harness(undefined,null);
  assert.equal(h.node('network-inspection').hidden,true,'No persistent diagnostic before inspection');
  const check=(receiver,source)=>{
    const before=plain(h.snapshot());h.inspectLink(receiver,source);
    const actual=h.inspection(),caption=h.node('network-inspection');
    assert.equal(caption.hidden,false);assert.equal(caption.dataset.source,String(source));assert.equal(caption.dataset.receiver,String(receiver));
    assert.equal(caption.dataset.connected,String(actual.connected));assert.equal(caption.dataset.local,String(actual.local));
    assert.equal(h.node('network-inspection-source').textContent,(actual.local?'Source and inverter ':'Source ')+source);
    assert.equal(h.node('network-inspection-join').textContent,actual.local?'':actual.connected?'→':'·','An absent link never gets an arrow');
    assert.equal(h.node('network-inspection-receiver').hidden,actual.local);
    assert.equal(h.node('network-inspection-status').textContent,actual.label.split(' · ').slice(1).join(' · '));
    assert.deepEqual(plain(h.snapshot()),before,'Role labels cannot alter physical states, forecasts, support, events or costs');
  };
  for(const receiver of PowerDemo.constants.inverterBuses)for(let source=2;source<=24;source++)check(receiver,source);
  assert.equal(h.node('network-inspection').dataset.context,'candidate');
  await compare(h);
  for(const source of [2,5,7,24])check(5,source);
  assert.equal(h.node('network-inspection').dataset.context,'deployed');
  h.event('topology-history','input');check(5,7);assert.equal(h.node('network-inspection').dataset.context,'history');
  h.click('history-live');check(5,7);
  const saved=h.saved(),restored=harness(saved,'communication');
  assert.deepEqual(plain(restored.snapshot()),plain(h.snapshot()),'Inspected pair retains exact version 14 replay');
  assert.equal(restored.node('network-inspection').dataset.source,'7');
  h.change('bus',2);assert.equal(h.node('network-inspection').hidden,true);
  assert.equal(h.node('network-inspection-source').textContent,'','No stale source label');
});

test('displayed link ownership follows the actual controller phase and saved discovery without changing the trial',()=>{
  for(const experiment of ['communication','prediction']){
    const h=harness(undefined,experiment);h.check('auto-compare',false);h.inspectLink(5,7);
    const check=(controller,context)=>{
      const heading=h.node('matrix-title');
      assert.equal(heading.textContent,controller+' links');assert.equal(heading.dataset.controller,controller);
      assert.equal(heading.dataset.context,context);assert.match(heading.title,/Other controllers use their own prediction sources/);
      if(h.inspection()){
        assert.equal(h.node('network-inspection').dataset.controller,controller);
        assert.ok(h.node('network-inspection-status').textContent.endsWith(' · '+controller));
      }
    };
    check('Online SLS','discovery');assert.match(h.node('matrix-title').title,/Candidate sparse links.*dense messages/);
    for(let i=0;i<31;i++)h.click('step');
    h.click('deploy');if(h.state().playing)h.click('run');
    const controller=experiment==='communication'?'Learned sparse':'Online SLS',before=plain(h.snapshot());
    check(controller,'comparison');assert.match(h.node('matrix-title').title,experiment==='communication'?/Fixed deployed prediction links/:/Dense prediction links/);
    h.node('topology-history').value='0';h.event('topology-history','input');
    check('Online SLS','saved-discovery');
    assert.ok(h.node('matrix-title').title.startsWith('Saved discovery links at '+h.protocol().historyAt+' s'));
    assert.deepEqual(plain(h.snapshot()),before,'Reading archived ownership cannot deploy archived links or alter the four policies');
    h.click('history-live');check(controller,'comparison');
    h.change('matrix-view','change');check(controller,'comparison');
    assert.deepEqual(plain(h.snapshot()),before,'Changing the ownership view never changes forecasts, states, support or costs');
    const restored=harness(h.saved(),experiment);
    assert.deepEqual(plain(restored.snapshot()),before,'Version 14 replay remains exact');
    assert.equal(restored.node('matrix-title').dataset.controller,controller);
    h.click('restart');check('Online SLS','discovery');
  }
});

test('schema fourteen rejects missing or different algorithm identifiers without replaying saved events',()=>{
  const h=harness();h.check('auto-compare',false);
  for(let t=0;t<35;t++)h.click('step');
  assert.ok(h.snapshot().calibration.updates>0);
  const saved=h.saved();
  assert.equal(saved.privateContent.version,14);assert.equal(saved.privateContent.algorithmId,ALGORITHM_ID);
  for(const algorithmId of [undefined,'upstream-shared-calibration','opredsls-window-ridge-v0']){
    const incompatible=plain(saved);
    if(algorithmId===undefined)delete incompatible.privateContent.algorithmId;else incompatible.privateContent.algorithmId=algorithmId;
    const before=plain(incompatible),restored=harness(incompatible);
    assert.equal(restored.snapshot().t,0);assert.equal(restored.snapshot().sampleCount,0);
    assert.equal(restored.snapshot().phase,'discovery');assert.equal(restored.snapshot().calibration.updates,0);
    assert.ok(Object.values(restored.snapshot().cumulative).every(value=>value===0));
    assert.equal(restored.snapshot().eventLog.length,0);assert.equal(restored.state().playing,false);
    assert.match(restored.node('event').textContent,/Earlier algorithm trial kept separately/);
    assert.deepEqual(incompatible,before,'Rejecting a stored experiment must not rewrite its evidence');
  }
});

test('offline storage bridge preserves old keys and writes current schema separately',async()=>{
  const template=fs.readFileSync(path.join(__dirname,'page-template.html'),'utf8');
  const script=template.match(/<script>([\s\S]*?)<\/script>/)[1];
  const old=JSON.stringify({privateContent:{version:13,t:80,events:[{type:'pulse',t:2,bus:7,strength:100}]}});
  const stored=new Map([['online-sls-demo-v1',old]]);
  const context={window:{},localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)}};
  vm.runInNewContext(script,context);
  assert.equal(context.window.openai.widgetState,null);assert.equal(context.window.openai.incompatibleWidgetState,true);
  const current={privateContent:{version:14,algorithmId:ALGORITHM_ID,t:0,events:[]}};
  await context.window.openai.setWidgetState(current);
  assert.equal(stored.get('online-sls-demo-v1'),old,'Legacy key remains byte-identical');
  assert.deepEqual(JSON.parse(stored.get('online-predsls-offline-v1')),current);
  const restored={window:{},localStorage:context.localStorage};vm.runInNewContext(script,restored);
  assert.deepEqual(plain(restored.window.openai.widgetState),current);assert.equal(restored.window.openai.incompatibleWidgetState,false);
});

test('prediction comparison displays dense access and restarts learning without discovery samples',()=>{
  const h=harness(undefined,'prediction');h.check('auto-compare',false);
  for(let t=0;t<35;t++)h.click('step');
  assert.ok(h.snapshot().calibration.updates>0);
  h.click('deploy');if(h.state().playing)h.click('run');
  const start=h.snapshot();
  assert.equal(start.phase,'deployment');assert.equal(start.t,0);assert.equal(start.sampleCount,0);
  assert.equal(start.calibration.updates,0);assert.equal(start.calibration.scalar,1);
  assert.deepEqual(start.calibration.matrix,PowerDemo.math.eye(PowerDemo.constants.N-1));
  assert.ok(start.deployedSupport.learned.flat().every(Boolean));assert.ok(start.deployedSupport.fixed.flat().every(Boolean));
  assert.equal(start.recommendations.filter(link=>link.from!==link.to).length,PowerDemo.constants.M*(PowerDemo.constants.N-2));
  h.inspectLink(5,7);
  assert.match(h.node('matrix-title').title,/Dense prediction links/);
  assert.match(h.node('forecast-support').textContent,/All sources available · Inverter/);
  assert.match(h.node('phase-note').textContent,/Fresh dense comparison · Updates restart at 30 s/);
  for(let t=0;t<30;t++)h.click('step');
  assert.equal(h.snapshot().calibration.updates,0);
  h.click('step');const fitted=plain(h.snapshot());
  assert.equal(fitted.calibration.windowSize,30);assert.ok(fitted.calibration.updates>0);
  const restored=harness(h.saved(),'prediction');
  assert.deepEqual(plain(restored.snapshot()),fitted,'Current dense comparison replay preserves every numerical field');
  assert.equal(restored.state().playing,false);
});


test('visible matrix modes and forecast SD values retain their exact source and distinguish observed RMSE',()=>{
  assert.equal((html.match(/id="pr-matrix-view"/g)||[]).length,1);
  const matrixStart=html.indexOf('class="pr-panel pr-matrix-panel"'),matrixEnd=html.indexOf('class="pr-panel pr-stage-panel"');
  assert.ok(html.indexOf('id="pr-matrix-view"')>matrixStart&&html.indexOf('id="pr-matrix-view"')<matrixEnd,'The existing matrix selector is directly in the matrix panel');
  assert.match(html,/<option value="links" selected>Sparsity<\/option><option value="change">Weight change<\/option>/);
  const h=harness(undefined,'communication');h.change('noise',8);h.change('bus',7);
  const scale=1000*PowerDemo.model.forecastForcingScales[6];
  const quiet=Number(h.node('noise-caption').dataset.sdMpu);
  assert.ok(Math.abs(quiet-.10645959706323978)<1e-12);assert.equal(quiet,scale*8*.05);
  h.click('fault');const noisy=Number(h.node('noise-caption').dataset.sdMpu);
  assert.ok(Math.abs(noisy-8.516767765059181)<1e-12);assert.equal(noisy,80*quiet);
  assert.equal(Number(h.node('noise-caption').dataset.gain),1);
  const p=harness(undefined,'prediction');p.change('bus',7);
  for(const presetId of ['reliable','uniform','mixed']){
    p.change('preset',presetId);p.change('bus',7);
    const preset=PowerDemo.constants.forecastPresets.find(item=>item.id===presetId);
    const fault=p.snapshot().faults.includes(7);
    assert.equal(Number(p.node('noise-caption').dataset.sdMpu),scale*(fault?preset.faultyNoise:preset.noise));
    assert.equal(Number(p.node('noise-caption').dataset.gain),fault?preset.faultyGain:preset.gain);
    assert.equal(Number(p.node('scenario-description').dataset.quietGain),preset.gain);
    assert.equal(Number(p.node('scenario-description').dataset.noisyGain),preset.faultyGain);
    const rows={quiet:[],noisy:[]};
    for(let bus=2;bus<=PowerDemo.constants.N;bus++){
      const bad=p.snapshot().faults.includes(bus);
      rows[bad?'noisy':'quiet'].push(1000*PowerDemo.model.forecastForcingScales[bus-1]*(bad?preset.faultyNoise:preset.noise));
    }
    for(const key of ['quiet','noisy'])assert.deepEqual(p.node('scenario-description').dataset[key+'Sd'].split(',').filter(Boolean).map(Number),rows[key]);
    assert.equal(p.forecastSettings(),null);assert.equal(p.node('scenario-description').dataset.beta,'');
    assert.doesNotMatch(p.node('scenario-description').textContent,/β/);
  }
  const issued=p.issuedForecasts(),sd=Number(p.node('noise-caption').dataset.sdMpu),gain=Number(p.node('noise-caption').dataset.gain);
  p.change('noise',8);assert.deepEqual(p.issuedForecasts(),issued,'Beta is not a prediction-preset generator parameter');
  assert.equal(Number(p.node('noise-caption').dataset.sdMpu),sd);assert.equal(Number(p.node('noise-caption').dataset.gain),gain);
  p.inspectLink(5,7);p.click('step');
  const observed=p.forecastObservation(),stats=p.sourceHistory().stats;
  assert.equal(stats.rmse,Math.abs(observed.error));
  assert.notEqual(1000*stats.rmse,sd,'A realized one-pair RMSE is not the configured Gaussian SD');
  assert.match(p.node('noise-caption').title,/Observed error and RMSE are reported separately/);
});
