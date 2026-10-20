import test from 'node:test';
import { fixtureRoot } from './fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { Store } from '../src/store.mjs';
import { Runtime } from '../src/runtime.mjs';
import { parse, input } from '../src/machine.mjs';
import { operate, claim, requestKey, content, TYPE, digest, capabilities } from '../src/external.mjs';
import { hash, NATIVE_BYTES, ADMISSION_BYTES, TRANSITION_BYTES, scanKey } from '../src/ledger.mjs';

const roots = [];
const root = () => { const d = fixtureRoot('pi-a2a-wake-'); roots.push(d); return d; };
test.after(() => { for (const d of roots) fs.rmSync(d, { recursive:true, force:true }); });
const send = (id='one', extra={}) => ({ v:1, op:'send', caller:'fixture', id, to:'pi/target', text:'synthetic wake', delivery:'queue', expectReply:false, ...extra });
const query = (op, id='one', caller='fixture') => ({v:1, op, caller, id});
function setup(extra={}) {
  const dir = root(), file = path.join(dir, 'session.jsonl'), calls=[];
  fs.writeFileSync(file, JSON.stringify({type:'session',id:'target'})+'\n');
  const r = new Runtime({root:dir, session:'target', cwd:dir, transcript:()=>file, sendMessage:(...a)=>calls.push(a), ...extra}); r.start();
  return {dir,file,r,store:r.store,calls};
}
test('strict scalar parser rejects duplicate/unknown/prototype keys, surrogates, frames, UTF8 and schema deviations', () => {
  assert.equal(parse(Buffer.from(JSON.stringify(send()))).text, 'synthetic wake');
  const bad = ['{"v":1,"v":1}', JSON.stringify({...send(),from:'chief'}), JSON.stringify({...send(),expectReply:true}),
    JSON.stringify({...send(),text:'  '}), JSON.stringify({...send(),text:'é'.repeat(16385)}), JSON.stringify({...send(),to:'chief'}),
    JSON.stringify({...send(),caller:'UPPER'}), JSON.stringify({...send(),id:'a/b'}), '{"__proto__":{}}',
    JSON.stringify(send())+'{}', JSON.stringify(send()).replace('synthetic wake','\\ud800'), JSON.stringify(send()).replace('"v":1','"v":[]')];
  for (const b of bad) assert.throws(()=>parse(Buffer.from(b)), undefined, b);
  assert.throws(()=>parse(Buffer.from([0xff]))); assert.throws(()=>parse(Buffer.alloc(262145)));
  assert.equal(parse(Buffer.from(JSON.stringify({...send(),text:' x\n '}))).text, ' x\n ');
});
test('stdin time/byte limits are finite', async () => {
  const a = new PassThrough(); await assert.rejects(input(a,15), {code:'INPUT_TIMEOUT'}); a.destroy();
  const b = new PassThrough(); const p = input(b); b.end(Buffer.alloc(262145)); await assert.rejects(p,{code:'INPUT_LIMIT'}); b.destroy();
});
test('separate CLI invocations dedup before liveness, conflicts and caller isolation; sanitized failures', async () => {
  const f=setup();
  const cli = x => { const p=spawnSync(process.execPath,['cli.mjs','machine'], {cwd:path.resolve('.'),env:{...process.env,PI_A2A_STATE:f.dir},input: typeof x==='string'?x:JSON.stringify(x),timeout:5000}); assert.equal(p.stderr.toString(),''); return {exit:p.status,...JSON.parse(p.stdout)}; };
  try {
    assert.equal(cli(send()).receipt.state,'admitted');
    assert.equal(cli(send('one',{caller:'other'})).receipt.state,'admitted');
    f.store.tx(s=>{s.sessions['pi/target'].online=false;});
    assert.equal(cli(send()).receipt.state,'admitted');
    assert.equal(cli(send('one',{text:'changed'})).error,'CONFLICT');
    assert.equal(cli(send('one',{delivery:'steer'})).error,'CONFLICT');
    assert.equal(cli(send('one',{to:'pi/elsewhere'})).error,'CONFLICT');
    assert.equal(cli(send('one',{caller:'third'})).error,'UNAVAILABLE');
    assert.equal(cli('{private broken').error,'INVALID_JSON');
    assert.equal(Object.keys(f.store.read().requests).length,0);
  } finally {await f.r.close();}
});
test('unknown cancellation tombstone survives restart, delays and capacity without reviving', () => {
  const store=new Store(root()); operate(store,query('cancel'));
  assert.throws(()=>operate(new Store(store.root),send()),{code:'CANCELLED'});
  assert.equal(operate(store,query('cancel')).state,'cancelled');
  assert.equal(operate(store,query('status')).state,'cancelled');
});

