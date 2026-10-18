/* Persistent observations of actual directed prediction support.
 * This module does not select links or change a controller.
 */
(function(root,factory){
  const TopologyTimeline=factory();
  if(typeof module==='object'&&module.exports)module.exports=TopologyTimeline;
  else root.TopologyTimeline=TopologyTimeline;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const key=edge=>edge.from+','+edge.to;
  const copy=edges=>edges.map(({from,to})=>({from,to}));
  const same=(a,b)=>a.length===b.length&&a.every((edge,i)=>key(edge)===key(b[i]));
  function support(edges){
    if(!Array.isArray(edges))throw new TypeError('Prediction support must be an array');
    const unique=new Map();
    for(const edge of edges){
      if(!edge||!Number.isInteger(edge.from)||!Number.isInteger(edge.to)||edge.from<1||edge.to<1)
        throw new TypeError('Prediction link endpoints must be positive integer bus numbers');
      if(edge.from!==edge.to)unique.set(key(edge),Object.freeze({from:edge.from,to:edge.to}));
    }
    return Object.freeze([...unique.values()].sort((a,b)=>a.to-b.to||a.from-b.from));
  }
  function time(value){
    if(!Number.isInteger(value)||value<0)throw new TypeError('Sample time must be a nonnegative integer');
    return value;
  }
  function phase(value){
    if(value!=='discovery'&&value!=='deployment')throw new TypeError('Unknown experiment phase');
    return value;
  }
  function difference(before,after){
    const a=new Set(before.map(key)),b=new Set(after.map(key));
    return{
      added:Object.freeze(after.filter(edge=>!a.has(key(edge)))),
      removed:Object.freeze(before.filter(edge=>!b.has(key(edge))))
    };
  }
  function event(index,t,before,after){
    return Object.freeze({index,t,...difference(before,after),before,after});
  }
  class TopologyTimeline{
    constructor(snapshot){this.reset(snapshot);}
    reset(snapshot){
      this._events=[];this._added=0;this._removed=0;this._initialized=false;
      this._phase='discovery';this._initialT=null;this._lastT=null;
      this._initial=support([]);this._current=this._initial;
      if(snapshot){
        const next=support(snapshot.recommendations),t=time(snapshot.t),nextPhase=phase(snapshot.phase);
        this._initial=next;this._current=next;this._initialT=t;this._lastT=t;
        this._phase=nextPhase;this._initialized=true;
      }
      return this;
    }
    observe(snapshot){
      if(!snapshot)throw new TypeError('An experiment snapshot is required');
      const nextPhase=phase(snapshot.phase);
      if(!this._initialized){this.reset(snapshot);return null;}
      // Deployment displays this completed discovery record as a frozen reference.
      // Its fresh trial clock and resynthesized weights must not create link events.
      if(nextPhase==='deployment'){this._phase=nextPhase;return null;}
      if(this._phase==='deployment'){this.reset(snapshot);return null;}
      const t=time(snapshot.t);
      if(t<this._lastT)return null;
      const next=support(snapshot.recommendations);
      this._lastT=t;
      if(same(next,this._current))return null;
      const change=event(this._events.length+1,t,this._current,next);
      this._events.push(change);this._current=next;
      this._added+=change.added.length;this._removed+=change.removed.length;
      return change;
    }
    get phase(){return this._phase;}
    get frozen(){return this._phase==='deployment';}
    get initialT(){return this._initialT;}
    get lastT(){return this._lastT;}
    get initial(){return this._initial;}
    get current(){return this._current;}
    get events(){return Object.freeze(this._events.slice());}
    get latest(){return this._events.at(-1)||null;}
    get cumulative(){return Object.freeze({added:this._added,removed:this._removed,
      changes:this._added+this._removed,transitions:this._events.length});}
    at(index){
      if(!Number.isInteger(index)||index<0||index>this._events.length)throw new RangeError('Unknown topology history position');
      return index===0?this._initial:this._events[index-1].after;
    }
    export(){
      return{version:1,initialized:this._initialized,phase:this._phase,
        initialT:this._initialT,lastT:this._lastT,initial:copy(this._initial),current:copy(this._current),
        events:this._events.map(change=>({index:change.index,t:change.t,
          added:copy(change.added),removed:copy(change.removed),before:copy(change.before),after:copy(change.after)}))};
    }
    restore(data){
      if(!data||data.version!==1)throw new TypeError('Unsupported topology history version');
      const nextPhase=phase(data.phase);
      if(typeof data.initialized!=='boolean'||!Array.isArray(data.events))throw new TypeError('Invalid topology history');
      const initial=support(data.initial),storedCurrent=support(data.current);
      if(!data.initialized){
        if(data.initialT!==null||data.lastT!==null||initial.length||storedCurrent.length||data.events.length)
          throw new TypeError('Uninitialized topology history contains observations');
        this.reset();this._phase=nextPhase;return this;
      }
      const initialT=time(data.initialT),lastT=time(data.lastT),events=[];
      let current=initial,previousT=initialT,added=0,removed=0;
      for(const stored of data.events){
        const t=time(stored.t),before=support(stored.before),after=support(stored.after);
        if(stored.index!==events.length+1||t<previousT||!same(before,current)||same(before,after))
          throw new TypeError('Topology history is not a continuous sequence');
        const change=event(stored.index,t,before,after);
        if(!same(support(stored.added),change.added)||!same(support(stored.removed),change.removed))
          throw new TypeError('Topology event changes do not match its supports');
        events.push(change);current=after;previousT=t;
        added+=change.added.length;removed+=change.removed.length;
      }
      if(lastT<previousT||!same(storedCurrent,current))throw new TypeError('Topology history endpoint does not match its events');
      // Validate completely before replacing a valid live record.
      this._initialized=true;this._phase=nextPhase;this._initialT=initialT;this._lastT=lastT;
      this._initial=initial;this._current=current;this._events=events;this._added=added;this._removed=removed;
      return this;
    }
  }
  return TopologyTimeline;
});
