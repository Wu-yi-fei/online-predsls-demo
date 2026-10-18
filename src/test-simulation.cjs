'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {Simulation,model,constants,math,voltageMetrics}=require('./simulation.js');
const {multiply,transpose,combine,frobenius,matvec,solveSPD}=math;
const Response=require('./response-controller.js');
const Calibration=require('./forecast-calibration.js');
const controllers=constants.controllers;
const distance=(a,b)=>frobenius(combine(a,b,1,-1));
const vectorDistance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
const run=(sim,n)=>{for(let i=0;i<n;i++)sim.step();return sim.snapshot();};
const bounded=a=>a.map(v=>Math.max(-.07,Math.min(.07,v)));
const reg=s=>s.map((v,i)=>v-model.baseDrop[i]).slice(1);
const zeros=(n,m=n)=>Array.from({length:n},()=>Array(m).fill(0));
const sq=x=>x.reduce((s,v)=>s+v*v,0);

test('radial feeder uses positive declared impedances, 23 states, eight physical inverters, and a fixed slack',()=>{
  assert.equal(constants.edges.length,23);assert.equal(model.A.length,23);assert.equal(model.B[0].length,8);
  assert.equal(model.baseKv,12.47);assert.equal(model.baseMva,1);
  for(const edge of model.edgeData){assert.ok(edge.rOhm>0&&edge.xOhm>0);assert.ok(Math.abs(edge.rPu-edge.rOhm/12.47**2)<1e-15);}
  assert.equal(new Set(model.order).size,24);
  assert.deepEqual(model.resistance[0],Array(24).fill(0));assert.deepEqual(model.reactance[0],Array(24).fill(0));
  for(let i=0;i<24;i++)for(let j=0;j<24;j++){
    let r=0,x=0;for(let e=0;e<23;e++){r+=model.paths[i][e]*model.paths[j][e]*model.edgeData[e].rPu;x+=model.paths[i][e]*model.paths[j][e]*model.edgeData[e].xPu;}
    assert.ok(Math.abs(model.resistance[i][j]-r)<1e-15);assert.ok(Math.abs(model.reactance[i][j]-x)<1e-15);
  }
  const s=new Simulation().snapshot();assert.deepEqual(s.voltage,s.referenceVoltage);assert.deepEqual(s.initialVoltage,s.referenceVoltage);
  assert.ok(Math.min(...s.referenceVoltage)>.95&&Math.max(...s.referenceVoltage)<=1.05);
  assert.ok(Math.abs(Math.min(...s.voltage)-.9873849473897026)<1e-14);
  assert.deepEqual(s.regulationStates.online,Array(24).fill(0));
});

test('general B Riccati feedback and terminal weight match the physical inverter lag model',()=>{
  const {A,B,P,Q,R,K}=model,at=transpose(A),bt=transpose(B),S=combine(R,multiply(bt,multiply(P,B)));
  const gain=solveSPD(S,multiply(bt,multiply(P,A)));
  const rhs=combine(combine(Q,multiply(at,multiply(P,A))),multiply(at,multiply(P,multiply(B,gain))),1,-1);
  assert.ok(distance(P,rhs)<1e-10);assert.ok(distance(K,gain.map(row=>row.map(v=>-v)))<1e-14);
  assert.ok(model.closedLoopNormInf<1);assert.ok(Math.abs(model.lag-Math.exp(-.5))<1e-15);
  for(let i=0;i<23;i++)for(let j=0;j<8;j++)assert.ok(Math.abs(B[i][j]-(1-model.lag)*model.reactance[i+1][constants.inverterBuses[j]-1])<1e-15);
});

test('finite horizon synthesis satisfies recurrence, FIR support, terminal handling and hard realizing gain support',()=>{
  const synthesizer=new Response.Synthesizer(model),masks=[null,Array.from({length:8},()=>Array(23).fill(false)),
    Array.from({length:8},(_,i)=>Array.from({length:23},(_,j)=>j===constants.inverterBuses[i]-2||j%5===i%5))];
  for(const T of [1,4,10,17])for(const mask of masks){
    const design=synthesizer.synthesize(T,mask);
    for(const column of design.columns){
      const k=column.k;assert.deepEqual(column.X[Math.max(0,k-5)],zeros(23));
      for(const [key,U] of Object.entries(column.U)){
        const t=Number(key),X=column.X[t],next=column.X[t+1]||zeros(23),AX=multiply(model.A,X),BU=multiply(model.B,U),KX=multiply(model.K,X);
        assert.ok(distance(next,combine(AX,BU))<1e-12);
        assert.ok(distance(column.L[t],combine(U,KX,1,-1))<1e-12);
        for(let i=0;i<8;i++)for(let j=0;j<23;j++)if(mask&&!mask[i][j])assert.ok(Math.abs(column.L[t][i][j])<1e-12);
        assert.ok(k>=t-4&&k<=t+5);
      }
      if(k+5<=T)assert.equal(column.X[k+5],undefined);
    }
  }
  const final=synthesizer.synthesize(10).columns.at(-1);
  assert.ok(frobenius(final.X[10])>1e-6,'terminal state remains free and carries P when FIR support reaches the horizon');
});

test('QP solution is stationary in its feasible nullspace and dense prediction improves its declared offline objective',()=>{
  const syn=new Response.Synthesizer(model),pattern=syn.pattern(20,10),allowed=[true,false,true,false,false,true,false,true];
  const factor=syn.factor(pattern,allowed),column=syn.column(20,10,Array.from({length:8},(_,i)=>Array(23).fill(allowed[i])));
  const bt=transpose(model.B),left=solveSPD(multiply(bt,model.B),bt);
  for(const source of [0,7,22]){
    const solution=factor.times.flatMap(time=>matvec(left,column.X[10+time].map(row=>row[source])));
    const gradient=matvec(factor.H,solution).map((v,i)=>v+factor.linear[i][source]);
    for(const direction of factor.basis)assert.ok(Math.abs(direction.reduce((s,v,i)=>s+v*gradient[i],0))<1e-10);
    const objectiveChange=solution.reduce((s,v,i)=>s+v*(matvec(factor.H,solution)[i]+2*factor.linear[i][source]),0);
    assert.ok(objectiveChange<=1e-12,'zero predictive response is a feasible comparison');
  }
});