test('oversize discard crosses windows/restart/partial EOF, stays bounded and resumes exact proof', {timeout:20000}, async()=>{
  const f=setup(); try {
    operate(f.store,send()); await f.r.reconcile(); const m=f.calls[0][0];
    // Stop automatic scans to measure exactly one window per explicit call.
    await f.r.close();
    fs.appendFileSync(f.file,'x'.repeat(3*262144+71));
    let previous=0;
    for(let i=0;i<4;i++) {
      const rec=operate(new Store(f.dir),query('status'));
      const scan=f.store.read().externalScans[scanKey(f.file)];
      assert.equal(rec.facts.consumed,false); assert.equal(rec.evidence,'oversized_record');
      assert.ok(scan.offset-previous<=262144+64); assert.ok(scan.offset>previous); previous=scan.offset;
    }
    assert.equal(operate(new Store(f.dir),query('status')).evidence,'oversized_record');
    fs.appendFileSync(f.file,'\n'+JSON.stringify({type:'custom_message',id:'later-entry',...m})+'\n');
    assert.equal(operate(new Store(f.dir),query('status')).state,'consumed');
    assert.equal(f.store.read().externalScans[scanKey(f.file)],undefined);
  } finally {await f.r.close();}
});

test('completed multi-window oversize before exact wake never skips the later record', async()=>{
  const f=setup(); try {
    operate(f.store,send()); await f.r.reconcile(); const m=f.calls[0][0]; await f.r.close();
    fs.appendFileSync(f.file,'x'.repeat(4*262144+3)+'\nnull\n'+JSON.stringify({type:'custom_message',id:'after-completed-oversize',...m})+'\n');
    for(let i=0;i<4;i++) {
      const rec=operate(new Store(f.dir),query('status'));
      assert.equal(rec.facts.consumed,false); assert.notEqual(rec.evidence,'absent');
    }
    assert.equal(operate(new Store(f.dir),query('status')).state,'consumed');
  } finally {await f.r.close();}
});

test('128 active payload slots are separate from permanent terminal receipts', async()=>{
  const f=setup(); try {
    for(let i=0;i<128;i++) operate(f.store,send(`active-${i}`));
    assert.throws(()=>operate(f.store,send('active-overflow')),{code:'CAPACITY'});
    operate(f.store,query('cancel','active-0')); operate(f.store,send('replacement'));
    assert.equal(Object.keys(f.store.read().external).length,129);
    assert.throws(()=>operate(f.store,send('active-0')),{code:'CANCELLED'});
  } finally {await f.r.close();}
});

test('one file window per transaction rotates past an unfinished discard to another exact proof', async()=>{
  const f=setup(); try {
    operate(f.store,send()); claim(f.store,requestKey(send()),'pi/target',f.r.epoch,Date.now());
    const second=path.join(f.dir,'second.jsonl');
    f.store.tx(s=>{s.sessions['pi/target'].transcript=second;});
    operate(f.store,send('second')); const taken=claim(f.store,requestKey(send('second')),'pi/target',f.r.epoch,Date.now());
    await f.r.close();
    fs.appendFileSync(f.file,'x'.repeat(900000));
    fs.writeFileSync(second,JSON.stringify({type:'session',id:'target'})+'\n'+JSON.stringify({type:'custom_message',customType:TYPE,id:'second-entry',details:{internal:taken.internal,claim:taken.claim,digest:taken.digest},content:content(taken)})+'\n');
    assert.equal(operate(f.store,query('status','second')).facts.consumed,false);
    const offset=f.store.read().externalScans[scanKey(f.file)].offset;
    assert.equal(operate(f.store,query('status','second')).state,'consumed');
    assert.equal(f.store.read().externalScans[scanKey(f.file)].offset,offset);
  } finally {await f.r.close();}
});

