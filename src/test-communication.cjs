'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {Simulation,model,constants,math}=require('./simulation.js');
const Calibration=require('./forecast-calibration.js');
const Online=require('./online-predsls.js');

const keys=constants.controllers;
const zeroScores=()=>Array.from({length:constants.M},()=>Array(constants.N-1).fill(0));
const run=(sim,n)=>{for(let i=0;i<n;i++)sim.step();return sim.snapshot();};
const clone=value=>JSON.parse(JSON.stringify(value));
const near=(actual,expected,tolerance=1e-12)=>{
  assert.equal(actual.length,expected.length);
  for(let i=0;i<actual.length;i++){
    if(Array.isArray(actual[i]))near(actual[i],expected[i],tolerance);
    else assert.ok(Math.abs(actual[i]-expected[i])<=tolerance,
      `entry ${i} differs by ${Math.abs(actual[i]-expected[i])}`);
  }
};
const communication=options=>new Simulation({experiment:'communication',seed:17,horizon:90,...options});

test('optional forecast stress levels preserve the reference grid and default',()=>{
  assert.deepEqual(constants.communicationBetas,[0,.25,.5,1,2]);
  assert.deepEqual(constants.communicationStressBetas,[4,8,16]);
  assert.equal(communication({horizon:45}).options.beta,1);
  for(const beta of constants.communicationStressBetas)assert.equal(communication({beta,horizon:45}).options.beta,beta);
  for(const beta of [-1,3,6,32,NaN,Infinity,'4'])assert.throws(()=>communication({beta,horizon:45}),RangeError);
});

test('communication noise changes only forecast errors and preserves paired physical disturbances',()=>{
  const betas=[...constants.communicationBetas,...constants.communicationStressBetas];
  const trials=betas.map(beta=>communication({beta,horizon:45}));
  for(let t=0;t<40;t++){
    if(t===12)for(const sim of trials)sim.queuePulse(23,100);
    const states=trials.map(sim=>sim.step());
    for(let i=1;i<trials.length;i++){
      assert.deepEqual(states[i].lastSample.base,states[0].lastSample.base);
      near(states[i].lastSample.disturbance,states[0].lastSample.disturbance,1e-14);
      assert.deepEqual(states[i].states.causal,states[0].states.causal);
      assert.deepEqual(states[i].lastInputs.causal,states[0].lastInputs.causal);
      assert.equal(states[i].cumulative.causal,states[0].cumulative.causal);
    }
  }
  for(let q=0;q<trials[0].forecasts.length;q++){
    const zero=trials[0].forecasts[q];
    const previous=q?trials[0].forecasts[q-1].base:Array(constants.N).fill(0);
    const truth=math.matvec(model.powerToVoltage,zero.base.map((value,j)=>value-model.lag*previous[j]));
    near(zero.forecast,truth,1e-15);
    for(const sim of trials)assert.equal(sim.forecasts[q].forecast[0],0,'the slack forecast must stay zero at every stress level');
    for(let b=1;b<trials.length;b++)for(let j=0;j<constants.N;j++){
      const expected=zero.forecast[j]+betas[b]*(trials[3].forecasts[q].forecast[j]-zero.forecast[j]);
      assert.ok(Math.abs(trials[b].forecasts[q].forecast[j]-expected)<1e-14);
    }
  }
});