test('prediction links affect real commands and forbidden channels have zero effect before saturation',()=>{
  const syn=new Response.Synthesizer(model),local=Array.from({length:8},(_,i)=>Array.from({length:23},(_,j)=>j===constants.inverterBuses[i]-2));
  const dense=syn.synthesize(30),sparse=syn.synthesize(30,local);let allowedEffect=0,forbiddenEffect=0,difference=0;
  for(const block of sparse.rows[12]){
    const reference=dense.rows[12].find(b=>b.k===block.k);
    for(let i=0;i<8;i++)for(let j=0;j<23;j++){
      const prediction=Array(23).fill(0);prediction[j]=.001;
      const command=matvec(block.L,prediction)[i];
      if(local[i][j])allowedEffect=Math.max(allowedEffect,Math.abs(command));else forbiddenEffect=Math.max(forbiddenEffect,Math.abs(command));
      difference=Math.max(difference,Math.abs(block.L[i][j]-reference.L[i][j]));
    }
  }
  assert.ok(forbiddenEffect<1e-14);assert.ok(allowedEffect>1e-5);assert.ok(difference>1e-3);
});

test('discovery calibrates future commands after warmup while completed row diagnostics preserve their original responses',()=>{
  const sim=new Simulation({horizon:80}),reference=sim.segments[0].dense;
  const frozenFuture=JSON.stringify(reference.rows[55]);let matrixDiffers=false,scalarDiffers=false;
  for(let t=0;t<60;t++){
    const previous=sim.snapshot(),revealed=sim.samples.slice(-60),snap=sim.step(),row=reference.rows[t];
    if(t<30){
      assert.deepEqual(snap.calibration.matrix,math.eye(23));assert.equal(snap.calibration.scalar,1);
      assert.deepEqual(snap.states.online,snap.states.static);assert.deepEqual(snap.states.scalar,snap.states.static);
    }else{
      const fit=Calibration.fit(revealed,{lambda:model.calibrationRidge});
      assert.deepEqual(snap.calibration.matrix,fit.matrix);assert.equal(snap.calibration.scalar,fit.scalar);
      assert.equal(snap.calibration.trainedThrough,t-1);assert.equal(snap.calibration.windowSize,Math.min(t,60));
      assert.equal(snap.calibration.updates,t-29);
    }
    for(const key of ['online','scalar','static']){
      let expected=matvec(model.K,reg(previous.states[key]));
      for(const block of row){
        const forecast=sim.forecasts[block.k-1].forecast.slice(1);
        const corrected=key==='online'?matvec(snap.calibration.matrix,forecast):key==='scalar'?forecast.map(v=>v*snap.calibration.scalar):forecast;
        const term=matvec(block.L,corrected);expected=expected.map((v,i)=>v+term[i]);
      }
      assert.ok(vectorDistance(snap.lastInputs[key],math.padInput(bounded(expected)))<1e-14);
    }
    matrixDiffers ||= vectorDistance(snap.lastInputs.online,snap.lastInputs.static)>1e-7;
    scalarDiffers ||= vectorDistance(snap.lastInputs.scalar,snap.lastInputs.static)>1e-7;
    assert.deepEqual(snap.lastInputs.causal,math.padInput(bounded(matvec(model.K,reg(previous.states.causal)))));
    assert.equal(snap.learning.completedRows,Math.max(0,t-4));
    if(t>=5){assert.equal(sim.rows.at(-1).t,t-5);assert.ok(sim.rows.at(-1).blocks.every(block=>block.k-1<=t-1));}
    assert.equal(JSON.stringify(reference.rows[55]),frozenFuture);
  }
  assert.ok(matrixDiffers);assert.ok(scalarDiffers);
  assert.ok(sim.rows.some(row=>row.beta>0));assert.ok(Object.isFrozen(reference.rows[55][0].L));
});

test('calibration never sees an unrevealed attack and uses only the latest sixty completed samples',()=>{
  const clean=new Simulation({horizon:100}),attacked=new Simulation({horizon:100});run(clean,65);run(attacked,65);
  attacked.queuePulse(23,150);
  const a=clean.step(),b=attacked.step();
  assert.deepEqual(a.calibration,b.calibration);assert.deepEqual(a.lastInputs,b.lastInputs);
  assert.notDeepEqual(a.lastSample.disturbance,b.lastSample.disturbance);
  assert.equal(b.calibration.windowSize,60);assert.equal(b.calibration.trainedThrough,64);
  const revealed=attacked.samples.slice(-60),expected=Calibration.fit(revealed,{lambda:model.calibrationRidge}),next=attacked.step();clean.step();
  assert.deepEqual(next.calibration.matrix,expected.matrix);assert.equal(next.calibration.scalar,expected.scalar);
  assert.notDeepEqual(next.calibration.matrix,clean.snapshot().calibration.matrix);
  const saved=attacked.snapshot();saved.calibration.matrix[0][0]+=10;
  assert.notEqual(saved.calibration.matrix[0][0],attacked.snapshot().calibration.matrix[0][0]);
});

test('Algorithm 1 uses the stored t-d response iterate rather than current or t-d+1',()=>{
  const sim=new Simulation({horizon:40}),versions=[0];let current=0;
  for(let t=0;t<25;t++){
    const snap=sim.step();
    if(t>=5){
      const row=sim.rows[0],delayed=versions[t-5]||0;
      current+=snap.learning.stepSize*(1-row.curvature*delayed);
      assert.ok(Math.abs(row.beta-current)<1e-9);
      // An explicit coefficient gradient verifies the rank-one reduction.
      const block=row.blocks[0],j=3,i=1,h=row.h[0][j],e=row.eu[i],off=block.U[i][j];
      const delayedCoefficient=off+delayed*e*h;
      const residual=(delayed*row.energy-1)*e;
      const gradient=residual*h+constants.ridge*(delayedCoefficient-off);
      const previousCoefficient=off+(versions[t]||0)*e*h;
      assert.ok(Math.abs(off+row.beta*e*h-(previousCoefficient-snap.learning.stepSize*gradient))<1e-12);
    }
    versions.push(current);
  }
});

