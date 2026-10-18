'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const Demo=require('./simulation.js');
const Calibration=require('./forecast-calibration.js');
const run=(sim,n)=>{for(let i=0;i<n;i++)sim.step();return sim.snapshot();};
const delta=(a,b)=>Math.max(0,...a.flat().map((v,i)=>Math.abs(v-b.flat()[i])));

test('network catalog is cached, explicit and rejects cross-network replay',()=>{
  assert.deepEqual(Demo.networks.map(n=>[n.id,n.N,n.M,n.remoteBudget]),[
    ['toy8',8,3,2],['feeder24',24,8,3],['feeder47',47,16,3]]);
  assert.equal(Demo.forNetwork('feeder24'),Demo);
  for(const network of Demo.networks){
    const api=Demo.forNetwork(network.id);assert.equal(api,Demo.forNetwork(network.id));
    const sim=new api.Simulation({horizon:1}),snap=sim.snapshot();
    assert.equal(snap.networkId,network.id);assert.equal(snap.initialOptions.networkId,network.id);
    assert.throws(()=>new api.Simulation({networkId:'different'}),/network/);
    assert.throws(()=>sim.queuePulse(network.N+1),/integer/);
    assert.equal(snap.referenceVoltage.length,network.N);
  }
  assert.throws(()=>Demo.forNetwork('unknown'),/Unknown network/);
});

for(const network of Demo.networks)test(network.id+' is a connected radial physical model with feasible nominal voltage and AC agreement',()=>{
  const {model,math,constants}=Demo.forNetwork(network.id),{N,M}=constants;
  assert.equal(model.edgeData.length,N-1);assert.equal(new Set(model.order).size,N);
  assert.equal(model.A.length,N-1);assert.equal(model.B.length,N-1);assert.equal(model.B[0].length,M);
  assert.equal(model.K.length,M);assert.equal(model.K[0].length,N-1);
  for(let bus=1;bus<N;bus++)assert.ok(model.parent[bus]>=0);
  assert.equal(model.referenceVoltage[0],1);assert.ok(Math.min(...model.referenceVoltage)>.95);
  assert.ok(model.dareResidual<2e-12);assert.ok(model.closedLoopNormInf<1);
  const power=math.physicalPower(Array(N).fill(0));
  const ac=math.radialAC(power.loadP,power.loadQ);
  assert.ok(ac.converged);assert.ok(delta([ac.voltage],[model.referenceVoltage])<.001);
  assert.equal(constants.forecastPresets.find(p=>p.id==='uniform').faultBuses.length,N-1);
  assert.deepEqual(constants.forecastedDemand.noisySources,constants.busProfiles.filter(p=>p.role==='Homes').map(p=>p.bus));
});

test('larger feeder repeats the original physical branches without stretching impedance or scheduled demand',()=>{
  const small=Demo.forNetwork('feeder24'),large=Demo.forNetwork('feeder47');
  for(let e=0;e<23;e++){
    assert.equal(large.model.edgeData[e+23].rOhm,small.model.edgeData[e].rOhm);
    assert.equal(large.model.edgeData[e+23].xOhm,small.model.edgeData[e].xOhm);
  }
  for(let bus=2;bus<=24;bus++){
    assert.equal(large.model.referenceVoltage[bus+22],small.model.referenceVoltage[bus-1]);
    for(const t of [0,13,37])assert.equal(large.math.scheduledPower(bus+23,t),small.math.scheduledPower(bus,t));
  }
  for(let i=0;i<23;i++)for(let j=23;j<46;j++)assert.equal(large.model.A[i][j],0);
});

test('calibration accepts explicitly declared sizes and preserves support and objective equations',()=>{
  for(const dimension of [7,46]){
    const samples=Array.from({length:dimension},(_,i)=>{
      const forecast=Array(dimension).fill(0);forecast[i]=.01;
      return{forecast:[0,...forecast],disturbance:[0,...forecast.map(v=>v*.4)]};
    });
    const fit=Calibration.fit(samples,{dimension,lambda:1e-7});
    assert.equal(fit.matrix.length,dimension);assert.ok(fit.matrixObjective<fit.rawObjective);
    assert.ok(fit.matrixRms<fit.rawRms);
    assert.deepEqual(Calibration.apply(Calibration.identity(dimension),samples[0].forecast,dimension),samples[0].forecast);
    assert.throws(()=>Calibration.fit(samples),/23 nonslack/);
  }
  assert.throws(()=>Calibration.fit([],{dimension:0}),/positive integer/);
});