test('extended forecast stress preserves issued messages and deployment settings with finite bounded controllers',()=>{
  const trials=[0,...constants.communicationStressBetas].map(beta=>communication({beta,horizon:45}));
  for(const sim of trials){
    run(sim,35);
    const sealed=clone(sim.forecasts),beta=sim.options.beta;
    sim.toggleFault(7);
    sim.queuePulse(23,100);
    sim.step();
    assert.deepEqual(sim.forecasts.slice(0,sealed.length),sealed,'source changes and physical attacks cannot rewrite issued forecasts');
    for(const entry of sim.forecasts){assert.ok(Object.isFrozen(entry));assert.ok(Object.isFrozen(entry.forecast));}
    assert.ok(sim.deployTopology());
    const state=sim.snapshot();
    assert.equal(state.beta,beta);assert.equal(state.initialOptions.beta,beta);assert.equal(state.discoveryRecord.options.beta,beta);
    assert.ok(state.faults.includes(7));
    assert.deepEqual(sim.forecasts,communication({beta,seed:state.seed,horizon:45,faultBuses:state.faults}).forecasts);
  }
  for(let t=0;t<40;t++){
    if(t>=12&&t<16)for(const sim of trials)sim.queuePulse(23,100);
    const states=trials.map(sim=>sim.step());
    for(const state of states){
      assert.deepEqual(state.lastSample.base,states[0].lastSample.base);
      near(state.lastSample.disturbance,states[0].lastSample.disturbance,1e-14);
      assert.deepEqual(state.states.causal,states[0].states.causal);
      assert.deepEqual(state.lastInputs.causal,states[0].lastInputs.causal);
      assert.equal(state.cumulative.causal,states[0].cumulative.causal);
      for(const key of keys){
        assert.ok(Number.isFinite(state.cumulative[key]));assert.ok(Number.isFinite(state.totalCost[key]));
        assert.ok(state.states[key].every(Number.isFinite));assert.ok(state.commandQ[key].every(Number.isFinite));
        assert.ok(state.lastInputs[key].every(value=>Number.isFinite(value)&&Math.abs(value)<=model.qLimit));
        assert.equal(state.states[key][0],0);assert.equal(state.lastInputs[key][0],0);
      }
    }
    for(const sim of trials)assert.ok(sim.forecasts.every(entry=>entry.forecast[0]===0));
  }
});

test('changing a source quality changes its forecast error by the declared factor without exposing labels to the fit',()=>{
  const good=communication({faultBuses:[],horizon:45});
  const bad=communication({faultBuses:[12],horizon:45});
  const truth=communication({beta:0,faultBuses:[],horizon:45});
  run(good,40);run(bad,40);run(truth,40);
  for(let q=0;q<good.forecasts.length;q++){
    assert.deepEqual(good.forecasts[q].base,bad.forecasts[q].base);
    for(let j=0;j<constants.N;j++){
      if(j!==11)assert.equal(good.forecasts[q].forecast[j],bad.forecasts[q].forecast[j]);
      else {
        const clean=truth.forecasts[q].forecast[j];
        assert.ok(Math.abs((bad.forecasts[q].forecast[j]-clean)-80*(good.forecasts[q].forecast[j]-clean))<1e-14);
      }
    }
  }
  const expected=Calibration.fit(bad.samples.slice(0,-1),{lambda:model.calibrationRidge});
  assert.deepEqual(bad.calibration.matrix,expected.matrix);
});

test('discovery scores equal an independent sum of executed direct gains with a matched offline scoring schedule',()=>{
  const sim=communication({horizon:75});
  const learned=zeroScores(),fixed=zeroScores();let count=0;
  assert.equal(sim.deployTopology(),false);
  for(let t=0;t<70;t++){
    const revealed=sim.samples.slice(-constants.window);
    const C=t<constants.warmup?Calibration.identity():Calibration.fit(revealed,{lambda:model.calibrationRidge}).matrix;
    const row=sim.segments[0].dense.rows[t];
    if(t>=constants.warmup){
      for(const block of row)for(let r=0;r<constants.M;r++)for(let j=0;j<constants.N-1;j++){
        let gain=0;
        for(let a=0;a<constants.N-1;a++)gain+=block.L[r][a]*C[a][j];
        learned[r][j]+=gain*gain;fixed[r][j]+=block.L[r][j]*block.L[r][j];
      }
      count++;
    }
    const state=sim.step();
    assert.equal(state.predictionDiagnostics.scoreSamples,count);
    assert.equal(sim.communicationScoreSamples,count);
    if(count){
      near(state.predictionDiagnostics.learnedScores,learned,1e-10);
      near(state.predictionDiagnostics.baselineScores,fixed,1e-10);
    }
    if(t===constants.warmup-1)assert.equal(state.canDeploy,false);
    if(t===constants.warmup)assert.equal(state.canDeploy,true);
    const before=clone(sim.communicationScores);
    sim.snapshot();sim.snapshot();
    assert.deepEqual(sim.communicationScores,before,'reading the interface must not add another observation');
  }
  const learnedMask=Online.selectSupport(learned,constants.inverterBuses,constants.remoteBudget);
  const fixedMask=Online.selectSupport(fixed,constants.inverterBuses,constants.remoteBudget);
  assert.ok(sim.deployTopology());
  assert.deepEqual(sim.deployedSupport.learned,learnedMask.support);
  assert.deepEqual(sim.deployedSupport.fixed,fixedMask.support);
});

