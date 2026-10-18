#!/usr/bin/env node
'use strict';
/* Independent end-to-end audit. No test selects parameters or requires wins.
 * Reports retain all attempted cases and failures, with an immutable run copy.
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const args=process.argv.slice(2),option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const repo=path.resolve(option('--repo',path.join(__dirname,'..')));
const output=path.resolve(option('--output',path.join(repo,'validation-report.json')));
const unitOnly=args.includes('--unit-only'),fullOnly=args.includes('--integration-only');
const clone=x=>JSON.parse(JSON.stringify(x));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const zero=(n,m)=>Array.from({length:n},()=>Array(m).fill(0));
const mm=(a,b)=>a.map(row=>b[0].map((_,j)=>row.reduce((s,v,k)=>s+v*b[k][j],0)));
const mv=(a,v)=>a.map(row=>row.reduce((s,x,j)=>s+x*v[j],0));
const norm2=v=>v.reduce((s,x)=>s+x*x,0);
const qform=(v,Q)=>v.reduce((s,x,i)=>s+x*Q[i].reduce((r,y,j)=>r+y*v[j],0),0);
const maxAbs=x=>Array.isArray(x)?x.reduce((m,v)=>Math.max(m,maxAbs(v)),0):Math.abs(x);
const sub=(a,b)=>a.map((v,i)=>Array.isArray(v)?sub(v,b[i]):v-b[i]);
const checks={};
function check(name,predicate,detail=''){checks[name]=(checks[name]||0)+1;assert.ok(predicate,name+(detail?': '+detail:''));}
function near(name,a,b,atol=1e-11,rtol=1e-11){
  assert.deepEqual(shape(a),shape(b),name+' shape');
  const error=maxAbs(sub(a,b)),bound=atol+rtol*maxAbs(b);check(name,error<=bound,`max error ${error}, bound ${bound}`);return error;
}
function shape(a){return Array.isArray(a)?[a.length,...(a.length?shape(a[0]):[])]:[];}
function addEnergy(target,blocks){for(const b of blocks)for(let i=0;i<target.length;i++)for(let j=0;j<target[i].length;j++)target[i][j]+=b.L[i][j]**2;}
function expectedSupport(scores,buses,budget){return scores.map((row,i)=>{const local=buses[i]-2,mask=row.map(()=>false);mask[local]=true;
  row.map((value,j)=>({value,j})).filter(v=>v.j!==local).sort((a,b)=>b.value-a.value||a.j-b.j).slice(0,budget).forEach(v=>mask[v.j]=true);return mask;});}
const report={kind:'offline demo transplanted-algorithm verification',createdUtc:new Date().toISOString(),status:'running',
  scope:'Existing demo physical model, static K, synthesis objective, terminal cost and actuator limits retained. Not a reproduction of the original vendor trajectory.',
  protocol:{networks:['toy8','feeder24','feeder47'],beta:[0,1,4],seeds:[17,29],discoveryActions:40,deploymentActions:35,horizon:80,
    warmup:30,selection:'exact descending raw actual-L squared energy; source-index tie break; mandatory local input',
    performanceSelection:'All cases reported; correctness does not require online or sparse cost superiority.'},checks,units:[],cases:[],causality:[],failures:[]};
function attempt(kind,id,fn){try{const result=fn();report[kind].push({id,status:'passed',...result});}
  catch(error){const failure={id,status:'failed',error:error.message,stack:error.stack};report[kind].push(failure);report.failures.push({...failure,kind});}}
let Demo,Online;
try{
  Demo=require(path.join(repo,'src/simulation.js'));Online=require(path.join(repo,'src/online-predsls.js'));
  report.sources=Object.fromEntries(['src/online-predsls.js','src/simulation.js','src/response-controller.js'].map(p=>[p,sha(path.join(repo,p))]));
  if(!fullOnly){
    attempt('units','source-index exact ordering and mandatory local',()=>{
      const scores=[[9,2,2+1e-13,0,0],[1,2,7,3,3]],buses=[2,4],budget=2;
      const before=clone(scores),got=Online.selectSupport(scores,buses,budget),want=expectedSupport(scores,buses,budget);
      assert.deepEqual(got.support,want);assert.deepEqual(scores,before);
      check('remote_link_count',got.links.length===buses.length*budget);
      for(let i=0;i<buses.length;i++){check('mandatory_local',got.support[i][buses[i]-2]);check('per_receiver_budget',got.support[i].filter(Boolean).length===budget+1);}
      return{support:got.support};
    });
    attempt('units','scores are raw squared deployed L, not average or normalized',()=>{
      const row=[{k:2,L:[[2,3],[0,-1]]},{k:3,L:[[1,0],[-4,2]]}],scores=zero(2,2);
      Online.accumulateScores(scores,row);near('raw_score_first',scores,[[5,9],[16,5]],0,0);
      Online.accumulateScores(scores,row);near('raw_score_repeat',scores,[[10,18],[32,10]],0,0);
      return{scores};
    });
    attempt('units','invalid mean-ridge or unsupported mask inputs rejected',()=>{
      for(const lambda of [0,-1,NaN,Infinity])assert.throws(()=>Online.fit([],{dimension:3,lambda}));
      assert.throws(()=>Online.fit([],{dimension:3,support:[[true,false,true]]}));
      const prior=Online.fit([],{dimension:3});near('empty_identity',prior.matrix,[[1,0,0],[0,1,0],[0,0,1]],0,0);check('empty_scalar',prior.scalar===1);
      return{};
    });
  }
  function verifyAction(api,sim,before,after,t){
    const {model,constants}=api,segment=sim.segments.find(s=>t>=s.start&&t<s.end),rows=after.lastResponseRows;
    check('actual_rows_exposed',!!rows&&constants.controllers.every(key=>Array.isArray(rows[key])));
    check('action_time',after.lastSample.t===t);
    for(const key of constants.controllers){
      const x=before.states[key].slice(1).map((v,j)=>v-model.baseDrop[j+1]);let raw=mv(model.K,x);
      for(const block of rows[key]){
        const q=segment.start+block.k-1,forecast=sim.forecasts[q];
        check('forecast_index_available',!!forecast&&forecast.issuedAt<=t);
        check('response_window',block.k-1>=Math.max(0,t-segment.start-60)&&block.k-1<t-segment.start+5);
        const independentL=sub(block.U,mm(model.K,block.X));near('actual_L_is_U_minus_KX',block.L,independentL,1e-10,1e-11);
        const contribution=mv(block.L,forecast.forecast.slice(1));raw=raw.map((v,i)=>v+contribution[i]);
      }
      const command=raw.map(v=>Math.max(-model.qLimit,Math.min(model.qLimit,v)));
      const actual=constants.inverterBuses.map(bus=>after.lastInputs[key][bus-1]);near('executed_command_from_actual_L',actual,command,2e-12,1e-11);
      const stage=qform(x,model.Q)+qform(actual,model.R);near('executed_stage_cost',[after.stage[key]],[stage],2e-13,1e-11);
      const post=after.states[key].slice(1).map((v,j)=>v-model.baseDrop[j+1]);
      near('executed_terminal_cost',[after.terminalCost[key]],[qform(post,model.P)],2e-13,1e-11);
      check('finite_states_and_cost',after.states[key].every(Number.isFinite)&&actual.every(Number.isFinite)&&Number.isFinite(after.totalCost[key]));
    }
  }
  function verifyCalibration(api,sim,after,t,revealed,phase,experiment){
    const frozen=phase==='deployment'&&experiment==='communication';
    if(frozen||t<30){near('initial_or_frozen_matrix',after.calibration.matrix,Online.identity(api.constants.N-1),0,0);check('initial_or_frozen_scalar',after.calibration.scalar===1);check('initial_or_frozen_update_count',after.calibration.updates===0);}
    else{
      const expected=Online.fit(revealed,{dimension:api.constants.N-1,lambda:1.2725674932370515e-5,window:60,warmup:30});
      near('fit_uses_only_completed_pairs',after.calibration.matrix,expected.matrix,2e-12,1e-11);
      near('scalar_uses_same_completed_pairs',[after.calibration.scalar],[expected.scalar],1e-13,1e-11);
      check('trained_through_previous_action',after.calibration.trainedThrough===t-1);
      check('history_window_count',after.calibration.windowSize===Math.min(t,60));
      check('update_count',after.calibration.updates===t-29);
    }
  }
  function runCase(network,beta,seed,experiment){
    const api=Demo.forNetwork(network),{constants,model}=api;
    const options={experiment,beta,seed,horizon:80,powerScenario:'forecasted-demand'};
    const sim=new api.Simulation(options),scores=zero(constants.M,constants.N-1),baseScores=zero(constants.M,constants.N-1);
    let s=sim.snapshot(),last;const discoveryCost={};
    check('warmup_constant',constants.warmup===30);check('exact_regularization',model.calibrationRidge===1.2725674932370515e-5);
    for(let t=0;t<40;t++){
      const before=s,revealed=sim.samples.slice();s=sim.step();last=t;
      verifyAction(api,sim,before,s,t);verifyCalibration(api,sim,s,t,revealed,'discovery',experiment);
      if(t>=30){addEnergy(scores,s.lastResponseRows.online);addEnergy(baseScores,s.lastResponseRows.static);}
      if(experiment==='communication'){
        near('discovery_actual_L_raw_sum',sim.communicationScores,scores,1e-10,1e-11);
        near('discovery_static_L_raw_sum',sim.communicationOfflineScores,baseScores,1e-10,1e-11);
        check('score_count_once_per_action',sim.communicationScoreSamples===Math.max(0,t-29));
        if(t>=30)near('display_score_is_raw_sum',s.predictionDiagnostics.learnedScores,scores,1e-10,1e-11);
      }
    }
    Object.assign(discoveryCost,s.totalCost);
    const issued=clone(sim.forecasts),discoverySeed=s.seed,discoveryScores=clone(s.predictionDiagnostics);
    check('deployment_available',sim.deployTopology());s=sim.snapshot();
    check('fresh_deployment_time',s.t===0&&sim.samples.length===0&&s.calibration.updates===0);
    for(const key of constants.controllers)near('fresh_physical_state',s.states[key],model.baseDrop,0,0);
    check('fresh_deployment_seed',s.seed!==discoverySeed&&s.seed===((seed^0x9E3779B9)>>>0));
    check('fresh_forecasts',JSON.stringify(sim.forecasts)!==JSON.stringify(issued));
    const frozenSupport=JSON.stringify(s.deployedSupport),frozenDiagnostics=JSON.stringify(s.predictionDiagnostics),designs=sim.segments[0].designs;
    let maximumForbidden=0,minimumLocal=Infinity;
    if(experiment==='communication'){
      assert.deepEqual(s.deployedSupport.learned,expectedSupport(scores,constants.inverterBuses,constants.remoteBudget));
      assert.deepEqual(s.deployedSupport.fixed,expectedSupport(baseScores,constants.inverterBuses,constants.remoteBudget));
      for(const [key,name] of [['online','learned'],['scalar','fixed']]){
        const support=s.deployedSupport[name],energy=Array(constants.M).fill(0);
        for(let i=0;i<constants.M;i++){check('local_link_preserved',support[i][constants.inverterBuses[i]-2]);check('budget_fixed',support[i].filter(Boolean).length===constants.remoteBudget+1);}
        for(const row of designs[key].rows)for(const block of row)for(let i=0;i<constants.M;i++)for(let j=0;j<constants.N-1;j++){
          if(!support[i][j])maximumForbidden=Math.max(maximumForbidden,Math.abs(block.L[i][j]));
          if(j===constants.inverterBuses[i]-2)energy[i]+=block.L[i][j]**2;
        }
        minimumLocal=Math.min(minimumLocal,...energy);check('every_local_gain_nonzero',energy.every(v=>v>1e-20));
      }
      check('sparse_QP_actual_L_zeros',maximumForbidden<1e-10,`${maximumForbidden}`);
      check('discovery_score_frozen',s.predictionDiagnostics.frozen===true);
    }else{
      for(const key of ['online','scalar','static'])check('prediction_deployment_keeps_dense_design',designs[key]===sim.segments[0].dense);
    }
    const cumulative=Object.fromEntries(constants.controllers.map(key=>[key,0]));
    for(let t=0;t<35;t++){
      const before=s,revealed=sim.samples.slice();s=sim.step();
      verifyAction(api,sim,before,s,t);verifyCalibration(api,sim,s,t,revealed,'deployment',experiment);
      if(experiment==='communication'){
        check('support_frozen',JSON.stringify(s.deployedSupport)===frozenSupport);
        check('communication_diagnostics_frozen',JSON.stringify(s.predictionDiagnostics)===frozenDiagnostics);
        for(const key of ['online','scalar','static'])check('synthesized_design_frozen',sim.segments[0].designs[key]===designs[key]);
      }
      for(const key of constants.controllers){cumulative[key]+=s.stage[key];near('cumulative_is_executed_sum',[s.cumulative[key]],[cumulative[key]],1e-12,1e-11);
        near('total_includes_terminal',[s.totalCost[key]],[cumulative[key]+s.terminalCost[key]],1e-12,1e-11);}
    }
    return{network,beta,seed,experiment,discoveryActions:40,deploymentActions:35,deploymentSeed:s.seed,
      remoteBudget:constants.remoteBudget,discoveryTotalCost:discoveryCost,deploymentTotalCost:s.totalCost,
      onlineRelativeToStatic:s.totalCost.online/s.totalCost.static,
      maximumForbiddenGain:experiment==='communication'?maximumForbidden:null,minimumLocalGainEnergy:experiment==='communication'?minimumLocal:null,
      scoreSamples:10,predictionDeploymentDense:experiment==='prediction'};
  }
  if(!unitOnly){
    for(const network of report.protocol.networks)for(const beta of report.protocol.beta)for(const seed of report.protocol.seeds)for(const experiment of ['communication','prediction']){
      const id=[network,experiment,`beta${beta}`,`seed${seed}`].join('_');attempt('cases',id,()=>runCase(network,beta,seed,experiment));
      process.stderr.write(id+': '+report.cases.at(-1).status+'\n');
    }
    for(const network of report.protocol.networks)attempt('causality',network+'_unannounced_pulse',()=>{
      const api=Demo.forNetwork(network),options={experiment:'prediction',beta:1,seed:41,horizon:80};
      const clean=new api.Simulation(options),attack=new api.Simulation(options);
      for(let t=0;t<35;t++){clean.step();attack.step();}
      const sealed=clone(attack.forecasts);attack.queuePulse(api.constants.N,100);
      assert.deepEqual(attack.forecasts,sealed);
      const a=clean.step(),b=attack.step();assert.deepEqual(a.calibration,b.calibration);assert.deepEqual(a.lastInputs,b.lastInputs);
      check('unrevealed_disturbance_not_fitted',JSON.stringify(a.lastSample.disturbance)!==JSON.stringify(b.lastSample.disturbance));
      check('pulse_forecast_immutable',JSON.stringify(attack.forecasts.slice(0,sealed.length))===JSON.stringify(sealed));
      const c=clean.step(),d=attack.step();check('newly_completed_disturbance_used',maxAbs(sub(c.calibration.matrix,d.calibration.matrix))>1e-12);
      return{eventAt:35,newPairFirstUsedAt:36};
    });
  }
}catch(error){report.failures.push({id:'setup',error:error.message,stack:error.stack});}
if(report.sources)for(const [file,before] of Object.entries(report.sources)){const after=sha(path.join(repo,file));if(after!==before)report.failures.push({id:'source_changed_during_verification',file,before,after});}
report.status=report.failures.length?'failed':'passed';report.summary={unitCases:report.units.length,integrationCases:report.cases.length,
  causalityCases:report.causality.length,assertions:Object.values(checks).reduce((a,b)=>a+b,0),failures:report.failures.length};
fs.mkdirSync(path.dirname(output),{recursive:true});const text=JSON.stringify(report,null,2)+'\n';fs.writeFileSync(output,text);
const archive=path.join(path.dirname(output),'validation','runs');fs.mkdirSync(archive,{recursive:true});
fs.writeFileSync(path.join(archive,new Date().toISOString().replace(/[:.]/g,'-')+'-offline.json'),text);
console.log(JSON.stringify({status:report.status,...report.summary,report:output}));process.exitCode=report.failures.length?1:0;
