'use strict';
const assert=require('node:assert/strict');
const Core=require('./online-predsls.js');
const golden=require('../tests/fixtures/original-online-golden.json');
const {fit,deployedRow,accumulateScores,selectSupport}=Core;
let maximumError=0,checks=0;
function close(actual,expected,path='value',tolerance=2e-9){
  if(Array.isArray(expected)){
    assert.equal(actual.length,expected.length,path+' shape');
    expected.forEach((value,i)=>close(actual[i],value,path+'['+i+']',tolerance));return;
  }
  assert.ok(Number.isFinite(actual),path+' is finite');
  const error=Math.abs(actual-expected);maximumError=Math.max(maximumError,error);checks++;
  assert.ok(error<=tolerance*(1+Math.abs(expected)),path+': '+actual+' != '+expected);
}
function deepFreeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;}
const mv=(a,x)=>a.map(row=>row.reduce((s,v,j)=>s+v*x[j],0));
const add=(a,b)=>a.map((v,i)=>v+b[i]);
for(const test of golden.cases){
  const result=fit(deepFreeze(test.samples),{dimension:test.dimension,window:test.window,lambda:test.lambda,warmup:0});
  close(result.matrix,test.matrix,test.name+'.matrix');close(result.scalar,test.scalar,test.name+'.scalar');
  assert.equal(result.windowSize,Math.min(test.window,test.samples.length));assert.equal(result.active,true);
  for(const mode of ['raw','matrix','scalar']){
    close(result[mode+'Rms'],test.diagnostics[mode].rms,test.name+'.'+mode+'Rms');
    close(result[mode+'Objective'],test.diagnostics[mode].objective,test.name+'.'+mode+'Objective');
    if(mode!=='raw')close(result[mode+'Delta'],test.diagnostics[mode].delta,test.name+'.'+mode+'Delta');
  }
  const padded=test.samples.map(s=>({forecast:[0,...s.forecast],disturbance:[0,...s.disturbance]}));
  close(fit(padded,{dimension:test.dimension,window:test.window,lambda:test.lambda,warmup:0}).matrix,test.matrix,'slack padding');
}
assert.equal(Core.ALGORITHM_ID,'opredsls-window-ridge-v1');
assert.equal(Core.constants.lambda,1.2725674932370515e-5);
assert.equal(Core.constants.window,60);assert.equal(Core.constants.warmup,30);
const sample={forecast:[.3,.1],disturbance:[-.1,.2]};
const before=fit(Array(29).fill(sample),{dimension:2});
assert.equal(before.active,false);assert.deepEqual(before.matrix,[[1,0],[0,1]]);assert.equal(before.scalar,1);
assert.equal(fit(Array(30).fill(sample),{dimension:2}).active,true);
assert.equal(fit(Array(30).fill(sample),{dimension:2,window:7}).active,true);
assert.equal(fit([],{dimension:2}).rawRms,null);
assert.throws(()=>fit([sample],{dimension:2,support:[[true,false]]}),/no support-constrained/);
assert.throws(()=>fit([sample],{dimension:2,lambda:0}),/positive/);
assert.throws(()=>fit([sample],{dimension:2,window:0}),/Window/);
assert.throws(()=>fit([{forecast:[1,.3,.1],disturbance:[0,-.1,.2]}],{dimension:2}),/slack/);

const test=golden.deployed,fitCase=golden.cases.find(c=>c.name===test.case);
deepFreeze(test.blocks);deepFreeze(test.K);
for(const family of ['matrix','scalar']){
  const correction=family==='matrix'?fitCase.matrix:fitCase.scalar;
  const row=deployedRow(test.blocks,test.K,correction,test);
  assert.deepEqual(row.map(b=>b.k),[5,8,9,11,13]); // q in [t-history,t+preview)
  row.forEach((block,index)=>{
    for(const response of ['X','U','L'])close(block[response],test.expected[family][index][response],family+'.'+response);
  });
  const action=row.reduce((u,b)=>add(u,mv(b.L,test.forecast[b.k-1])),mv(test.K,test.x));
  close(action,test.actions[family],family+' action');
  // The equality is for this current row with static K, not general vendor K_e.
  let calibrationAction=mv(test.K,test.x);
  for(const block of test.blocks.filter(b=>row.some(r=>r.k===b.k))){
    const raw=test.forecast[block.k-1];
    const corrected=family==='matrix'?mv(correction,raw):raw.map(v=>v*correction);
    calibrationAction=add(calibrationAction,mv(block.L,corrected));
  }
  close(action,calibrationAction,family+' current-row equivalence');
  const scores=Array.from({length:2},()=>Array(3).fill(0));
  const expected=scores.map((r,i)=>r.map((_,j)=>row.reduce((sum,b)=>sum+b.L[i][j]**2,0)));
  assert.equal(accumulateScores(scores,row),scores);close(scores,expected,'raw score');
  accumulateScores(scores,row);close(scores,expected.map(r=>r.map(v=>2*v)),'score sum, not mean');
}
const identityRow=deployedRow(test.blocks,test.K,1,test);
assert.equal(identityRow[0].X,test.blocks[2].X); // no writes or dense identity product
const corrupted=test.blocks.map(b=>({...b,L:b.L.map(r=>r.map(()=>999))}));
close(deployedRow(corrupted,test.K,fitCase.matrix,test).map(b=>b.L),test.expected.matrix.map(b=>b.L),'L recomputed from paired CLMs');
const mask=selectSupport([[0,0,0,0],[7,3,3,3]],[3,5],2);
assert.deepEqual(mask.support,[[true,true,true,false],[true,true,false,true]]);
assert.deepEqual(mask.links.map(e=>[e.from,e.to]),[[2,3],[4,3],[2,5],[3,5]]);
assert.ok(mask.support.every(row=>row.filter(Boolean).length===3));
const localOnly=selectSupport([[0,0,0]],[3],0);
assert.deepEqual(localOnly.support,[[false,true,false]]);assert.deepEqual(localOnly.links,[]);
assert.throws(()=>selectSupport([[0,0]],[2],2),/budget/);
assert.throws(()=>selectSupport([[0,0]],[1],0),/receiver/);
assert.throws(()=>selectSupport([[0,-1]],[2],0),/nonnegative/);
// A selected mask constrains subsequent synthesis, not the ridge coefficients.
// A supported static-K template retains zero forbidden gains under cI.
const sparse={k:1,X:[[0,0,0],[0,0,0],[0,0,0]],U:[[0,2,0]],L:[[0,2,0]]};
const sparseRow=deployedRow([sparse],[[.2,.3,.4]],.8,{time:0});
close(sparseRow[0].L,[[0,1.6,0]],'forbidden static/scalar gain');
console.log(JSON.stringify({ok:true,checks,maximumAbsoluteError:maximumError,
  sourceSha256:golden.provenance.source_sha256,scope:golden.provenance.scope}));