test('the current attack cannot affect the calibration or topology scored for the same action',()=>{
  const clean=communication(),attacked=communication();
  run(clean,45);run(attacked,45);
  const revealed=attacked.samples.slice(-constants.window);
  attacked.queuePulse(23,100);
  const a=clean.step(),b=attacked.step();
  assert.deepEqual(a.calibration,b.calibration);
  assert.deepEqual(a.lastInputs,b.lastInputs);
  assert.deepEqual(a.predictionDiagnostics.learnedScores,b.predictionDiagnostics.learnedScores);
  assert.deepEqual(b.calibration.matrix,Calibration.fit(revealed,{lambda:model.calibrationRidge}).matrix);
  assert.equal(b.calibration.trainedThrough,44);
  assert.notDeepEqual(a.lastSample.disturbance,b.lastSample.disturbance);
  const nextRevealed=attacked.samples.slice(-constants.window),next=attacked.step();
  assert.deepEqual(next.calibration.matrix,Calibration.fit(nextRevealed,{lambda:model.calibrationRidge}).matrix);
  assert.equal(next.calibration.trainedThrough,45);
});

test('zero forecast noise selects the same sparse support and produces the same executed comparison costs',()=>{
  const sim=communication({beta:0,horizon:80});run(sim,65);
  assert.ok(sim.deployTopology());
  assert.deepEqual(sim.deployedSupport.learned,sim.deployedSupport.fixed);
  for(let t=0;t<75;t++){
    if(t===18||t===19)sim.queuePulse(23,100);
    if(t>=45&&t<50)sim.queuePulse(7,50);
    const state=sim.step();
    near(state.lastInputs.online,state.lastInputs.scalar,1e-14);
    near(state.states.online,state.states.scalar,1e-14);
    assert.ok(Math.abs(state.cumulative.online-state.cumulative.scalar)<1e-14);
  }
});

test('deployment starts a fresh paired physical trial and preserves only the selected topology evidence',()=>{
  const seed=17,sim=communication({seed});run(sim,65);
  const discovery=sim.snapshot(),discoveryEvidence=clone(discovery.predictionDiagnostics);
  const initialDiscoveryForecast=clone(sim.forecasts[0]);
  assert.ok(sim.deployTopology());
  const state=sim.snapshot(),deploymentSeed=(seed^0x9E3779B9)>>>0;
  assert.equal(state.phase,'deployment');assert.equal(state.seed,deploymentSeed);assert.equal(state.t,0);
  assert.equal(state.sampleCount,0);assert.equal(state.history.length,0);
  for(const key of keys){assert.equal(state.cumulative[key],0);assert.deepEqual(state.states[key],model.baseDrop);}
  assert.notDeepEqual(sim.forecasts[0].base,initialDiscoveryForecast.base);
  const independent=communication({seed:deploymentSeed});
  assert.deepEqual(sim.forecasts,independent.forecasts);
  assert.deepEqual(state.calibration.matrix,Calibration.identity());assert.equal(state.calibration.scalar,1);
  assert.equal(state.calibration.updates,0);assert.equal(state.calibration.windowSize,0);
  assert.deepEqual(state.predictionDiagnostics,{...discoveryEvidence,frozen:true,scoreBasis:'frozen-discovery-executed-row-raw-sum'});
  assert.equal(state.deployedSupport.scoreSamples,discovery.predictionDiagnostics.scoreSamples);
});

