'use strict';
// Prespecified paired stress audit. Error strength is the only forecast change.
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {Simulation,constants,model,math}=require('./simulation.js');
const fs=require('node:fs'),path=require('node:path');
const keys=constants.controllers;
const seeds=Array.from({length:20},(_,i)=>i+1),betas=[1,2,4,8,16];
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mean=x=>x.reduce((a,b)=>a+b,0)/x.length,rms=x=>Math.sqrt(mean(x.map(v=>v*v)));
function run(seed,beta,physical='none'){
 const sim=new Simulation({seed,beta,experiment:'communication',horizon:180});for(let t=0;t<180;t++)sim.step();sim.deployTopology();
 const rawErr=[],forcing=[],attackForcing=[],stats=Object.fromEntries(keys.map(k=>[k,{forecast:[],feedback:[],raw:[],limited:0,minVoltage:1,maxVoltage:1,maxDeviation:0}]));
 let appliedPeakKw=0,requestedPeakKw=0;
 for(let t=0;t<180;t++){
  if(t>=30&&t<50&&physical!=='none')for(const b of physical==='all'?Array.from({length:23},(_,i)=>i+2):[24])sim.queuePulse(b,100);
  sim.sealPreview();const seg=sim.segments.find(s=>t>=s.start&&t<s.end),row=t-seg.start;
  for(const key of keys){const x=sim.states[key].slice(1).map((v,i)=>v-model.baseDrop[i+1]),feedback=math.matvec(model.K,x),pred=Array(8).fill(0);
   if(key!=='causal')for(const block of seg.designs[key].rows[row]){const contribution=math.matvec(block.L,sim.forecasts[seg.start+block.k-1].forecast.slice(1));for(let i=0;i<8;i++)pred[i]+=contribution[i];}
   stats[key].forecast.push(...pred.map(v=>v*1000));stats[key].feedback.push(...feedback.map(v=>v*1000));stats[key].raw.push(...pred.map((v,i)=>(v+feedback[i])*1000));
  }
  const s=sim.step(),f=sim.forecasts[t],prev=t?sim.forecasts[t-1].base:Array(24).fill(0),baseW=math.matvec(model.powerToVoltage,f.base.map((v,i)=>v-model.A[0][0]*prev[i]));
  rawErr.push(...f.forecast.slice(1).map((v,i)=>1000*(v-baseW[i+1])));forcing.push(...baseW.slice(1).map(v=>1000*v));
  attackForcing.push(...s.lastSample.disturbance.slice(1).map((v,i)=>1000*(v-baseW[i+1])));
  appliedPeakKw=Math.max(appliedPeakKw,s.lastPulseApplications.reduce((a,p)=>a+p.appliedKw,0));requestedPeakKw=Math.max(requestedPeakKw,s.lastPulseApplications.reduce((a,p)=>a+p.requestedKw,0));
  for(const key of keys){const a=stats[key];a.limited+=s.saturation[key].filter(Boolean).length;a.minVoltage=Math.min(a.minVoltage,...s.voltages[key]);a.maxVoltage=Math.max(a.maxVoltage,...s.voltages[key]);a.maxDeviation=Math.max(a.maxDeviation,...s.states[key].map((v,i)=>Math.abs(v-model.baseDrop[i])));}
 }
 const s=sim.snapshot();
 const learnedPairs=new Set(s.deployedSupport.links.map(e=>e.from+','+e.to));
 const fixedPairs=new Set(s.deployedSupport.fixedLinks.map(e=>e.from+','+e.to));
 const addedLinks=[...learnedPairs].filter(key=>!fixedPairs.has(key)).length;
 const removedLinks=[...fixedPairs].filter(key=>!learnedPairs.has(key)).length;
 return{seed,deploymentSeed:s.seed,beta,physical,forecastsFingerprint:fingerprint(sim.forecasts),supportFingerprint:fingerprint({learned:s.deployedSupport.learned,fixed:s.deployedSupport.fixed}),learnedLinks:s.deployedSupport.links.map(({from,to})=>({from,to})),fixedLinks:s.deployedSupport.fixedLinks.map(({from,to})=>({from,to})),costs:s.totalCost,stageCosts:s.cumulative,terminalCosts:s.terminalCost,savings:Object.fromEntries(['scalar','static','causal'].map(k=>[k,100*(s.totalCost[k]-s.totalCost.online)/s.totalCost[k]])),changedLinks:addedLinks+removedLinks,addedLinks,removedLinks,linkReplacements:addedLinks,rawForecastErrorRmsMpu:rms(rawErr),backgroundForcingRmsMpu:rms(forcing),physicalForcingRmsMpu:rms(attackForcing),physicalForcingMaxMpu:Math.max(...attackForcing.map(Math.abs)),appliedPeakKw,requestedPeakKw,controllers:Object.fromEntries(keys.map(k=>{const a=stats[k];return[k,{forecastRmsKvar:rms(a.forecast),forecastMaxKvar:Math.max(...a.forecast.map(Math.abs)),feedbackRmsKvar:rms(a.feedback),rawRmsKvar:rms(a.raw),limitedCommands:a.limited,limitedPercent:100*a.limited/(180*8),minVoltage:a.minVoltage,maxVoltage:a.maxVoltage,maxDeviationPu:a.maxDeviation}]}))};
}