test('near native byte ceiling permits external admission, claim, cursor/proof and continued native reconcile', {timeout:20000}, async()=>{
  const f=setup(); try {
    f.store.tx(s=>{
      s.requests.native={id:'native',from:'pi/target',to:'pi/other',status:'queued',expectReply:false,deadline:0};
      const size=Buffer.byteLength(JSON.stringify({sessions:s.sessions,requests:s.requests,creates:s.creates}));
      s.creates.padding='x'.repeat(NATIVE_BYTES-size-150);
    });
    operate(f.store,send()); await f.r.reconcile();
    assert.equal(f.store.read().requests.native.status,'timeout');
    fs.appendFileSync(f.file,'x'.repeat(600000));
    assert.equal(operate(f.store,query('status')).evidence,'oversized_record');
    assert.equal(f.store.read().sessions['pi/target'].proofScan,undefined);
    fs.appendFileSync(f.file,'\n'+JSON.stringify({type:'custom_message',id:'entry',...f.calls[0][0]})+'\n');
    for(let i=0;i<4;i++) operate(f.store,query('status'));
    assert.equal(operate(f.store,query('status')).facts.consumed,true);
    await f.r.reconcile(); assert.equal(f.store.read().requests.native.status,'timeout');
  } finally {await f.r.close();}
});

