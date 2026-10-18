'use strict';
// Fixed paired protocol. All parameters are chosen before observing costs.
// Discovery and deployment use separate deterministic random streams.
const {Simulation,constants,model}=require('./simulation.js');
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const seeds=Array.from({length:20},(_,i)=>i+1),horizon=180;
const keys=['online','scalar','static','causal'];
const stress=process.argv.includes('--attacks');
// Fixed before evaluating any attack run. No attacks enter the forecasts.
const interventions=stress?[
  {t:20,bus:23,strength:100},{t:21,bus:23,strength:100},
  ...Array.from({length:10},(_,i)=>({t:60+i,bus:7,strength:50})),
  ...Array.from({length:10},(_,i)=>({t:100+i,bus:12,strength:50})),
  ...Array.from({length:10},(_,i)=>({t:140+i,bus:23,strength:50}))
]:[];
const labels={online:'Online SLS',scalar:'Scalar adaptation',static:'Fixed prediction',causal:'Feedback only'};
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
const stdev=a=>{const m=mean(a);return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1));};
const results=constants.forecastPresets.map(preset=>{
  const runs=seeds.map(seed=>{
    const sim=new Simulation({seed,horizon,preset:preset.id});
    for(let t=0;t<horizon;t++)sim.step();
    const discovery=sim.snapshot();
    if(!sim.deployTopology())throw new Error('Discovery did not produce a deployable topology');
    let state=sim.snapshot();
    const voltageRange=Object.fromEntries(keys.map(k=>[k,{min:Math.min(...state.voltages[k]),max:Math.max(...state.voltages[k])}]));
    const saturationCount=Object.fromEntries(keys.map(k=>[k,0]));
    for(let t=0;t<horizon;t++){
      for(const event of interventions)if(event.t===t)sim.queuePulse(event.bus,event.strength);
      state=sim.step();
      for(const key of keys){
        voltageRange[key].min=Math.min(voltageRange[key].min,...state.voltages[key]);
        voltageRange[key].max=Math.max(voltageRange[key].max,...state.voltages[key]);
        saturationCount[key]+=state.saturation[key].filter(Boolean).length;
      }
    }
    if(!state.totalCost||!state.terminalCost)throw new Error('Terminal objective was not reported');
    return {seed,deploymentSeed:state.seed,discoveryCost:discovery.cumulative,
      stageCosts:state.cumulative,terminalCosts:state.terminalCost,costs:state.totalCost,
      voltageRange,saturationCount,links:state.recommendations};
  });
  const means=Object.fromEntries(keys.map(k=>[k,mean(runs.map(r=>r.costs[k]))]));
  const standardDeviations=Object.fromEntries(keys.map(k=>[k,stdev(runs.map(r=>r.costs[k]))]));
  const comparisons=Object.fromEntries(keys.slice(1).map(k=>[k,{
    savingsPercent:100*(means[k]-means.online)/means[k],
    wins:runs.filter(r=>r.costs.online<r.costs[k]-1e-12).length,
    ties:runs.filter(r=>Math.abs(r.costs.online-r.costs[k])<=1e-12).length,
    losses:runs.filter(r=>r.costs.online>r.costs[k]+1e-12).length
  }]));
  const voltageRange=Object.fromEntries(keys.map(k=>[k,{
    min:Math.min(...runs.map(r=>r.voltageRange[k].min)),max:Math.max(...runs.map(r=>r.voltageRange[k].max))
  }]));
  return {preset:preset.id,label:preset.label,means,standardDeviations,comparisons,voltageRange,runs};
});
const report={algorithmId:constants.algorithmId,seeds,discoverySamples:horizon,deploymentSamples:horizon,interventions,controllers:labels,
  model:'Balanced LinDistFlow with bounded inverter commands and actuator lag',
  physicalBases:{kv:constants.baseKv,mva:constants.baseMva},
  referenceVoltage:model.referenceVoltage,
  learning:'Online SLS and scalar adaptation use the same revealed pairs, mean ridge objective, warmup 30 and history window 60',
  deployment:'Dense offline predictive responses retained for all predictive methods. The fresh trial resets the learner and starts adaptation at action 30; no discovery observations are carried over',
  remoteBudget:constants.N-2,previewDepth:5,ridge:model.calibrationRidge,
  ridgeLoss:'Mean squared prediction residual plus Frobenius prior',
  calibrationScale:model.calibrationScale,dimensionlessRidge:model.calibrationNormalizedRidge,
  discoveryAndDeploymentIndependent:true,topologyFixedBeforeTesting:true,
  objective:'Sum of executed stage costs plus terminal x transpose P x',
  currentWebsiteCurves:'Executed stage costs only, with no terminal jump during ongoing playback',
  sourceHashes:Object.fromEntries(['simulation.js','response-controller.js','online-predsls.js','benchmark.cjs'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')])),results};
if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
else {
  console.table(results.map(r=>({preset:r.preset,...r.means})));
  console.table(results.flatMap(r=>keys.slice(1).map(k=>({preset:r.preset,baseline:labels[k],...r.comparisons[k]}))));
  console.log('Positive savings mean lower Online SLS cost. Final costs include the terminal penalty.');
}
