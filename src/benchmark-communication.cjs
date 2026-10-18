'use strict';
// Prespecified topology isolation protocol. All beta levels and all seeds are
// reported, including regimes where sparse communication loses to dense.
const {Simulation,constants,model}=require('./simulation.js');
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const seeds=Array.from({length:20},(_,i)=>i+1),horizon=180;
const keys=['online','scalar','static','causal'];
const labels={online:'Learned sparse',scalar:'Fixed sparse',static:'Dense prediction',causal:'Feedback only'};
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
function interval(runs,reference){
  let state=314159;const random=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296;};
  const values=Array.from({length:2000},()=>{
    let a=0,b=0;for(let i=0;i<runs.length;i++){const r=runs[Math.floor(random()*runs.length)];a+=r.costs.online;b+=r.costs[reference];}
    return 100*(b-a)/b;
  }).sort((a,b)=>a-b);
  return [values[49],values[1949]];
}
const results=constants.communicationBetas.map(beta=>{
  const runs=seeds.map(seed=>{
    const sim=new Simulation({experiment:'communication',beta,seed,horizon});
    for(let t=0;t<horizon;t++)sim.step();
    const discovery=sim.snapshot();
    if(!sim.deployTopology())throw new Error('Topology discovery did not complete');
    let s=sim.snapshot();
    const ranges=Object.fromEntries(keys.map(k=>[k,{min:1,max:0,saturatedCommands:0}]));
    for(let t=0;t<horizon;t++){
      s=sim.step();
      for(const k of keys){ranges[k].min=Math.min(ranges[k].min,...s.voltages[k]);ranges[k].max=Math.max(ranges[k].max,...s.voltages[k]);ranges[k].saturatedCommands+=s.saturation[k].filter(Boolean).length;}
    }
    const fixed=new Set(s.deployedSupport.fixedLinks.map(e=>e.from+','+e.to));
    return {seed,deploymentSeed:s.seed,costs:s.totalCost,stageCosts:s.cumulative,terminalCosts:s.terminalCost,
      discoveryScoreSamples:discovery.predictionDiagnostics.scoreSamples,
      remoteLinks:s.recommendations.length,fixedRemoteLinks:s.deployedSupport.fixedLinks.length,
      replacedLinks:s.recommendations.filter(e=>!fixed.has(e.from+','+e.to)).length,
      noisyRemoteLinks:{learned:s.recommendations.filter(e=>s.faults.includes(e.from)).length,
        fixed:s.deployedSupport.fixedLinks.filter(e=>s.faults.includes(e.from)).length},
      selectedSources:s.recommendations.map(({from,to})=>({from,to})),ranges};
  });
  const means=Object.fromEntries(keys.map(k=>[k,mean(runs.map(r=>r.costs[k]))]));
  const comparisons=Object.fromEntries(keys.slice(1).map(k=>[k,{
    savingsPercent:100*(means[k]-means.online)/means[k],
    pairedBootstrap95Percent:interval(runs,k),
    wins:runs.filter(r=>r.costs.online<r.costs[k]-1e-12).length,
    ties:runs.filter(r=>Math.abs(r.costs.online-r.costs[k])<=1e-12).length,
    losses:runs.filter(r=>r.costs.online>r.costs[k]+1e-12).length
  }]));
  return {beta,means,comparisons,runs};
});
const report={algorithmId:constants.algorithmId,experiment:'LinDistFlow communication selection',seeds,discoveryEpisodesPerTrial:1,
  discoverySamples:horizon,scoredActions:[30,179],deploymentSamples:horizon,
  paperDifferences:'Physical feeder and local plus three remote budget retained. One interactive discovery episode rather than six. Not an exact numerical reproduction.',
  forecast:'Truth plus beta times the fixed physical forcing scale times a_j times an independent standard Gaussian',
  errorMultipliers:{busesDivisibleByThree:4,otherBuses:.05},betaGrid:constants.communicationBetas,
  calibrationRidge:model.calibrationRidge,sourceQualityLabelsAvailableToLearner:false,
  selection:'Raw accumulated squared actually executed direct prediction gains at actions 30 through 179; no time or row normalization',
  fixedSelection:'Identical action rows with identity correction',
  numericalTies:'Exact descending score order, then ascending source index for equal scores',
  deployment:'Resynthesize both sparse controllers under frozen supports. Identity prediction correction for every predictive controller.',
  commonPlantFeedbackObjectiveLimits:true,independentDiscoveryAndTest:true,
  sameStandardizedNoiseAcrossBeta:true,remoteBudgetPerInverter:3,
  denseRemoteLinks:constants.M*(constants.N-2),controllers:labels,
  objective:'Executed stage costs plus terminal Riccati penalty',
  uncertainty:'2000 paired bootstrap resamples of 20 trials, ratio of mean costs',
  sourceHashes:Object.fromEntries(['simulation.js','response-controller.js','online-predsls.js','benchmark-communication.cjs'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')])),results};
if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
else console.table(results.map(r=>({beta:r.beta,...r.means,vsFixed:r.comparisons.scalar.savingsPercent,vsDense:r.comparisons.static.savingsPercent})));