for(const network of Demo.networks)test(network.id+' replays repeated attacks and deploys genuine constrained prediction gains',()=>{
  const api=Demo.forNetwork(network.id),options={experiment:'communication',powerScenario:'forecasted-demand',horizon:60,beta:4,seed:21};
  const sim=new api.Simulation(options),copy=new api.Simulation(sim.initialOptions);
  const advance=(count)=>{for(let t=0;t<count;t++)for(const s of [sim,copy]){
    if(t===10||t===11)s.queuePulse(network.N,100,'held-target-v1');
    if(t===24)s.toggleFault(2);const snapshot=s.step();
    if(t===11){
      const ac=api.math.radialAC(snapshot.loadP,snapshot.loadQ,snapshot.inverterQ.online);
      assert.ok(ac.converged);assert.ok(delta([ac.voltage],[snapshot.voltages.online])<.002);
    }
  }};
  advance(60);assert.deepEqual(sim.snapshot(),copy.snapshot());
  assert.ok(sim.deployTopology());assert.ok(copy.deployTopology());
  assert.equal(sim.snapshot().cumulative.online,0);assert.notEqual(sim.options.seed,options.seed);
  assert.ok(sim.deployedSupport.links.length<=network.M*network.remoteBudget);
  const design=sim.segments[0].designs.online,support=sim.deployedSupport.learned;
  let allowed=0,forbidden=0,different=0;
  for(const block of design.rows[12]){
    const dense=sim.segments[0].dense.rows[12].find(item=>item.k===block.k);
    for(let i=0;i<network.M;i++)for(let j=0;j<network.N-1;j++){
      if(support[i][j])allowed=Math.max(allowed,Math.abs(block.L[i][j]));
      else forbidden=Math.max(forbidden,Math.abs(block.L[i][j]));
      different=Math.max(different,Math.abs(block.L[i][j]-dense.L[i][j]));
    }
  }
  assert.ok(allowed>1e-7);assert.ok(forbidden<1e-11);assert.ok(different>1e-7);
  advance(60);assert.deepEqual(sim.snapshot(),copy.snapshot());
  const snap=sim.snapshot();
  for(const key of api.constants.controllers){
    assert.ok(Number.isFinite(snap.totalCost[key])&&snap.totalCost[key]>0);
    assert.ok(snap.commandQ[key].every(q=>Math.abs(q)<=70+1e-10));
    assert.equal(snap.voltages[key][0],1);
    const ac=api.math.radialAC(snap.loadP,snap.loadQ,snap.inverterQ[key]);
    assert.ok(ac.converged);assert.ok(delta([ac.voltage],[snap.voltages[key]])<.002);
  }
});

test('independent component synthesis equals the full larger-network quadratic with cross-component permissions',()=>{
  const api=Demo.forNetwork('feeder47'),{model,constants,math}=api;
  const support=Array.from({length:constants.M},(_,i)=>Array.from({length:constants.N-1},(_,j)=>
    j===constants.inverterBuses[i]-2||j%7===i%7));
  const separated=math.getDesign(6,support),full=new math.Response.Synthesizer(model,constants.preview).synthesize(6,support);
  for(let k=0;k<6;k++)for(const group of ['X','U','L'])for(const time of Object.keys(full.columns[k][group]))
    assert.ok(delta(separated.columns[k][group][time],full.columns[k][group][time])<1e-10,'full and separated '+group+' match');
});

test('default and explicit feeder24 replay the same physical comparison and independently recomputed costs',()=>{
  const options={horizon:180,beta:4,experiment:'communication',powerScenario:'forecasted-demand'};
  const sim=new Demo.Simulation(options),explicit=new (Demo.forNetwork('feeder24').Simulation)({...options,networkId:'feeder24'});
  for(let t=0;t<180;t++)assert.deepEqual(sim.step(),explicit.step());
  assert.ok(sim.deployTopology());assert.ok(explicit.deployTopology());
  assert.deepEqual(sim.snapshot(),explicit.snapshot());
  const sums=Object.fromEntries(Demo.constants.controllers.map(key=>[key,0]));
  for(let t=0;t<180;t++){
    const before=sim.snapshot(),snap=sim.step();assert.deepEqual(snap,explicit.step());
    for(const key of Demo.constants.controllers){
      const x=before.states[key].slice(1).map((v,i)=>v-Demo.model.baseDrop[i+1]);
      const u=Demo.constants.inverterBuses.map(bus=>snap.lastInputs[key][bus-1]);
      const quad=(v,weight)=>v.reduce((sum,value,i)=>sum+value*weight[i].reduce((s,w,j)=>s+w*v[j],0),0);
      const stage=quad(x,Demo.model.Q)+quad(u,Demo.model.R);sums[key]+=stage;
      const end=snap.states[key].slice(1).map((v,i)=>v-Demo.model.baseDrop[i+1]);
      const terminal=quad(end,Demo.model.P);
      assert.ok(Math.abs(snap.stage[key]-stage)<1e-12);
      assert.ok(Math.abs(snap.cumulative[key]-sums[key])<1e-12);
      assert.ok(Math.abs(snap.terminalCost[key]-terminal)<1e-12);
      assert.ok(Math.abs(snap.totalCost[key]-sums[key]-terminal)<1e-12);
    }
  }
});