test('completed row optimum and measured error agree with explicit rank-one response reconstruction',()=>{
  const sim=new Simulation({horizon:60});run(sim,40);let numerator=0,denominator=0;
  for(const row of sim.rows){
    for(let b=0;b<row.blocks.length;b++)for(const error of [row.ex,row.eu])for(const e of error)for(const h of row.h[b]){
      const actual=row.beta*e*h,target=e*h/(constants.ridge+row.energy);
      numerator+=(actual-target)**2;denominator+=target*target;
    }
  }
  assert.ok(Math.abs(sim.learning.prefixError-Math.sqrt(numerator/denominator))<1e-12);
  assert.ok(sim.rows.every(row=>row.energy>=0&&row.curvature>0));assert.equal(constants.ridge,1e-6);
});

test('canonical forecasts are immutable, correctly issued, shared across controllers, and never contain a future pulse',()=>{
  const clean=new Simulation(),attacked=new Simulation();run(clean,20);run(attacked,20);
  const before=attacked.snapshot();attacked.queuePulse(23,100);
  const queued=attacked.snapshot();for(const field of ['t','states','costs','history'])assert.deepEqual(queued[field],before[field]);
  const a=clean.step(),b=attacked.step();assert.deepEqual(a.lastPreview,b.lastPreview);assert.deepEqual(a.lastInputs,b.lastInputs);assert.deepEqual(a.stage,b.stage);
  assert.ok(Math.abs(b.loadP[22]-a.loadP[22]-100)<1e-12);
  for(const record of attacked.forecasts){assert.ok(Object.isFrozen(record.forecast));assert.equal(record.issuedAt,Math.max(0,record.t-4));}
  assert.equal(b.lastSample.units,'pu voltage forcing');assert.equal(b.lastSample.forecast[0],0);
  for(const key of controllers)assert.ok(vectorDistance(b.lastSample.disturbances[key],b.lastSample.disturbance)<1e-14);
  const c=clean.step(),d=attacked.step();assert.notDeepEqual(c.lastInputs.online,d.lastInputs.online);assert.ok(d.stage.online>c.stage.online);
});

test('fault changes only newly issued canonical forecasts and presets share the same actual load sequence',()=>{
  const sims=constants.forecastPresets.map(p=>new Simulation({seed:17,preset:p.id,horizon:40}));
  for(let t=0;t<40;t++){
    const snaps=sims.map(s=>s.step());for(const snap of snaps)assert.deepEqual(snap.loadP,snaps[0].loadP);
    const base=sims[0].forecasts[t].base,previous=t?sims[0].forecasts[t-1].base:Array(24).fill(0);
    const truth=matvec(model.powerToVoltage,base.map((v,i)=>v-model.lag*previous[i]));
    for(let i=1;i<24;i++){
      const scale=model.forecastForcingScales[i],noise=(snaps[0].lastSample.forecast[i]-truth[i])/(scale*.05);
      assert.ok(Math.abs(snaps[1].lastSample.forecast[i]-(.65*truth[i]+scale*.65*noise))<1e-14);
    }
  }
  const a=new Simulation(),b=new Simulation();b.toggleFault(4);
  for(let t=0;t<5;t++)assert.deepEqual(a.step().lastSample.forecast,b.step().lastSample.forecast);
  assert.notEqual(a.step().lastSample.forecast[3],b.step().lastSample.forecast[3]);
});

test('all four physical plants obey voltage sensitivity, inverter lag, capability and recovered disturbance equations',()=>{
  const sim=new Simulation({horizon:100});
  for(let t=0;t<100;t++){
    if(t===35||t===36)sim.queuePulse(23,150);if(t===65)sim.queuePulse(7,150);
    const previous=sim.snapshot(),current=sim.step();
    for(const key of controllers){
      assert.equal(current.voltages[key][0],1);assert.equal(current.lastInputs[key][0],0);
      const old=reg(previous.states[key]),next=reg(current.states[key]),u=constants.inverterBuses.map(bus=>current.lastInputs[key][bus-1]);
      const expected=matvec(model.A,old),bu=matvec(model.B,u);
      assert.ok(vectorDistance(next,expected.map((v,i)=>v+bu[i]+current.lastSample.disturbance[i+1]))<1e-14);
      for(let bus=1;bus<=24;bus++){
        const q=current.inverterQ[key][bus-1],command=current.commandQ[key][bus-1];
        assert.ok(Math.abs(q)<=70+1e-12&&Math.abs(command)<=70+1e-12);
        assert.ok(Math.abs(q-model.lag*previous.inverterQ[key][bus-1]-(1-model.lag)*command)<1e-12);
        if(!constants.inverterBuses.includes(bus))assert.equal(q,0);else assert.ok(q*q+current.inverterP[bus-1]**2<=120**2+1e-9);
      }
      const rv=matvec(model.resistance,current.loadP.map(v=>v/1000));
      const xv=matvec(model.reactance,current.loadQ.map((v,i)=>(v-current.inverterQ[key][i])/1000));
      assert.ok(vectorDistance(current.states[key],rv.map((v,i)=>-v-xv[i]))<1e-14);
    }
  }
});

