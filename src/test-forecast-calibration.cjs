'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {fit,identity,apply,compatibleMask,constants}=require('./forecast-calibration.js');
const n=constants.dimension;
const zeros=()=>Array(n).fill(0);
const distance=(a,b)=>Math.hypot(...a.flat().map((value,i)=>value-b.flat()[i]));
function basisSamples(gains=Array(n).fill(1),copies=2){
  return Array.from({length:n*copies},(_,t)=>{
    const source=t%n,forecast=zeros(),disturbance=zeros();
    forecast[source]=.01;disturbance[source]=.01*gains[source];return{forecast,disturbance};
  });
}

test('identity correction retains physical coordinate units and an explicit zero slack',()=>{
  const vector=Array.from({length:n},(_,i)=>.001*(i-11));
  assert.deepEqual(apply(identity(),vector),vector);
  assert.deepEqual(apply(identity(),[0,...vector]),[0,...vector]);
  assert.throws(()=>apply(identity(),[1,...vector]),/slack/);
  assert.throws(()=>fit([{forecast:[0,1],disturbance:[0,1]}]),/23 nonslack/);
});

test('no observations keeps the offline prior and fitting exact forecasts keeps identity',()=>{
  const empty=fit([]);assert.deepEqual(empty.matrix,identity());
  assert.equal(empty.scalar,1);assert.equal(empty.windowSize,0);assert.equal(empty.rawRms,null);
  assert.equal(empty.lambda,constants.lambda);assert.equal(empty.effectiveSumRidge,constants.lambda);
  assert.equal(empty.rawObjective,0);assert.equal(empty.matrixObjective,0);assert.equal(empty.scalarObjective,0);
  const exact=fit(basisSamples());assert.ok(distance(exact.matrix,identity())<1e-14);
  assert.equal(exact.scalar,1);assert.ok(exact.matrixRms<1e-17);
});

test('matrix learns heterogeneous channel corruption without moving fixed data or choosing a favorable cost',()=>{
  const gains=Array.from({length:n},(_,i)=>i%2?.2:1.5),samples=basisSamples(gains),before=JSON.stringify(samples);
  // The synthetic basis has mean energy 0.01 squared divided by 23 per channel.
  // A declared small prior tests recovery rather than strong prior shrinkage.
  const lambda=1e-7,result=fit(samples,{lambda});
  assert.ok(result.matrixRms<result.rawRms*.1);
  assert.ok(result.matrixRms<result.scalarRms*.1);
  assert.ok(result.matrixObjective<result.scalarObjective);
  assert.ok(result.scalarObjective<result.rawObjective);
  for(let i=0;i<n;i++)assert.ok(Math.abs(result.matrix[i][i]-gains[i])<.05);
  assert.equal(JSON.stringify(samples),before);
  assert.deepEqual(fit(samples,{lambda}),result);
});

test('scalar and matrix agree on isotropic calibration under the same Frobenius ridge objective',()=>{
  const gain=.3,copies=2,samples=basisSamples(Array(n).fill(gain),copies);
  const result=fit(samples),energy=copies*.01**2;
  const ridge=constants.lambda*samples.length,expected=(gain*energy+ridge)/(energy+ridge);
  assert.equal(result.lambda,constants.lambda);assert.equal(result.effectiveSumRidge,ridge);
  assert.ok(Math.abs(result.scalar-expected)<1e-14);
  assert.ok(distance(result.matrix,identity().map(row=>row.map(value=>expected*value)))<1e-13);
  assert.ok(Math.abs(result.matrixObjective-result.scalarObjective)<1e-18);
});

test('both fits use only the last sixty supplied revealed observations',()=>{
  const old=basisSamples(Array(n).fill(20),2),recent=Array.from({length:60},(_,i)=>basisSamples(Array(n).fill(.4))[i%46]);
  const all=old.concat(recent),recentFit=fit(recent);
  assert.equal(fit(all).windowSize,60);assert.deepEqual(fit(all),recentFit);
  all[0].forecast.fill(500);all[0].disturbance.fill(-900);
  assert.deepEqual(fit(all),recentFit);
});

