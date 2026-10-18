'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const test=require('node:test');
const ROOT=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(__dirname,'reference-study.html'),'utf8');
const report=JSON.parse(fs.readFileSync(path.join(ROOT,'validation-report.json'),'utf8'));
const methods=['online','scalar','static','causal'];
function verifyReport(value){
  assert.equal(value.status,'passed');assert.deepEqual(value.failures,[]);
  assert.equal(value.summary.failures,0);assert.ok(value.summary.assertions>0);
  for(const filename of ['src/online-predsls.js','src/simulation.js','src/response-controller.js']){
    const actual=createHash('sha256').update(fs.readFileSync(path.join(ROOT,filename))).digest('hex');
    assert.equal(value.sources[filename],actual,'Current source fingerprint: '+filename);
  }
  const expected=new Set(value.protocol.networks.flatMap(network=>value.protocol.beta.flatMap(beta=>value.protocol.seeds.flatMap(seed=>
    ['communication','prediction'].map(experiment=>[network,beta,seed,experiment].join('/'))))));
  const actual=value.cases.map(row=>[row.network,row.beta,row.seed,row.experiment].join('/'));
  assert.deepEqual(new Set(actual),expected);assert.equal(actual.length,expected.size);
  assert.equal(value.summary.integrationCases,actual.length);
  for(const row of [...value.units,...value.cases,...value.causality])assert.equal(row.status,'passed');
  for(const row of value.cases)for(const phase of ['discoveryTotalCost','deploymentTotalCost'])for(const method of methods)
    assert.ok(Number.isFinite(row[phase][method])&&row[phase][method]>=0,'Every reported executed cost is finite and nonnegative');
  for(const check of ['actual_L_is_U_minus_KX','executed_command_from_actual_L','discovery_actual_L_raw_sum','fit_uses_only_completed_pairs','prediction_deployment_keeps_dense_design'])
    assert.ok(value.checks[check]>0,'Required transplanted-controller check: '+check);
}

test('current result panel separates validation from the old benchmark and preserves stage versus terminal cost meaning',()=>{
  assert.match(html,/<details id="pr-reference-study" class="[^"]+">/);
  assert.ok(!html.includes(' open'));
  assert.match(html,/href="validation-report\.json"/);
  assert.match(html,/upstream benchmark tables describe a different implementation/i);
  assert.match(html,/not displayed as evidence/);
  assert.match(html,/Plots: accumulated stage cost/);
  assert.match(html,/Validation: terminal cost reported separately/);
  assert.deepEqual(Array.from(html.matchAll(/href="([^"]+)"/g),m=>m[1]),['environment.html','validation-report.json','README.md']);
  assert.doesNotMatch(html,/data-study-method|data-ablation-method|data-regime-method|data-beta=/);
  assert.doesNotMatch(html,/href="benchmark-[^"]+"|lowest mean|percent less|cheapest at/i);
});

test('the linked local report validates the current numerical sources and retains every declared trial',()=>{
  verifyReport(report);
});

test('stale source fingerprints and missing experimental cells cannot pass as current validation',()=>{
  const changed=JSON.parse(JSON.stringify(report));changed.sources['src/online-predsls.js']='0'.repeat(64);
  assert.throws(()=>verifyReport(changed),/Current source fingerprint/);
  const missing=JSON.parse(JSON.stringify(report));missing.cases.pop();assert.throws(()=>verifyReport(missing));
  const invalid=JSON.parse(JSON.stringify(report));invalid.cases[0].deploymentTotalCost.online=NaN;
  assert.throws(()=>verifyReport(invalid),/finite and nonnegative/);
});
