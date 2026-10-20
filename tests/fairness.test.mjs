import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureRoot, reconcileUntil } from './fixture.mjs';
import { Runtime } from '../src/runtime.mjs';
import { operate, claim, lookup, requestKey } from '../src/external.mjs';

const send=(id='one')=>({v:1,op:'send',caller:'fixture',id,to:'pi/owner',text:'Synthetic clock fixture',delivery:'queue',expectReply:false});
function memory() {
  let now=0, cost=0;
  let state={v:2,sessions:{'pi/owner':{pid:process.pid,epoch:'fixture',online:true,heartbeat:0,externalV1:true,persistence:true,transcript:'/synthetic.jsonl'}},requests:{},creates:{},external:{}};
  return {clock:()=>now,set:(n,c=0)=>{now=n;cost=c;},state:()=>state,
    read(){now+=cost;return structuredClone(state);},
    tx(fn){now+=cost;const candidate=structuredClone(state);const value=fn(candidate);state=candidate;return value;}};
}
test('fresh decision clocks sample after slow read/acquisition; companion never refreshes peers',()=>{
  const m=memory();m.set(0,70000);
  assert.throws(()=>operate(m,send(),m.clock),{code:'UNAVAILABLE'});
  assert.equal(m.state().sessions['pi/owner'].heartbeat,0);
  assert.equal(Object.keys(m.state().external).length,0);
  m.set(0,70000);assert.equal(lookup(m,'pi/owner',m.clock).live,false);
  const real=Date.now;Date.now=m.clock;
  try {m.set(0,70000);assert.throws(()=>operate(m,send()),{code:'UNAVAILABLE'});m.set(0,70000);assert.equal(lookup(m,'pi/owner').live,false);}
  finally {Date.now=real;}
  m.set(0,30000);assert.equal(operate(m,send(),m.clock).state,'admitted');
  assert.equal(m.state().external[requestKey(send())].deadline,330000);
  m.set(0,330000);assert.equal(claim(m,requestKey(send()),'pi/owner','fixture',m.clock),null);
  assert.equal(m.state().external[requestKey(send())].evidence,'deadline');
});
test('fresh claim rejects stale heartbeat; claimed/cancelled keys never revive under changed clocks',()=>{
  const m=memory();operate(m,send(),m.clock);m.set(0,70000);
  assert.equal(claim(m,requestKey(send()),'pi/owner','fixture',m.clock),null);
  assert.equal(m.state().external[requestKey(send())].evidence,'owner_unavailable');
  const n=memory();operate(n,send(),n.clock);assert.ok(claim(n,requestKey(send()),'pi/owner','fixture',n.clock));
  n.set(1000000);assert.equal(operate(n,send(),n.clock).facts.claimed,true);
  assert.equal(claim(n,requestKey(send()),'pi/owner','fixture',()=>{throw Error('known claim must not be reconsidered');}),null);
  operate(n,{v:1,op:'cancel',caller:'fixture',id:'late'},n.clock);
  assert.throws(()=>operate(n,send('late'),n.clock),{code:'CANCELLED'});
});
test('default claim clock is sampled inside acquisition, not at entry',()=>{
  for (const [cost,evidence] of [[70000,'owner_unavailable'],[300000,'deadline']]) {
    const m=memory();operate(m,send(),m.clock);m.set(0,cost);
    const real=Date.now;Date.now=m.clock;
    try {assert.equal(claim(m,requestKey(send()),'pi/owner','fixture'),null);}
    finally {Date.now=real;}
    assert.equal(m.state().external[requestKey(send())].evidence,evidence);
    assert.equal(m.state().sessions['pi/owner'].heartbeat,0);
  }
});
function fixture(extra={}) {
  const dir=fixtureRoot('a2a-fair-'),file=path.join(dir,'session.jsonl'),calls=[];
  fs.writeFileSync(file,JSON.stringify({type:'session',id:'owner'})+'\n');
  const r=new Runtime({root:dir,session:'owner',cwd:dir,transcript:()=>file,sendMessage:m=>{calls.push(m);},...extra});r.start();
  return {dir,r,calls,async close(){await r.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('terminal native active maintenance releases a no-candidate timeout but preserves nonterminal blocked work',async()=>{
  let now=100000;const real=Date.now;Date.now=()=>now;
  const f=fixture({now:()=>now});
  const sender=new Runtime({root:f.dir,session:'sender',cwd:f.dir,now:()=>now,sendMessage:()=>{}});sender.start();
  try {
    const first=await sender.send(f.r.self,'Synthetic hung native turn');
    await reconcileUntil(f.r,()=>f.r.active?.id===first.id,'first native dispatch');
    assert.equal(f.r.active.candidate,undefined);
    f.r.blocked(true);
    for(let i=0;i<3;i++)await f.r.reconcile();
    assert.equal(f.r.store.read().requests[first.id].status,'blocked');
    assert.equal(f.r.active.id,first.id,'absence of a candidate cannot clear a nonterminal blocked request');
    assert.equal(f.r.active.candidate,undefined);assert.equal(f.calls.length,1);
    now=f.r.store.read().requests[first.id].deadline+1;
    await reconcileUntil(f.r,()=>f.r.store.read().requests[first.id].status==='timeout'&&!f.r.active,'timeout persisted and terminal slot released');
    const second=await sender.send(f.r.self,'Synthetic next valid native turn');
    assert.ok(f.r.store.read().requests[second.id].deadline>now);
    await reconcileUntil(f.r,()=>f.r.active?.id===second.id,'second valid native dispatch');
    for(let i=0;i<3;i++)await f.r.reconcile();
    const rows=f.r.store.read().requests;
    assert.equal(rows[first.id].status,'timeout');assert.equal(rows[second.id].status,'queued');
    assert.equal(rows[second.id].injected,true);
    assert.deepEqual(f.calls.map(m=>m.details.request),[first.id,second.id],'one native facade per request, no replay');
  } finally {try {await sender.close();await f.close();} finally {Date.now=real;}}
});
test('bounded round-robin work yields real timers and progresses native/external lanes with owned heartbeat',async()=>{
  let now=100000,ticks=0,txs=0;const trace=[];
  const f=fixture({now:()=>now,sendMessage:m=>{f.calls.push(m);return new Promise(()=>{});}});
  const timer=setInterval(()=>{ticks++;},1);
  try {
    for(let i=0;i<6;i++)operate(f.r.store,send(`wake-${i}`),()=>now);
    f.r.store.tx(s=>{for(let i=0;i<8;i++)s.requests[`native-${i}`]={id:`native-${i}`,from:f.r.self,to:'pi/other',status:'queued',expectReply:false,deadline:0};});
    const original=f.r.store.tx.bind(f.r.store);
    f.r.store.tx=fn=>original(s=>{now+=10000;txs++;const value=fn(s);trace.push({ticks,hb:s.sessions[f.r.self].heartbeat,now,native:Object.values(s.requests).filter(r=>r.status==='timeout').length,claimed:Object.values(s.external).filter(r=>r.claim).length});return value;});
    for(let pass=0;pass<12;pass++) {
      const before=txs;const p=f.r.reconcile();assert.equal(f.r.reconcile(),p);await p;
      assert.ok(txs-before<=8,'at most eight transaction units per pass');
      const state=f.r.store.read();
      if(Object.values(state.external).every(r=>r.claim)&&Object.values(state.requests).every(r=>r.status==='timeout'))break;
    }
    const state=f.r.store.read();
    assert.equal(Object.values(state.external).filter(r=>r.claim).length,6);
    assert.equal(Object.values(state.requests).filter(r=>r.status==='timeout').length,8);
    assert.equal(f.calls.length,6);assert.equal(new Set(f.calls.map(m=>m.details.internal)).size,6);
    assert.ok(trace.every(x=>x.now-x.hb<=20000));
    assert.ok(trace.some(x=>x.native>0&&x.claimed<6));
    assert.ok(trace.some(x=>x.claimed>0&&x.native<8));
    assert.ok(new Set(trace.map(x=>x.ticks)).size>3,'timer ran between backlogged units');
    const oldHeartbeat=state.sessions[f.r.self].heartbeat;
    now+=30000;await f.r.reconcile();const renewed=f.r.store.read().sessions[f.r.self].heartbeat;
    assert.ok(renewed>oldHeartbeat);assert.ok(now-renewed<=20000);
    assert.equal(f.calls.length,6,'unresolved facade promises never block or replay');
  } finally {clearInterval(timer);await f.close();}
});
// Synthetic finite pre/callback/post/read costs, NOT measured native timings.
for(const scenario of [
  {name:'overdue on return',pre:13999,callback:1,post:22000,read:3450,gap:30000},
  {name:'shorter return tail',pre:15828,callback:1,post:10456,read:3450,gap:30000},
  {name:'expired before service',pre:13999,callback:1,post:22000,read:3450,gap:300001}
]) test(`finite slow units cannot monopolize rotating work with priority heartbeats: ${scenario.name}`,async t=>{
  const realNow=Date.now;let now=100000,enabled=false,inTx=false,lane='priority-heartbeat',ticks=0;
  let f,read,tx,originalTurn;const methods=new Map(),units=[],lanes=[];
  let attempts=0,callbacks=0;
  Date.now=()=>now;
  try {
    f=fixture({now:()=>now});
    const r=f.r,store=r.store,x=send('slow-unit');
    operate(store,x,()=>now);
    store.tx(s=>{s.requests.expired={id:'expired',from:r.self,to:'pi/other',status:'queued',expectReply:false,deadline:0};});
    const deadline=store.read().external[requestKey(x)].deadline;
    read=store.read;tx=store.tx;originalTurn=r.turn;
    store.read=function(){const s=read.call(this);if(enabled&&!inTx)now+=scenario.read;return s;};
    store.tx=function(fn){
      if(!enabled)return tx.call(this,fn);
      attempts++;const start=now;let cb,hb;
      inTx=true;
      try {
        const result=tx.call(this,s=>{now+=scenario.pre;cb=now;callbacks++;const value=fn(s);hb=s.sessions[r.self].heartbeat;now+=scenario.callback;return value;});
        now+=scenario.post;
        units.push({lane,start,cb,end:now,hb,tick:ticks});return result;
      } finally {inTx=false;}
    };
    r.turn=async function(){assert.equal(inTx,false,'real turns occur outside transactions');const ready=await originalTurn.call(this);ticks++;return ready;};
    for(const method of ['reconcileExternal','dispatchExternal','reconcileNative','flushWrite','dispatchNative','completeCandidate','deliverReply']){
      const original=r[method];methods.set(method,original);
      r[method]=function(...args){const previous=lane;lane=method;lanes.push({lane,cursor:this.laneNext});try{return original.apply(this,args);}finally{lane=previous;}};
    }
    now+=scenario.gap;enabled=true;
    for(let pass=0;pass<3;pass++){
      const first=units.length,firstLane=lanes.length;
      await r.reconcile();
      const successful=units.slice(first);
      assert.ok(successful.length<=8,'successful mutation units stay inside the eight-unit budget');
      assert.ok(successful.filter(u=>u.lane==='priority-heartbeat').length<=1,'at most one standalone priority heartbeat per pass');
      if(pass===0){
        assert.ok(lanes.length>firstLane,'overdue return still permits rotating lane service');
        assert.ok(lanes.slice(firstLane).some(l=>l.cursor!==0),'lane cursor advances beyond priority-only state');
      }
      assert.ok(successful.every(u=>u.hb===u.cb),'ledger heartbeat retains actual callback time');
      assert.ok(successful.every(u=>u.end-u.hb===scenario.callback+scenario.post),'finite post-callback cost remains visible, not hidden by fake freshness');
      if(successful.length)assert.equal(r.lastHeartbeat,successful.at(-1).hb,'scheduling hint also retains callback time');
      assert.equal(attempts,callbacks,'no busy or failed acquisition is counted as callback success');
      assert.equal(callbacks,units.length,'every recorded transaction really completed once');
      assert.equal(new Set(successful.map(u=>u.tick)).size,successful.length,'a real timer turn separates mutation units');
      const s=read.call(store),row=s.external[requestKey(x)];
      assert.equal(s.requests.expired.status,'timeout','native deadline writes progress');
      if(scenario.gap>300000){assert.equal(row.state,'failed');assert.equal(row.evidence,'deadline');assert.equal(row.claim,undefined);assert.equal(f.calls.length,0);}
      else {
        assert.ok(row.claim,'live-deadline external claim progresses');assert.equal(f.calls.length,1);
        if(pass===0)assert.ok(units.find(u=>u.lane==='dispatchExternal').cb<deadline,'claim is made before the unchanged deadline');
      }
    }
    const s=read.call(store),row=s.external[requestKey(x)];
    assert.equal(row.proof,undefined,'facade delivery never manufactures saved intake');
    assert.equal(f.calls.length,scenario.gap>300000?0:1,'later passes never replay a facade');
    t.diagnostic(JSON.stringify({scenario:scenario.name,attempts,callbacks,priorityHeartbeats:units.filter(u=>u.lane==='priority-heartbeat').length,facades:f.calls.length,external:row.state,native:s.requests.expired.status}));
  } finally {
    enabled=false;
    if(f){if(read)f.r.store.read=read;if(tx)f.r.store.tx=tx;if(originalTurn)f.r.turn=originalTurn;for(const [method,original] of methods)f.r[method]=original;}
    try {if(f){await f.close();assert.equal(f.r.turns.size,0);assert.equal(f.r.children.size,0);assert.equal(f.r.reconciling,null);}}
    finally {Date.now=realNow;if(f)f.r.now=realNow;}
  }
});
test('owned renewal is exact PID/epoch/online only; lookup and companion status do not renew',async()=>{
  for(const field of ['epoch','pid','online']) {
    let now=100000;const f=fixture({now:()=>now});
    try {
      operate(f.r.store,send(),()=>now);
      const hb=f.r.store.read().sessions[f.r.self].heartbeat;now+=40000;
      lookup(f.r.store,f.r.self,()=>now);operate(f.r.store,{v:1,op:'status',caller:'fixture',id:'one'},()=>now);
      assert.equal(f.r.store.read().sessions[f.r.self].heartbeat,hb);
      f.r.store.tx(s=>{s.sessions[f.r.self][field]=field==='epoch'?'replacement':field==='pid'?process.pid+100000:false;});
      await f.r.reconcile();
      assert.equal(f.r.store.read().sessions[f.r.self].heartbeat,hb);assert.equal(f.calls.length,0);
      assert.equal(f.r.store.read().external[requestKey(send())].claim,undefined);
    } finally {await f.close();}
  }
});
test('close during real yield cancels units and late facade continuation cannot write',async()=>{
  const f=fixture();
  try {operate(f.r.store,send());const pass=f.r.reconcile();await f.r.close();await pass;assert.equal(f.calls.length,0);assert.equal(f.r.turns.size,0);}
  finally {await f.close();}
  let resolve;const g=fixture({sendMessage:m=>{g.calls.push(m);return new Promise(r=>{resolve=r;});}});
  try {operate(g.r.store,send());await g.r.reconcile();await g.r.close();const bytes=fs.readFileSync(g.r.store.file);resolve();await new Promise(r=>setTimeout(r,0));assert.deepEqual(fs.readFileSync(g.r.store.file),bytes);assert.equal(g.r.externalWrites.size,0);}
  finally {await g.close();}
});
test('busy work is bounded and rotated; idle passes do not manufacture writes',async()=>{
  const f=fixture();
  try {
    operate(f.r.store,send());const tx=f.r.store.tx.bind(f.r.store);let attempts=0;
    f.r.store.tx=()=>{attempts++;throw Object.assign(Error('fixture busy'),{code:'A2A_BUSY'});};
    await f.r.reconcile();assert.equal(attempts,1);assert.equal(f.calls.length,0);assert.ok(f.r.scheduled);
    f.r.store.tx=tx;await f.r.reconcile();assert.equal(f.calls.length,1);
    let idleWrites=0;f.r.store.tx=fn=>{idleWrites++;return tx(fn);};
    await f.r.reconcile();idleWrites=0;await f.r.reconcile();assert.equal(idleWrites,0);
  } finally {await f.close();}
});
test('replacement between the snapshot and a unit prevents heartbeat and injection',async()=>{
  for(const field of ['epoch','pid']) {
    let now=100000;const f=fixture({now:()=>now});
    try {
      operate(f.r.store,send(),()=>now);now+=40000;
      const turn=f.r.turn.bind(f.r);let turns=0;
      f.r.turn=async()=>{const ready=await turn();if(++turns===2)f.r.store.tx(s=>{s.sessions[f.r.self][field]=field==='epoch'?'replacement':process.pid+100000;});return ready;};
      const heartbeat=f.r.store.read().sessions[f.r.self].heartbeat;
      await f.r.reconcile();assert.equal(f.r.lostOwner,true);assert.equal(f.calls.length,0);
      assert.equal(f.r.store.read().sessions[f.r.self].heartbeat,heartbeat);
      assert.equal(f.r.store.read().external[requestKey(send())].claim,undefined);
    } finally {await f.close();}
  }
});
test('unresolved OC outcome does not block heartbeat; late completion cannot beat deadline or replaced epoch',async()=>{
  for(const replace of [false,true]) {
    let now=100000,resolve,calls=0;
    const f=fixture({now:()=>now,oc:{url:'http://127.0.0.1:1',send:async()=>{},events:async()=>{},outcome:()=>{calls++;return new Promise(r=>{resolve=r;});}}});
    try {
      const sent=await f.r.send('oc/ses_fixture','Synthetic outcome',{expectReply:false});
      f.r.store.tx(s=>{s.requests[sent.id].deadline=500000;});
      await reconcileUntil(f.r,()=>calls===1,'initial OC outcome collection');assert.equal(calls,1);
      now+=30000;await f.r.reconcile();assert.equal(calls,1);
      const hb=f.r.store.read().sessions[f.r.self].heartbeat;assert.equal(hb,now);
      if(replace)f.r.store.tx(s=>{s.sessions[f.r.self].epoch='replacement';});
      else now=600000;
      resolve({status:'completed',answer:'late'});await new Promise(r=>setTimeout(r,0));await f.r.reconcile();
      const state=f.r.store.read();assert.equal(state.requests[sent.id].status,replace?'sent':'timeout');
      if(replace)assert.equal(state.sessions[f.r.self].heartbeat,hb);
    } finally {await f.close();}
  }
});
test('deadline fixture joining a pre-clock-change snapshot requires a fresh normal pass, never a repeated effect',async()=>{
  let sends=0,outcomes=0,release=()=>{};
  const f=fixture({oc:{url:'http://127.0.0.1:1',send:async()=>{sends++;},events:async()=>{},outcome:async()=>{outcomes++;return {status:'completed',answer:'too late'};}}});
  try {
    await f.r.reconcile();
    const turn=f.r.turn.bind(f.r);let turns=0,ready;
    const snapshot=new Promise(resolve=>{ready=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    // Hold only the real turn AFTER the verified read, never a Store lock.
    f.r.turn=async()=>{const result=await turn();if(++turns===2){ready();await gate;}return result;};
    const existing=f.r.reconcile();
    await Promise.race([snapshot,existing.then(()=>{throw Error('pass ended before controlled snapshot gate');})]);
    assert.equal(f.r.store.read().requests.stable,undefined);
    const opts={id:'stable'};
    await f.r.send('oc/ses_fixture','Synthetic deadline',opts);await f.r.send('oc/ses_fixture','Synthetic deadline',opts);
    assert.equal(sends,1);f.r.now=()=>Date.now()+200000;
    assert.equal(f.r.reconcile(),existing,'call joins snapshot preceding admission and clock change');
    release();await existing;
    assert.equal(f.r.store.read().requests.stable.status,'sent');assert.equal(f.r.moreWork,true);
    await reconcileUntil(f.r,()=>f.r.store.read().requests.stable.status==='timeout','fresh deadline pass persists timeout');
    assert.equal(f.r.store.read().requests.stable.status,'timeout');
    assert.equal(sends,1,'normal timeout reconciliation never replays external admission');
    assert.equal(outcomes,0,'expired work is not collected as completed');
  } finally {release();await f.close();}
});
test('compacted claim persists facade/event facts without treating either as saved consumption',async()=>{
  const f=fixture();
  try {
    operate(f.r.store,send());await reconcileUntil(f.r,()=>f.r.store.read().external[requestKey(send())].injected===true,'compacted claim persists injection fact');
    let row=f.r.store.read().external[requestKey(send())];
    assert.equal(row.epoch,undefined);assert.equal(row.injected,true);assert.equal(row.proof,undefined);
    f.r.message({type:'message_end',message:{role:'custom',...f.calls[0]}});await reconcileUntil(f.r,()=>f.r.store.read().external[requestKey(send())].observed===true,'compacted claim persists observed event');
    row=f.r.store.read().external[requestKey(send())];assert.equal(row.observed,true);assert.equal(row.proof,undefined);
  } finally {await f.close();}
});