test('caller supplied past prefix excludes future disturbances from the action correction',()=>{
  const samples=basisSamples(Array(n).fill(.6),3),time=35;
  const before=fit(samples.slice(0,time));
  for(let i=time;i<samples.length;i++){samples[i].disturbance.fill(10);samples[i].forecast.fill(-10);}
  assert.deepEqual(fit(samples.slice(0,time)),before);
  assert.notDeepEqual(fit(samples),before,'the caller must explicitly exclude unrevealed samples');
});

test('support compatibility follows receiver inclusion rather than merely masking covariance entries',()=>{
  const support=[zeros().map((_,j)=>j===0||j===1),zeros().map((_,j)=>j===1||j===2)];
  const mask=compatibleMask(support);
  assert.equal(mask[0][1],true);assert.equal(mask[1][0],false);
  assert.equal(mask[2][1],true);assert.equal(mask[1][2],false);
  for(let a=0;a<n;a++)for(let b=0;b<n;b++)assert.equal(mask[a][b],support.every(row=>!row[a]||row[b]));
  assert.ok(compatibleMask().flat().every(Boolean));
});

test('a fitted support compatible matrix changes allowed actions while forbidden raw sources have zero effect',()=>{
  const support=[zeros().map((_,j)=>j===0||j===1),zeros().map((_,j)=>j===1||j===2)];
  const samples=basisSamples(Array(n).fill(.25));
  // Off diagonal calibration is needed to reconstruct source zero from source one.
  for(const sample of samples)sample.disturbance[0]+=.5*sample.forecast[1];
  const result=fit(samples,{support,lambda:1e-7}),mask=compatibleMask(support);
  assert.ok(result.matrix[0][1]>.4);
  for(let a=0;a<n;a++)for(let b=0;b<n;b++)if(!mask[a][b])assert.equal(result.matrix[a][b],0);
  const gains=support.map((row,i)=>row.map((allowed,j)=>allowed?(i+1)*(j+1):0));
  let changed=false;
  for(let source=0;source<n;source++){
    const forecast=zeros();forecast[source]=.001;
    const corrected=apply(result.matrix,forecast);
    for(let receiver=0;receiver<support.length;receiver++){
      const before=gains[receiver].reduce((sum,value,j)=>sum+value*forecast[j],0);
      const after=gains[receiver].reduce((sum,value,j)=>sum+value*corrected[j],0);
      if(!support[receiver][source])assert.equal(after,0);
      else changed ||= Math.abs(after-before)>1e-6;
    }
  }
  assert.equal(changed,true);
});

test('padded and nonslack samples fit identically and invalid numerical inputs fail explicitly',()=>{
  const samples=basisSamples(Array(n).fill(.8));
  assert.deepEqual(fit(samples),fit(samples.map(sample=>({forecast:[0,...sample.forecast],disturbance:[0,...sample.disturbance]}))));
  assert.throws(()=>fit(samples,{lambda:0}),/positive/);
  assert.throws(()=>fit(samples,{lambda:Infinity}),/positive/);
  assert.throws(()=>fit(samples,{support:[[true]]}),/23 source/);
  const invalid=basisSamples();invalid[0].forecast[2]=NaN;
  assert.throws(()=>fit(invalid),/finite/);
});


test('diagnostics and normal equations use mean residual loss with the declared Frobenius prior',()=>{
  const samples=Array.from({length:31},(_,t)=>{
    const forecast=Array.from({length:n},(_,j)=>.003*Math.sin((t+1)*(j+1)*.17));
    const disturbance=forecast.map((v,j)=>(j%2?.4:1.3)*v+.25*forecast[(j+1)%n]);
    return{forecast,disturbance};
  });
  const lambda=2e-7,result=fit(samples,{lambda}),m=samples.length;
  let rawSquared=0,matrixSquared=0,scalarSquared=0,scalarGradient=lambda*n*(result.scalar-1);
  const gradient=result.matrix.map((row,a)=>row.map((v,b)=>lambda*(v-+(a===b))));
  for(const {forecast,disturbance} of samples){
    const corrected=apply(result.matrix,forecast);
    for(let a=0;a<n;a++){
      const residual=corrected[a]-disturbance[a],scalarResidual=result.scalar*forecast[a]-disturbance[a];
      rawSquared+=(forecast[a]-disturbance[a])**2;matrixSquared+=residual**2;scalarSquared+=scalarResidual**2;
      scalarGradient+=scalarResidual*forecast[a]/m;
      for(let b=0;b<n;b++)gradient[a][b]+=residual*forecast[b]/m;
    }
  }
  const deltaSquared=result.matrix.reduce((sum,row,a)=>sum+row.reduce((total,v,b)=>total+(v-+(a===b))**2,0),0);
  assert.ok(Math.abs(result.rawObjective-.5*rawSquared/m)<1e-18);
  assert.ok(Math.abs(result.matrixObjective-.5*(matrixSquared/m+lambda*deltaSquared))<1e-18);
  assert.ok(Math.abs(result.scalarObjective-.5*(scalarSquared/m+lambda*n*(result.scalar-1)**2))<1e-18);
  assert.ok(Math.max(...gradient.flat().map(Math.abs))<1e-18);assert.ok(Math.abs(scalarGradient)<1e-18);
});

