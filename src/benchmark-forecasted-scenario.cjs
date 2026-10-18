'use strict';
// Actual-engine evaluation of the locked forecastable schedule.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {Simulation,constants,model,math}=require('./simulation.js');
const Online=require('./online-predsls.js');
const keys=constants.controllers,betas=[0,1,2,4],heldoutSeeds=Array.from({length:20},(_,i)=>i+21);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mean=values=>values.reduce((sum,v)=>sum+v,0)/values.length;
const sumSquares=values=>values.reduce((sum,v)=>sum+v*v,0);
const pairs=links=>new Set(links.map(e=>e.from+','+e.to));
function run(seed,beta,{powerScenario='forecasted-demand',faultBuses}={}){
  const sim=new Simulation({experiment:'communication',powerScenario,beta,seed,horizon:180,...(faultBuses?{faultBuses}:{} )});
  for(let t=0;t<180;t++)sim.step();
  assert.ok(sim.deployTopology());
  const frozenSupportHash=hash(sim.deployedSupport);
  const gainHashes=Object.fromEntries(['online','scalar','static'].map(key=>[key,hash(sim.segments[0].designs[key])]));
  const ranges=Object.fromEntries(keys.map(key=>[key,{minimumVoltagePu:1,maximumVoltagePu:1,peakReferenceDeviationPu:0,saturatedCommands:0}]));
  const plannedRangeKw={Homes:{min:Infinity,max:-Infinity},Solar:{min:Infinity,max:-Infinity},Battery:{min:Infinity,max:-Infinity}};
  const appliedRangeKw={Homes:{min:Infinity,max:-Infinity},Solar:{min:Infinity,max:-Infinity},Battery:{min:Infinity,max:-Infinity}};
  for(let t=0;t<180;t++){
    const s=sim.step();
    for(const key of keys){
      const r=ranges[key];
      r.minimumVoltagePu=Math.min(r.minimumVoltagePu,...s.voltages[key]);
      r.maximumVoltagePu=Math.max(r.maximumVoltagePu,...s.voltages[key]);
      r.peakReferenceDeviationPu=Math.max(r.peakReferenceDeviationPu,...s.states[key].map((v,i)=>Math.abs(v-model.baseDrop[i])));
      r.saturatedCommands+=s.saturation[key].filter(Boolean).length;
    }
    if(powerScenario==='forecasted-demand'){
      assert.deepEqual(s.lastSample.scheduledPowerKw,sim.forecasts[t].scheduledPowerKw);
      assert.deepEqual(s.lastSample.powerDeviation,sim.forecasts[t].base,'Planned bounded power equals the realized power without extra attacks');
      for(const profile of constants.busProfiles.slice(1)){
        const requested=s.lastSample.scheduledPowerKw[profile.bus-1],applied=s.lastSample.scheduledAppliedKw[profile.bus-1];
        const a=plannedRangeKw[profile.role],b=appliedRangeKw[profile.role];
        a.min=Math.min(a.min,requested);a.max=Math.max(a.max,requested);b.min=Math.min(b.min,applied);b.max=Math.max(b.max,applied);
      }
    }
  }
  const s=sim.snapshot(),learned=pairs(s.deployedSupport.links),fixed=pairs(s.deployedSupport.fixedLinks);
  assert.equal(hash(sim.deployedSupport),frozenSupportHash,'Discovery support and score record remain frozen');
  for(const key of ['online','scalar','static'])assert.equal(hash(sim.segments[0].designs[key]),gainHashes[key],'Deployed predictive gains stay fixed');
  const error=[];let commonForcingResidual=0;
  for(let t=0;t<180;t++){
    const f=sim.forecasts[t],previous=t?sim.forecasts[t-1].base:Array(24).fill(0);
    const forcing=math.matvec(model.powerToVoltage,f.base.map((v,i)=>v-model.lag*previous[i]));
    for(let j=1;j<24;j++)error.push((f.forecast[j]-forcing[j])*1000);
    for(const key of keys)for(let j=0;j<24;j++)commonForcingResidual=Math.max(commonForcingResidual,Math.abs(sim.samples[t].disturbances[key][j]-forcing[j]));
  }
  assert.ok(commonForcingResidual<1e-10,'All controllers experience the same realized voltage forcing');
  for(const key of keys)ranges[key].saturatedPercent=100*ranges[key].saturatedCommands/(180*constants.M);
  return {seed,deploymentSeed:s.seed,beta,powerScenario,faultBuses:s.faults,costs:s.totalCost,stageCosts:s.cumulative,terminalCosts:s.terminalCost,
    discoveryScoreSamples:s.deployedSupport.scoreSamples,learnedRemoteLinks:s.deployedSupport.links.map(({from,to})=>({from,to})),fixedRemoteLinks:s.deployedSupport.fixedLinks.map(({from,to})=>({from,to})),
    replacedLinks:[...learned].filter(key=>!fixed.has(key)).length,noisyRemoteLinks:{learned:s.deployedSupport.links.filter(e=>s.faults.includes(e.from)).length,fixed:s.deployedSupport.fixedLinks.filter(e=>s.faults.includes(e.from)).length},
    ranges,plannedRangeKw:powerScenario==='forecasted-demand'?plannedRangeKw:null,appliedRangeKw:powerScenario==='forecasted-demand'?appliedRangeKw:null,
    rawForecastErrorRmsMpu:Math.sqrt(sumSquares(error)/error.length),commonForcingResidual,
    realizationHash:hash(sim.forecasts.map(f=>({t:f.t,base:f.base}))),issuedForecastHash:hash(sim.forecasts),deployedSupportHash:frozenSupportHash,gainHashes};
}
function randomGenerator(seed){let state=seed>>>0;return()=>{state+=0x6D2B79F5;let z=state;z=Math.imul(z^(z>>>15),z|1);z^=z+Math.imul(z^(z>>>7),z|61);return((z^(z>>>14))>>>0)/4294967296;};}
function summarize(runs,bootstrapSeed){
  const means=Object.fromEntries(keys.map(key=>[key,mean(runs.map(r=>r.costs[key]))]));
  const comparisons={};
  for(const key of ['scalar','static','causal']){
    const rng=randomGenerator(bootstrapSeed),samples=[];
    for(let b=0;b<5000;b++){let online=0,baseline=0;for(let i=0;i<runs.length;i++){const row=runs[Math.floor(rng()*runs.length)];online+=row.costs.online;baseline+=row.costs[key];}samples.push(100*(baseline-online)/baseline);}
    samples.sort((a,b)=>a-b);
    comparisons[key]={learnedSavingsPercent:100*(means[key]-means.online)/means[key],pairedBootstrap95Percent:[samples[Math.floor(.025*samples.length)],samples[Math.floor(.975*samples.length)]],
      wins:runs.filter(r=>r.costs.online<r.costs[key]-1e-12).length,ties:runs.filter(r=>Math.abs(r.costs.online-r.costs[key])<=1e-12).length,losses:runs.filter(r=>r.costs.online>r.costs[key]+1e-12).length};
  }
  return{means,comparisons,ranges:Object.fromEntries(keys.map(key=>[key,{minimumVoltagePu:Math.min(...runs.map(r=>r.ranges[key].minimumVoltagePu)),maximumVoltagePu:Math.max(...runs.map(r=>r.ranges[key].maximumVoltagePu)),maximumReferenceDeviationPu:Math.max(...runs.map(r=>r.ranges[key].peakReferenceDeviationPu)),meanSaturatedPercent:mean(runs.map(r=>r.ranges[key].saturatedPercent))}])),meanReplacedLinks:mean(runs.map(r=>r.replacedLinks)),runs};
}
function ongoingDiagnostic(){
  const sim=new Simulation({experiment:'communication',powerScenario:'forecasted-demand',beta:4,seed:20261013,horizon:180});
  for(let t=0;t<180;t++)sim.step();
  const observed=sim.samples.slice(-60);
  const plain=observed.map(sample=>({forecast:sample.forecast,disturbance:sample.disturbance}));
  const misleading=observed.map(sample=>({...sample,faultBuses:[1,2,3],sourceQuality:'arbitrary label',scheduledPowerKw:Array(24).fill(1e9)}));
  const options={dimension:constants.N-1,lambda:model.calibrationRidge,window:60,warmup:0};
  const fitted=Online.fit(observed,options);
  assert.equal(fitted.algorithmId,constants.algorithmId);
  assert.deepEqual(fitted,Online.fit(plain,options));
  assert.deepEqual(fitted,Online.fit(misleading,options));
  sim.deployTopology();for(let t=0;t<180;t++)sim.step();
  const s=sim.snapshot();
  const stageCosts=Object.fromEntries(keys.map(key=>[key,s.cumulative[key]-sim.history[29][key]]));
  const stageAndTerminalCosts=Object.fromEntries(keys.map(key=>[key,stageCosts[key]+s.terminalCost[key]]));
  return{algorithmId:fitted.algorithmId,seed:20261013,beta:4,actions:[30,179],stageCosts,stageAndTerminalCosts,
    savingsVsFeedback:100*(stageAndTerminalCosts.causal-stageAndTerminalCosts.online)/stageAndTerminalCosts.causal,learnerIgnoresNonForecastMetadata:true};
}
function main(){
  assert.equal(constants.forecastedDemand.id,'forecasted-demand');
  const referenceChecks=[];
  for(const beta of [0,1,2]){
    referenceChecks.push(run(1,beta,{powerScenario:'reference'}));
  }
  const heldout=[];
  for(const beta of betas){
    const runs=heldoutSeeds.map(seed=>run(seed,beta));
    if(heldout.length)for(let i=0;i<runs.length;i++)assert.equal(runs[i].realizationHash,heldout[0].runs[i].realizationHash,'Every beta uses the same physical realization for a paired seed');
    heldout.push({beta,...summarize(runs,20261017+beta)});console.error('Held out beta '+beta+' complete');
  }
  const defaultSeed=betas.map(beta=>run(20261013,beta));
  const allNoisySeeds=[21,22,23,24,25],allNoisy=allNoisySeeds.map(seed=>run(seed,4,{faultBuses:Array.from({length:23},(_,i)=>i+2)}));
  for(const r of allNoisy)assert.equal(r.realizationHash,heldout.find(x=>x.beta===4).runs.find(x=>x.seed===r.seed).realizationHash,'Reliability ablation leaves physical power unchanged');
  const report={algorithmId:constants.algorithmId,scenario:'Forecastable demand and solar with compromised household estimates',powerScenario:'forecasted-demand',defaultBeta:4,
    physicalProfile:constants.forecastedDemand,physicalScale:1,discoverySamples:180,comparisonSamples:180,
    independentSeedSets:{heldout:heldoutSeeds,default:20261013,allNoisyAblation:allNoisySeeds},betas,
    forecast:'Bounded scheduled active power plus the unchanged seeded background enters immutable issued forecasts before execution. Five forecast samples include the current action, giving up to four future steps. This is a constructed forecast experiment, not a measured forecasting service.',
    reliability:'All 8 forecast sources associated with inverter buses use multiplier 0.05; all 15 household estimate sources use multiplier 4. These channels estimate future voltage forcing rather than directly measuring future voltage. Beta scales both. This is a declared experimental telemetry model, not an empirical classification. The learner sees completed forecast/realization pairs, not the reliability labels.',
    shared:'All 4 methods execute the same realized power and issued forecasts with the same common feedback, objective and inverter limits. Learned and fixed sparse supports and predictive gains are frozen before the fresh comparison. Source-quality labels are used only to generate data and report diagnostics.',
    cost:'All executed stage costs plus terminal Riccati penalty. Savings are ratios of mean paired total costs. Positive means learned costs less. No attack costs are removed.',
    uncertainty:'5000 paired bootstrap resamples with deterministic seed 20261017+beta; 95 percent percentile intervals for savings ratios. All seedwise outcomes retained.',
    limitations:'Synthetic schedule and reliability model. Dense prediction can win at low noise. Corrupting all sources removes reliable alternatives. Unexpected physical attacks remain outside issued forecasts and can dominate total recovery cost. This is not a numerical reproduction of the manuscript.',
    modelHash:hash({A:model.A,B:model.B,Q:model.Q,R:model.R,K:model.K,qLimit:model.qLimit,remoteBudget:constants.remoteBudget}),
    sourceQualityLabelsAvailableToLearner:false,ongoingBenefitDiagnostic:ongoingDiagnostic(),
    sourceHashes:Object.fromEntries(['simulation.js','response-controller.js','online-predsls.js','benchmark-forecasted-scenario.cjs'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')])),
    referenceChecks,heldout,defaultSeed,allNoisyAblation:{beta:4,...summarize(allNoisy,20261021)}};
  if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
  else console.table(heldout.map(r=>({beta:r.beta,...r.means,learnedVsFixedPercent:r.comparisons.scalar.learnedSavingsPercent,learnedVsDensePercent:r.comparisons.static.learnedSavingsPercent,learnedVsFeedbackPercent:r.comparisons.causal.learnedSavingsPercent})));
  return report;
}
if(require.main===module)main();
module.exports={run,summarize,ongoingDiagnostic,main};