test('stage and terminal costs use actual voltage errors and bounded commands without voltage clipping',()=>{
  const sim=new Simulation({horizon:80}),sums=Object.fromEntries(controllers.map(key=>[key,0]));
  for(let t=0;t<80;t++){
    if(t===30)for(let k=0;k<20;k++)sim.queuePulse(23,150);
    const previous=sim.snapshot(),snap=sim.step();assert.equal(snap.costTime,t);assert.equal(snap.stateTime,t+1);assert.deepEqual(snap.costStates,previous.states);
    for(const key of controllers){
      const error=reg(previous.states[key]),expected=35*sq(error)+.08*sq(snap.lastInputs[key]);
      assert.ok(Math.abs(expected-snap.stage[key])<1e-14);sums[key]+=expected;assert.ok(Math.abs(sums[key]-snap.costs[key])<1e-12);
      const x=reg(snap.states[key]),terminal=x.reduce((sum,v,i)=>sum+v*matvec(model.P,x)[i],0);
      assert.ok(Math.abs(terminal-snap.terminalCost[key])<1e-12);assert.equal(snap.totalCost[key],snap.costs[key]+snap.terminalCost[key]);
    }
  }
  assert.ok(sim.history.some(row=>row.states.online.some(v=>v<-.05)));
});

test('repeat attacks use physical role limits, exact decay, and no cooldown while slack stays fixed',()=>{
  const sim=new Simulation(),clean=new Simulation();assert.equal(sim.queuePulse(1,100),false);assert.equal(sim.toggleFault(1),false);
  sim.queuePulse(23,100);sim.queuePulse(23,100);const profile=constants.busProfiles[22];
  for(let t=0;t<15;t++){
    if(t===1)sim.queuePulse(23,50);const a=clean.step(),b=sim.step();
    let expected=t<profile.steps?200*Math.exp(-t/profile.decay):0;if(t>=1&&t-1<profile.steps)expected+=50*Math.exp(-(t-1)/profile.decay);
    assert.ok(Math.abs(b.loadP[22]-a.loadP[22]-expected)<1e-10);
  }
  for(const bus of [7,12]){
    const s=new Simulation();for(let n=0;n<4;n++)s.queuePulse(bus,150);const current=s.step(),applied=current.lastPulseApplications[0];
    assert.equal(applied.requestedKw,600);assert.equal(applied.capped,true);
    if(bus===7)assert.ok(Math.abs(current.generationP[bus-1])<1e-10);else assert.ok(Math.abs(current.inverterP[bus-1]+90)<1e-10);
  }
  for(const bad of [NaN,Infinity,0,9,151,'100'])assert.throws(()=>sim.queuePulse(3,bad),RangeError);
});

test('prediction comparison resets samples and warmup and adapts the same dense offline responses',()=>{
  const sim=new Simulation({seed:13,horizon:70,experiment:'prediction'});run(sim,40);const discovery=sim.snapshot();
  assert.ok(discovery.canDeploy);const fresh=sim.deployTopology();assert.equal(fresh.t,0);assert.equal(fresh.phase,'deployment');
  assert.notEqual(fresh.seed,discovery.seed);assert.equal(fresh.canFreeze,false);assert.deepEqual(fresh.cumulative,{online:0,scalar:0,static:0,causal:0});
  assert.deepEqual(fresh.deployedSupport.trainingSamples,[]);assert.equal(fresh.sampleCount,0);
  assert.deepEqual(fresh.calibration.matrix,math.eye(23));assert.equal(fresh.calibration.scalar,1);
  assert.equal(fresh.calibration.updates,0);assert.equal(fresh.calibration.windowSize,0);
  for(const mask of [fresh.deployedSupport.learned,fresh.deployedSupport.fixed])assert.ok(mask.every(row=>row.every(Boolean)));
  for(const key of ['online','scalar','static'])assert.equal(sim.segments[0].designs[key],sim.segments[0].dense);
  const support=JSON.stringify(fresh.deployedSupport);let differs=false;
  for(let t=0;t<70;t++){
    const previous=sim.snapshot(),revealed=sim.samples.slice(-60),s=sim.step();
    assert.equal(JSON.stringify(s.deployedSupport),support);
    if(t<30){
      assert.deepEqual(s.calibration.matrix,math.eye(23));assert.equal(s.calibration.scalar,1);
      assert.equal(s.calibration.updates,0);assert.equal(s.calibration.trainedThrough,null);
      assert.deepEqual(s.states.online,s.states.static);assert.deepEqual(s.states.scalar,s.states.static);
    }else{
      const fit=Calibration.fit(revealed,{lambda:model.calibrationRidge});
      assert.deepEqual(s.calibration.matrix,fit.matrix);assert.equal(s.calibration.scalar,fit.scalar);
      assert.equal(s.calibration.trainedThrough,t-1);assert.equal(s.calibration.windowSize,Math.min(t,60));
      assert.equal(s.calibration.carriedSamples,0);assert.equal(s.calibration.updates,t-29);
    }
    for(const key of ['online','scalar','static']){
      let expected=matvec(model.K,reg(previous.states[key]));
      for(const block of s.lastResponseRows[key]){
        const forecast=sim.forecasts[block.k-1].forecast.slice(1);
        const term=matvec(block.L,forecast);expected=expected.map((v,i)=>v+term[i]);
      }
      assert.ok(vectorDistance(s.lastInputs[key],math.padInput(bounded(expected)))<1e-14);
    }
    differs ||= vectorDistance(s.lastInputs.online,s.lastInputs.static)>1e-6;
  }
  assert.ok(differs);const final=sim.snapshot();sim.reset();assert.equal(sim.phase,'deployment');run(sim,70);assert.deepEqual(sim.snapshot(),final);
});

