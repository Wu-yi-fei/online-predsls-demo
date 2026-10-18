'use strict';
// Read-only provenance check. The historical plot generator is archived.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
function check(){
  const root=path.resolve(__dirname,'..');
  const html=fs.readFileSync(path.join(__dirname,'reference-study.html'),'utf8');
  const report=JSON.parse(fs.readFileSync(path.join(root,'validation-report.json'),'utf8'));
  assert.match(html,/href="validation-report\.json"/);
  assert.doesNotMatch(html,/href="benchmark-|data-study-method|data-regime-method/);
  assert.equal(report.status,'passed');assert.deepEqual(report.failures,[]);
  for(const name of ['src/online-predsls.js','src/simulation.js','src/response-controller.js']){
    const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');
    assert.equal(report.sources[name],hash,'Re-run scripts/verify-offline.cjs after changing '+name);
  }
  return true;
}
if(require.main===module){check();console.log('Current offline validation provenance verified; no HTML rewritten.');}
module.exports={check};