test('50,000 realistic permanent compact identities retain lookup/conflict/cancel/late proof at full count', {timeout:120000}, async t=>{
  const f=setup(); await f.r.close();
  const body=i=>send(`retained-${i}`,{caller:'docket-'+'a'.repeat(32),text:`Synthetic finite reminder ${i}: `+'context '.repeat(90)});
  const known=body(1), late=body(3);
  f.store.tx(s=>{
    s.sessions['pi/target'].online=true; s.sessions['pi/target'].heartbeat=Date.now();
    for(let i=0;i<50000;i++) {
      const x=body(i), r={internal:hash(`internal-${i}`).slice(0,36),digest:digest(x),to:x.to,text:x.text,
        admitted:true,state:i%4===0?'cancelled':i%4===1?'consumed':i%4===2?'failed':'uncertain'};
      if(i%4===1 || i%4===3) Object.assign(r,{claim:hash(`claim-${i}`).slice(0,36),injected:true,observed:true,uncertainty:true,evidence:i%4===1?'saved_exact':'absent',file:f.file,session:'target'});
      if(i%4===1) r.proof={entry:hash(`entry-${i}`),record:hash(`record-${i}`)};
      s.external[requestKey(x)]=r;
    }
  });
  const state=f.store.read(), bytes=fs.statSync(f.store.file).size;
  assert.equal(Object.keys(state.external).length,50000); assert.ok(bytes>16*1024*1024);
  assert.ok(Buffer.byteLength(JSON.stringify([state.external,state.externalScans]))+50000*TRANSITION_BYTES<ADMISSION_BYTES);
  assert.equal(Object.values(state.external).some(r=>Object.hasOwn(r,'text')),false);
  assert.equal(operate(f.store,known).state,'consumed');
  assert.throws(()=>operate(f.store,{...known,text:'changed'}),{code:'CONFLICT'});
  assert.equal(operate(f.store,{...query('cancel',body(0).id),caller:body(0).caller}).state,'cancelled');
  assert.throws(()=>operate(f.store,body(0)),{code:'CANCELLED'});
  assert.throws(()=>operate(f.store,send('new-at-full')),{code:'CAPACITY'});
  assert.throws(()=>operate(f.store,query('cancel','new-at-full')),{code:'CAPACITY'});
  const r=state.external[requestKey(late)];
  fs.appendFileSync(f.file,JSON.stringify({type:'custom_message',customType:TYPE,id:'late-entry',details:{internal:r.internal,claim:r.claim,digest:r.digest},content:content({...r,text:late.text})})+'\n');
  const q={...query('status',late.id),caller:late.caller};
  assert.equal(operate(new Store(f.dir),q).state,'consumed');
  assert.throws(()=>operate(f.store,{...q,op:'cancel'}),{code:'TOO_LATE'});
  assert.equal(capabilities().maxRetainedIdentities,50000);
  // Real Runtime admission, not just timeout reconciliation, with >12 MiB of
  // retained external metadata and a genuinely registered/live Pi peer.
  const retained=hash(JSON.stringify(f.store.read().external)), delivered=[];
  let ocCalls=0;
  const sender=new Runtime({root:f.dir,session:'native-sender',cwd:f.dir,sendMessage:()=>{},oc:{
    url:'http://127.0.0.1:1',events:async()=>{},send:async r=>{
      assert.equal(f.store.read().requests[r.id].status,'admitted'); ocCalls++;
    }
  }});
  const peer=new Runtime({root:f.dir,session:'native-peer',cwd:f.dir,sendMessage:m=>delivered.push(m)});
  try {
    sender.start(); peer.start();
    const pi=await sender.send(peer.self,'Synthetic native admission',{id:'retained-native',expectReply:false});
    assert.equal(pi.status,'admitted');
    await peer.reconcile();
    assert.equal(delivered.length,1); assert.equal(delivered[0].details.request,pi.id);
    const oc=await sender.send('oc/ses_fixture','Synthetic fake OC admission',{id:'retained-oc',expectReply:false});
    assert.equal(oc.status,'sent'); assert.equal(ocCalls,1);
  } finally {await sender.close(); await peer.close();}
  assert.equal(Object.keys(f.store.read().external).length,50000);
  assert.equal(hash(JSON.stringify(f.store.read().external)),retained);
  t.diagnostic(`retained identities=50000, ledger bytes=${bytes}, active payloads=0; late exact proof resolved after compaction`);
});

test('candidate-inclusive native byte limit rejects new Runtime Pi/OC admission without effects or byte changes', {timeout:20000}, async()=>{
  const dir=root(), store=new Store(dir); let ocCalls=0;
  const sender=new Runtime({root:dir,session:'sender',cwd:dir,sendMessage:()=>{},oc:{url:'http://127.0.0.1:1',send:async()=>{ocCalls++;}}});
  const peer=new Runtime({root:dir,session:'peer',cwd:dir,sendMessage:()=>{}});
  try {
    sender.start(); peer.start();
    store.tx(s=>{
      const size=Buffer.byteLength(JSON.stringify({sessions:s.sessions,requests:s.requests,creates:s.creates}));
      s.creates.padding='x'.repeat(NATIVE_BYTES-size-512);
    });
    const before=hash(fs.readFileSync(store.file));
    for(const to of [peer.self,'oc/ses_fixture']) {
      await assert.rejects(sender.send(to,'x'.repeat(32768),{id:to===peer.self?'pi-limit':'oc-limit'}),/Native state capacity reached/);
      assert.equal(hash(fs.readFileSync(store.file)),before);
    }
    assert.equal(ocCalls,0); assert.deepEqual(store.read().requests,{});
    assert.equal(fs.existsSync(store.lock),false);
  } finally {await sender.close(); await peer.close();}
});