test('positive ridge keeps covariance positive definite for rank deficient and zero forecasts',()=>{
  const lambda=2e-7,samples=Array.from({length:17},(_,t)=>({
    forecast:Array.from({length:n},(_,j)=>.001*(t+1)*(j%3-1)),
    disturbance:Array.from({length:n},(_,j)=>.0003*(t+1)*(j%3-1))
  }));
  const covariance=identity().map(row=>row.map(v=>lambda*v));
  for(const {forecast} of samples)for(let a=0;a<n;a++)for(let b=0;b<n;b++)covariance[a][b]+=forecast[a]*forecast[b]/samples.length;
  const cholesky=identity().map(row=>row.map(()=>0));
  for(let i=0;i<n;i++)for(let j=0;j<=i;j++){
    let pivot=covariance[i][j];for(let k=0;k<j;k++)pivot-=cholesky[i][k]*cholesky[j][k];
    if(i===j){assert.ok(pivot>0);cholesky[i][j]=Math.sqrt(pivot);}else cholesky[i][j]=pivot/cholesky[j][j];
  }
  const result=fit(samples,{lambda});assert.ok(result.matrix.flat().every(Number.isFinite));assert.ok(Number.isFinite(result.scalar));
  const zero=fit(Array.from({length:17},()=>({forecast:zeros(),disturbance:zeros()})),{lambda});
  assert.ok(distance(zero.matrix,identity())<1e-14);assert.equal(zero.scalar,1);
});

test('rescaling physical coordinates and ridge together preserves both corrections',()=>{
  const samples=basisSamples(Array.from({length:n},(_,j)=>j%2?.4:1.3),1),lambda=2e-7;
  for(const sample of samples)sample.disturbance[0]+=.3*sample.forecast[1];
  const support=[zeros().map((_,j)=>j<4),zeros().map((_,j)=>j>=4&&j<8)];
  for(const mask of [null,support]){
    const reference=fit(samples,{lambda,support:mask});
    for(const scale of [.001,.1,10,1000]){
      const scaled=samples.map(({forecast,disturbance})=>({forecast:forecast.map(v=>v*scale),disturbance:disturbance.map(v=>v*scale)}));
      const actual=fit(scaled,{lambda:lambda*scale**2,support:mask});
      assert.ok(distance(actual.matrix,reference.matrix)<1e-12);assert.ok(Math.abs(actual.scalar-reference.scalar)<1e-13);
      for(const key of ['rawObjective','matrixObjective','scalarObjective'])assert.ok(Math.abs(actual[key]/scale**2-reference[key])<1e-16);
    }
  }
});

test('duplicating observations within the window leaves the mean loss optimizer unchanged',()=>{
  const samples=basisSamples(Array.from({length:n},(_,j)=>j%3?.6:1.4),1),lambda=2e-7;
  const single=fit(samples,{lambda}),double=fit(samples.concat(samples),{lambda});
  assert.equal(single.windowSize,23);assert.equal(double.windowSize,46);
  assert.equal(double.effectiveSumRidge,2*single.effectiveSumRidge);assert.equal(double.lambda,single.lambda);
  assert.ok(distance(single.matrix,double.matrix)<1e-13);assert.ok(Math.abs(single.scalar-double.scalar)<1e-13);
  for(const key of ['rawObjective','matrixObjective','scalarObjective','rawRms','matrixRms','scalarRms'])assert.ok(Math.abs(single[key]-double[key])<1e-16);
});
