'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {Simulation,constants,voltageMetrics}=require('./simulation.js');
const seeds=Array.from({length:20},(_,i)=>i+1),betas=[0,1,2],keys=constants.controllers;
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
const simulate=(seed,beta,powerScenario)=>{
  const sim=new Simulation({experiment:'communication',seed,beta,horizon:180,powerScenario});
  for(let t=0;t<180;t++)sim.step();
  assert.ok(sim.deployTopology());
  const snapshots=[];
  for(let t=0;t<180;t++)snapshots.push(sim.step());
  return {sim,snapshot:snapshots.at(-1),snapshots};
};
const results=betas.map(beta=>{
  const runs=seeds.map(seed=>{
    const reference=simulate(seed,beta,'reference'),outage=simulate(seed,beta,'solar-outage');
    assert.deepEqual(reference.sim.forecasts,outage.sim.forecasts,'Outage is absent from identical issued forecasts');
    assert.deepEqual(reference.snapshot.deployedSupport.learned,outage.snapshot.deployedSupport.learned);
    assert.deepEqual(reference.snapshot.deployedSupport.fixed,outage.snapshot.deployedSupport.fixed);
    const recovery=Object.fromEntries(keys.map(key=>{
      const errors=outage.snapshots.map((s,t)=>Math.max(...s.states[key].map((v,i)=>Math.abs(v-reference.snapshots[t].states[key][i]))));
      let confirmedSeconds=null,consecutive=0;
      for(let t=50;t<180;t++) {
        consecutive=errors[t]<=.0001?consecutive+1:0;
        if(consecutive===5) {confirmedSeconds=t+1-50;break;}
      }
      return [key,{peakIncrementalPu:Math.max(...errors),confirmedRecoverySeconds:confirmedSeconds,
        limitedCommands:outage.snapshots.reduce((sum,s)=>sum+s.saturation[key].filter(Boolean).length,0)}];
    }));
    return {seed,referenceCosts:reference.snapshot.totalCost,outageCosts:outage.snapshot.totalCost,
      outageStageCosts:outage.snapshot.cumulative,outageTerminalCosts:outage.snapshot.terminalCost,
      voltage:voltageMetrics(outage.snapshot),recovery,
      outageAppliedKw:outage.snapshots.slice(30,50).map(s=>s.scenario.appliedKw),
      unchangedForecasts:true,frozenSupport:true};
  });
  const referenceMeans=Object.fromEntries(keys.map(key=>[key,mean(runs.map(r=>r.referenceCosts[key]))]));
  const means=Object.fromEntries(keys.map(key=>[key,mean(runs.map(r=>r.outageCosts[key]))]));
  const comparisons=Object.fromEntries(keys.filter(k=>k!=='online').map(key=>[key,{
    learnedSavingsPercent:100*(means[key]-means.online)/means[key],
    wins:runs.filter(r=>r.outageCosts.online<r.outageCosts[key]-1e-12).length,
    ties:runs.filter(r=>Math.abs(r.outageCosts.online-r.outageCosts[key])<=1e-12).length,
    losses:runs.filter(r=>r.outageCosts.online>r.outageCosts[key]+1e-12).length
  }]));
  return {beta,referenceMeans,outageMeans:means,comparisons,
    recovery: Object.fromEntries(keys.map(key=>[key,{meanConfirmedSeconds:mean(runs.filter(r=>r.recovery[key].confirmedRecoverySeconds!==null).map(r=>r.recovery[key].confirmedRecoverySeconds)),
      failures:runs.filter(r=>r.recovery[key].confirmedRecoverySeconds===null).length}])),runs};
});
const report={algorithmId:constants.algorithmId,protocol:'Prespecified unforecast four-site solar outage',seeds,betas,discoverySamples:180,comparisonSamples:180,
  outageActions:[30,49],restorationAction:50,nominalLostGenerationKw:320,maxAvailableLostGenerationKw:360,
  bounds:'Four existing solar sites at buses 5,7,14,21, each available generation capped at existing 90 kW limit. All generation goes to zero during outage.',
  shared:'Identical realized background and issued forecasts for all methods and both paired scenarios. Fixed deployed topology and coefficients.',
  cost:'All executed stage costs plus terminal Riccati penalty. No physical costs removed.',
  recovery:'Matched reference incremental voltage error at every bus <=0.0001 pu for five consecutive samples after restoration. Report the confirmation time, not first entry. Null is failure by end of comparison.',
  limitations:'Not universal prediction advantage or utility data. Zero, high and severe noise tested; intermediate levels not evaluated for this preset. Recovery is conditional on this bounded scenario and background.',
  sourceHashes:Object.fromEntries(['simulation.js','response-controller.js','online-predsls.js','benchmark-stress.cjs'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')])),
  results};
console.log('STRESS_REPORT '+JSON.stringify(report));