test('matrix and scalar update both predictive CLMs from the same dense candidate without mutating offline responses',()=>{
  const sim=new Simulation({seed:13,horizon:70,experiment:'prediction'});run(sim,40);sim.deployTopology();
  const design=sim.segments[0].designs.online;
  assert.equal(design,sim.segments[0].designs.scalar);assert.equal(design,sim.segments[0].designs.static);
  const offline=JSON.stringify(design);let differs=false;
  for(let t=0;t<45;t++){
    const s=sim.step(),C=s.calibration.matrix,c=s.calibration.scalar;
    for(const family of ['online','scalar','static'])for(const actual of s.lastResponseRows[family]){
      const block=design.rows[t].find(b=>b.k===actual.k);
      const correction=family==='online'?C:math.eye(23).map(row=>row.map(v=>v*(family==='scalar'?c:1)));
      assert.ok(distance(actual.X,multiply(block.X,correction))<1e-12);
      assert.ok(distance(actual.U,multiply(block.U,correction))<1e-12);
      assert.ok(distance(actual.L,combine(actual.U,multiply(model.K,actual.X),1,-1))<1e-12);
    }
    if(t>=30)differs ||= vectorDistance(s.lastInputs.online,s.lastInputs.scalar)>1e-7;
  }
  const s=sim.snapshot(),C=s.calibration.matrix;
  assert.ok(distance(C,math.eye(23).map(row=>row.map(v=>v*s.calibration.scalar)))>1e-6);
  // Holding this one C fixed across a candidate preserves its homogeneous
  // recurrence. This does not assert recurrence for rows deployed under C_t.
  for(const column of design.columns)for(const [key,U] of Object.entries(column.U)){
    const t=Number(key),X=multiply(column.X[t],C),UC=multiply(U,C),LC=multiply(column.L[t],C);
    const next=multiply(column.X[t+1]||zeros(23),C);
    assert.ok(distance(next,combine(multiply(model.A,X),multiply(model.B,UC)))<1e-12);
    assert.ok(distance(LC,combine(UC,multiply(model.K,X),1,-1))<1e-12);
  }
  assert.ok(differs,'the common dense offline response must permit distinct matrix and scalar corrections');
  assert.equal(JSON.stringify(design),offline,'online updates cannot overwrite the immutable offline candidate');
});

test('only inverter receivers and physical nonslack source channels are ranked with a fixed remote budget',()=>{
  const sim=new Simulation();run(sim,90);const s=sim.snapshot();assert.equal(s.localChannels.length,8);assert.equal(constants.remoteBudget,3);
  for(const edge of s.recommendations){assert.ok(constants.inverterBuses.includes(edge.to));assert.ok(edge.from>1);assert.ok(edge.weight>0);assert.notEqual(edge.from,edge.to);}
  for(const bus of constants.inverterBuses)assert.ok(s.recommendations.filter(e=>e.to===bus).length<=3);
  for(let bus=1;bus<=24;bus++)if(!constants.inverterBuses.includes(bus))assert.deepEqual(s.directGain[bus-1],Array(24).fill(0));
});

test('gain diagnostics distinguish executed discovery sums from live prediction-candidate profiles',()=>{
  const sim=new Simulation({horizon:70,experiment:'prediction'});
  assert.equal(sim.snapshot().predictionDiagnostics.available,false);
  assert.equal(sim.snapshot().predictionDiagnostics.relativeGainChange,null);
  const executed={baseline:zeros(8,23),learned:zeros(8,23),changeSquared:0};
  for(let t=0;t<45;t++){
    if(t===20||t===21)sim.queuePulse(7,100);const snap=sim.step();
    if(t<30)continue;
    for(const actual of snap.lastResponseRows.online){
      const reference=snap.lastResponseRows.static.find(block=>block.k===actual.k);
      for(let i=0;i<8;i++)for(let j=0;j<23;j++){
        executed.baseline[i][j]+=reference.L[i][j]**2;
        executed.learned[i][j]+=actual.L[i][j]**2;
        executed.changeSquared+=(actual.L[i][j]-reference.L[i][j])**2;
      }
    }
  }
  function verifyScores(){
    const snap=sim.snapshot(),diagnostic=snap.predictionDiagnostics,design=sim.segments[0].designs.online;
    let {baseline,learned,changeSquared}=executed;
    if(snap.phase==='deployment'){
      baseline=zeros(8,23);learned=zeros(8,23);changeSquared=0;
      // This is the current candidate at a fixed C, not historical deployed gains.
      for(const row of design.rows.slice(0,design.T))for(const block of row){
        const actual=combine(multiply(block.U,snap.calibration.matrix),multiply(model.K,multiply(block.X,snap.calibration.matrix)),1,-1);
        for(let i=0;i<8;i++)for(let j=0;j<23;j++){
          baseline[i][j]+=block.L[i][j]**2/design.T;
          learned[i][j]+=actual[i][j]**2/design.T;
          changeSquared+=(actual[i][j]-block.L[i][j])**2/design.T;
        }
      }
    }
    const baselineSquared=baseline.flat().reduce((sum,v)=>sum+v,0);
    assert.equal(diagnostic.scoreBasis,snap.phase==='discovery'?'executed-row-raw-sum':'current-candidate-time-mean');
    assert.deepEqual(diagnostic.receiverBuses,constants.inverterBuses);
    assert.deepEqual(diagnostic.sourceBuses,Array.from({length:23},(_,i)=>i+2));
    assert.equal(diagnostic.completedRows,snap.calibration.windowSize);
    if(snap.phase==='discovery')assert.equal(diagnostic.scoreSamples,15);
    assert.ok(distance(diagnostic.baselineScores,baseline)/frobenius(baseline)<1e-12);
    assert.ok(distance(diagnostic.learnedScores,learned)/frobenius(learned)<1e-12);
    if(snap.calibration.windowSize)assert.ok(Math.abs(diagnostic.relativeGainChange-Math.sqrt(changeSquared/baselineSquared))<1e-12);
    else assert.equal(diagnostic.relativeGainChange,null);
    for(let i=0;i<8;i++)for(let j=0;j<23;j++){
      const delta=learned[i][j]-baseline[i][j],total=baseline[i].reduce((sum,v)=>sum+v,0);
      assert.ok(Math.abs(diagnostic.receiverNormalizedChange[i][j]-delta/total)<1e-12);
      if(baseline[i][j]===0)assert.equal(diagnostic.relativeEnergyChange[i][j],null);
    }
    assert.ok(Object.isFrozen(diagnostic.receiverNormalizedChange[0]));return diagnostic;
  }
  const diagnostic=verifyScores();sim.freeze();sim.fitStep(12);assert.deepEqual(sim.snapshot().predictionDiagnostics,diagnostic);sim.resume();
  const fresh=sim.deployTopology();assert.equal(fresh.predictionDiagnostics.frozen,false);const deployed=verifyScores();
  const links=fresh.recommendations.map(e=>[e.from,e.to]);sim.queuePulse(23,100);run(sim,10);verifyScores();
  assert.deepEqual(sim.snapshot().predictionDiagnostics.learnedScores,deployed.learnedScores,'fresh comparison cannot adapt before warmup');
  run(sim,25);verifyScores();
  assert.notDeepEqual(sim.snapshot().predictionDiagnostics.learnedScores,deployed.learnedScores);
  assert.deepEqual(sim.snapshot().recommendations.map(e=>[e.from,e.to]),links);
});

