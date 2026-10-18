'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {Simulation,constants,model,math}=require('./simulation.js');
const Calibration=require('./forecast-calibration.js');
const keys=constants.controllers;
const homes=constants.busProfiles.filter(profile=>profile.role==='Homes').map(profile=>profile.bus);
const trial=options=>new Simulation({experiment:'communication',powerScenario:'forecasted-demand',seed:17,beta:4,horizon:90,...options});
const run=(sim,steps)=>{for(let t=0;t<steps;t++)sim.step();return sim.snapshot();};
const near=(a,b,tolerance=1e-12)=>{
  assert.equal(a.length,b.length);
  for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-b[i])<=tolerance,`entry ${i} differs by ${Math.abs(a[i]-b[i])}`);
};
const truthAt=(sim,t)=>math.matvec(model.powerToVoltage,sim.forecasts[t].base.map((value,i)=>value-model.lag*(t?sim.forecasts[t-1].base[i]:0)));

test('the scheduled scenario has a fixed bounded role profile and a declared default source map',()=>{
  const metadata=constants.forecastedDemand,sim=trial();
  assert.ok(Object.isFrozen(metadata));assert.ok(Object.isFrozen(metadata.noisySources));
  assert.equal(metadata.periodSeconds,60);assert.equal(metadata.previewSamples,5);assert.equal(metadata.leadSteps,4);
  assert.deepEqual(sim.snapshot().faults,homes);assert.equal(homes.length,15);
  for(const bus of constants.inverterBuses)assert.ok(!homes.includes(bus));
  assert.deepEqual(trial({faultBuses:[]}).snapshot().faults,[]);
  assert.deepEqual(trial({faultBuses:[7,23]}).snapshot().faults,[7,23]);
  assert.deepEqual(trial({experiment:'prediction',preset:'reliable'}).snapshot().faults,[]);
  assert.deepEqual(trial({experiment:'prediction',preset:'uniform'}).snapshot().faults,Array.from({length:23},(_,i)=>i+2));
  assert.deepEqual(trial({experiment:'prediction',preset:'reliable',faultBuses:[7,23]}).snapshot().faults,[7,23]);
  for(let t=0;t<=120;t++)for(const profile of constants.busProfiles){
    const value=math.scheduledPower(profile.bus,t)*1000;
    near([math.scheduledPower(profile.bus,t+60)],[value/1000],1e-14);
    if(profile.role==='Homes')assert.ok(Math.abs(value)<=35+1e-12);
    if(profile.role==='Battery')assert.ok(Math.abs(value)<=15+1e-12);
    if(profile.role==='Solar')assert.ok(value>=0&&value<=30+1e-12);
    if(profile.role==='Substation')assert.equal(value,0);
  }
  near([math.scheduledPower(6,15)*1000,math.scheduledPower(12,15)*1000,math.scheduledPower(7,30)*1000],[35,15,30]);
  const legacy=new Simulation({experiment:'communication',horizon:45});
  assert.equal(legacy.options.powerScenario,'reference');assert.equal(legacy.options.beta,1);
  assert.deepEqual(legacy.options.faultBuses,[3,6,9,12,15,18,21,24]);
  assert.equal(Object.hasOwn(legacy.forecasts[0],'scheduledPowerKw'),false);
  assert.equal(Object.hasOwn(legacy.snapshot(),'scheduledPowerKw'),false);
});