const results=[];
for(const beta of betas){
 const runs=[];
 for(const seed of seeds){
  const reference=run(seed,beta,'none'),physical=run(seed,beta,'all');
  assert.equal(reference.forecastsFingerprint,physical.forecastsFingerprint,'Power requests must not enter issued forecasts');
  assert.equal(reference.supportFingerprint,physical.supportFingerprint,'Physical test must not change deployed supports');
  assert.ok(Math.abs(reference.rawForecastErrorRmsMpu-physical.rawForecastErrorRmsMpu)<1e-12,'Physical requests must not change forecast noise');
  assert.ok(reference.physicalForcingRmsMpu<1e-10,'No unrequested physical forcing in reference');
  runs.push({seed,reference,physical});
 }
 const summarize=scenario=>{
  const values=runs.map(r=>r[scenario]);
  const costs=Object.fromEntries(keys.map(k=>[k,mean(values.map(r=>r.costs[k]))]));
  return{meanCosts:costs,comparisons:Object.fromEntries(['scalar','static','causal'].map(k=>[k,{learnedSavingsPercent:100*(costs[k]-costs.online)/costs[k],wins:values.filter(r=>r.costs.online<r.costs[k]-1e-12).length,ties:values.filter(r=>Math.abs(r.costs.online-r.costs[k])<=1e-12).length,losses:values.filter(r=>r.costs.online>r.costs[k]+1e-12).length}])),meanRawForecastErrorRmsMpu:mean(values.map(r=>r.rawForecastErrorRmsMpu)),meanBackgroundForcingRmsMpu:mean(values.map(r=>r.backgroundForcingRmsMpu)),meanPhysicalForcingRmsMpu:mean(values.map(r=>r.physicalForcingRmsMpu)),meanAppliedPeakKw:mean(values.map(r=>r.appliedPeakKw)),meanRequestedPeakKw:mean(values.map(r=>r.requestedPeakKw)),controllers:Object.fromEntries(keys.map(k=>[k,{meanForecastRmsKvar:mean(values.map(r=>r.controllers[k].forecastRmsKvar)),meanFeedbackRmsKvar:mean(values.map(r=>r.controllers[k].feedbackRmsKvar)),meanLimitedPercent:mean(values.map(r=>r.controllers[k].limitedPercent)),minimumVoltagePu:Math.min(...values.map(r=>r.controllers[k].minVoltage)),maximumDeviationPu:Math.max(...values.map(r=>r.controllers[k].maxDeviationPu))}]))};
 };
 const reference=summarize('reference'),physical=summarize('physical');
 results.push({beta,reference,physical,runs});
 console.error('Forecast stress beta '+beta+' complete');
}
const report={algorithmId:constants.algorithmId,protocol:'Prespecified forecast strength and common power stress audit',seeds,betas,discoverySamples:180,comparisonSamples:180,
 defaultBeta:1,originalBenchmarkBetas:[0,.25,.5,1,2],additionalStressBetas:[4,8,16],
 forecast:'Synthetic independent zero mean Gaussian errors. Standard deviation at source j is beta times the model forecast forcing scale times 4 for noisy sources and 0.05 for quiet sources. Increasing beta scales quiet and noisy sources equally. These are constructed stress levels, not measured cyberattack data or paper reproduction.',
 noisySources:[3,6,9,12,15,18,21,24],
 physical:'Actions 30 through 49 request 100 kW at each bus 2 through 24 every sample. Existing pulse decay, accumulation, solar and battery caps and 70 kvar inverter limits are unchanged. Homes demand has no added cap. This intentionally severe simultaneous load test is a dilution diagnostic, not a realistic feeder operating recommendation.',
 model:'Same LinDistFlow dynamics, common feedback, controller synthesis rules, objective, control limits and disturbance seeds at every level. Topology is selected from 180 discovery samples, then frozen for 180 fresh comparison samples. Power requests are never included in immutable issued forecasts.',
 cost:'Every executed stage cost plus terminal Riccati penalty. No shared physical cost removed. Four policies retained, including feedback only. Savings are ratios of paired mean total costs. Positive means learned costs less.',
 units:{forecastForcing:'mpu voltage forcing',voltage:'pu',power:'kW',inverterCommand:'kvar',oneMpu:0.001},
 limitations:'Increasing unbiased forecast errors can separate predictive policies while making feedback only best. Common large physical disturbances can dominate all total costs. These stress results do not establish a universal advantage or reproduce the manuscript numerical gains.',
 sourceHashes:Object.fromEntries(['simulation.js','response-controller.js','online-predsls.js','benchmark-forecast-stress.cjs'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')])),
 results};
if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
else console.table(results.flatMap(result=>['reference','physical'].map(scenario=>({beta:result.beta,scenario,...result[scenario].meanCosts,learnedVsFixedPercent:result[scenario].comparisons.scalar.learnedSavingsPercent,learnedVsDensePercent:result[scenario].comparisons.static.learnedSavingsPercent,learnedVsFeedbackPercent:result[scenario].comparisons.causal.learnedSavingsPercent}))));
