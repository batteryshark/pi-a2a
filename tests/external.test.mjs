import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { Store } from '../src/store.mjs';
import { Runtime } from '../src/runtime.mjs';
import { parse, input } from '../src/machine.mjs';
import { operate, claim, requestKey, content, TYPE } from '../src/external.mjs';

const roots = [];
const root = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-a2a-wake-'))); roots.push(d); return d; };
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
  for(let i=1;i<128;i++) operate(store,query('cancel',`t${i}`));
  assert.throws(()=>operate(store,query('cancel','overflow')),{code:'CAPACITY'});
  assert.equal(operate(store,query('status')).state,'cancelled');
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
    operate(f.store,send('oversized')); await f.r.reconcile();
    fs.appendFileSync(f.file,'x'.repeat(262145));
    assert.equal(operate(f.store,query('status','oversized')).evidence,'oversized_record');
    assert.equal(operate(f.store,query('status','oversized')).facts.consumed,false);
  } finally {await f.r.close();}
});