// Real overlapping owned processes. First holds the acquired transaction lock
// while the second tries. Retry only the same operation/key AFTER both exit.
async function race(dir, first, second) {
  const children=[];
  function participant(job) {
    const p=spawn(process.execPath,['tests/race-participant.mjs'],{stdio:['pipe','pipe','pipe','ipc']}); children.push(p);
    let stderr=''; p.stderr.on('data',b=>stderr+=b);
    const messages=[]; const waiters=[];
    p.on('message',m=>{messages.push(m); for(const w of waiters.splice(0)) w();});
    const wait=async type=>{while(!messages.some(m=>m.type===type)) await Promise.race([new Promise(resolve=>waiters.push(resolve)),done.then(()=>{if(!messages.some(m=>m.type===type)) throw Error('participant exited before barrier');})]); return messages.find(m=>m.type===type);};
    const done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(`participant exit ${code}: ${stderr}`)));});
    p.stdin.end(JSON.stringify({dir,...job})); return {p,wait,done};
  }
  const watchdog=setTimeout(()=>{for(const p of children) if(p.exitCode===null) p.kill('SIGKILL');},10000);
  try {
    const release=path.join(dir,'race-release');
    const a=participant({...first,hold:true,release}), b=participant(second);
    await Promise.all([a.wait('ready'),b.wait('ready')]); a.p.send('go');
    await a.wait('locked'); b.p.send('go');
    const contended=await b.wait('result');
    assert.equal(contended.error,'A2A_BUSY','second operation must actually contend before release');
    assert.equal(a.p.exitCode,null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'transaction.lock','owner'),'utf8')).pid,a.p.pid);
    assert.equal(fs.existsSync(release),false);
    fs.writeFileSync(release,'release',{flag:'wx',mode:0o600});
    const results=[await a.wait('result'),contended];
    assert.equal(results[0].error,undefined,'lock holder must finish its operation');
    await Promise.all([a.done,b.done]);
    for(let i=0;i<results.length;i++) if(results[i].error==='A2A_BUSY') {
      const job=[first,second][i];
      try {results[i].value=job.action==='claim'?claim(new Store(dir),requestKey(job.x),'pi/target','race-epoch',Date.now()):operate(new Store(dir),job.x); delete results[i].error;}
      catch(e) {results[i].error=e.code;}
    }
    return results;
  } finally {
    clearTimeout(watchdog);
    await Promise.all(children.map(p=>p.exitCode!==null?Promise.resolve():new Promise(resolve=>{p.once('exit',resolve);p.kill('SIGKILL');})));
  }
}
test('simultaneous send/send, send/cancel and both cancel/claim orders preserve durable barriers', {timeout:30000}, async t=>{
  for(const actions of [['send','send'],['cancel','send'],['send','cancel'],['cancel','claim'],['claim','cancel'],['claim','claim']]) {
    const dir=root(), store=new Store(dir);
    store.tx(s=>{s.sessions['pi/target']={externalV1:true,persistence:true,epoch:'race-epoch',online:true,pid:process.pid,heartbeat:Date.now(),transcript:path.join(dir,'session.jsonl')};});
    if(actions.includes('claim')) operate(store,send());
    const jobs=actions.map(action=>({action:action==='claim'?'claim':'operate',x:action==='send'||action==='claim'?send():query('cancel')}));
    const result=await race(dir,...jobs);
    const expectedError=actions[0]==='cancel'&&actions[1]==='send'?'CANCELLED':actions[0]==='claim'&&actions[1]==='cancel'?'TOO_LATE':undefined;
    assert.equal(result[1].error,expectedError);
    const saved=store.read().external[requestKey(send())];
    const claimed=result.filter(r=>r.value?.claim).length;
    assert.ok(claimed<=1);
    const taken=claim(new Store(dir),requestKey(send()),'pi/target','race-epoch',Date.now());
    let invocations=fs.existsSync(path.join(dir,'invocations'))?fs.readFileSync(path.join(dir,'invocations'),'utf8').trim().split('\n').length:0;
    if(taken) invocations++; // facade stand-in, only after durable claim
    assert.ok(invocations<=1);
    assert.equal(claim(new Store(dir),requestKey(send()),'pi/target','race-epoch',Date.now()),null);
    if(actions.includes('cancel') && actions[0]!=='claim') {
      assert.equal(saved.state,'cancelled');
      assert.throws(()=>operate(new Store(dir),send()),{code:'CANCELLED'});
    }
    if(saved.claim) assert.throws(()=>operate(new Store(dir),query('cancel')),{code:'TOO_LATE'});
  }
  t.diagnostic('6 parent-released races observed A2A_BUSY while the first participant owned the lock; retries began only after both children exited');
});
test('atomic cancel vs claim barriers, immutable fields, expiry, owner epoch and legacy rejection', async () => {
  const f=setup(); try {
    operate(f.store,send()); operate(f.store,query('cancel'));
    assert.equal(claim(f.store,requestKey(send()),'pi/target',f.r.epoch,Date.now()),null);
    operate(f.store,send('two')); const k=requestKey(send('two'));
    assert.ok(claim(f.store,k,'pi/target',f.r.epoch,Date.now()));
    assert.throws(()=>operate(f.store,query('cancel','two')),{code:'TOO_LATE'});
    assert.equal(claim(f.store,k,'pi/target',f.r.epoch,Date.now()),null);
    operate(f.store,send('expired')); claim(f.store,requestKey(send('expired')),'pi/target',f.r.epoch,Date.now()+400000);
    assert.equal(operate(f.store,query('status','expired')).state,'failed');
    operate(f.store,send('epoch')); f.store.tx(s=>{s.sessions['pi/target'].epoch='replacement';});
    assert.equal(claim(f.store,requestKey(send('epoch')),'pi/target',f.r.epoch,Date.now()),null);
    f.store.tx(s=>{delete s.sessions['pi/target'].externalV1;});
    assert.throws(()=>operate(f.store,send('old')),{code:'UNSUPPORTED_TARGET'});
  } finally {await f.r.close();}
});
test('multiple external queue/steer wakes bypass active native work and never become native requests', async () => {
  const f=setup(); try {
    f.r.active={id:'native',focus:true};
    f.store.tx(s=>{s.requests.native={id:'native',from:'pi/sender',to:'pi/target',status:'queued',injected:true,expectReply:true,deadline:Date.now()+60000};});
    for(let i=0;i<3;i++) operate(f.store,send(`q${i}`,{delivery:i===2?'steer':'queue'}));
    await f.r.reconcile(); await f.r.reconcile();
    assert.equal(f.calls.length,3); assert.deepEqual(f.calls.map(c=>c[1].deliverAs),['followUp','followUp','steer']);
    f.r.message({type:'message_start',message:{role:'custom',...f.calls[0][0]}}); assert.equal(f.r.active.focus,false);
    assert.deepEqual(Object.keys(f.store.read().requests),['native']);
  } finally {f.r.active=null; await f.r.close();}
});
test('no event/facade ack proves consumption; exact complete saved entry, session header and proof persistence required', async () => {
  const f=setup(); try {
    operate(f.store,send()); await f.r.reconcile(); const m=f.calls[0][0];
    f.r.message({type:'message_end',message:{role:'custom',...m}}); await f.r.reconcile();
    assert.equal(operate(f.store,query('status')).facts.consumed,false);
    const line=JSON.stringify({type:'custom_message',id:'entry',...m}); fs.appendFileSync(f.file,line);
    assert.equal(operate(f.store,query('status')).facts.consumed,false);
    fs.appendFileSync(f.file,'\n'); assert.equal(operate(f.store,query('status')).state,'consumed');
    assert.equal(operate(new Store(f.dir),query('status')).facts.consumed,true);
  } finally {await f.r.close();}
});
test('async facade rejection and crash after claim never replay; missing and mismatched proof fail closed', async () => {
  const f=setup({sendMessage:()=>Promise.reject(Error('private provider error'))});
  try {
    operate(f.store,send()); await f.r.reconcile(); await f.r.reconcile();
    assert.equal(operate(f.store,query('status')).state,'uncertain');
    await f.r.close(); const calls=[]; const r=new Runtime({root:f.dir,session:'target',cwd:f.dir,transcript:()=>f.file,sendMessage:m=>calls.push(m)}); r.start();
    try { await r.reconcile(); assert.equal(calls.length,0);
      fs.writeFileSync(f.file,JSON.stringify({type:'session',id:'different'})+'\n');
      assert.equal(operate(f.store,query('status')).evidence,'session_mismatch');
      fs.unlinkSync(f.file); assert.equal(operate(f.store,query('status')).facts.consumed,false);
    } finally {await r.close();}
  } finally {await f.r.close();}
});
test('store precommit and potentially committed postrename failures never authorize a second claim', async () => {
  const f=setup(); try {
    operate(f.store,send()); const original=f.store.tx.bind(f.store);
    f.store.tx=fn=>original(s=>{fn(s);throw Error('before commit');});
    await assert.rejects(f.r.reconcile()); assert.equal(f.calls.length,0);
    f.store.tx=fn=>{original(fn);throw Error('after commit');};
    await assert.rejects(f.r.reconcile()); assert.equal(f.calls.length,0);
    f.store.tx=original; await f.r.reconcile(); assert.equal(f.calls.length,0);
    assert.equal(operate(f.store,query('status')).state,'uncertain');
  } finally {await f.r.close();}
});
test('old state is rejected, never migrated or modified',()=>{
  const dir=root(),file=path.join(dir,'state.json'),body='{"v":1,"sessions":{},"requests":{},"creates":{}}';
  fs.writeFileSync(file,body,{mode:0o600}); assert.throws(()=>new Store(dir).read(),/version/); assert.equal(fs.readFileSync(file,'utf8'),body);
});

