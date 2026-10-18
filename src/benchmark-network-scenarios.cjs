'use strict';
// Prespecified size check. Every setting and predefined seed is retained, including
// cases where dense prediction or feedback wins. No model parameters are fitted.
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const Demo=require('./simulation.js');
const seeds=[21,22,23,24,25],cases=[{id:'reliable',beta:0},{id:'mixed2',beta:2},{id:'mixed4',beta:4},{id:'allNoisy',beta:4,allNoisy:true}];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function run(networkId,seed,scenario){
  const api=Demo.forNetwork(networkId),{constants,model}=api;
  const sim=new api.Simulation({networkId,seed,beta:scenario.beta,experiment:'communication',powerScenario:'forecasted-demand',horizon:180,
    ...(scenario.allNoisy?{faultBuses:Array.from({length:constants.N-1},(_,i)=>i+2)}:{})});
  for(let t=0;t<180;t++)sim.step();assert.ok(sim.deployTopology());
  const supportHash=hash(sim.deployedSupport),minimumVoltage=Object.fromEntries(constants.controllers.map(k=>[k,1]));
  const maximumVoltage={...minimumVoltage};let maximumCommandKvar=0,commonForcingResidual=0;
  for(let t=0;t<180;t++){
    const s=sim.step();
    for(const key of constants.controllers){
      minimumVoltage[key]=Math.min(minimumVoltage[key],...s.voltages[key]);maximumVoltage[key]=Math.max(maximumVoltage[key],...s.voltages[key]);
      maximumCommandKvar=Math.max(maximumCommandKvar,...s.commandQ[key].map(Math.abs));
      commonForcingResidual=Math.max(commonForcingResidual,...s.lastSample.disturbances[key].map((v,i)=>Math.abs(v-s.lastSample.disturbances.online[i])));
    }
  }
  const s=sim.snapshot();assert.equal(hash(sim.deployedSupport),supportHash);assert.ok(commonForcingResidual<1e-12);assert.ok(maximumCommandKvar<=70+1e-10);
  const fixed=new Set(s.deployedSupport.fixedLinks.map(e=>e.from+','+e.to));
  return{seed,deploymentSeed:s.seed,costs:s.totalCost,stageCosts:s.cumulative,terminalCosts:s.terminalCost,
    links:{learned:s.deployedSupport.links.length,fixed:s.deployedSupport.fixedLinks.length,dense:constants.M*(constants.N-2),feedback:0},
    replacedLinks:s.deployedSupport.links.filter(e=>!fixed.has(e.from+','+e.to)).length,
    minimumVoltage,maximumVoltage,maximumCommandKvar,commonForcingResidual,
    realizationHash:hash(sim.forecasts.map(f=>({t:f.t,base:f.base}))),supportHash,
    acNominalMaxErrorPu:Math.max(...api.math.radialAC(model.baseP.map(v=>v*1000),model.baseQ.map(v=>v*1000)).voltage.map((v,i)=>Math.abs(v-model.referenceVoltage[i])))};
}
function main(){
  const results=[];
  for(const network of Demo.networks){
    const physicalHashes=new Map();
    for(const scenario of cases){
      const runs=seeds.map(seed=>run(network.id,seed,scenario));
      for(const row of runs){if(physicalHashes.has(row.seed))assert.equal(row.realizationHash,physicalHashes.get(row.seed));else physicalHashes.set(row.seed,row.realizationHash);}
      const means=Object.fromEntries(Demo.constants.controllers.map(key=>[key,runs.reduce((s,r)=>s+r.costs[key],0)/runs.length]));
      const comparisons=Object.fromEntries(['scalar','static','causal'].map(key=>[key,{learnedSavingsPercent:100*(means[key]-means.online)/means[key],
        wins:runs.filter(r=>r.costs.online<r.costs[key]-1e-12).length,ties:runs.filter(r=>Math.abs(r.costs.online-r.costs[key])<=1e-12).length,losses:runs.filter(r=>r.costs.online>r.costs[key]+1e-12).length}]));
      results.push({networkId:network.id,scenario:scenario.id,beta:scenario.beta,means,comparisons,runs});
      console.error(network.id+' '+scenario.id+' complete');
    }
  }
  const report={protocol:'network-size-check-v1',seeds,discoverySamples:180,comparisonSamples:180,
    networks:Demo.networks,cases,cost:'All stage costs plus the terminal Riccati penalty. Savings are ratios of paired mean costs.',
    construction:'Toy feeder is the first eight buses of the existing tree. Larger feeder repeats both original radial arms with a shared fixed slack. Roles, line impedances and scheduled phases are copied. Toy budget is two remote links per inverter, otherwise three.',
    limits:'Synthetic feeders, not standard utility test cases. Larger network is a repeated feeder, not arbitrary topology scaling. Four predefined reliability settings and five predefined seeds are reported in full. Similar qualitative mechanisms do not guarantee identical rankings.',results};
  if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));else console.table(results.map(r=>({network:r.networkId,scenario:r.scenario,...r.means,...Object.fromEntries(Object.entries(r.comparisons).map(([k,v])=>['savingsVs'+k,v.learnedSavingsPercent]))})));
  return report;
}
if(require.main===module)main();
module.exports={run,main,seeds,cases};
