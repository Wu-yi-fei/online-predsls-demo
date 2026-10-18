'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const TopologyTimeline=require('./topology-timeline.js');
const a={from:2,to:5},b={from:3,to:5},c={from:4,to:8};
const snap=(t,recommendations,phase='discovery')=>({t,recommendations,phase});

test('initial support is captured without claiming a topology change',()=>{
  const timeline=new TopologyTimeline(snap(0,[c,{...a,weight:3},{from:5,to:5},a]));
  assert.deepEqual(timeline.initial,[a,c]);assert.deepEqual(timeline.current,[a,c]);
  assert.deepEqual(timeline.cumulative,{added:0,removed:0,changes:0,transitions:0});
  assert.equal(timeline.latest,null);assert.deepEqual(timeline.at(0),[a,c]);
});

test('actual additions and removals record directed source and receiver identities',()=>{
  const timeline=new TopologyTimeline(snap(0,[a]));
  const first=timeline.observe(snap(1,[a,b]));
  assert.deepEqual(first,{index:1,t:1,added:[b],removed:[],before:[a],after:[a,b]});
  const second=timeline.observe(snap(2,[b]));
  assert.deepEqual(second.removed,[a]);assert.deepEqual(second.added,[]);
  timeline.observe(snap(3,[{from:5,to:3}]));
  assert.deepEqual(timeline.latest.added,[{from:5,to:3}]);
  assert.deepEqual(timeline.latest.removed,[b]);
  assert.deepEqual(timeline.cumulative,{added:2,removed:2,changes:4,transitions:3});
});

test('a swap and return to initial support remain in persistent history',()=>{
  const timeline=new TopologyTimeline(snap(0,[a,c]));
  timeline.observe(snap(7,[b,c]));timeline.observe(snap(12,[a,c]));
  assert.deepEqual(timeline.current,timeline.initial);
  assert.deepEqual(timeline.events.map(change=>change.t),[7,12]);
  assert.deepEqual(timeline.at(1),[b,c]);assert.deepEqual(timeline.at(2),[a,c]);
  assert.deepEqual(timeline.cumulative,{added:2,removed:2,changes:4,transitions:2});
});

test('reordering, duplicate links, local channels, and weight changes are not topology events',()=>{
  const timeline=new TopologyTimeline(snap(0,[a,c]));
  for(const t of [0,0,1,1,2])assert.equal(timeline.observe(snap(t,[{...c,weight:t},{...a,weight:-t},c,{from:8,to:8}])),null);
  assert.equal(timeline.events.length,0);assert.equal(timeline.lastT,2);
});

test('same-time genuine support updates are recorded once and stale samples are ignored',()=>{
  const timeline=new TopologyTimeline(snap(4,[a]));
  assert.ok(timeline.observe(snap(4,[b])));
  assert.equal(timeline.observe(snap(4,[b])),null);
  assert.equal(timeline.observe(snap(3,[c])),null);
  assert.equal(timeline.events.length,1);assert.deepEqual(timeline.current,[b]);
});

test('deployment freezes discovery history and a new discovery starts a fresh baseline',()=>{
  const timeline=new TopologyTimeline(snap(0,[a]));
  timeline.observe(snap(8,[b]));
  timeline.observe(snap(0,[c],'deployment'));
  timeline.observe(snap(120,[a],'deployment'));
  assert.equal(timeline.frozen,true);assert.equal(timeline.lastT,8);
  assert.deepEqual(timeline.current,[b]);assert.equal(timeline.events.length,1);
  timeline.observe(snap(0,[c]));
  assert.equal(timeline.frozen,false);assert.equal(timeline.events.length,0);
  assert.deepEqual(timeline.initial,[c]);assert.equal(timeline.lastT,0);
});

test('reset deliberately clears prior transitions without inventing an initial change',()=>{
  const timeline=new TopologyTimeline(snap(0,[a]));timeline.observe(snap(1,[b]));
  timeline.reset(snap(30,[c]));assert.equal(timeline.events.length,0);
  assert.equal(timeline.initialT,30);assert.deepEqual(timeline.current,[c]);
  timeline.reset();assert.equal(timeline.initialT,null);
  assert.equal(timeline.observe(snap(0,[a])),null);assert.deepEqual(timeline.initial,[a]);
});

test('serializable version 1 export restores exact discovery and frozen deployment history',()=>{
  const timeline=new TopologyTimeline(snap(0,[a]));
  timeline.observe(snap(1,[b]));timeline.observe(snap(2,[a]));timeline.observe(snap(5,[a]));
  for(const phase of ['discovery','deployment']){
    if(phase==='deployment')timeline.observe(snap(0,[a],phase));
    const exported=JSON.parse(JSON.stringify(timeline.export()));
    const restored=new TopologyTimeline().restore(exported);
    assert.deepEqual(restored.export(),exported);assert.deepEqual(restored.cumulative,timeline.cumulative);
    assert.equal(restored.observe(snap(phase==='discovery'?5:20,[a],phase)),null);
  }
  const fresh=new TopologyTimeline();assert.deepEqual(new TopologyTimeline().restore(fresh.export()).export(),fresh.export());
});

test('history reconstruction from every sample preserves transitions hidden by final support',()=>{
  const timeline=new TopologyTimeline();
  const observations=[snap(0,[a]),snap(1,[a]),snap(2,[b]),snap(3,[a]),snap(4,[a])];
  observations.forEach(snapshot=>timeline.observe(snapshot));
  assert.equal(timeline.events.length,2);assert.deepEqual(timeline.initial,timeline.current);
  const replay=new TopologyTimeline();observations.forEach(snapshot=>replay.observe(snapshot));
  assert.deepEqual(replay.export(),timeline.export());
});

test('public history cannot be mutated and exports are detached copies',()=>{
  const timeline=new TopologyTimeline(snap(0,[a]));timeline.observe(snap(1,[b]));
  assert.throws(()=>timeline.current.push(c),TypeError);
  assert.throws(()=>{timeline.events[0].added[0].from=99;},TypeError);
  assert.throws(()=>timeline.events.pop(),TypeError);
  const exported=timeline.export();exported.events[0].added[0].from=99;exported.current=[];
  assert.deepEqual(timeline.current,[b]);assert.deepEqual(timeline.latest.added,[b]);
});

test('restore rejects discontinuities or false change counts without corrupting current history',()=>{
  const timeline=new TopologyTimeline(snap(0,[a]));timeline.observe(snap(1,[b]));
  const good=timeline.export();
  for(const damage of [
    data=>data.version=2,
    data=>data.events[0].before=[c],
    data=>data.events[0].added=[],
    data=>data.current=[c],
    data=>data.lastT=0,
    data=>data.events[0].index=3
  ]){
    const data=JSON.parse(JSON.stringify(good));damage(data);
    assert.throws(()=>timeline.restore(data),TypeError);assert.deepEqual(timeline.export(),good);
  }
  assert.throws(()=>timeline.at(-1),RangeError);assert.throws(()=>timeline.at(2),RangeError);
});