test('independent nonlinear AC reference validates representative physical cases and loss balance',()=>{
  const cases=[new Simulation().snapshot()];for(const bus of [3,7,12,23,24]){const sim=new Simulation();run(sim,40);sim.queuePulse(bus,150);for(let t=0;t<5;t++)cases.push(sim.step());}
  let maxError=0;
  for(const snap of cases)for(const key of controllers){
    const ac=math.radialAC(snap.loadP,snap.loadQ,snap.inverterQ[key]);assert.equal(ac.converged,true);assert.equal(ac.voltage[0],1);
    assert.ok(Math.abs(ac.slackKw-snap.loadP.reduce((s,v)=>s+v,0)-ac.lossesKw)<1e-6);
    assert.ok(Math.abs(ac.slackKvar-snap.loadQ.reduce((s,v)=>s+v,0)+snap.inverterQ[key].reduce((s,v)=>s+v,0)-ac.lossesKvar)<1e-6);
    maxError=Math.max(maxError,...ac.voltage.map((v,i)=>Math.abs(v-snap.voltages[key][i])));
  }
  assert.ok(maxError<.0005,`maximum voltage magnitude error ${maxError}`);
});

test('segment extension keeps the physical delay clock and stage cost continuous beyond 480 samples',()=>{
  const sim=new Simulation({horizon:8}),versions=[0];let beta=0;
  for(let t=0;t<30;t++){
    if(t===8)sim.extend(30);const previous=sim.snapshot(),s=sim.step();
    if(t>=5){const row=sim.rows[0];beta+=s.learning.stepSize*(1-row.curvature*(versions[t-5]||0));assert.ok(Math.abs(beta-row.beta)<1e-8);}
    versions.push(beta);for(const key of controllers)assert.ok(s.cumulative[key]>=previous.cumulative[key]);
  }
  const long=new Simulation();run(long,480);const before=long.snapshot();long.queuePulse(23,50);run(long,62);assert.equal(long.t,542);
  assert.deepEqual(long.history[479],before.history[479]);assert.equal(long.snapshot().segments.length,2);
});

test('fixed data convergence uses an independent diagnostic copy and cannot alter live learning or deployed links',()=>{
  const sim=new Simulation({horizon:100}),control=new Simulation({horizon:100});run(sim,40);run(control,40);
  const live=sim.snapshot(),betas=sim.rows.map(row=>row.beta),delays=sim.rows.map(row=>row.delayed.slice());
  const frozen=sim.freeze();assert.equal(frozen.fitDiagnostic.independent,true);assert.equal(frozen.fitDiagnostic.deployed,false);
  const fit=sim.fitStep(60000);assert.equal(fit.mode,'converged');assert.ok(fit.fitError<1e-5);assert.ok(fit.fitError<frozen.fitError);
  for(const key of ['t','states','loadP','loadQ','inverterQ','commandQ','costs','history','learning','directGain','recommendations'])assert.deepEqual(fit[key],live[key]);
  assert.deepEqual(sim.rows.map(row=>row.beta),betas);assert.deepEqual(sim.rows.map(row=>row.delayed),delays);
  sim.resume();const resumed=sim.step(),normal=control.step();
  for(const key of ['states','learning','recommendations','directGain','costs'])assert.deepEqual(resumed[key],normal[key]);
  assert.deepEqual(sim.deployTopology().deployedSupport,control.deployTopology().deployedSupport);
});

function replayRecord(record){
  const sim=new Simulation(record.options);let index=0;
  for(let t=0;t<=record.t;t++){
    while(index<record.events.length&&record.events[index].t===t){
      const event=record.events[index++];
      if(event.type==='pulse')sim.queuePulse(event.bus,event.strength);
      else if(event.type==='forecast')sim.toggleFault(event.bus);
      else if(event.type==='extend')sim.extend(event.steps);
      else if(event.type==='freeze')sim.freeze();
      else if(event.type==='fit')sim.fitStep(event.count);
      else if(event.type==='resume')sim.resume();
      else throw new Error('Unknown replay action');
    }
    if(t<record.t)sim.step();
  }
  assert.equal(index,record.events.length);return sim;
}

test('discovery and deployment replay preserve extensions, diagnostic counts, repeated interventions and independent seeds',()=>{
  const sim=new Simulation({horizon:40,seed:123});
  for(let t=0;t<52;t++){
    if(t===10)sim.extend(12);if(t===20){sim.queuePulse(23,100);sim.queuePulse(23,50);}
    if(t===25)sim.toggleFault(7);if(t===35){sim.freeze();sim.fitStep(4321);sim.resume();}sim.step();
  }
  const fresh=sim.deployTopology();assert.equal(fresh.discoveryRecord.options.horizon,40);
  const replay=replayRecord(fresh.discoveryRecord);replay.deployTopology();assert.deepEqual(replay.snapshot(),fresh);
  const journal=sim.eventLog;assert.equal(journal.length,0);
  run(sim,40);sim.queuePulse(12,100);run(sim,7);
  const record={options:sim.snapshot().initialOptions,t:sim.t,events:sim.eventLog};
  let index=0;for(let t=0;t<=record.t;t++){
    while(index<record.events.length&&record.events[index].t===t){const e=record.events[index++];if(e.type==='extend')replay.extend(e.steps);if(e.type==='pulse')replay.queuePulse(e.bus,e.strength);}
    if(t<record.t)replay.step();
  }
  assert.deepEqual(replay.snapshot(),sim.snapshot());
});