test('forecast reliability changes survive deployment without rewriting sealed predictions or discovery replay',()=>{
  const seed=17,sim=communication({seed}),reference=communication({seed});
  run(sim,40);run(reference,40);
  const originalOptions=clone(sim.initialOptions),sealed=clone(sim.forecasts);
  assert.equal(sim.toggleFault(7),true);
  assert.equal(sim.toggleFault(12),false);
  const finalFaults=sim.snapshot().faults;
  const changedAt=sim.t;
  sim.step();reference.step();
  assert.deepEqual(sim.forecasts.slice(0,sealed.length),sealed,'issued predictions must remain immutable');
  assert.equal(sim.forecasts.length,sealed.length+1);
  const future=sim.forecasts.at(-1),unchanged=reference.forecasts.at(-1);
  assert.equal(future.issuedAt,changedAt);
  assert.deepEqual(future.base,unchanged.base);
  const previous=sim.forecasts.at(-2).base;
  const truth=math.matvec(model.powerToVoltage,future.base.map((value,j)=>value-model.lag*previous[j]));
  assert.ok(Math.abs((future.forecast[6]-truth[6])-80*(unchanged.forecast[6]-truth[6]))<1e-14);
  assert.ok(Math.abs(80*(future.forecast[11]-truth[11])-(unchanged.forecast[11]-truth[11]))<1e-14);
  run(sim,24);
  assert.ok(sim.deployTopology());
  const deployed=sim.snapshot(),record=sim.discoveryRecord;
  assert.deepEqual(deployed.faults,finalFaults);
  assert.deepEqual(sim.initialOptions.faultBuses,finalFaults);
  assert.deepEqual(record.options,originalOptions,'discovery begins from its original source map during replay');
  assert.deepEqual(record.events.filter(event=>event.type==='forecast').map(({t,bus,faulty})=>({t,bus,faulty})),[
    {t:changedAt,bus:7,faulty:true},{t:changedAt,bus:12,faulty:false}
  ]);
  assert.equal(deployed.seed,(seed^0x9E3779B9)>>>0);
  assert.equal(deployed.t,0);assert.equal(deployed.sampleCount,0);
  const fresh=communication({seed:deployed.seed,faultBuses:finalFaults});
  assert.deepEqual(sim.forecasts,fresh.forecasts,'the held out stream starts with the final discovery source map');
  const replay=communication(record.options);
  for(let t=0;t<record.t;t++){
    for(const event of record.events)if(event.t===t&&event.type==='forecast')replay.toggleFault(event.bus);
    replay.step();
  }
  assert.ok(replay.deployTopology());
  assert.deepEqual(replay.snapshot().faults,deployed.faults);
  assert.deepEqual(replay.forecasts,sim.forecasts);
  assert.deepEqual(replay.deployedSupport.learned,sim.deployedSupport.learned);
  assert.deepEqual(replay.deployedSupport.fixed,sim.deployedSupport.fixed);
});

test('deployed commands use fixed synthesized gains and raw forecasts while forbidden sources remain zero',()=>{
  const sim=communication({horizon:80});run(sim,65);assert.ok(sim.deployTopology());
  for(const key of ['online','scalar']){
    const support=sim.deployedSupport[key==='online'?'learned':'fixed'];
    assert.equal(support.flat().filter(Boolean).length,constants.M*(constants.remoteBudget+1));
    for(let r=0;r<constants.M;r++){
      assert.equal(support[r][constants.inverterBuses[r]-2],true);
      assert.equal(support[r].filter(Boolean).length,constants.remoteBudget+1);
    }
    for(const row of sim.segments[0].designs[key].rows)for(const block of row)
      for(let r=0;r<constants.M;r++)for(let j=0;j<constants.N-1;j++)
        if(!support[r][j])assert.ok(Math.abs(block.L[r][j])<1e-12);
  }
  for(let t=0;t<70;t++){
    if(t>=25&&t<30)sim.queuePulse(12,50);
    const before=sim.snapshot(),state=sim.step();
    for(const key of keys){
      const x=before.states[key].slice(1).map((value,j)=>value-model.baseDrop[j+1]);
      const raw=math.matvec(model.K,x);
      if(key!=='causal')for(const block of sim.segments[0].designs[key].rows[t]){
        const forecast=sim.forecasts[block.k-1].forecast.slice(1);
        for(let r=0;r<constants.M;r++)for(let j=0;j<constants.N-1;j++)raw[r]+=block.L[r][j]*forecast[j];
      }
      const bounded=raw.map(value=>Math.max(-model.qLimit,Math.min(model.qLimit,value)));
      near(state.lastInputs[key],math.padInput(bounded),1e-13);
    }
  }
});