test('scheduled physical activity is sealed in forecasts and appears in the executed plant with exact units',()=>{
  const sim=trial({beta:0});
  for(let t=0;t<80;t++){
    const state=sim.step(),issued=sim.forecasts[t];
    assert.ok(Object.isFrozen(issued.scheduledPowerKw));assert.ok(Object.isFrozen(issued.scheduledAppliedKw));
    assert.deepEqual(issued.scheduledPowerKw,constants.busProfiles.map(profile=>1000*math.scheduledPower(profile.bus,t)));
    assert.deepEqual(state.lastSample.base,issued.base);
    assert.deepEqual(state.powerDeviation,issued.base,'the scheduled physical base is executed exactly once');
    assert.deepEqual(state.lastSample.scheduledPowerKw,issued.scheduledPowerKw);
    assert.deepEqual(state.scheduledPowerKw,issued.scheduledPowerKw);
    assert.deepEqual(state.lastSample.scheduledAppliedKw,issued.scheduledAppliedKw);
    near(issued.forecast,truthAt(sim,t),1e-14);
    for(const key of keys)near(state.lastSample.disturbances[key],truthAt(sim,t),1e-14);
    assert.equal(state.lastSample.forecast[0],0);assert.equal(state.powerDeviation[0],0);
    const applications=state.lastScenarioApplications;
    assert.equal(applications.length,23);assert.ok(applications.every(item=>item.forecasted));
    near(applications.map(item=>item.appliedKw),issued.scheduledAppliedKw.slice(1));
    const sum=role=>applications.filter(item=>!role||item.role===role).reduce((total,item)=>total+item.appliedKw,0);
    assert.equal(state.scenario.appliedKw,sum());assert.equal(state.scenario.demandChangeKw,sum('Homes'));
    assert.equal(state.scenario.solarLossKw,sum('Solar'));assert.equal(state.scenario.batteryChangeKw,sum('Battery'));
    assert.equal(state.scenario.action,t);assert.equal(state.scenario.forecasted,true);
    for(const profile of constants.busProfiles){
      const value=state.powerDeviation[profile.bus-1]*1000;
      if(profile.role==='Solar')assert.ok(value>=-10-1e-12&&value<=80+1e-12);
      if(profile.role==='Battery')assert.ok(Math.abs(value)<=90+1e-12);
      if(profile.role==='Homes')assert.ok(value>=-70-1e-12);
    }
  }
  assert.deepEqual(sim.eventLog.filter(event=>event.type==='scenario').map(event=>({t:event.t,forecasted:event.forecasted,kind:event.kind})),[
    {t:0,forecasted:true,kind:'demand'},{t:60,forecasted:true,kind:'demand'}]);
});

test('source errors change without changing the scheduled physical stream or feedback controller',()=>{
  const zero=trial({beta:0}),reference=trial({beta:1}),stress=trial({beta:4});
  for(let t=0;t<80;t++){
    const snapshots=[zero,reference,stress].map(sim=>sim.step());
    for(let i=1;i<snapshots.length;i++){
      assert.deepEqual(snapshots[i].powerDeviation,snapshots[0].powerDeviation);
      assert.deepEqual(snapshots[i].states.causal,snapshots[0].states.causal);
      assert.deepEqual(snapshots[i].lastInputs.causal,snapshots[0].lastInputs.causal);
      assert.equal(snapshots[i].cumulative.causal,snapshots[0].cumulative.causal);
    }
    const expected=reference.forecasts[t].forecast.map((value,i)=>zero.forecasts[t].forecast[i]+4*(value-zero.forecasts[t].forecast[i]));
    near(stress.forecasts[t].forecast,expected,1e-14);
  }
});

test('scheduled preview timing remains causal and later source changes cannot rewrite issued messages',()=>{
  const sim=trial();run(sim,26);
  assert.equal(sim.forecasts.length,30,'before action26 target30 is not issued');
  sim.step();
  assert.equal(sim.forecasts[30].issuedAt,26);
  assert.equal(sim.t,27);assert.equal(sim.samples.at(-1).t,26);
  const sealed=JSON.stringify(sim.forecasts);
  sim.toggleFault(7);
  assert.equal(JSON.stringify(sim.forecasts),sealed);
  run(sim,3);
  const prior=sim.samples.slice(-constants.window);
  assert.equal(prior.at(-1).t,29);
  const expected=Calibration.fit(prior,{lambda:model.calibrationRidge});
  const state=sim.step();
  assert.equal(state.t,31);assert.equal(state.lastSample.t,30);
  assert.equal(state.calibration.trainedThrough,29);
  assert.deepEqual(state.calibration.matrix,expected.matrix,'only earlier revealed samples enter the current fit');
  assert.equal(JSON.stringify(sim.forecasts.slice(0,31)),sealed);
  assert.deepEqual(state.lastSample.forecast,sim.forecasts[30].forecast);
});