test('voltage diagnostics use each bus nominal profile and executed state times rather than the illustrative band',()=>{
  const reference=[1,.987,.99],baseline=reference.map(v=>v-1);
  const states=Object.fromEntries(controllers.map(key=>[key,baseline.slice()]));
  states.online[1]=-.02;
  const past=Object.fromEntries(controllers.map(key=>[key,baseline.slice()]));
  past.online[1]=-.04;
  const snapshot={t:9,referenceVoltage:reference,initialVoltage:reference.slice(),states,
    history:[{stateTime:4,t:4,states:past,costStates:Object.fromEntries(controllers.map(key=>[key,[0,-.5,0]]))}],
    saturation:Object.fromEntries(controllers.map(key=>[key,key==='online'?[false,true,false]:[false,false,false]]))};
  const before=JSON.stringify(snapshot),metrics=voltageMetrics(snapshot);
  assert.ok(Math.abs(metrics.online.currentMaxPu-.007)<1e-14);
  assert.ok(Math.abs(metrics.online.peakMaxPu-.027)<1e-14);
  assert.equal(metrics.online.currentBus,2);assert.equal(metrics.online.peakBus,2);assert.equal(metrics.online.peakTime,4);
  assert.equal(metrics.online.limitedCount,1);
  assert.equal(metrics.causal.currentMaxPu,0,'A nominal .987 pu bus has zero regulation error');
  assert.equal(metrics.causal.peakMaxPu,0);
  assert.equal(JSON.stringify(snapshot),before,'Diagnostics are read only');
  const reset={...snapshot,t:0,history:[],states:Object.fromEntries(controllers.map(key=>[key,baseline.slice()])),saturation:{}};
  assert.equal(voltageMetrics(reset).online.peakMaxPu,0,'Fresh comparison does not inherit discovery peaks');
});

test('voltage diagnostics agree with raw states for all twenty predefined seeds in discovery and held out comparison',()=>{
  const verify=sim=>{
    const snapshot=sim.snapshot(),before=JSON.stringify(snapshot),metrics=voltageMetrics(snapshot);
    for(const key of controllers) {
      const deviation=state=>Math.max(...state.map((value,i)=>Math.abs(1+value-snapshot.referenceVoltage[i])));
      const current=deviation(snapshot.states[key]);
      const initial=Math.max(...snapshot.initialVoltage.map((value,i)=>Math.abs(value-snapshot.referenceVoltage[i])));
      const peak=Math.max(initial,current,...snapshot.history.map(entry=>deviation(entry.states[key])));
      assert.ok(Math.abs(metrics[key].currentMaxPu-current)<1e-14);
      assert.ok(Math.abs(metrics[key].peakMaxPu-peak)<1e-14);
      assert.equal(metrics[key].limitedCount,snapshot.saturation[key].filter(Boolean).length);
      assert.ok(metrics[key].limitedCount<=constants.inverterBuses.length);
      assert.ok(Number.isFinite(peak));assert.ok(peak>=current);
    }
    assert.equal(JSON.stringify(snapshot),before);
  };
  for(let seed=1;seed<=20;seed++) {
    const sim=new Simulation({experiment:'communication',beta:1,seed,horizon:180});
    verify(sim);run(sim,180);verify(sim);
    assert.equal(sim.deployTopology().phase,'deployment');verify(sim);
    assert.equal(voltageMetrics(sim.snapshot()).online.peakMaxPu,0);
    sim.queuePulse(23,150);run(sim,8);verify(sim);
  }
});

test('solar outage is bounded, comparison only and absent from issued forecasts',()=>{
  assert.throws(()=>new Simulation({powerScenario:'unknown'}),/scenario/);
  const reference=new Simulation({experiment:'communication',seed:3,horizon:180});
  const stress=new Simulation({experiment:'communication',seed:3,horizon:180,powerScenario:'solar-outage'});
  run(reference,180);run(stress,180);
  assert.deepEqual(reference.snapshot().states,stress.snapshot().states,'Discovery has no physical stress');
  assert.deepEqual(reference.forecasts,stress.forecasts);
  reference.deployTopology();stress.deployTopology();
  const support=JSON.stringify(stress.snapshot().deployedSupport);
  let activeSamples=0;
  for(let action=0;action<60;action++) {
    const a=reference.step(),b=stress.step();
    assert.deepEqual(reference.forecasts,stress.forecasts,'No scenario information enters forecasts');
    assert.equal(JSON.stringify(b.deployedSupport),support);
    if(action>=30&&action<50) {
      activeSamples++;assert.equal(b.scenario.active,true);
      assert.equal(b.lastScenarioApplications.length,4);
      assert.ok(b.scenario.requestedKw<=360+1e-9);assert.ok(b.scenario.appliedKw<=360+1e-9);
      for(const bus of [5,7,14,21])assert.ok(Math.abs(b.generationP[bus-1])<1e-9,'Full generation outage');
      assert.deepEqual(b.lastSample.forecast,a.lastSample.forecast);
    } else assert.equal(b.scenario.active,false);
  }
  assert.equal(activeSamples,20);
  assert.deepEqual(stress.snapshot().eventLog.filter(e=>e.type==='scenario').map(e=>[e.t,e.action]),[[30,'start'],[50,'restore']]);
  assert.ok(stress.snapshot().generationP[4]>0);
  assert.deepEqual(stress.snapshot().pendingPulses,[],'Scenario does not fabricate clicked attacks');
});


