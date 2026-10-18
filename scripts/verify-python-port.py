#!/usr/bin/env python3
"""Cross-language parity with the verbatim original Python ridge function.

Requires Python+NumPy and Node.  This validates the transplanted update and
X/U/L algebra, not equality with the original vendor's physical trajectories.
Every run retains a timestamped report, including failures.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import traceback
import numpy as np

DEFAULT_LAMBDA=1.2725674932370515e-5

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    home=Path(__file__).resolve().parents[1]
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',type=Path,default=home)
    parser.add_argument('--node',default=shutil.which('node'))
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    output=args.output or args.repo/'validation/python-port.json'
    output.parent.mkdir(parents=True,exist_ok=True)
    report={'kind':'original Python / JavaScript algorithm parity','created_utc':datetime.now(timezone.utc).isoformat(),
            'scope':'Mean ridge update and deployed predictive X/U/L; not a vendor trajectory reproduction.',
            'checks':[],'failures':[]}
    try:
        if not args.node:raise RuntimeError('Node executable not found; pass --node PATH')
        reference=home/'validation/reference_correction_matrix.py'
        manifest=json.loads((home/'validation/reference_manifest.json').read_text())
        if sha(reference)!=manifest['reference_sha256']:raise AssertionError('verbatim Python reference hash mismatch')
        report['reference']=manifest
        report['javascript_sha256']=sha(args.repo/'src/online-predsls.js')
        spec=importlib.util.spec_from_file_location('original_correction_reference',reference)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        rng=np.random.default_rng(20261018)
        fixtures=[];expected=[]
        # Includes underdetermined, repeated/zero columns, long and short history,
        # 46-state larger feeder, and the exact lambda used by the manuscript code.
        for n in [1,3,7,23,46]:
            for rank in ['full','rank_one','zero']:
                for count,window,lam in [(1,60,DEFAULT_LAMBDA),(7,7,1e-8),(60,60,.003),(83,60,.1)]:
                    h=.02*rng.normal(size=(count,n))
                    if rank=='rank_one':h=np.outer(.02*rng.normal(size=count),rng.normal(size=n))
                    if rank=='zero':h[:]=0
                    y=.8*h+.009*rng.normal(size=(count,n))
                    selected_h,selected_y=h[-window:],y[-window:]
                    matrix=module.correction_matrix(selected_y,selected_h,lam,'online_sls')
                    scalar=float(module.correction_matrix(selected_y,selected_h,lam,'scalar')[0,0])
                    fixtures.append({'id':f'n{n}_{rank}_count{count}_h{window}_lambda{lam:g}',
                        'samples':[{'forecast':a.tolist(),'disturbance':b.tolist()} for a,b in zip(h,y)],
                        'options':{'dimension':n,'window':window,'lambda':lam,'warmup':0}})
                    expected.append({'matrix':matrix,'scalar':scalar,'windowSize':len(selected_h)})
        # Explicit no-data and initialization cases, including slack-padded input.
        for count in [0,1,29,30,35]:
            n=7;h=.02*rng.normal(size=(count,n));y=.6*h+.005*rng.normal(size=(count,n))
            active=count>=30
            matrix=module.correction_matrix(y[-12:],h[-12:],DEFAULT_LAMBDA) if active else np.eye(n)
            scalar=float(module.correction_matrix(y[-12:],h[-12:],DEFAULT_LAMBDA,'scalar')[0,0]) if active else 1.
            fixtures.append({'id':f'warmup30_slack_count{count}',
                'samples':[{'forecast':[0,*a.tolist()],'disturbance':[0,*b.tolist()]} for a,b in zip(h,y)],
                'options':{'dimension':n,'window':12,'lambda':DEFAULT_LAMBDA,'warmup':30}})
            expected.append({'matrix':matrix,'scalar':scalar,'active':active})
        row_cases=[];row_expected=[]
        for n,m in [(1,1),(3,2),(7,3),(23,8),(46,16)]:
            C=rng.normal(scale=.2,size=(n,n))+np.eye(n);K=rng.normal(scale=.1,size=(m,n))
            blocks=[{'k':k,'X':rng.normal(scale=.2,size=(n,n)).tolist(),'U':rng.normal(scale=.2,size=(m,n)).tolist()}
                    for k in [0,1,3,8,13,15,20]]
            for family in ['matrix','scalar']:
                correction=C if family=='matrix' else .37*np.eye(n)
                target=[]
                for b in blocks:
                    if not max(0,8-3)<=b['k']-1<8+5:continue
                    X=np.asarray(b['X'])@correction;U=np.asarray(b['U'])@correction
                    target.append({'k':b['k'],'X':X,'U':U,'L':U-K@X})
                row_cases.append({'id':f'rows_n{n}_m{m}_{family}','blocks':blocks,'K':K.tolist(),
                    'correction':C.tolist() if family=='matrix' else .37,
                    'options':{'time':8,'historyWindow':3,'predictionWindow':5}})
                row_expected.append(target)
        payload={'fits':fixtures,'rows':row_cases}
        js="""
