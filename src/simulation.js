/* Synthetic LinDistFlow plant retained from the upstream demo.
 * Online PredSLS ports the experimental mean-ridge predictive-response update.
 * The current X/U response row and L=U-KX drive actions, scoring and inspection.
 * Sparse comparison freezes learned links and re-synthesizes the predictive maps.
 * The separate completed-row legacy diagnostic does not drive this controller. */
(function (root, factory) {
  const edges=[[1,2],[2,3],[3,4],[4,5],[4,6],[6,7],[4,8],
    [3,9],[9,10],[9,11],[11,12],[1,15],[15,13],[13,14],[13,16],
    [16,17],[16,18],[18,19],[19,20],[20,21],[18,22],[22,23],[23,24]];
  const inverters=[5,7,8,12,14,18,21,24],solar=[5,7,14,21],battery=[8,12,18,24];
  const mixed=[3,6,9,12,15,18,21,24],secondBus=bus=>bus===1?1:bus+23;
  const definitions=[
    {id:'toy8',label:'Toy feeder',N:8,remoteBudget:2,edges:edges.filter(([from,to])=>from<=8&&to<=8),
      inverters:inverters.filter(bus=>bus<=8),solar:solar.filter(bus=>bus<=8),battery:battery.filter(bus=>bus<=8),
      mixed:mixed.filter(bus=>bus<=8),edgePeriod:23},
    {id:'feeder24',label:'Distribution feeder',N:24,remoteBudget:3,edges,inverters,solar,battery,mixed,edgePeriod:23},
    {id:'feeder47',label:'Larger feeder',N:47,remoteBudget:3,edges:[...edges,...edges.map(edge=>edge.map(secondBus))],
      inverters:[...inverters,...inverters.map(secondBus)],solar:[...solar,...solar.map(secondBus)],
      battery:[...battery,...battery.map(secondBus)],mixed:[...mixed,...mixed.map(secondBus)],edgePeriod:23}
  ];
  const networks=Object.freeze(definitions.map(network=>Object.freeze({id:network.id,label:network.label,N:network.N,
    M:network.inverters.length,remoteBudget:network.remoteBudget})));
  const cache=new Map();
  function forNetwork(id='feeder24'){
    const definition=definitions.find(network=>network.id===id);
    if(!definition)throw new RangeError('Unknown network '+id);
    if(!cache.has(id))cache.set(id,Object.assign(factory(definition),{networks,forNetwork}));
    return cache.get(id);
  }
  const api=forNetwork();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PowerDemo=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(network){
  'use strict';
  const N=network.N, M=network.inverters.length, AMPLITUDE=.006, RAW_RIDGE=1e-6;
  const ONLINE_RIDGE=1.2725674932370515e-5; // Original voltage experiment, in physical forcing coordinates.
  const RIDGE=RAW_RIDGE,REMOTE_BUDGET=network.remoteBudget,PREVIEW=5,WINDOW=60,WARMUP=30,TOLERANCE=1e-5;
  const BASE_KV=12.47,BASE_MVA=1,POWER_BASE_KW=1000,SAMPLE_SECONDS=1,TAU_SECONDS=2;
  const LAG=Math.exp(-SAMPLE_SECONDS/TAU_SECONDS),Q_LIMIT=.07,S_RATING=.12;
  const PULSE_DEFAULT=100,PULSE_MIN=10,PULSE_MAX=150;
  const CONTROLLERS=['online','scalar','static','causal'];
  const COMMUNICATION_BETAS=[0,.25,.5,1,2];
  const COMMUNICATION_STRESS_BETAS=[4,8,16];
  const INVERTER_BUSES=network.inverters;
  const SOLAR_BUSES=network.solar,BATTERY_BUSES=network.battery;
  const PF_RATIO=Math.tan(Math.acos(.95));
  const EDGES=network.edges;
  const FORECAST_PRESETS=[
    {id:'reliable',label:'Reliable forecasts',faultBuses:[],gain:1,noise:.05,faultyGain:.15,faultyNoise:1.6},
    {id:'uniform',label:'Uniform corruption',faultBuses:Array.from({length:N-1},(_,i)=>i+2),
      gain:1,noise:.05,faultyGain:.65,faultyNoise:.65},
    {id:'mixed',label:'Mixed reliability',faultBuses:network.mixed,
      gain:1,noise:.05,faultyGain:.15,faultyNoise:1.6}
  ];
  const BUS_PROFILES=Array.from({length:N},(_,i)=>{
    const bus=i+1;
    if(bus===1)return{bus,role:'Substation',eventName:'Fixed slack',decay:4,steps:16,
      attackable:false,inverterKvar:0,baseDemandKw:0,baseGenerationKw:0,reactiveRatio:0};
    const solar=SOLAR_BUSES.includes(bus),battery=BATTERY_BUSES.includes(bus);
    return{bus,role:solar?'Solar':battery?'Battery':'Homes',
      eventName:solar?'Cloud cover':battery?'Charging surge':'Demand surge',
      decay:solar?6:battery?2:3,steps:solar?24:battery?8:12,attackable:true,
      inverterKvar:solar||battery?70:0,inverterKva:solar||battery?120:0,
      baseDemandKw:battery?50:70,baseGenerationKw:solar?80:0,
      activePowerLimitKw:solar||battery?90:null,reactiveRatio:solar||battery?0:PF_RATIO};
  });
  const FORECASTED_DEMAND={id:'forecasted-demand',label:'Forecastable demand and solar',periodSeconds:60,
    homeAmplitudeKw:35,solarLossMaxKw:30,batteryAmplitudeKw:15,maxScheduledKw:35,
    phaseRule:network.id==='feeder47'?'2 pi times original branch bus modulo 6 divided by 6':'2 pi times bus modulo 6 divided by 6',previewSamples:PREVIEW,leadSteps:PREVIEW-1,
    noisySources:BUS_PROFILES.filter(profile=>profile.role==='Homes').map(profile=>profile.bus)};
  function scheduledPower(bus,t){
    const profile=BUS_PROFILES[bus-1],phaseBus=network.id==='feeder47'&&bus>24?bus-23:bus,phase=2*Math.PI*(phaseBus%6)/6;
    if(profile.role==='Solar')return .030*(1-Math.cos(2*Math.PI*t/60))/2;
    if(profile.role==='Battery')return .015*Math.sin(2*Math.PI*t/60+phase);
    if(profile.role==='Homes')return .035*Math.sin(2*Math.PI*t/60+phase);
    return 0;
  }
  function zeros(n = N, m = n) { return Array.from({length:n}, () => Array(m).fill(0)); }
  function eye(n = N) { const a = zeros(n); for (let i=0;i<n;i++) a[i][i]=1; return a; }
  function copy(a) { return a.map(row => row.slice()); }
  function transpose(a) { return a[0].map((_,j) => a.map(row => row[j])); }
  function multiply(a,b) {
    const c = zeros(a.length,b[0].length);
    for (let i=0;i<a.length;i++) for (let k=0;k<b.length;k++) {
      const v = a[i][k];
      for (let j=0;j<b[0].length;j++) c[i][j] += v*b[k][j];
    }
    return c;
  }
  function matvec(a,x) { return a.map(row => row.reduce((v,e,j) => v+e*x[j],0)); }
  function combine(a,b,alpha=1,beta=1) { return a.map((row,i) => row.map((v,j) => alpha*v+beta*b[i][j])); }
  function frobenius(a) { return Math.sqrt(a.reduce((s,row) => s+row.reduce((t,v) => t+v*v,0),0)); }
  function normInf(a) { return Math.max(...a.map(row => row.reduce((s,v) => s+Math.abs(v),0))); }
  function squared(x) { return x.reduce((s,v) => s+v*v,0); }
  function deepFreeze(x) {
    if (x && typeof x === 'object' && !Object.isFrozen(x)) {
      Object.values(x).forEach(deepFreeze); Object.freeze(x);
    }
    return x;
  }

  // Solve A X = B for symmetric positive definite A without explicit inversion.
  function solveSPD(a,b) {
    const n=a.length, m=b[0].length, l=zeros(n), y=zeros(n,m), x=zeros(n,m);
    for (let i=0;i<n;i++) for (let j=0;j<=i;j++) {
      let v=a[i][j];
      for (let k=0;k<j;k++) v -= l[i][k]*l[j][k];
      if (i===j) {
        if (!(v>0)) throw new Error('Matrix must be positive definite');
        l[i][j]=Math.sqrt(v);
      } else l[i][j]=v/l[j][j];
    }
    for (let i=0;i<n;i++) for (let j=0;j<m;j++) {
      let v=b[i][j];
      for (let k=0;k<i;k++) v -= l[i][k]*y[k][j];
      y[i][j]=v/l[i][i];
    }
    for (let i=n-1;i>=0;i--) for (let j=0;j<m;j++) {
      let v=y[i][j];
      for (let k=i+1;k<n;k++) v -= l[k][i]*x[k][j];
      x[i][j]=v/l[i][i];
    }
    return x;
  }

  function seededRandom(seed) {
    let state=seed>>>0;
    function uniform() {
      state += 0x6D2B79F5;
      let z=state;
      z=Math.imul(z^(z>>>15),z|1);
      z ^= z+Math.imul(z^(z>>>7),z|61);
      return ((z^(z>>>14))>>>0)/4294967296;
    }
    let spare=null;
    return {normal() {
      if (spare!==null) { const x=spare; spare=null; return x; }
      const r=Math.sqrt(-2*Math.log(Math.max(Number.MIN_VALUE,uniform())));
      const theta=2*Math.PI*uniform();
      spare=r*Math.sin(theta); return r*Math.cos(theta);
    }};
  }

  function buildModel(){
    const children=Array.from({length:N},()=>[]),parent=Array(N).fill(-1),parentEdge=Array(N).fill(-1);
    const edgeData=EDGES.map(([from,to],index)=>{
      const branchIndex=index%network.edgePeriod;
      const rOhm=.45+.15*(branchIndex%4),xOhm=.30+.08*(branchIndex%3),zBase=BASE_KV*BASE_KV/BASE_MVA;
      children[from-1].push(to-1);parent[to-1]=from-1;parentEdge[to-1]=index;
      return{from,to,rOhm,xOhm,rPu:rOhm/zBase,xPu:xOhm/zBase};
    });
    const order=[0];for(let k=0;k<order.length;k++)order.push(...children[order[k]]);
    const paths=zeros(N,N-1);
    for(const i of order.slice(1)){paths[i]=paths[parent[i]].slice();paths[i][parentEdge[i]]=1;}
    const resistance=zeros(),reactance=zeros();
    for(let i=1;i<N;i++)for(let j=1;j<N;j++)for(let e=0;e<N-1;e++){
      resistance[i][j]+=paths[i][e]*paths[j][e]*edgeData[e].rPu;
      reactance[i][j]+=paths[i][e]*paths[j][e]*edgeData[e].xPu;
    }
    const baseP=BUS_PROFILES.map(p=>(p.baseDemandKw-p.baseGenerationKw)/POWER_BASE_KW);
    const baseQ=BUS_PROFILES.map(p=>p.baseDemandKw*PF_RATIO/POWER_BASE_KW);
    const baseDrop=matvec(resistance,baseP).map((v,i)=>-v-matvec(reactance,baseQ)[i]);
    const referenceVoltage=baseDrop.map(v=>1+v);
    // Magnitude LinDistFlow has no factor two. The corresponding squared
    // voltage equation has 2R and 2X instead.
    const powerToVoltage=resistance.map((row,i)=>row.map((r,j)=>-r-reactance[i][j]*BUS_PROFILES[j].reactiveRatio));
    const F=powerToVoltage.slice(1),X=reactance.slice(1).map(row=>INVERTER_BUSES.map(bus=>row[bus-1]));
    const A=eye(N-1).map(row=>row.map(v=>LAG*v));
    const B=X.map(row=>row.map(v=>(1-LAG)*v));
    const Q=eye(N-1).map(row=>row.map(v=>35*v)),R=eye(M).map(row=>row.map(v=>.08*v));
    const at=transpose(A),bt=transpose(B);
    let P=copy(Q),residual=Infinity,iterations=0;
    for(;iterations<2000;iterations++){
      const btp=multiply(bt,P),S=combine(R,multiply(btp,B));
      const gain=solveSPD(S,multiply(btp,A));
      const next=combine(combine(Q,multiply(at,multiply(P,A))),multiply(at,multiply(P,multiply(B,gain))),1,-1);
      residual=frobenius(combine(next,P,1,-1));P=next;
      if(residual<1e-12)break;
    }
    const S=combine(R,multiply(bt,multiply(P,B)));
    const K=solveSPD(S,multiply(bt,multiply(P,A))).map(row=>row.map(v=>-v));
    const closedLoop=combine(A,multiply(B,K));
    const distances=zeros();
    for(let i=0;i<N;i++)for(let j=0;j<N;j++)for(let e=0;e<N-1;e++)distances[i][j]+=Math.abs(paths[i][e]-paths[j][e]);
    // Keep the original voltage experiment's declared ridge parameter.
    // Physical forecast scales describe the unchanged feeder, not a retuning rule.
    const forecastForcingScales=powerToVoltage.map(row=>AMPLITUDE*Math.sqrt(squared(row)*(1+LAG*LAG)));
    const forecastScaleSquared=squared(forecastForcingScales.slice(1))/(N-1);
    return deepFreeze({A,B,Q,R,P,K,S,X,F,resistance,reactance,powerToVoltage,paths,
      baseP,baseQ,baseDrop,referenceVoltage,initialVoltage:referenceVoltage,
      edgeData,order,parent,parentEdge,children,distances,
      inverterBuses:INVERTER_BUSES,lag:LAG,qLimit:Q_LIMIT,inverterRating:S_RATING,
      baseKv:BASE_KV,baseMva:BASE_MVA,sampleSeconds:SAMPLE_SECONDS,tauSeconds:TAU_SECONDS,
      variant:'Synthetic radial LinDistFlow feeder with inverter lag',
      costReference:'Nominal feasible voltage profile',forecastForcingScales,
      calibrationScale:Math.sqrt(forecastScaleSquared),calibrationNormalizedRidge:ONLINE_RIDGE/forecastScaleSquared,
      calibrationRidge:ONLINE_RIDGE,dareResidual:residual,
      dareIterations:iterations+1,closedLoopNormInf:normInf(closedLoop)});
  }
  const model=buildModel();
  function padInput(values){const padded=Array(N).fill(0);INVERTER_BUSES.forEach((bus,i)=>padded[bus-1]=values[i]);return padded;}
  function paddedGain(gain){const out=zeros();INVERTER_BUSES.forEach((bus,i)=>out[bus-1]=gain[i].slice());return out;}
  function recommendations(gain){
    const result=[];
    for(const receiver of INVERTER_BUSES){
      const ranked=[];
      for(let source=2;source<=N;source++)if(source!==receiver){
        const weight=gain[receiver-1][source-1]**2;
        if(weight>1e-20)ranked.push({from:source,to:receiver,weight});
      }
      ranked.sort((a,b)=>b.weight-a.weight||a.from-b.from);result.push(...ranked.slice(0,REMOTE_BUDGET));
    }
    return result;
  }
  function edgeChanges(before,after){
    const a=new Set(before.map(e=>e.from+','+e.to)),b=new Set(after.map(e=>e.from+','+e.to));
    let changes=0;for(const key of a)if(!b.has(key))changes++;for(const key of b)if(!a.has(key))changes++;
    return changes/2;
  }
  function boundedPowerDeviation(bus,value){
    const p=BUS_PROFILES[bus-1];
    if(bus===1)return 0;
    if(p.role==='Solar')return Math.max((p.baseGenerationKw-p.activePowerLimitKw)/1000,Math.min(p.baseGenerationKw/1000,value));
    if(p.role==='Battery')return Math.max(-p.activePowerLimitKw/1000,Math.min(p.activePowerLimitKw/1000,value));
    return Math.max(-p.baseDemandKw/1000,value);
  }
  function physicalPower(deviation){
    const loadP=model.baseP.map((v,i)=>(v+deviation[i])*1000);
    const loadQ=model.baseQ.map((v,i)=>(v+BUS_PROFILES[i].reactiveRatio*deviation[i])*1000);
    const demandP=BUS_PROFILES.map((p,i)=>p.role==='Solar'?p.baseDemandKw:
      p.role==='Battery'?p.baseDemandKw+Math.max(0,deviation[i]*1000):p.baseDemandKw+deviation[i]*1000);
    const generationP=BUS_PROFILES.map((p,i)=>p.role==='Solar'?p.baseGenerationKw-deviation[i]*1000:
      p.role==='Battery'?Math.max(0,-deviation[i]*1000):0);
    const inverterP=BUS_PROFILES.map((p,i)=>p.role==='Solar'?generationP[i]:p.role==='Battery'?-deviation[i]*1000:0);
    return{loadP,loadQ,demandP,generationP,inverterP};
  }
  function voltageFrom(deviation,q){
    const voltageEffect=matvec(model.powerToVoltage,deviation);
    const qEffect=matvec(model.reactance,padInput(q));
    return model.baseDrop.map((v,i)=>v+voltageEffect[i]+qEffect[i]);
  }
  function branchFlows(loadP,loadQ,q){
    const p=loadP.slice(),reactive=loadQ.map((v,i)=>v-padInput(q)[i]*1000),flows=Array(N-1);
    for(const bus of model.order.slice(1).reverse()){
      flows[model.parentEdge[bus]]={pKw:p[bus],qKvar:reactive[bus]};
      p[model.parent[bus]]+=p[bus];reactive[model.parent[bus]]+=reactive[bus];
    }
    return flows;
  }
  // Independent balanced constant-power AC reference. This verifies the linear
  // approximation; the interactive plant itself remains linear DistFlow.
  function radialAC(loadP,loadQ,inverterQ=Array(N).fill(0),tolerance=1e-11){
    let vr=Array(N).fill(1),vi=Array(N).fill(0),ir=[],ii=[],converged=false,iterations=0;
    for(;iterations<100;iterations++){
      const oldR=vr.slice(),oldI=vi.slice();ir=Array(N).fill(0);ii=Array(N).fill(0);
      for(let i=1;i<N;i++){
        const p=loadP[i]/1000,q=(loadQ[i]-inverterQ[i])/1000,den=vr[i]**2+vi[i]**2;
        if(!(den>1e-12))return{converged:false,iterations,voltage:vr.map((v,i)=>Math.hypot(v,vi[i]))};
        ir[i]=(p*vr[i]+q*vi[i])/den;ii[i]=(p*vi[i]-q*vr[i])/den;
      }
      for(const bus of model.order.slice(1).reverse()){ir[model.parent[bus]]+=ir[bus];ii[model.parent[bus]]+=ii[bus];}
      for(const bus of model.order.slice(1)){
        const edge=model.edgeData[model.parentEdge[bus]],parent=model.parent[bus];
        vr[bus]=vr[parent]-(edge.rPu*ir[bus]-edge.xPu*ii[bus]);
        vi[bus]=vi[parent]-(edge.rPu*ii[bus]+edge.xPu*ir[bus]);
      }
      if(Math.max(...vr.map((v,i)=>Math.hypot(v-oldR[i],vi[i]-oldI[i])))<tolerance){converged=true;iterations++;break;}
    }
    let lossesKw=0,lossesKvar=0;
    for(const bus of model.order.slice(1)){
      const edge=model.edgeData[model.parentEdge[bus]],current=ir[bus]**2+ii[bus]**2;
      lossesKw+=edge.rPu*current*1000;lossesKvar+=edge.xPu*current*1000;
    }
    return{converged,iterations,voltage:vr.map((v,i)=>Math.hypot(v,vi[i])),
      slackKw:ir[0]*1000,slackKvar:-ii[0]*1000,lossesKw,lossesKvar};
  }

  const Response=typeof module==='object'&&module.exports?require('./response-controller.js'):globalThis.ResponseController;
  if(!Response)throw new Error('Load response-controller.js before simulation.js');
  const Online=typeof module==='object'&&module.exports?require('./online-predsls.js'):globalThis.OnlinePredSLS;
  if(!Online)throw new Error('Load online-predsls.js before simulation.js');
  const ALGORITHM_ID='opredsls-window-ridge-v1';
  const synthesizer=new Response.Synthesizer(model,PREVIEW),designCache=new Map(),gramCache=new WeakMap();
  // At the larger feeder's fixed slack, each outgoing radial component is
  // independent. A, B, Q, R and P are block diagonal up to bus ordering, so
  // every forecast-column quadratic separates exactly. Cross-component
  // responses have zero forcing and a positive control penalty, hence their
  // optimum is zero even when finite-data scoring selects such a channel.
  const synthesisComponents=network.id==='feeder47'?model.children[0].map(first=>{
    const buses=[first];for(let i=0;i<buses.length;i++)buses.push(...model.children[buses[i]]);
    const states=buses.map(bus=>bus-1).sort((a,b)=>a-b);
    const inputs=INVERTER_BUSES.flatMap((bus,index)=>buses.includes(bus-1)?[index]:[]);
    const block=(matrix,rows,columns)=>rows.map(i=>columns.map(j=>matrix[i][j]));
    const component={A:block(model.A,states,states),B:block(model.B,states,inputs),
      Q:block(model.Q,states,states),R:block(model.R,inputs,inputs),P:block(model.P,states,states),
      K:block(model.K,inputs,states)};
    return{states,inputs,synthesizer:new Response.Synthesizer(component,PREVIEW)};
  }):null;
  function synthesizeDesign(horizon,support){
    if(!synthesisComponents)return synthesizer.synthesize(horizon,support);
    const designs=synthesisComponents.map(component=>component.synthesizer.synthesize(horizon,
      support?component.inputs.map(i=>component.states.map(j=>support[i][j])):null));
    const joined={X:new WeakMap(),U:new WeakMap(),L:new WeakMap()};
    function assemble(parts,group){
      let cache=joined[group];
      for(const part of parts.slice(0,-1)){
        if(!cache.has(part))cache.set(part,new WeakMap());cache=cache.get(part);
      }
      const last=parts.at(-1);
      if(!cache.has(last)){
        const result=zeros(group==='X'?N-1:M,N-1);
        synthesisComponents.forEach((component,index)=>{
          const rows=group==='X'?component.states:component.inputs;
          rows.forEach((row,i)=>component.states.forEach((column,j)=>result[row][column]=parts[index][i][j]));
        });
        cache.set(last,result);
      }
      return cache.get(last);
    }
    const rows=Array.from({length:horizon+1},()=>[]);
    const columns=designs[0].columns.map((first,index)=>{
      const column={k:first.k,pattern:first.pattern};
      for(const group of ['X','U','L'])column[group]=Object.fromEntries(Object.keys(first[group]).map(time=>
        [time,assemble(designs.map(design=>design.columns[index][group][time]),group)]));
      for(const key of Object.keys(column.X)){
        const time=Number(key);rows[time].push({k:column.k,X:column.X[time],
          U:column.U[time]||zeros(M,N-1),L:column.L[time]||zeros(M,N-1)});
      }
      return column;
    });
    return{T:horizon,rows,columns,support:support?support.map(row=>row.slice()):null};
  }
  // Sum L' L once per receiver and design. Scores of L C can then be computed
  // exactly without rebuilding every temporal response block each sample.
  function calibratedScores(design,C){
    if(!gramCache.has(design)){
      const grams=Array.from({length:M},()=>zeros(N-1));
      for(const row of design.rows.slice(0,design.T))for(const block of row)for(let r=0;r<M;r++)
        for(let a=0;a<N-1;a++)for(let b=0;b<N-1;b++)grams[r][a][b]+=block.L[r][a]*block.L[r][b]/design.T;
      gramCache.set(design,grams);
    }
    const grams=gramCache.get(design),delta=combine(C,eye(N-1),1,-1);
    const scores=zeros(M,N-1),baseline=zeros(M,N-1);let changeSquared=0;
    for(let r=0;r<M;r++){
      const GC=multiply(grams[r],C),GD=multiply(grams[r],delta);
      for(let j=0;j<N-1;j++){
        baseline[r][j]=grams[r][j][j];
        for(let a=0;a<N-1;a++){scores[r][j]+=C[a][j]*GC[a][j];changeSquared+=delta[a][j]*GD[a][j];}
        scores[r][j]=Math.max(0,scores[r][j]);
      }
    }
    return{scores,baseline,changeSquared:Math.max(0,changeSquared)};
  }
  function getDesign(horizon,support=null){
    const key=JSON.stringify([horizon,support]);
    if(!designCache.has(key))designCache.set(key,deepFreeze(synthesizeDesign(horizon,support)));
    return designCache.get(key);
  }
  function scoreGain(scores){
    const gain=zeros();INVERTER_BUSES.forEach((bus,i)=>scores[i].forEach((v,j)=>gain[bus-1][j+1]=Math.sqrt(Math.max(0,v))));return gain;
  }
  function addScores(a,b){for(let i=0;i<M;i++)for(let j=0;j<N-1;j++)a[i][j]+=b[i][j];}
  class Simulation{
    constructor(options={}){
      if(options.networkId!==undefined&&options.networkId!==network.id)throw new RangeError('Saved trial network does not match '+network.id);
      const experiment=options.experiment===undefined?'prediction':options.experiment;
      if(!['prediction','communication'].includes(experiment))throw new RangeError('Unknown experiment');
      const beta=options.beta===undefined?1:options.beta;
      if(!COMMUNICATION_BETAS.includes(beta)&&!COMMUNICATION_STRESS_BETAS.includes(beta))throw new RangeError('Invalid communication noise level');
      const id=options.preset===undefined?'mixed':options.preset;
      const preset=FORECAST_PRESETS.find(p=>p.id===id);
      if(!preset)throw new RangeError('Forecast preset must be reliable, uniform, or mixed');
      const powerScenario=options.powerScenario || 'reference';
      if(!['reference','solar-outage','forecasted-demand'].includes(powerScenario))throw new RangeError('Unknown power scenario');
      this.preset=preset;
      this.initialOptions={networkId:network.id,experiment,beta,powerScenario,seed:options.seed===undefined?20261013:options.seed,
        horizon:options.horizon===undefined?480:options.horizon,preset:id,
        faultBuses:options.faultBuses===undefined?(powerScenario==='forecasted-demand'&&id==='mixed'?FORECASTED_DEMAND.noisySources:preset.faultBuses).slice():options.faultBuses.slice()};
      if(!Number.isInteger(this.initialOptions.horizon)||this.initialOptions.horizon<1)throw new Error('Invalid horizon');
      this.phase='discovery';this.discoveryRecord=null;this.deployedSupport=null;this.reset();
    }
    reset(){
      this.options={...this.initialOptions,faultBuses:this.initialOptions.faultBuses.slice()};
      this.random=seededRandom(this.options.seed);this.t=0;this.mode='running';
      this.powerDeviation=Array(N).fill(0);this.power=physicalPower(this.powerDeviation);
      this.q=Object.fromEntries(CONTROLLERS.map(key=>[key,Array(M).fill(0)]));
      this.command=Object.fromEntries(CONTROLLERS.map(key=>[key,Array(M).fill(0)]));
      this.saturation=Object.fromEntries(CONTROLLERS.map(key=>[key,Array(N).fill(false)]));
      this.states=Object.fromEntries(CONTROLLERS.map(key=>[key,model.baseDrop.slice()]));
      this.costStates=Object.fromEntries(CONTROLLERS.map(key=>[key,model.baseDrop.slice()]));
      this.cumulative=Object.fromEntries(CONTROLLERS.map(key=>[key,0]));this.stage={...this.cumulative};
      this.faults=new Set(this.options.faultBuses.map(bus=>this.checkBus(bus)).filter(bus=>bus!==1));
      this.latent=Array.from({length:N+1},()=>this.random.normal());
      this.pulses=[];this.samples=[];this.history=[];this.eventLog=[];this.forecasts=[];this.lastPreview=[];
      this.lastResponseRows={online:[],scalar:[],static:[],causal:[]};
      this.lastPulseApplications=[];this.lastScenarioApplications=[];this.lastSample=null;this.lastInputs=null;
      this.rows=[];this.rowIds=new Set();this.segments=[];this.addSegment(0,this.options.horizon);
      this.learning={completedRows:0,delay:PREVIEW,updates:0,updateCount:0,prefixError:null,prefixLoss:null,
        stepSize:null,fitError:null,rawRms:null,calibratedRms:null,windowStart:null,windowEnd:null,windowSize:0};
      this.fit=null;this.fitHistory=[];this.fitError=null;this.fitObjective=null;this.fitIteration=0;
      this.drift=0;this.changedEdges=0;this.sinceStable=0;this.lastTrainingTime=null;this.lastTrainingSampleCount=0;
      this.directGain=null;this.recommendations=[];
      this.communicationScores=zeros(M,N-1);this.communicationOfflineScores=zeros(M,N-1);this.communicationScoreSamples=0;this.communicationGainChangeSquared=0;this._scoreAt=null;
      this._calibrationAt=null;this.calibration={matrix:eye(N-1),scalar:1,windowSize:0,updates:0,trainedThrough:null,parameterChange:0};
      this.updateCalibration();this.refreshScores();this.sealPreview();return this.snapshot();
    }
    addSegment(start,length){
      const dense=getDesign(length),offlineScores=Response.scores(dense);
      const fixed=Online.selectSupport(offlineScores,INVERTER_BUSES,REMOTE_BUDGET);
      const designs={online:dense,scalar:dense,static:dense};
      if(this.phase==='deployment'&&this.options.experiment==='communication'){
        designs.online=getDesign(length,this.deployedSupport.learned);
        designs.scalar=getDesign(length,this.deployedSupport.fixed);
      }
      this.segments.push({start,end:start+length,length,dense,designs,offlineScores,fixed});
    }
    checkBus(bus){if(!Number.isInteger(bus)||bus<1||bus>N)throw new Error('Bus must be an integer from 1 through '+N);return bus;}
    queuePulse(bus,strength=PULSE_DEFAULT,protocol=null){
      this.checkBus(bus);
      if(!Number.isFinite(strength)||strength<PULSE_MIN||strength>PULSE_MAX)throw new RangeError('Pulse strength must be from 10 through 150 kW');
      if(bus===1)return false;if(this.mode==='completed')this.extend();if(this.mode!=='running')return false;
      if(protocol!==null&&protocol!=='held-target-v1')throw new RangeError('Unknown power request protocol');
      // Refresh only this bus's continuous component. Explicit and legacy pulses
      // remain independent decaying requests, including in version 13 replay.
      if(protocol==='held-target-v1')this.pulses=this.pulses.filter(event=>event.bus!==bus||event.protocol!==protocol);
      const extra=protocol?{protocol}:{};
      const profile=BUS_PROFILES[bus-1];this.pulses.push({bus,strength,age:0,t:this.t,...profile,...extra,requestedKw:strength,appliedKw:null});
      this.eventLog.push(deepFreeze({t:this.t,type:'pulse',bus,strength,units:'kW',role:profile.role,
        eventName:profile.eventName,decay:profile.decay,steps:profile.steps,...extra,message:profile.eventName+' at bus '+bus}));return true;
    }
    extend(steps=480){
      if(!Number.isInteger(steps)||steps<1)throw new RangeError('Extension must be a positive number of steps');
      this.addSegment(this.options.horizon,steps);this.options.horizon+=steps;
      this.eventLog.push(deepFreeze({t:this.t,type:'extend',steps,message:'New finite planning segment'}));
      if(this.mode==='completed')this.mode='running';this.sealPreview();return this.snapshot();
    }
    sealPreview(){
      // A forecast is issued exactly once, at max(0,s-d+1). Forecasts beyond
      // the current finite segment are still sealed to support later extension.
      while(this.forecasts.length<this.t+PREVIEW){
        const s=this.forecasts.length,rho=.72,innovation=Math.sqrt(1-rho*rho);
        this.latent=this.latent.map(v=>rho*v+innovation*this.random.normal());
        const scheduled=this.options.powerScenario==='forecasted-demand'?Array.from({length:N},(_,i)=>scheduledPower(i+1,s)):null;
        const randomBase=Array.from({length:N},(_,i)=>i===0?0:AMPLITUDE*(.35*this.latent[0]+.65*this.latent[i+1]));
        const base=randomBase.map((value,i)=>i===0?0:boundedPowerDeviation(i+1,scheduled?scheduled[i]+value:value));
        const previous=s?this.forecasts[s-1].base:Array(N).fill(0);
        const baseW=matvec(model.powerToVoltage,base.map((v,i)=>v-LAG*previous[i]));
        const forecast=baseW.map((v,i)=>{
          const faulty=this.faults.has(i+1),noise=this.random.normal();
          const scale=model.forecastForcingScales[i];
          if(this.options.experiment==='communication')return i===0?0:v+scale*this.options.beta*(faulty?4:.05)*noise;
          return i===0?0:(faulty?this.preset.faultyGain:this.preset.gain)*v
            +scale*(faulty?this.preset.faultyNoise:this.preset.noise)*noise;
        });
        const scheduledMetadata=scheduled?{scheduledPowerKw:scheduled.map(value=>value*POWER_BASE_KW),
          scheduledAppliedKw:base.map((value,i)=>(value-boundedPowerDeviation(i+1,randomBase[i]))*POWER_BASE_KW)}:{};
        this.forecasts.push(deepFreeze({t:s,issuedAt:Math.max(0,s-PREVIEW+1),base,forecast,units:'pu voltage forcing',...scheduledMetadata}));
      }
    }
    toggleFault(bus){
      this.checkBus(bus);if(bus===1||!['running','completed'].includes(this.mode))return false;
      if(this.faults.has(bus))this.faults.delete(bus);else this.faults.add(bus);
      this.eventLog.push(deepFreeze({t:this.t,type:'forecast',bus,faulty:this.faults.has(bus),
        message:'Future voltage-forcing forecasts '+(this.faults.has(bus)?'corrupted':'repaired')}));return this.faults.has(bus);
    }
    addCompletedRow(segment,localRow){
      const id=segment.start+','+localRow;if(this.rowIds.has(id))return;
      const blocks=segment.dense.rows[localRow],h=[],ex=Array(N-1).fill(0),eu=Array(M).fill(0);
      for(const block of blocks){
        const index=segment.start+block.k-1,forecast=this.forecasts[index].forecast.slice(1);
        const actual=this.samples[index].disturbance.slice(1),error=actual.map((v,i)=>v-forecast[i]);
        h.push(forecast);const dx=matvec(block.X,error),du=matvec(block.U,error);
        for(let i=0;i<N-1;i++)ex[i]+=dx[i];for(let i=0;i<M;i++)eu[i]+=du[i];
      }
      const kex=matvec(model.K,ex),el=eu.map((v,i)=>v-kex[i]),energy=h.reduce((s,v)=>s+squared(v),0);
      const score0=zeros(M,N-1),score1=zeros(M,N-1),score2=zeros(M,N-1);
      blocks.forEach((block,k)=>{for(let i=0;i<M;i++)for(let j=0;j<N-1;j++){
        const direction=el[i]*h[k][j],base=block.L[i][j];
        score0[i][j]+=base*base;score1[i][j]+=2*base*direction;score2[i][j]+=direction*direction;
      }});
      this.rows.push({id,t:segment.start+localRow,segmentStart:segment.start,localRow,blocks,h,ex,eu,el,
        energy,curvature:RAW_RIDGE+energy,residualEnergy:squared(ex)+squared(eu),beta:0,
        delayed:Array(PREVIEW+1).fill(0),score0,score1,score2});this.rowIds.add(id);
    }
    advanceRows(rows){
      const maximum=Math.max(...rows.map(row=>row.energy));
      const eta=.05/((PREVIEW+1)*(RAW_RIDGE+maximum));
      for(const row of rows){
        row.beta+=eta*(1-row.curvature*row.delayed[0]);
        row.delayed.shift();row.delayed.push(row.beta);
      }
      return eta;
    }
    updateResponses(){
      if(!this.rows.length)return;
      this.learning.stepSize=this.advanceRows(this.rows);
      this.learning.updates++;this.learning.updateCount=this.learning.updates;
      this.measureResponses();this.refreshScores();
    }
    rowMetrics(rows){
      let error=0,scale=0,loss=0;
      for(const row of rows){
        const optimum=1/row.curvature,weight=row.residualEnergy*row.energy;
        error+=weight*(row.beta-optimum)**2;scale+=weight*optimum*optimum;
        loss+=.5*row.residualEnergy*((row.beta*row.energy-1)**2+RAW_RIDGE*row.beta*row.beta*row.energy);
      }
      return{error:rows.length?Math.sqrt(error/Math.max(scale,1e-30)):null,loss:rows.length?loss:null};
    }
    measureResponses(){
      const metrics=this.rowMetrics(this.rows);
      this.learning.completedRows=this.rows.length;this.learning.windowSize=this.rows.length;
      this.learning.windowStart=this.rows.length?this.rows[0].t:null;
      this.learning.windowEnd=this.rows.length?this.rows.at(-1).t:null;
      this.learning.prefixError=metrics.error;this.learning.prefixLoss=metrics.loss;
      this.lastTrainingTime=this.learning.windowEnd;this.lastTrainingSampleCount=this.rows.length;
    }
    updateCalibration(){
      // At action t, only pairs q<t are observed. Fresh comparison resets the
      // learner; discovery samples are used for selection, never carried into it.
      if(this._calibrationAt===this.t||this.t<WARMUP)return;
      if(this.phase==='deployment'&&this.options.experiment==='communication')return;
      const samples=this.samples.slice(-WINDOW);
      if(!samples.length)return;
      this._calibrationAt=this.t;
      const previous=this.calibration.matrix;
      const fit=Online.fit(samples,{dimension:N-1,lambda:model.calibrationRidge,
        window:WINDOW,warmup:0});
      this.calibration={...fit,updates:this.calibration.updates+1,trainedThrough:this.t-1,
        carriedSamples:0,parameterChange:frobenius(combine(fit.matrix,previous,1,-1))};
    }
    refreshScores(){
      const segment=this.segments.find(s=>this.t>=s.start&&this.t<s.end)||this.segments.at(-1);
      const measured=calibratedScores(segment.designs.online,this.calibration.matrix);
      let scores=measured.scores;
      let baselineScores=measured.baseline;
      let changeSquared=measured.changeSquared,scoreBasis='current-candidate-time-mean';
      if(this.phase==='discovery'&&this.t>=WARMUP&&this.lastSample?.t===this.t&&this._scoreAt!==this.t){
        // Score exactly the row that was executed, with its pre-action fit.
        // S is a raw squared-gain sum, never time- or row-normalized.
        Online.accumulateScores(this.communicationScores,this.lastResponseRows.online);
        Online.accumulateScores(this.communicationOfflineScores,this.lastResponseRows.static);
        const offline=new Map(this.lastResponseRows.static.map(block=>[block.k,block.L]));
        for(const block of this.lastResponseRows.online){
          const reference=offline.get(block.k);
          for(let i=0;i<M;i++)for(let j=0;j<N-1;j++)
            this.communicationGainChangeSquared+=(block.L[i][j]-reference[i][j])**2;
        }
        this.communicationScoreSamples++;this._scoreAt=this.t;
      }
      if(this.phase==='deployment'&&this.options.experiment==='communication'){
        scores=this.deployedSupport.scores.map(row=>row.slice());
        baselineScores=this.deployedSupport.discoveryDiagnostics.baselineScores.map(row=>row.slice());
      }else if(this.phase==='discovery'&&this.communicationScoreSamples){
        scores=this.communicationScores.map(row=>row.slice());
        baselineScores=this.communicationOfflineScores.map(row=>row.slice());
        changeSquared=this.communicationGainChangeSquared;scoreBasis='executed-row-raw-sum';
      }
      const selection=Online.selectSupport(scores,INVERTER_BUSES,REMOTE_BUDGET,this.options.experiment==='communication'?1e-12:0),gain=scoreGain(scores);
      const next=this.phase==='deployment'?this.deployedSupport.links.map(e=>({...e,weight:scores[INVERTER_BUSES.indexOf(e.to)][e.from-2]})):selection.links;
      if(this.directGain){
        this.drift=frobenius(combine(gain,this.directGain,1,-1))/Math.max(frobenius(this.directGain),1e-12);
        this.changedEdges=edgeChanges(this.recommendations,next);this.sinceStable=this.changedEdges===0?this.sinceStable+1:0;
      }
      this.directGain=gain;this.recommendations=next.map(e=>({...e}));this.predictionScores=scores;
      const count=this.calibration.windowSize,receiverEnergy=baselineScores.map(row=>row.reduce((sum,v)=>sum+v,0));
      const baselineEnergy=receiverEnergy.reduce((sum,v)=>sum+v,0);
      const energyChange=scores.map((row,i)=>row.map((v,j)=>v-baselineScores[i][j]));
      const relativeEnergyChange=energyChange.map((row,i)=>row.map((v,j)=>baselineScores[i][j]>0?v/baselineScores[i][j]:null));
      const receiverNormalizedChange=energyChange.map((row,i)=>row.map(v=>receiverEnergy[i]>0?v/receiverEnergy[i]:0));
      const offlineLinks=this.phase==='deployment'?this.deployedSupport.fixedLinks:Online.selectSupport(baselineScores,INVERTER_BUSES,REMOTE_BUDGET,this.options.experiment==='communication'?1e-12:0).links;
      const offlineKeys=new Set(offlineLinks.map(e=>e.to+','+e.from)),learnedKeys=new Set(next.map(e=>e.to+','+e.from));
      const addedLinkCount=[...learnedKeys].filter(key=>!offlineKeys.has(key)).length;
      const removedLinkCount=[...offlineKeys].filter(key=>!learnedKeys.has(key)).length;
      this.predictionDiagnostics=deepFreeze({available:count>0||this.phase==='deployment',frozen:this.phase==='deployment'&&this.options.experiment==='communication',completedRows:count,
        scoreSamples:this.phase==='deployment'?this.deployedSupport.scoreSamples:this.communicationScoreSamples,scoreBasis,
        receiverBuses:INVERTER_BUSES.slice(),sourceBuses:Array.from({length:N-1},(_,i)=>i+2),
        baselineScores,learnedScores:scores,energyChange,relativeEnergyChange,receiverNormalizedChange,
        relativeGainChange:count&&baselineEnergy>0?Math.sqrt(changeSquared/baselineEnergy):null,
        overallRelativeEnergyChange:baselineEnergy>0?energyChange.flat().reduce((sum,v)=>sum+v,0)/baselineEnergy:null,
        offlineLinks,addedLinkCount,removedLinkCount,changedLinkCount:addedLinkCount+removedLinkCount});
      if(this.phase==='deployment'&&this.options.experiment==='communication')
        this.predictionDiagnostics=deepFreeze({...this.deployedSupport.discoveryDiagnostics,frozen:true,scoreBasis:'frozen-discovery-executed-row-raw-sum'});
    }
    step(){
      if(this.mode!=='running')return this.snapshot();
      if(this.t>=this.options.horizon){this.mode='completed';return this.snapshot();}
      const time=this.t,segment=this.segments.find(s=>time>=s.start&&time<s.end),local=time-segment.start;
      this.updateCalibration();
      this.sealPreview();this.lastPreview=segment.dense.rows[local].map(block=>this.forecasts[segment.start+block.k-1]);
      const issued=this.forecasts[time],background=issued.base,requested=Array(N).fill(0);
      // A prespecified unannounced generation outage is realized only after
      // deployment. It never enters sealPreview or changes discovery selection.
      const outage=this.phase==='deployment'&&this.options.powerScenario==='solar-outage'&&time>=30&&time<50;
      const scenarioRequest=background.map((v,i)=>outage&&SOLAR_BUSES.includes(i+1)?Math.max(0,BUS_PROFILES[i].baseGenerationKw-v*1000):0);
      const scenarioBase=background.map((v,i)=>boundedPowerDeviation(i+1,v+scenarioRequest[i]/1000));
      this.lastScenarioApplications=issued.scheduledPowerKw
        ?issued.scheduledPowerKw.flatMap((requestedKw,i)=>i>0?[{bus:i+1,requestedKw,appliedKw:issued.scheduledAppliedKw[i],forecasted:true,role:BUS_PROFILES[i].role}]:[])
        :scenarioRequest.flatMap((requestedKw,i)=>requestedKw>0?[{bus:i+1,requestedKw,appliedKw:(scenarioBase[i]-background[i])*1000}]:[]);
      if(this.options.powerScenario==='forecasted-demand'&&time%FORECASTED_DEMAND.periodSeconds===0)
        this.eventLog.push(deepFreeze({t:time,type:'scenario',kind:'demand',forecasted:true,message:'Scheduled demand and solar cycle'}));
      if(this.phase==='deployment'&&this.options.powerScenario==='solar-outage'&&(time===30||time===50))
        this.eventLog.push(deepFreeze({t:time,type:'scenario',action:time===30?'start':'restore',buses:SOLAR_BUSES.slice(),message:time===30?'Solar outage begins':'Solar generation restored'}));
      for(const event of this.pulses){event.requestedKw=event.strength*Math.exp(-event.age/event.decay);requested[event.bus-1]+=event.requestedKw;}
      const nextPower=scenarioBase.map((v,i)=>boundedPowerDeviation(i+1,v+requested[i]/1000));
      const pulse=nextPower.map((v,i)=>(v-scenarioBase[i])*1000);this.lastPulseApplications=[];
      for(let i=1;i<N;i++)if(requested[i]>0)this.lastPulseApplications.push({bus:i+1,requestedKw:requested[i],
        appliedKw:pulse[i],capped:pulse[i]<requested[i]-1e-9,eventName:BUS_PROFILES[i].eventName});
      for(const event of this.pulses){event.appliedKw=requested[event.bus-1]?event.requestedKw*pulse[event.bus-1]/requested[event.bus-1]:0;event.age++;}
      this.pulses=this.pulses.filter(event=>event.age<event.steps);
      this.costStates=Object.fromEntries(CONTROLLERS.map(key=>[key,this.states[key].slice()]));
      const inputs={},rms={},regulationRms={},recovered={};
      const fixedTopologyTrial=this.phase==='deployment'&&this.options.experiment==='communication';
      this.lastResponseRows={causal:[]};
      for(const key of ['online','scalar','static']){
        const correction=fixedTopologyTrial?1:key==='online'?this.calibration.matrix:
          key==='scalar'?this.calibration.scalar:1;
        this.lastResponseRows[key]=deepFreeze(Online.deployedRow(segment.designs[key].rows[local],model.K,
          correction,{time:local,historyWindow:WINDOW,predictionWindow:PREVIEW}));
      }
      for(const key of CONTROLLERS){
        const x=this.states[key].slice(1).map((v,i)=>v-model.baseDrop[i+1]);
        const raw=matvec(model.K,x);
        for(const block of this.lastResponseRows[key]){
          const forecast=this.forecasts[segment.start+block.k-1].forecast.slice(1);
          const contribution=matvec(block.L,forecast);
          for(let i=0;i<M;i++)raw[i]+=contribution[i];
        }
        const bounded=raw.map(v=>Math.max(-Q_LIMIT,Math.min(Q_LIMIT,v)));
        this.command[key]=bounded;this.saturation[key]=padInput(raw.map((v,i)=>Math.abs(v-bounded[i])>1e-12));
        this.stage[key]=35*squared(x)+.08*squared(bounded);this.cumulative[key]+=this.stage[key];
        this.q[key]=this.q[key].map((v,i)=>LAG*v+(1-LAG)*bounded[i]);
        this.states[key]=voltageFrom(nextPower,this.q[key]);inputs[key]=padInput(bounded);
        const bu=matvec(model.B,bounded),xn=this.states[key].slice(1).map((v,i)=>v-model.baseDrop[i+1]);
        recovered[key]=[0,...xn.map((v,i)=>v-LAG*x[i]-bu[i])];
        rms[key]=Math.sqrt(squared(this.states[key].slice(1))/(N-1));regulationRms[key]=Math.sqrt(squared(xn)/(N-1));
      }
      const sample=deepFreeze({t:time,forecast:issued.forecast,disturbance:recovered.online,
        voltageDisturbance:recovered.online,disturbances:recovered,base:background,powerDeviation:nextPower,
        pulse,scenarioApplications:this.lastScenarioApplications.map(p=>({...p})),pulseApplications:this.lastPulseApplications.map(p=>({...p})),units:'pu voltage forcing',pulseUnits:'kW',
        ...(issued.scheduledPowerKw?{scheduledPowerKw:issued.scheduledPowerKw,scheduledAppliedKw:issued.scheduledAppliedKw}:{})});
      this.powerDeviation=nextPower.slice();this.power=physicalPower(nextPower);this.lastInputs=deepFreeze(inputs);this.lastSample=sample;this.samples.push(sample);
      this.learning.rawRms=Math.sqrt(squared(sample.forecast.map((v,i)=>v-sample.disturbance[i]))/(N-1));
      if(this.phase==='discovery'&&time>=PREVIEW){
        const completedTime=time-PREVIEW,completedSegment=this.segments.find(s=>completedTime>=s.start&&completedTime<s.end);
        this.addCompletedRow(completedSegment,completedTime-completedSegment.start);
      }
      if(this.phase==='discovery'&&this.rows.length)this.updateResponses();
      else this.refreshScores();
      this.t++;
      this.history.push(deepFreeze({t:this.t,costTime:time,stateTime:this.t,...this.cumulative,stage:{...this.stage},rms,regulationRms,
        pulse:sample.pulse,costStates:this.costStates,states:Object.fromEntries(CONTROLLERS.map(key=>[key,this.states[key].slice()])),
        regulationStates:Object.fromEntries(CONTROLLERS.map(key=>[key,this.states[key].map((v,i)=>v-model.baseDrop[i])])),
        rawForecastRms:this.learning.rawRms,
        calibratedForecastRms:Math.sqrt(squared(matvec(this.calibration.matrix,sample.forecast.slice(1)).map((v,i)=>v-sample.disturbance[i+1]))/(N-1)),
        prefixError:this.learning.prefixError,prefixLoss:this.learning.prefixLoss,
        completedRows:this.rows.length,drift:this.drift,changedEdges:this.changedEdges}));
      if(this.t>=this.options.horizon)this.mode='completed';return this.snapshot();
    }
    freeze(){
      if(this.phase!=='discovery'||this.rows.length<WARMUP)return false;
      if(['frozen','fitting','converged'].includes(this.mode))return this.snapshot();
      this.fit={rows:this.rows.map(row=>({...row,delayed:row.delayed.slice()})),rowCount:this.rows.length};
      this.fitIteration=0;this.fitHistory=[];this.mode='frozen';
      this.measureFit();this.eventLog.push(deepFreeze({t:this.t,type:'freeze',message:'Independent copy of completed response prefix frozen'}));return this.snapshot();
    }
    measureFit(){
      const metrics=this.rowMetrics(this.fit.rows);this.fitError=metrics.error;this.fitObjective=metrics.loss;
      this.fitHistory.push(deepFreeze({iteration:this.fitIteration,error:this.fitError,objective:this.fitObjective,changedEdges:this.changedEdges}));
    }
    fitStep(count=12){
      if(!this.fit||['running','completed','converged'].includes(this.mode))return this.snapshot();
      if(!Number.isInteger(count)||count<1)throw new Error('Iteration count must be positive');
      this.mode='fitting';for(let i=0;i<count;i++)this.advanceRows(this.fit.rows);this.fitIteration+=count;this.measureFit();
      this.eventLog.push(deepFreeze({t:this.t,type:'fit',count,message:'Delayed response optimization on fixed data'}));
      if(this.fitError<TOLERANCE)this.mode='converged';return this.snapshot();
    }
    resume(){
      this.mode=this.t>=this.options.horizon?'completed':'running';this.fit=null;this.fitError=null;this.fitObjective=null;
      this.fitIteration=0;this.fitHistory=[];this.drift=0;this.changedEdges=0;this.sinceStable=0;
      this.eventLog.push(deepFreeze({t:this.t,type:'resume',message:'Physical trial resumed'}));return this.snapshot();
    }
    deployTopology(){
      if(this.phase!=='discovery'||this.samples.length<WARMUP)return false;
      if(this.options.experiment==='communication'&&!this.communicationScoreSamples)return false;
      this.discoveryRecord=deepFreeze({options:{...this.initialOptions,faultBuses:this.initialOptions.faultBuses.slice()},
        t:this.t,events:this.eventLog.slice()});
      let learned=Online.selectSupport(this.predictionScores,INVERTER_BUSES,REMOTE_BUDGET);
      const offline=this.communicationScoreSamples?this.communicationOfflineScores:
        this.segments.reduce((sum,segment)=>{addScores(sum,segment.offlineScores);return sum;},zeros(M,N-1));
      let fixed=Online.selectSupport(offline,INVERTER_BUSES,REMOTE_BUDGET);
      // Prediction comparison evaluates unrestricted online/scalar adaptation.
      // Only communication comparison deploys re-synthesized sparse responses.
      if(this.options.experiment==='prediction'){
        const dense=Online.selectSupport(this.predictionScores,INVERTER_BUSES,N-2);
        learned=dense;fixed=dense;
      }
      this.deployedSupport=deepFreeze({learned:learned.support,fixed:fixed.support,links:learned.links,fixedLinks:fixed.links,
        scores:this.predictionScores.map(row=>row.slice()),completedRows:this.rows.length,discoveryTime:this.t,
        scoreSamples:this.communicationScoreSamples,trainingSamples:[],
        algorithmId:ALGORITHM_ID,selection:'raw executed message-gain energy; exact row budget; local mandatory',
        discoveryDiagnostics:this.predictionDiagnostics});
      // A fresh physical trial retains the reliability map observed at the end
      // of discovery. Original options and events above remain replayable.
      this.phase='deployment';this.initialOptions={...this.discoveryRecord.options,
        faultBuses:[...this.faults].sort((a,b)=>a-b),
        seed:(this.discoveryRecord.options.seed^0x9E3779B9)>>>0};return this.reset();
    }
    snapshot(){
      const voltages=Object.fromEntries(CONTROLLERS.map(key=>[key,this.states[key].map(v=>1+v)]));
      const inverterQ=Object.fromEntries(CONTROLLERS.map(key=>[key,padInput(this.q[key]).map(v=>v*1000)]));
      const commandQ=Object.fromEntries(CONTROLLERS.map(key=>[key,padInput(this.command[key]).map(v=>v*1000)]));
      const flows=Object.fromEntries(CONTROLLERS.map(key=>[key,branchFlows(this.power.loadP,this.power.loadQ,this.q[key])]));
      const terminalCost=Object.fromEntries(CONTROLLERS.map(key=>{
        const x=this.states[key].slice(1).map((v,i)=>v-model.baseDrop[i+1]),px=matvec(model.P,x);return[key,x.reduce((sum,v,i)=>sum+v*px[i],0)];}));
      const scheduled=this.options.powerScenario==='forecasted-demand';
      const sumScheduled=role=>this.lastScenarioApplications.filter(item=>!role||item.role===role).reduce((sum,item)=>sum+item.appliedKw,0);
      const scenario=scheduled?{...FORECASTED_DEMAND,forecasted:true,phaseLabel:'Demand and solar cycle',
        action:this.lastSample?.t ?? null,active:this.t>0,
        requestedKw:this.lastScenarioApplications.reduce((sum,item)=>sum+item.requestedKw,0),appliedKw:sumScheduled(),
        demandChangeKw:sumScheduled('Homes'),solarLossKw:sumScheduled('Solar'),batteryChangeKw:sumScheduled('Battery'),
        absoluteAppliedKw:this.lastScenarioApplications.reduce((sum,item)=>sum+Math.abs(item.appliedKw),0)}
        :{id:this.options.powerScenario,start:30,end:50,active:this.phase==='deployment'&&this.t>30&&this.t<=50,requestedKw:this.lastScenarioApplications.reduce((sum,p)=>sum+p.requestedKw,0),appliedKw:this.lastScenarioApplications.reduce((sum,p)=>sum+p.appliedKw,0)};
      return{networkId:network.id,networkLabel:network.label,t:this.t,costTime:this.lastSample?this.lastSample.t:null,stateTime:this.t,horizon:this.options.horizon,
        initialOptions:{...this.initialOptions,faultBuses:this.initialOptions.faultBuses.slice()},
        algorithmId:ALGORITHM_ID,lastResponseRows:this.lastResponseRows,
        phase:this.phase,experiment:this.options.experiment,beta:this.options.beta,canDeploy:this.phase==='discovery'&&this.samples.length>=WARMUP&&(this.options.experiment!=='communication'||this.communicationScoreSamples>0),
        discoveryRecord:this.discoveryRecord,deployedSupport:this.deployedSupport,
        segments:this.segments.map(s=>({start:s.start,end:s.end,length:s.length})),
        mode:this.mode,seed:this.options.seed,preset:this.options.preset,presetLabel:this.preset.label,
        initialVoltage:model.initialVoltage.slice(),referenceVoltage:model.referenceVoltage.slice(),initialStates:model.baseDrop.slice(),
        voltage:voltages.online.slice(),voltages,inverterQ,commandQ,
        saturation:Object.fromEntries(CONTROLLERS.map(key=>[key,this.saturation[key].map(Boolean)])),
        ...Object.fromEntries(Object.entries(this.power).map(([key,value])=>[key,value.slice()])),powerDeviation:this.powerDeviation.slice(),
        edgeData:model.edgeData.map((edge,i)=>({...edge,pKw:flows.online[i].pKw,qKvar:Object.fromEntries(CONTROLLERS.map(key=>[key,flows[key][i].qKvar]))})),
        powerScenario:this.options.powerScenario,scenario,
        ...(scheduled?{scheduledPowerKw:this.lastSample?.scheduledPowerKw.slice() || Array(N).fill(0)}:{}),
        lastScenarioApplications:this.lastScenarioApplications.map(p=>({...p})),lastPulseApplications:this.lastPulseApplications.map(p=>({...p})),costStates:Object.fromEntries(CONTROLLERS.map(key=>[key,this.costStates[key].slice()])),
        learning:{...this.learning},calibration:{...this.calibration,matrix:copy(this.calibration.matrix)},predictionDiagnostics:this.predictionDiagnostics,lastPreview:this.lastPreview.slice(),
        pendingPulses:this.pulses.filter(e=>e.age===0).map(e=>({...e})),activePulses:this.pulses.filter(e=>e.age>0).map(e=>({...e})),
        states:Object.fromEntries(CONTROLLERS.map(key=>[key,this.states[key].slice()])),
        regulationStates:Object.fromEntries(CONTROLLERS.map(key=>[key,this.states[key].map((v,i)=>v-model.baseDrop[i])])),
        cumulative:{...this.cumulative},stage:{...this.stage},costs:{...this.cumulative},terminalCost,
        totalCost:Object.fromEntries(CONTROLLERS.map(key=>[key,this.cumulative[key]+terminalCost[key]])),
        history:this.history.slice(),directGain:copy(this.directGain),recommendations:this.recommendations.map(e=>({...e})),
        localChannels:INVERTER_BUSES.map(bus=>({from:bus,to:bus,weight:this.directGain[bus-1][bus-1]**2})),
        faults:[...this.faults].sort((a,b)=>a-b),eventLog:this.eventLog.slice(),lastSample:this.lastSample,lastInputs:this.lastInputs,
        drift:this.drift,changedEdges:this.changedEdges,sinceStable:this.sinceStable,sampleCount:this.samples.length,
        lastTrainingTime:this.lastTrainingTime,lastTrainingSampleCount:this.lastTrainingSampleCount,
        fitError:this.fitError,fitObjective:this.fitObjective,fitIteration:this.fitIteration,fitHistory:this.fitHistory.slice(),
        fitDiagnostic:this.fit?{independent:true,rowCount:this.fit.rowCount,deployed:false}:null,
        canFreeze:this.phase==='discovery'&&this.rows.length>=WARMUP};
    }
  }
  // Pure diagnostics over executed states. These never enter control or cost.
  function voltageMetrics(snapshot) {
    const reference=snapshot.referenceVoltage;
    const worst=(values,absolute=false)=>{
      let value=-Infinity,bus=1;
      for(let i=0;i<reference.length;i++) {
        const error=Math.abs((absolute?values[i]:1+values[i])-reference[i]);
        if(error>value) {value=error;bus=i+1;}
      }
      return {value,bus};
    };
    return Object.fromEntries(CONTROLLERS.map(key=>{
      const current=worst(snapshot.states[key]);
      let peak=worst(snapshot.initialVoltage,true),peakTime=0;
      for(const entry of snapshot.history || []) {
        if(!entry.states?.[key]) continue;
        const candidate=worst(entry.states[key]);
        if(candidate.value>peak.value) {peak=candidate;peakTime=entry.stateTime ?? entry.t;}
      }
      if(current.value>peak.value) {peak=current;peakTime=snapshot.t;}
      return [key,{currentMaxPu:current.value,currentBus:current.bus,peakMaxPu:peak.value,peakBus:peak.bus,peakTime,
        limitedCount:(snapshot.saturation?.[key] || []).filter(Boolean).length}];
    }));
  }
  return{Simulation,model,voltageMetrics,constants:deepFreeze({algorithmId:ALGORITHM_ID,networkId:network.id,networkLabel:network.label,N,M,edges:EDGES,edgeData:model.edgeData,inverterBuses:INVERTER_BUSES,
    amplitude:AMPLITUDE,ridge:RIDGE,rawRidge:RAW_RIDGE,remoteBudget:REMOTE_BUDGET,preview:PREVIEW,window:WINDOW,warmup:WARMUP,
    busProfiles:BUS_PROFILES,controllers:CONTROLLERS,forecastPresets:FORECAST_PRESETS,communicationBetas:COMMUNICATION_BETAS,
    communicationStressBetas:COMMUNICATION_STRESS_BETAS,forecastedDemand:FORECASTED_DEMAND,tolerance:TOLERANCE,horizon:480,
    pulseDefault:PULSE_DEFAULT,pulseMin:PULSE_MIN,pulseMax:PULSE_MAX,pulseUnits:'kW',powerBaseKw:POWER_BASE_KW,
    baseKv:BASE_KV,baseMva:BASE_MVA,sampleSeconds:SAMPLE_SECONDS,tauSeconds:TAU_SECONDS,inverterKvar:70}),
    math:{zeros,eye,transpose,multiply,matvec,combine,frobenius,normInf,solveSPD,getDesign,Response,Online,calibratedScores,
      recommendations,physicalPower,voltageFrom,branchFlows,radialAC,padInput,scheduledPower}};
});