test('completed trials accept pending source settings without extending time or rewriting issued forecasts',()=>{
  for(const beta of [0,4]){
    const options={experiment:'communication',powerScenario:'forecasted-demand',beta,seed:21,horizon:45};
    const changed=new Simulation(options),control=new Simulation(options);
    for(const sim of [changed,control]){run(sim,45);assert.ok(sim.deployTopology());run(sim,45);}
    const before=changed.snapshot(),issued=changed.forecasts.slice(),support=JSON.stringify(before.deployedSupport);
    assert.equal(before.mode,'completed');assert.equal(before.faults.includes(7),false);
    assert.equal(changed.toggleFault(7),true);
    const configured=changed.snapshot();
    assert.equal(configured.mode,'completed');assert.equal(configured.t,45);assert.equal(configured.horizon,before.horizon);
    assert.deepEqual(configured.segments,before.segments);assert.deepEqual(changed.forecasts,issued);
    assert.deepEqual(configured.cumulative,before.cumulative);assert.deepEqual(configured.states,before.states);
    assert.equal(JSON.stringify(configured.deployedSupport),support);
    assert.deepEqual(configured.eventLog.at(-1),{t:45,type:'forecast',bus:7,faulty:true,message:'Future voltage-forcing forecasts corrupted'});
    assert.deepEqual(changed.step().states,before.states,'Pending setting cannot advance a completed plant');
    changed.extend(10);control.extend(10);
    assert.deepEqual(changed.forecasts.slice(0,issued.length),issued,'The sealed prefix is immutable');
    assert.equal(changed.forecasts.length,issued.length+1);
    const a=changed.forecasts.at(-1),b=control.forecasts.at(-1);
    assert.equal(a.issuedAt,45);assert.equal(a.t,49);assert.deepEqual(a.base,b.base);
    for(let i=0;i<24;i++)if(i!==6||beta===0)assert.equal(a.forecast[i],b.forecast[i]);
    if(beta)assert.notEqual(a.forecast[6],b.forecast[6],'The first newly issued source message uses the pending setting');
    assert.equal(JSON.stringify(changed.snapshot().deployedSupport),support);
  }
});

test('continuous targets replace only their own component and release into the existing decay',()=>{
  const sim=new Simulation({horizon:30,seed:20261013}),bus=23;
  sim.queuePulse(bus,50);
  for(let t=0;t<5;t++){
    sim.queuePulse(bus,150,'held-target-v1');
    sim.queuePulse(bus,150,'held-target-v1');
    const s=sim.step(),request=s.lastPulseApplications.find(p=>p.bus===bus);
    assert.ok(Math.abs(request.requestedKw-(150+50*Math.exp(-t/constants.busProfiles[bus-1].decay)))<1e-10);
    assert.equal(s.activePulses.filter(p=>p.protocol==='held-target-v1').length,1);
    assert.equal(s.activePulses.filter(p=>!p.protocol).length,1);
  }
  sim.queuePulse(bus,50,'held-target-v1');const changed=sim.step();
  assert.ok(Math.abs(changed.lastPulseApplications[0].requestedKw-(50+50*Math.exp(-5/constants.busProfiles[bus-1].decay)))<1e-10);
  const released=sim.step();
  assert.ok(Math.abs(released.lastPulseApplications[0].requestedKw-(50*Math.exp(-1/constants.busProfiles[bus-1].decay)+50*Math.exp(-6/constants.busProfiles[bus-1].decay)))<1e-10);
  assert.equal(released.eventLog.filter(e=>e.protocol==='held-target-v1').length,11);
});

test('all predefined seeds retain bounded continuous requests, original forecasts and all four full costs',()=>{
  const evidence=[];
  for(const seed of [...Array.from({length:40},(_,i)=>i+1),20261013]){
    const options={experiment:'communication',powerScenario:'forecasted-demand',beta:4,seed,horizon:90};
    const target=new Simulation(options),legacy=new Simulation(options);
    let peakTarget=0,peakLegacy=0,minTarget=1,minLegacy=1;
    for(let t=0;t<90;t++){
      if(t>=5&&t<65)for(let bus=2;bus<=24;bus++){
        target.queuePulse(bus,150,'held-target-v1');legacy.queuePulse(bus,150);
      }
      const current=target.step(),previous=legacy.step();
      assert.deepEqual(target.forecasts,legacy.forecasts,'Unexpected power never enters newly issued forecasts, seed '+seed);
      assert.deepEqual(current.lastSample.base,previous.lastSample.base,'Protocol changes no base power draws');
      if(t>=5&&t<65){
        assert.equal(current.lastPulseApplications.length,23);
        for(const item of current.lastPulseApplications){
          assert.equal(item.requestedKw,150,'No overlap accumulation');
          assert.ok(item.appliedKw>=-1e-9&&item.appliedKw<=150+1e-9,'Existing equipment limits bound the actual effect');
          if(constants.busProfiles[item.bus-1].role==='Homes')assert.ok(Math.abs(item.appliedKw-150)<1e-8);
        }
        assert.equal(current.activePulses.length,23);
      }
      peakTarget=Math.max(peakTarget,current.lastPulseApplications.reduce((sum,p)=>sum+p.appliedKw,0));
      peakLegacy=Math.max(peakLegacy,previous.lastPulseApplications.reduce((sum,p)=>sum+p.appliedKw,0));
      minTarget=Math.min(minTarget,...Object.values(current.voltages).flat());
      minLegacy=Math.min(minLegacy,...Object.values(previous.voltages).flat());
    }
    const a=target.snapshot(),b=legacy.snapshot();
    assert.ok(peakTarget<=23*150+1e-8);assert.ok(peakLegacy>23*150,'Legacy stacking remains reproducible');
    assert.deepEqual(Object.keys(a.cumulative),controllers);
    evidence.push({seed,peakAppliedKw:peakTarget,legacyPeakAppliedKw:peakLegacy,minVoltage:minTarget,legacyMinVoltage:minLegacy,
      stageCosts:a.cumulative,totalCosts:a.totalCost,legacyStageCosts:b.cumulative,legacyTotalCosts:b.totalCost});
  }
  console.log('Continuous target protocol audit '+JSON.stringify({seeds:evidence.length,settingKw:150,activeActions:[5,64],samples:90,phase:'discovery protocol regression, not held out algorithm ranking',results:evidence}));
});