const fs=require('fs'),path=require('path');
const p=JSON.parse(fs.readFileSync(0,'utf8')),A=require(path.resolve(process.argv[1],'src/online-predsls.js'));
const fits=p.fits.map(f=>{try{return{ok:true,result:A.fit(f.samples,f.options)}}catch(e){return{ok:false,error:e.stack}}});
const rows=p.rows.map(f=>{try{const before=JSON.stringify([f.blocks,f.K,f.correction]);const result=A.deployedRow(f.blocks,f.K,f.correction,f.options);return{ok:true,result,inputsUnchanged:before===JSON.stringify([f.blocks,f.K,f.correction])}}catch(e){return{ok:false,error:e.stack}}});
process.stdout.write(JSON.stringify({fits,rows}));
"""
        completed=subprocess.run([args.node,'-e',js,str(args.repo)],input=json.dumps(payload),text=True,capture_output=True,check=False)
        if completed.returncode:raise RuntimeError(completed.stderr or completed.stdout)
        actual=json.loads(completed.stdout)
        maximum_matrix=maximum_scalar=maximum_clm=0.
        for fixture,expect,got in zip(fixtures,expected,actual['fits']):
            check={'id':fixture['id']}
            try:
                if not got['ok']:raise AssertionError(got['error'])
                fit=got['result'];matrix=np.asarray(fit['matrix'])
                if matrix.shape!=expect['matrix'].shape:raise AssertionError('matrix shape changed')
                em=float(np.max(np.abs(matrix-expect['matrix'])));es=abs(float(fit['scalar'])-expect['scalar'])
                maximum_matrix=max(maximum_matrix,em);maximum_scalar=max(maximum_scalar,es)
                np.testing.assert_allclose(matrix,expect['matrix'],atol=2e-8,rtol=2e-8)
                np.testing.assert_allclose(fit['scalar'],expect['scalar'],atol=2e-13,rtol=2e-13)
                if 'active' in expect:assert fit['active']==expect['active']
                if 'windowSize' in expect:assert fit['windowSize']==expect['windowSize']
                check.update(status='passed',matrix_max_abs=em,scalar_abs=es)
            except Exception as error:
                check.update(status='failed',error=str(error));report['failures'].append(check.copy())
            report['checks'].append(check)
        for fixture,expect,got in zip(row_cases,row_expected,actual['rows']):
            check={'id':fixture['id']}
            try:
                if not got['ok']:raise AssertionError(got['error'])
                assert got['inputsUnchanged'];assert len(got['result'])==len(expect)
                error=0.
                for want,found in zip(expect,got['result']):
                    assert want['k']==found['k']
                    for field in ['X','U','L']:
                        error=max(error,float(np.max(np.abs(np.asarray(found[field])-want[field]))))
                        np.testing.assert_allclose(found[field],want[field],atol=2e-12,rtol=2e-12)
                maximum_clm=max(maximum_clm,error);check.update(status='passed',clm_max_abs=error)
            except Exception as error:
                check.update(status='failed',error=str(error));report['failures'].append(check.copy())
            report['checks'].append(check)
        report.update(fit_cases=len(fixtures),clm_cases=len(row_cases),
                      maximum_errors={'matrix':maximum_matrix,'scalar':maximum_scalar,'CLM':maximum_clm},
                      python=sys.version.split()[0],numpy=np.__version__,node=subprocess.check_output([args.node,'--version'],text=True).strip())
    except Exception as error:
        report['failures'].append({'id':'setup_or_execution','error':str(error),'traceback':traceback.format_exc()})
    report['status']='passed' if not report['failures'] else 'failed'
    text=json.dumps(report,indent=2,allow_nan=False)+'\n';output.write_text(text)
    archive=output.parent/'runs';archive.mkdir(exist_ok=True)
    (archive/(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'-python-port.json')).write_text(text)
    print(json.dumps({'status':report['status'],'checks':len(report['checks']),'failures':len(report['failures']),'report':str(output),**({'maximum_errors':report['maximum_errors']} if 'maximum_errors' in report else {})}))
    return 0 if report['status']=='passed' else 1

if __name__=='__main__':raise SystemExit(main())
