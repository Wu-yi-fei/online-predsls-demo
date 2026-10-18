/* Finite-horizon predictive SLS synthesis and the literal support-projected
 * delayed response update. This module has no plant or browser dependencies. */
(function(root,factory){
  const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;
  else root.ResponseController=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const zeros=(n,m=n)=>Array.from({length:n},()=>Array(m).fill(0));
  const dot=(a,b)=>a.reduce((v,x,i)=>v+x*b[i],0);
  const mv=(a,x)=>a.map(row=>dot(row,x));
  const transpose=a=>a[0].map((_,j)=>a.map(row=>row[j]));
  const mm=(a,b)=>a.map(row=>b[0].map((_,j)=>row.reduce((v,x,k)=>v+x*b[k][j],0)));
  const add=(a,b)=>a.map((row,i)=>row.map((v,j)=>v+b[i][j]));
  function cholesky(a){
    const l=zeros(a.length);
    for(let i=0;i<a.length;i++)for(let j=0;j<=i;j++){
      let value=a[i][j];for(let k=0;k<j;k++)value-=l[i][k]*l[j][k];
      if(i===j){if(!(value>0))throw new Error('Synthesis Hessian is not positive definite');l[i][j]=Math.sqrt(value);}
      else l[i][j]=value/l[j][j];
    }return l;
  }
  function solve(l,b){
    const y=Array(b.length).fill(0),x=y.slice();
    for(let i=0;i<b.length;i++){let v=b[i];for(let j=0;j<i;j++)v-=l[i][j]*y[j];y[i]=v/l[i][i];}
    for(let i=b.length-1;i>=0;i--){let v=y[i];for(let j=i+1;j<b.length;j++)v-=l[j][i]*x[j];x[i]=v/l[i][i];}
    return x;
  }
  function orthogonalize(v,basis){
    // Two passes prevent the nearly dependent terminal equations from creating
    // spurious allowed communication channels.
    const out=v.slice();for(let pass=0;pass<2;pass++)for(const q of basis){const c=dot(out,q);for(let i=0;i<out.length;i++)out[i]-=c*q[i];}
    return out;
  }
  function nullspace(rows,n){
    const rowBasis=[];
    for(const row of rows){const v=orthogonalize(row,rowBasis),norm=Math.sqrt(dot(v,v));if(norm>1e-10)rowBasis.push(v.map(x=>x/norm));}
    const basis=[];
    for(let i=0;i<n;i++){
      const e=Array(n).fill(0);e[i]=1;
      const v=orthogonalize(orthogonalize(e,rowBasis),basis),norm=Math.sqrt(dot(v,v));
      if(norm>1e-9)basis.push(v.map(x=>x/norm));
    }
    return basis;
  }
  class Synthesizer{
    constructor(model,depth=5){
      this.model=model;this.depth=depth;this.n=model.A.length;this.m=model.B[0].length;
      this.a=model.A[0][0];
      this.C=mm(model.K,model.B);for(let i=0;i<this.m;i++)this.C[i][i]+=this.a;
      this.F=add(model.A,mm(model.B,model.K));
      this.powers=[model.A.map((row,i)=>row.map((_,j)=>+(i===j)))];
      for(let i=1;i<=2*depth;i++)this.powers.push(mm(this.F,this.powers[i-1]));
      this.cache=new Map();this.columnCache=new Map();
    }
    pattern(T,k){
      const first=Math.max(0,k-this.depth),last=Math.min(T,k+this.depth-1);
      // Coordinates relative to column k make every interior factor reusable.
      return{first:first-k,last:last-k,terminal:T-k,controlLast:Math.min(T-1,k+this.depth-1)-k};
    }
    factor(pattern,allowed){
      const {first,last,terminal,controlLast}=pattern,m=this.m;
      const key=[first,last,terminal<=last?terminal:'interior',controlLast,allowed.join('')].join('|');
      if(this.cache.has(key))return this.cache.get(key);
      const times=Array.from({length:last-first},(_,i)=>first+i+1),dim=times.length*m;
      const pos=new Map(times.map((t,i)=>[t,i*m])),H=zeros(dim),linear=zeros(dim,this.n),constraints=[];
      const Bt=transpose(this.model.B);
      for(const time of times){
        const weight=time===terminal?this.model.P:this.model.Q;
        const gram=mm(Bt,mm(weight,this.model.B)),offset=pos.get(time);
        for(let i=0;i<m;i++)for(let j=0;j<m;j++)H[offset+i][offset+j]+=gram[i][j];
        if(time>=0){const cross=mm(Bt,mm(weight,this.powers[time]));for(let i=0;i<m;i++)for(let j=0;j<this.n;j++)linear[offset+i][j]+=cross[i][j];}
      }
      for(let time=first;time<=controlLast;time++){
        const mapping=zeros(m,dim),current=pos.get(time),next=pos.get(time+1);
        for(let i=0;i<m;i++){if(current!==undefined)mapping[i][current+i]-=this.a;if(next!==undefined)mapping[i][next+i]+=1;}
        const Rt=mm(transpose(mapping),this.model.R),gram=mm(Rt,mapping);
        for(let i=0;i<dim;i++)for(let j=0;j<dim;j++)H[i][j]+=gram[i][j];
        if(time>=0){const cross=mm(Rt,mm(this.model.K,this.powers[time]));for(let i=0;i<dim;i++)for(let j=0;j<this.n;j++)linear[i][j]+=cross[i][j];}
        for(let i=0;i<m;i++)if(!allowed[i]){
          const row=Array(dim).fill(0);if(next!==undefined)row[next+i]=1;
          if(current!==undefined)for(let j=0;j<m;j++)row[current+j]-=this.C[i][j];
          constraints.push(row);
        }
      }
      const basis=nullspace(constraints,dim),projection=basis.length?transpose(basis):zeros(dim,0);
      const chol=basis.length?cholesky(mm(basis,mm(H,projection))):[];
      const reducedLinear=basis.length?mm(basis,linear):[];
      const result={times,pos,dim,H,linear,basis,projection,chol,reducedLinear,constraints,pattern};
      this.cache.set(key,result);return result;
    }
    column(T,k,support){
      const p=this.pattern(T,k),X={},U={},L={},z={};
      const cacheKey=JSON.stringify([p.first,p.last,p.terminal<=p.last?p.terminal:null,p.controlLast,support]);
      if(this.columnCache.has(cacheKey)){
        const template=this.columnCache.get(cacheKey),shift=group=>Object.fromEntries(Object.entries(group).map(([time,value])=>[k+Number(time),value]));
        return{X:shift(template.X),U:shift(template.U),L:shift(template.L),k,pattern:p};
      }
      for(let time=p.first;time<=p.last;time++)z[time]=zeros(this.m,this.n);
      z[p.last+1]=zeros(this.m,this.n);
      for(let source=0;source<this.n;source++){
        const allowed=support?support.map(row=>row[source]):Array(this.m).fill(true);
        const f=this.factor(p,allowed);
        if(!f.basis.length)continue;
        const reduced=solve(f.chol,f.reducedLinear.map(row=>-row[source]));
        const solution=mv(f.projection,reduced);
        for(const time of f.times){const offset=f.pos.get(time);for(let i=0;i<this.m;i++)z[time][i][source]=solution[offset+i];}
      }
      for(let time=p.first;time<=p.last;time++)X[k+time]=mm(this.model.B,z[time]);
      for(let time=p.first;time<=p.controlLast;time++){
        const current=z[time],next=z[time+1];
        U[k+time]=next.map((row,i)=>row.map((v,j)=>v-this.a*current[i][j]));
        const correction=mm(this.C,current);
        L[k+time]=next.map((row,i)=>row.map((v,j)=>v-correction[i][j]));
      }
      const relative=group=>Object.fromEntries(Object.entries(group).map(([time,value])=>[Number(time)-k,value]));
      this.columnCache.set(cacheKey,{X:relative(X),U:relative(U),L:relative(L)});
      return{X,U,L,k,pattern:p};
    }
    synthesize(T,support=null){
      if(!Number.isInteger(T)||T<1)throw new Error('Synthesis horizon must be positive');
      const rows=Array.from({length:T+1},()=>[]),columns=[];
      for(let k=1;k<=T;k++){
        const column=this.column(T,k,support);columns.push(column);
        for(const key of Object.keys(column.X)){
          const t=Number(key);rows[t].push({k,X:column.X[t],U:column.U[t]||zeros(this.m,this.n),L:column.L[t]||zeros(this.m,this.n)});
        }
      }
      return{T,rows,columns,support:support?support.map(row=>row.slice()):null};
    }
  }
  function supportFromScores(scores,inverterBuses,remoteBudget=3,relativeTieTolerance=0){
    const support=scores.map(()=>Array(scores[0].length).fill(false)),links=[];
    scores.forEach((row,i)=>{
      const bus=inverterBuses[i];support[i][bus-2]=true;
      // Quantized rank keys give a transitive, deterministic source-index tie
      // break for numerically identical gains. Original score values are kept.
      const quantum=Math.max(...row)*relativeTieTolerance;
      const rank=value=>quantum>0?Math.round(value/quantum):value;
      const ranked=row.map((weight,j)=>({from:j+2,to:bus,weight})).filter(e=>e.from!==bus&&e.weight>1e-20)
        .sort((a,b)=>rank(b.weight)-rank(a.weight)||a.from-b.from).slice(0,remoteBudget);
      for(const edge of ranked){support[i][edge.from-2]=true;links.push(edge);}
    });return{support,links};
  }
  function scores(design){
    const m=design.rows[0][0].L.length,n=design.rows[0][0].L[0].length,out=zeros(m,n);
    for(const row of design.rows.slice(0,design.T))for(const block of row)for(let i=0;i<m;i++)for(let j=0;j<n;j++)out[i][j]+=block.L[i][j]**2;
    return out;
  }
  return{Synthesizer,supportFromScores,scores,math:{zeros,mv,mm,dot,transpose,nullspace}};
});