test('proof rejects wrong tokens/digests/content and oversized records; saved proof survives receipt commit failure', async()=>{
  const f=setup(); try {
    operate(f.store,send()); await f.r.reconcile(); const m=f.calls[0][0];
    const append=x=>fs.appendFileSync(f.file,JSON.stringify({type:'custom_message',id:'fixture-entry',...x})+'\n');
    append({...m,details:{...m.details,claim:'wrong'}});
    append({...m,details:{...m.details,digest:'wrong'}});
    append({...m,content:m.content+'changed'});
    assert.equal(operate(f.store,query('status')).facts.consumed,false);
    append(m);
    const original=f.store.tx.bind(f.store);
    f.store.tx=fn=>original(s=>{fn(s);throw Error('proof commit failure');});
    assert.throws(()=>operate(f.store,query('status')));
    assert.equal(f.store.read().external[requestKey(send())].proof,undefined);
    f.store.tx=original;
    assert.equal(operate(f.store,query('status')).state,'consumed');
    const escaped=send('escaped',{text:'\u0000'.repeat(32767)+'x'});
    operate(f.store,escaped); await f.r.reconcile();
    append(f.calls.at(-1)[0]);
    assert.equal(operate(f.store,query('status','escaped')).state,'consumed');
    operate(f.store,send('unicode',{text:'replacement \ufffd'})); await f.r.reconcile();
    const unicode=f.calls.at(-1)[0];
    append({...unicode,content:unicode.content.replace('\ufffd','\ud800')});
    assert.equal(operate(f.store,query('status','unicode')).facts.consumed,false);
    append(unicode); assert.equal(operate(f.store,query('status','unicode')).state,'consumed');
    operate(f.store,send('oversized')); await f.r.reconcile();
    fs.appendFileSync(f.file,'x'.repeat(262145));
    // Completed earlier proofs may have released the cursor; allow their one
    // bounded rescan window before the oversized tail is reached.
    let tail;
    for(let i=0;i<3;i++) {tail=operate(f.store,query('status','oversized')); assert.equal(tail.facts.consumed,false);}
    assert.equal(tail.evidence,'oversized_record');
    assert.equal(operate(f.store,query('status','oversized')).facts.consumed,false);
  } finally {await f.r.close();}
});