test('held out observations and repeated attacks cannot change frozen comparison coefficients or topology scores',()=>{
  const sim=communication({horizon:80});run(sim,65);assert.ok(sim.deployTopology());
  const initial=sim.snapshot(),designs=sim.segments[0].designs;
  const weights=clone(initial.directGain),scores=clone(initial.predictionDiagnostics),calibration=clone(initial.calibration);
  for(let t=0;t<70;t++){
    if(t>=15&&t<25)sim.queuePulse(23,100);
    if(t===32)sim.toggleFault(12);
    const state=sim.step();
    assert.deepEqual(state.calibration,calibration);
    assert.deepEqual(state.directGain,weights);
    assert.deepEqual(state.predictionDiagnostics,scores);
    assert.deepEqual(state.recommendations,initial.recommendations);
    assert.equal(state.predictionDiagnostics.frozen,true);
    assert.equal(state.calibration.updates,0);
    for(const key of ['online','scalar','static'])assert.equal(sim.segments[0].designs[key],designs[key]);
  }
  assert.equal(sim.samples.length,70,'comparison observations are recorded even though policies are fixed');
});

test('unforecast pulses share the same unsaturated feedback response despite different prediction commands',()=>{
  const clean=communication({horizon:80}),attacked=communication({horizon:80});
  for(const sim of [clean,attacked]){run(sim,65);assert.ok(sim.deployTopology());}
  assert.deepEqual(attacked.deployedSupport,clean.deployedSupport);
  assert.notDeepEqual(clean.deployedSupport.learned,clean.deployedSupport.fixed);
  const executedCost=Object.fromEntries(keys.map(key=>[key,0]));let predictionDifference=0;
  for(let t=0;t<40;t++){
    if(t===8){
      const sealed=clone(attacked.forecasts);attacked.queuePulse(24,50);
      assert.deepEqual(attacked.forecasts,sealed,'a physical pulse cannot rewrite an issued forecast');
    }
    const a=clean.step(),b=attacked.step();
    assert.deepEqual(attacked.forecasts,clean.forecasts,'the entire paired forecast stream stays unchanged');
    const dx=b.states.online.map((value,j)=>value-a.states.online[j]);
    const du=b.lastInputs.online.map((value,j)=>value-a.lastInputs.online[j]);
    if(t===8)assert.ok(dx.some(value=>Math.abs(value)>1e-6),'the unforecast pulse must affect the physical state');
    for(const key of keys){
      assert.ok(!a.saturation[key].some(Boolean)&&!b.saturation[key].some(Boolean));
      near(b.states[key].map((value,j)=>value-a.states[key][j]),dx,1e-12);
      near(b.lastInputs[key].map((value,j)=>value-a.lastInputs[key][j]),du,1e-12);
      const fullStage=35*b.costStates[key].reduce((sum,value,j)=>sum+(value-model.baseDrop[j])**2,0)
        +.08*b.lastInputs[key].reduce((sum,value)=>sum+value*value,0);
      assert.ok(Math.abs(b.stage[key]-fullStage)<1e-12);
      executedCost[key]+=fullStage;
      assert.ok(Math.abs(b.cumulative[key]-executedCost[key])<1e-12);
    }
    // Initial state is zero, so the first commands contain prediction only.
    if(t===0)predictionDifference=Math.max(...a.lastInputs.online.map((value,j)=>Math.abs(value-a.lastInputs.scalar[j])));
  }
  assert.ok(predictionDifference>1e-6,'different selected links must still produce different prediction commands');
  assert.ok(Math.abs(attacked.cumulative.online-clean.cumulative.online)>1e-9,
    'reported cost must retain the pulse effect rather than subtracting it');
});