test('manual power attacks remain unforecast while selected supports and realized controllers stay genuine',()=>{
  const clean=trial(),attacked=trial();
  for(const sim of [clean,attacked]){run(sim,75);assert.ok(sim.deployTopology());}
  const support=JSON.stringify(attacked.deployedSupport);
  assert.notDeepEqual(attacked.deployedSupport.learned,attacked.deployedSupport.fixed);
  assert.deepEqual(attacked.deployedSupport,clean.deployedSupport);
  let differentCommands=false;
  for(let t=0;t<70;t++){
    if(t>=20&&t<24)attacked.queuePulse(23,100);
    const before=attacked.snapshot(),a=clean.step(),b=attacked.step();
    assert.deepEqual(attacked.forecasts,clean.forecasts,'manual power never enters sealed scheduled forecasts');
    assert.deepEqual(a.lastSample.base,b.lastSample.base);
    assert.equal(JSON.stringify(attacked.deployedSupport),support);
    for(const key of keys){
      const x=before.states[key].slice(1).map((value,i)=>value-model.baseDrop[i+1]);
      const command=math.matvec(model.K,x);
      if(key!=='causal')for(const block of attacked.segments[0].designs[key].rows[t]){
        const contribution=math.matvec(block.L,attacked.forecasts[block.k-1].forecast.slice(1));
        for(let i=0;i<command.length;i++)command[i]+=contribution[i];
      }
      const bounded=math.padInput(command.map(value=>Math.max(-model.qLimit,Math.min(model.qLimit,value))));
      near(b.lastInputs[key],bounded,1e-13);
      assert.ok(Number.isFinite(b.cumulative[key]));assert.ok(b.states[key].every(Number.isFinite));
    }
    if(t===20)assert.notDeepEqual(a.powerDeviation,b.powerDeviation);
    differentCommands ||= b.lastInputs.online.some((value,i)=>Math.abs(value-b.lastInputs.scalar[i])>1e-8);
  }
  assert.ok(differentCommands,'the learned and fixed supports must execute different prediction commands');
  assert.notEqual(attacked.cumulative.online,clean.cumulative.online,'full manual disturbance costs remain included');
});

test('scenario identity and source overrides survive fresh deployment and exact discovery replay',()=>{
  const sim=trial({faultBuses:[3,7,23]});
  run(sim,40);sim.toggleFault(7);sim.toggleFault(6);run(sim,35);
  const faults=sim.snapshot().faults;
  assert.ok(sim.deployTopology());
  assert.equal(sim.options.powerScenario,'forecasted-demand');assert.equal(sim.options.beta,4);
  assert.deepEqual(sim.options.faultBuses,faults);assert.equal(sim.t,0);
  for(const key of keys)assert.equal(sim.cumulative[key],0);
  assert.equal(sim.snapshot().scenario.active,false);
  assert.deepEqual(sim.snapshot().scheduledPowerKw,Array(24).fill(0));
  const replay=trial(sim.discoveryRecord.options);
  for(let t=0;t<sim.discoveryRecord.t;t++){
    for(const event of sim.discoveryRecord.events)if(event.t===t&&event.type==='forecast')replay.toggleFault(event.bus);
    replay.step();
  }
  assert.ok(replay.deployTopology());
  assert.deepEqual(replay.deployedSupport,sim.deployedSupport);
  assert.deepEqual(replay.forecasts,sim.forecasts);
  assert.deepEqual(run(replay,10),run(sim,10));
});

test('extended playback keeps the scheduled clock, sealed forecasts, fixed support and complete costs',()=>{
  const sim=trial({horizon:45});run(sim,40);assert.ok(sim.deployTopology());
  const support=JSON.stringify(sim.deployedSupport),sums=Object.fromEntries(keys.map(key=>[key,0]));
  for(let t=0;t<130;t++){
    if(sim.mode==='completed'){
      const sealed=JSON.stringify(sim.forecasts),costs={...sim.cumulative};sim.extend(45);
      assert.equal(JSON.stringify(sim.forecasts.slice(0,JSON.parse(sealed).length)),sealed);
      assert.deepEqual(sim.cumulative,costs);
    }
    const state=sim.step();assert.equal(state.t,t+1);
    assert.equal(JSON.stringify(sim.deployedSupport),support);
    assert.deepEqual(state.scheduledPowerKw,constants.busProfiles.map(profile=>1000*math.scheduledPower(profile.bus,t)));
    for(const key of keys){sums[key]+=state.stage[key];assert.equal(state.cumulative[key],sums[key]);}
    const segment=sim.segments.find(item=>t>=item.start&&t<item.end);
    assert.ok(segment.designs.online.rows[t-segment.start].length>0);
  }
  assert.deepEqual(sim.eventLog.filter(event=>event.type==='scenario').map(event=>event.t),[0,60,120]);
  assert.equal(sim.history.length,130);assert.equal(sim.segments.length,3);
});
