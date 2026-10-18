/* Shared predictive-input calibration for the manuscript's experimental
 * matrix/scalar comparison, not the completed-row Algorithm 1 update.
 *
 * fit accepts an array of already revealed {forecast, disturbance} pairs.
 * Each vector contains dimension nonslack voltage-forcing coordinates in physical
 * pu, or dimension + 1 coordinates with an exactly zero slack at index zero.
 * The explicit dimension defaults to 23 for saved single-feeder experiments.
 * The caller owns causality and warmup. Only pass observations available before
 * the current action. This module retains the last 60 supplied observations.
 *
 * Both estimators minimize the same objective
 *   0.5 mean_s ||C forecast_s - disturbance_s||^2
 *       + 0.5 lambda ||C - I||_F^2.
 * The scalar estimator restricts C to c I. The matrix estimator can additionally
 * restrict C so applying it never introduces a forbidden raw prediction source.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.ForecastCalibration=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const DIMENSION=23,WINDOW=60,LAMBDA=1.27e-5;
  const identity=(n=DIMENSION)=>Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>+(i===j)));
  const squared=values=>values.reduce((sum,value)=>sum+value*value,0);

  function coordinates(values,dimension=DIMENSION){
    if(!Array.isArray(values)||![dimension,dimension+1].includes(values.length))
      throw new RangeError('Expected '+dimension+' nonslack or '+(dimension+1)+' slack-padded coordinates');
    if(values.some(value=>!Number.isFinite(value)))throw new TypeError('Coordinates must be finite numbers');
    if(values.length===dimension+1&&values[0]!==0)throw new RangeError('The padded slack coordinate must be zero');
    return values.length===dimension+1?values.slice(1):values.slice();
  }

  function compatibleMask(support=null,dimension=DIMENSION){
    if(support!==null&&(!Array.isArray(support)||!support.length||support.some(row=>
      !Array.isArray(row)||row.length!==dimension||row.some(value=>typeof value!=='boolean'))))
      throw new TypeError('Support must contain boolean receiver rows with '+dimension+' source columns');
    // C[a][b] lets raw source b influence calibrated source a. Every receiver
    // already using a must also be allowed to receive b. Diagonal terms survive.
    return Array.from({length:dimension},(_,a)=>Array.from({length:dimension},(_,b)=>
      support===null||support.every(row=>!row[a]||row[b])));
  }

  function solveSPD(matrix,rhs){
    const n=rhs.length,L=Array.from({length:n},()=>Array(n).fill(0));
    for(let i=0;i<n;i++)for(let j=0;j<=i;j++){
      let value=matrix[i][j];for(let k=0;k<j;k++)value-=L[i][k]*L[j][k];
      if(i===j){
        if(!(value>0))throw new Error('Calibration covariance must be positive definite');
        L[i][j]=Math.sqrt(value);
      }else L[i][j]=value/L[j][j];
    }
    const y=Array(n).fill(0),x=Array(n).fill(0);
    for(let i=0;i<n;i++){
      let value=rhs[i];for(let j=0;j<i;j++)value-=L[i][j]*y[j];y[i]=value/L[i][i];
    }
    for(let i=n-1;i>=0;i--){
      let value=y[i];for(let j=i+1;j<n;j++)value-=L[j][i]*x[j];x[i]=value/L[i][i];
    }
    return x;
  }

  function apply(matrix,vector,dimension=DIMENSION){
    const input=coordinates(vector,dimension);
    if(!Array.isArray(matrix)||matrix.length!==dimension||matrix.some(row=>
      !Array.isArray(row)||row.length!==dimension||row.some(value=>!Number.isFinite(value))))
      throw new TypeError('Correction matrix must be a finite '+dimension+' by '+dimension+' array');
    const output=matrix.map(row=>row.reduce((sum,value,j)=>sum+value*input[j],0));
    return vector.length===dimension+1?[0,...output]:output;
  }

  function fit(samples,{support=null,lambda=LAMBDA,dimension=DIMENSION}={}){
    if(!Number.isInteger(dimension)||dimension<1)throw new RangeError('Dimension must be a positive integer');
    if(!Array.isArray(samples))throw new TypeError('Revealed samples must be an array');
    if(!Number.isFinite(lambda)||lambda<=0)throw new RangeError('Ridge parameter must be positive');
    const mask=compatibleMask(support,dimension),observed=samples.slice(-WINDOW).map(sample=>({
      forecast:coordinates(sample.forecast,dimension),disturbance:coordinates(sample.disturbance,dimension)
    }));
    const effectiveSumRidge=lambda*Math.max(1,observed.length);
    if(!observed.length)return{matrix:identity(dimension),scalar:1,windowSize:0,lambda,effectiveSumRidge,
      rawRms:null,matrixRms:null,scalarRms:null,matrixDelta:0,scalarDelta:0,
      rawObjective:0,matrixObjective:0,scalarObjective:0};
    // Multiplying the mean loss normal equations by the observation count
    // leaves the optimizer unchanged and scales the prior by that same count.
    const covariance=identity(dimension).map(row=>row.map(value=>effectiveSumRidge*value));
    const cross=identity(dimension).map(row=>row.map(value=>effectiveSumRidge*value));
    let scalarNumerator=effectiveSumRidge*dimension,scalarDenominator=effectiveSumRidge*dimension;
    for(const {forecast,disturbance} of observed){
      for(let a=0;a<dimension;a++){
        scalarNumerator+=disturbance[a]*forecast[a];scalarDenominator+=forecast[a]*forecast[a];
        for(let b=0;b<dimension;b++){
          covariance[a][b]+=forecast[a]*forecast[b];
          cross[a][b]+=disturbance[a]*forecast[b];
        }
      }
    }
    const matrix=identity(dimension).map((_,a)=>{
      const allowed=mask[a].flatMap((ok,b)=>ok?[b]:[]);
      const coefficients=solveSPD(allowed.map(b=>allowed.map(c=>covariance[b][c])),allowed.map(b=>cross[a][b]));
      const row=Array(dimension).fill(0);allowed.forEach((b,j)=>row[b]=coefficients[j]);return row;
    });
    const scalar=scalarNumerator/scalarDenominator;
    let rawSquared=0,matrixSquared=0,scalarSquared=0;
    for(const {forecast,disturbance} of observed){
      const corrected=apply(matrix,forecast,dimension);
      rawSquared+=squared(forecast.map((value,a)=>value-disturbance[a]));
      matrixSquared+=squared(corrected.map((value,a)=>value-disturbance[a]));
      scalarSquared+=squared(forecast.map((value,a)=>scalar*value-disturbance[a]));
    }
    const matrixDeltaSquared=matrix.reduce((sum,row,a)=>sum+squared(row.map((value,b)=>value-+(a===b))),0);
    const scalarDeltaSquared=dimension*(scalar-1)**2,count=observed.length*dimension;
    return {matrix,scalar,windowSize:observed.length,lambda,effectiveSumRidge,
      rawRms:count?Math.sqrt(rawSquared/count):null,
      matrixRms:count?Math.sqrt(matrixSquared/count):null,
      scalarRms:count?Math.sqrt(scalarSquared/count):null,
      matrixDelta:Math.sqrt(matrixDeltaSquared),scalarDelta:Math.sqrt(scalarDeltaSquared),
      rawObjective:.5*rawSquared/observed.length,
      matrixObjective:.5*(matrixSquared/observed.length+lambda*matrixDeltaSquared),
      scalarObjective:.5*(scalarSquared/observed.length+lambda*scalarDeltaSquared)};
  }
  return {fit,identity,apply,compatibleMask,constants:Object.freeze({dimension:DIMENSION,window:WINDOW,lambda:LAMBDA})};
});
