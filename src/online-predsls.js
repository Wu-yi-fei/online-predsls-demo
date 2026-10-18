/* Finite-window ridge adaptation of predictive closed-loop response rows.
 *
 * Ports correction_matrix in online_sls/original_online.py. Samples must have
 * been revealed before the current action; timing belongs to the caller. One
 * C_t is shared by the predictive blocks deployed at time t. No online affine
 * projection, clipping, or communication-dependent calibration rule is added.
 * deployedRow uses this demo's static K, not the vendor's general history K_e.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.OnlinePredSLS=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const ALGORITHM_ID='opredsls-window-ridge-v1';
  const DIMENSION=23,WINDOW=60,WARMUP=30,LAMBDA=1.2725674932370515e-5;
  const identity=(n=DIMENSION)=>Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>+(i===j)));
  const squared=values=>values.reduce((sum,value)=>sum+value*value,0);
  function integer(value,name,minimum=1){
    if(!Number.isInteger(value)||value<minimum)throw new RangeError(name+' must be an integer >= '+minimum);
  }
  function matrixShape(matrix,name,rows=null,cols=null){
    if(!Array.isArray(matrix)||!matrix.length||!Array.isArray(matrix[0])||!matrix[0].length)
      throw new TypeError(name+' must be a nonempty matrix');
    const width=matrix[0].length;
    if(matrix.some(row=>!Array.isArray(row)||row.length!==width||row.some(value=>!Number.isFinite(value)))||
      (rows!==null&&matrix.length!==rows)||(cols!==null&&width!==cols))
      throw new TypeError(name+' has invalid dimensions or nonfinite coefficients');
    return [matrix.length,width];
  }
  function coordinates(values,dimension){
    if(!Array.isArray(values)||![dimension,dimension+1].includes(values.length)||values.some(v=>!Number.isFinite(v)))
      throw new TypeError('Expected '+dimension+' finite nonslack coordinates, optionally padded with zero slack');
    if(values.length===dimension+1&&values[0]!==0)throw new RangeError('The padded slack coordinate must be zero');
    return values.length===dimension+1?values.slice(1):values.slice();
  }
  const multiply=(a,b)=>a.map(row=>b[0].map((_,j)=>row.reduce((sum,value,k)=>sum+value*b[k][j],0)));
  function cholesky(matrix){
    const n=matrix.length,lower=Array.from({length:n},()=>Array(n).fill(0));
    for(let i=0;i<n;i++)for(let j=0;j<=i;j++){
      let value=matrix[i][j];for(let k=0;k<j;k++)value-=lower[i][k]*lower[j][k];
      if(i===j){
        if(!(value>0))throw new Error('Ridge covariance is not numerically positive definite');
        lower[i][j]=Math.sqrt(value);
      }else lower[i][j]=value/lower[j][j];
    }
    return lower;
  }
  function solve(lower,rhs){
    const n=rhs.length,y=Array(n).fill(0),x=Array(n).fill(0);
    for(let i=0;i<n;i++){
      let value=rhs[i];for(let j=0;j<i;j++)value-=lower[i][j]*y[j];y[i]=value/lower[i][i];
    }
    for(let i=n-1;i>=0;i--){
      let value=y[i];for(let j=i+1;j<n;j++)value-=lower[j][i]*x[j];x[i]=value/lower[i][i];
    }
    return x;
  }
  function apply(matrix,vector,dimension=matrix.length){
    integer(dimension,'Dimension');matrixShape(matrix,'Correction',dimension,dimension);
    const input=coordinates(vector,dimension),output=matrix.map(row=>row.reduce((sum,value,j)=>sum+value*input[j],0));
    return vector.length===dimension+1?[0,...output]:output;
  }
  function fit(samples,options={}){
    const {lambda=LAMBDA,dimension=DIMENSION,window=WINDOW,warmup=WARMUP}=options;
    integer(dimension,'Dimension');integer(window,'Window');integer(warmup,'Warmup',0);
    if(options.support!==undefined&&options.support!==null)
      throw new TypeError('The original ridge update has no support-constrained calibration rule');
    if(!Array.isArray(samples))throw new TypeError('Revealed samples must be an array');
    if(!Number.isFinite(lambda)||lambda<=0)throw new RangeError('Ridge parameter must be finite and positive');
    const observed=samples.slice(-window).map(sample=>({
      forecast:coordinates(sample.forecast,dimension),disturbance:coordinates(sample.disturbance,dimension)
    }));
    const count=observed.length,effectiveSumRidge=lambda*Math.max(1,count);
    // Warmup counts supplied observations before window truncation. A caller
    // retaining a shorter buffer must gate by action time and pass warmup:0.
    const active=count>0&&samples.length>=warmup;
    let matrix=identity(dimension),scalar=1;
    if(active){
      // Mean-loss normal equations multiplied by the observation count.
      const covariance=identity(dimension).map(row=>row.map(value=>effectiveSumRidge*value));
      const cross=identity(dimension).map(row=>row.map(value=>effectiveSumRidge*value));
      let numerator=dimension*effectiveSumRidge,denominator=dimension*effectiveSumRidge;
      for(const {forecast,disturbance} of observed)for(let a=0;a<dimension;a++){
        numerator+=disturbance[a]*forecast[a];denominator+=forecast[a]*forecast[a];
        for(let b=0;b<dimension;b++){
          covariance[a][b]+=forecast[a]*forecast[b];
          cross[a][b]+=disturbance[a]*forecast[b];
        }
      }
      const lower=cholesky(covariance);
      matrix=cross.map(row=>solve(lower,row));scalar=numerator/denominator;
    }
    let rawSquared=0,matrixSquared=0,scalarSquared=0;
    for(const {forecast,disturbance} of observed){
      const corrected=apply(matrix,forecast,dimension);
      rawSquared+=squared(forecast.map((value,a)=>value-disturbance[a]));
      matrixSquared+=squared(corrected.map((value,a)=>value-disturbance[a]));
      scalarSquared+=squared(forecast.map((value,a)=>scalar*value-disturbance[a]));
    }
    const matrixDeltaSquared=matrix.reduce((sum,row,a)=>sum+squared(row.map((value,b)=>value-+(a===b))),0);
    const scalarDeltaSquared=dimension*(scalar-1)**2;
    return {algorithmId:ALGORITHM_ID,active,matrix,scalar,windowSize:count,lambda,effectiveSumRidge,
      rawRms:count?Math.sqrt(rawSquared/(count*dimension)):null,
      matrixRms:count?Math.sqrt(matrixSquared/(count*dimension)):null,
      scalarRms:count?Math.sqrt(scalarSquared/(count*dimension)):null,
      matrixDelta:Math.sqrt(matrixDeltaSquared),scalarDelta:Math.sqrt(scalarDeltaSquared),
      rawObjective:count?.5*rawSquared/count:0,
      matrixObjective:count?.5*(matrixSquared/count+lambda*matrixDeltaSquared):0,
      scalarObjective:count?.5*(scalarSquared/count+lambda*scalarDeltaSquared):0};
  }
  function deployedRow(blocks,K,correction,{time,historyWindow=WINDOW,predictionWindow=5}={}){
    integer(time,'Action time',0);integer(historyWindow,'History window');integer(predictionWindow,'Prediction window');
    if(!Array.isArray(blocks))throw new TypeError('Response blocks must be an array');
    const [m,n]=matrixShape(K,'Static feedback');
    const selected=correction&&typeof correction==='object'&&!Array.isArray(correction)?correction.matrix:correction;
    const scalar=typeof selected==='number';
    if(scalar){if(!Number.isFinite(selected))throw new TypeError('Scalar correction must be finite');}
    else matrixShape(selected,'Correction',n,n);
    const transform=scalar?(selected===1?value=>value:value=>value.map(row=>row.map(v=>v*selected))):value=>multiply(value,selected);
    const start=Math.max(0,time-historyWindow),stop=time+predictionWindow;
    return blocks.filter(block=>{
      integer(block.k,'Forecast column',0);
      const q=block.k-1;return q>=start&&q<stop;
    }).map(block=>{
      matrixShape(block.X,'Offline predictive state response',n,n);
      matrixShape(block.U,'Offline predictive input response',m,n);
      const X=transform(block.X),U=transform(block.U),KX=multiply(K,X);
      const L=U.map((row,i)=>row.map((value,j)=>value-KX[i][j]));
      return {...block,X,U,L};
    });
  }
  function accumulateScores(scores,row){
    const [m,n]=matrixShape(scores,'Scores');
    if(scores.some(values=>values.some(value=>value<0)))throw new RangeError('Scores must be nonnegative');
    if(!Array.isArray(row))throw new TypeError('Deployed row must be an array');
    for(const block of row)matrixShape(block.L,'Direct prediction gain',m,n);
    for(const block of row)for(let i=0;i<m;i++)for(let j=0;j<n;j++)scores[i][j]+=block.L[i][j]**2;
    return scores;
  }
  function selectSupport(scores,receiverBuses,budget){
    const [m,n]=matrixShape(scores,'Scores');integer(budget,'Remote budget',0);
    if(budget>n-1)throw new RangeError('Remote budget exceeds the available nonlocal sources');
    if(scores.some(row=>row.some(value=>value<0)))throw new RangeError('Scores must be nonnegative');
    if(!Array.isArray(receiverBuses)||receiverBuses.length!==m||receiverBuses.some(bus=>!Number.isInteger(bus)||bus<2||bus>n+1))
      throw new RangeError('Each receiver bus must identify a source bus in 2,...,n+1');
    const support=scores.map(()=>Array(n).fill(false)),links=[];
    scores.forEach((row,i)=>{
      const bus=receiverBuses[i];support[i][bus-2]=true;
      const remote=row.map((weight,j)=>({from:j+2,to:bus,weight})).filter(edge=>edge.from!==bus)
        .sort((a,b)=>b.weight-a.weight||a.from-b.from).slice(0,budget);
      for(const edge of remote){support[i][edge.from-2]=true;links.push(edge);}
    });
    return {support,links};
  }
  return {ALGORITHM_ID,algorithmId:ALGORITHM_ID,fit,identity,apply,deployedRow,accumulateScores,selectSupport,
    constants:Object.freeze({dimension:DIMENSION,window:WINDOW,historyWindow:WINDOW,predictionWindow:5,warmup:WARMUP,lambda:LAMBDA})};
});
