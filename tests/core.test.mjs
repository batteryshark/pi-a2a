import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { envelope, address, admit, ocOutcome } from '../src/protocol.mjs';
import { Runtime } from '../src/runtime.mjs';
import { chiefTarget, loopback, OpenCode, messageID } from '../src/opencode.mjs';
import { workerArgs } from '../src/worker.mjs';
import { EventEmitter } from 'node:events';
import { fixtureRoot, reconcileUntil } from './fixture.mjs';

// All session IDs, messages, endpoints and auth strings in this suite are synthetic.
const roots = [];
function root() { const r = fixtureRoot(); roots.push(r); return r; }
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const make = (dir, session, extra = {}) => { const messages = []; const r = new Runtime({ root: dir, session, cwd: dir, extension: path.resolve('index.ts'), sendMessage: (...args) => messages.push(args), ...extra }); r.messages = messages; return r; };
function inbound(r) { r.message({ message: { role: 'custom', customType: 'pi-a2a-request', details: { request: r.active.id } } }); }
function answer(r, s, stopReason = 'stop') { r.message({ message: { role: 'assistant', content: [{ type: 'text', text: s }], stopReason } }); }
function reply(r, id) { const m = r.messages.find(([m]) => m.details?.replyId === `${id}-reply`)[0]; r.message({ type: 'message_start', message: { role: 'custom', ...m } }); return m; }

test('strict addresses, payload byte bounds, IDs, self-send and route loop defenses', () => {
  for (const bad of ['pi/../x', 'pi/a/b', 'pi/%2f', 'oc/abc', 'http://x', 'pi/' + 'x'.repeat(97)]) assert.throws(() => address(bad));
  assert.equal(address('chief').kind, 'chief'); assert.equal(address('pi/a').session, 'a');
  assert.throws(() => envelope('pi/a', 'pi/b', 'é'.repeat(16385)));
  assert.throws(() => envelope('pi/a', 'pi/a', 'x'));
  assert.throws(() => envelope('pi/b', 'pi/a', 'x', {}, envelope('pi/a', 'pi/b', 'x')));
  assert.throws(() => envelope('pi/a', 'pi/b', 'x', { id: '../bad' }));
});
test('owner-only state, atomic admission/dedup and per-target serialization', () => {
  const dir = root(), store = new Store(dir), r = envelope('pi/a', 'pi/b', 'x');
  store.tx(s => admit(s, r)); store.tx(s => admit(s, r));
  assert.equal(Object.keys(store.read().requests).length, 1);
  assert.throws(() => store.tx(s => admit(s, { ...r, text: 'spoof' })));
  assert.throws(() => store.tx(s => admit(s, envelope('pi/c', 'pi/b', 'x'))));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
    const link = path.join(dir, 'linked'); fs.symlinkSync(dir, link); assert.throws(() => new Store(link));
    fs.chmodSync(store.file, 0o644); assert.throws(() => store.read());
  } // Windows counterparts are real ACL/junction negatives in test:windows.
});
test('transaction contention fails clearly without waiting or clobbering', () => {
  const store = new Store(root());
  store.tx(s => { assert.throws(() => store.tx(() => {}), /busy/); s.marker = 1; });
  assert.equal(store.read().marker, 1);
});
test('idle request auto wake, busy followUp, true settled correlation and reply wake', async () => {
  const dir = root(), a = make(dir, 'a'), b = make(dir, 'b'); a.start(); b.start();
  try {
    const sent = await a.send('pi/b', 'Do a task');
    assert.equal(a.store.read().requests[sent.id].status, 'admitted');
    await reconcileUntil(b,()=>b.active?.id===sent.id,'receiver dispatches original request');
    assert.deepEqual(b.messages[0][1], { triggerTurn: true, deliverAs: 'followUp' });
    answer(b, 'unrelated busy-turn output'); b.settled();
    assert.equal(b.store.read().requests[sent.id].status, 'queued');
    inbound(b); answer(b, 'intermediate'); // agent_end is deliberately not an integration hook
    assert.equal(b.store.read().requests[sent.id].status, 'queued');
    answer(b, 'final'); b.beforeSettle({ outcome: 'completed' }); b.settled(); await reconcileUntil(a,()=>hasReply(a,sent.id),'sender queues final reply');
    assert.equal(a.messages.length, 1); assert.match(a.messages[0][0].content, /final/);
    assert.equal(a.messages[0][1].triggerTurn, true);
    await a.reconcile(); assert.equal(a.messages.length, 1);
    assert.equal(a.store.read().requests[sent.id].status, 'completed');
  } finally { await b.close(); await a.close(); }
});
test('steer delivery, error and abort outcomes remain request specific', async () => {
  const dir = root(), a = make(dir, 'a'), b = make(dir, 'b'); a.start(); b.start();
  try {
    for (const status of ['error', 'abort']) {
      const r = await a.send('pi/b', status, { delivery: 'steer' }); await reconcileUntil(b,()=>b.active?.id===r.id,`receiver dispatches ${status} request`);
      assert.equal(b.messages.at(-1)[1].deliverAs, 'steer'); inbound(b);
      answer(b, status, status === 'abort' ? 'aborted' : 'error');
      b.beforeSettle({ outcome: status === 'abort' ? 'aborted' : 'error' }); b.settled();
      assert.equal(a.store.read().requests[r.id].status, status);
    }
  } finally { await b.close(); await a.close(); }
});
test('offline rejection, persisted reply while owner offline, recovery without replay', async () => {
  const dir = root(), a = make(dir, 'a'), b = make(dir, 'b'); a.start(); b.start();
  await assert.rejects(a.send('pi/missing', 'x'), /offline/);
  const r = await a.send('pi/b', 'x'); await a.close(); await reconcileUntil(b,()=>b.active?.id===r.id,'receiver dispatches while sender offline'); inbound(b); answer(b, 'durable'); b.settled();
  const resumed = make(dir, 'a'); resumed.start(); await reconcileUntil(resumed,()=>hasReply(resumed,r.id),'resumed Runtime queues durable reply');
  assert.match(resumed.messages[0][0].content, /durable/);
   assert.equal(resumed.store.read().requests[r.id].notified, false); // enqueue is not consumption
  await resumed.close(); await b.close();
});
test('reload of injected turn blocks instead of duplicate model execution; timeout releases pending', async () => {
  const dir = root(), a = make(dir, 'a'), b = make(dir, 'b'); a.start(); b.start();
  const sent = await a.send('pi/b', 'x'); await reconcileUntil(b,()=>b.active?.id===sent.id,'receiver injects before reconstruction'); await b.close();
  const resumed = make(dir, 'b'); resumed.start(); await resumed.reconcile();
  assert.equal(resumed.messages.length, 0); assert.equal(a.store.read().requests[sent.id].status, 'blocked');
  a.now = () => Date.now() + 200000; await reconcileUntil(a,()=>a.store.read().requests[sent.id].status==='timeout','expired reloaded request times out');
  assert.equal(a.store.read().requests[sent.id].status, 'timeout');
  await resumed.close(); await a.close();
});
test('one live process owner per transcript, including same-process double load', async () => {
  const dir = root(), a = make(dir, 'a'); a.start();
  assert.throws(() => make(dir, 'a').start(), /already owned/); await a.close();
});
test('OpenCode strict closing-idle correlation ignores newer unrelated turns and active targets', () => {
  const data = [ { id: 'idle-new', type: 'idle', outcome: 'succeeded' }, { id: 'other', type: 'assistant', content: [{ type: 'text', text: 'WRONG' }] },
    { id: 'close', type: 'idle', outcome: 'succeeded' }, { id: 'answer', type: 'assistant', content: [{ type: 'text', text: 'RIGHT' }] }, { id: 'mine', type: 'user' } ];
  assert.equal(ocOutcome(data, 'mine', false).answer, 'RIGHT');
  assert.equal(ocOutcome(data, 'missing', false), null); assert.equal(ocOutcome(data, 'mine', true), null);
  assert.equal(ocOutcome(data.slice(3), 'mine', false), null);
  for (const [outcome, status] of [['failed', 'error'], ['interrupted', 'abort']]) assert.equal(ocOutcome([{ id: 'idle', type: 'idle', outcome }, { id: 'mine' }], 'mine', false).status, status);
});
test('chief pointer validation and per-send rotation pinning; durable-before-send; no replay on restart', async () => {
  const dir = root(), file = path.join(dir, 'chief.json');
  fs.writeFileSync(file, JSON.stringify({ session: 'ses_fake_one', directory: dir }));
  const seen = [], oc = { url: 'http://127.0.0.1:1234', async send(r) { assert.ok(a.store.read().requests[r.id]); seen.push(r.to); throw Error('ambiguous'); }, async outcome() { return null; }, async events() {} };
  const a = make(dir, 'a', { oc, chiefFile: file }); a.start();
  const r = await a.send('chief', 'one');
  fs.writeFileSync(file, JSON.stringify({ session: 'ses_fake_two', directory: dir }));
  const s = await a.send('chief', 'two');
  assert.equal(a.store.read().requests[r.id].to, 'oc/ses_fake_one'); assert.equal(a.store.read().requests[s.id].to, 'oc/ses_fake_two');
  await a.reconcile(); assert.deepEqual(seen, ['oc/ses_fake_one', 'oc/ses_fake_two']); await a.close();
  const resumed = make(dir, 'a', { oc, chiefFile: file }); resumed.start(); await resumed.reconcile();
  assert.equal(seen.length, 2); await resumed.close();
  fs.writeFileSync(file, JSON.stringify({ session: 'ses_fake_one', directory: 'relative' })); assert.throws(() => chiefTarget(file));
});
test('loopback-only auth inherited not persisted; pagination and stable admission ID', async () => {
  for (const u of ['https://example.com', 'http://a@localhost', 'http://localhost/path']) assert.throws(() => loopback(u));
  const calls = [], client = new OpenCode({ url: 'http://127.0.0.1:1', env: { OPENCODE_SERVER_PASSWORD: 'not-a-secret-fixture' }, fetchImpl: async (u, init) => {
    calls.push({ u, init }); return { ok: true, json: async () => u.includes('cursor=next') ? { data: [{ id: 'old' }], cursor: {} } : { data: [{ id: 'new' }], cursor: { next: 'next' } } };
  } });
  assert.equal((await client.records('ses_fake_x')).length, 2); assert.match(calls[1].u, /cursor=next/);
  const r = envelope('pi/a', 'oc/ses_fake_x', 'x'); await client.send(r); await client.send(r);
  assert.equal(JSON.parse(calls.at(-1).init.body).id, messageID(r));
  assert.ok(messageID({ ...r, created: r.created + 1 }) > messageID(r));
  assert.ok(calls[0].init.headers.authorization.startsWith('Basic '));
});
test('worker requires explicit allowed model/cwd/tool policy, isolation and transcript path', () => {
  const opts = { model: 'openai-codex/gpt-5.4', directory: root(), extension: '/workspace/extension.ts', transcript: '/workspace/transcript.jsonl', tools: ['read', 'a2a_send'] };
  const args = workerArgs(opts); assert.ok(args.includes('--no-mcp')); assert.ok(args.includes('--no-extensions'));
  assert.throws(() => workerArgs({ ...opts, model: 'anthropic/claude' }));
  assert.throws(() => workerArgs({ ...opts, tools: ['bash'] })); assert.throws(() => workerArgs({ ...opts, directory: '.' }));
});
test('bounded worker root reservations, non-nested real reply ownership, single-use settle and cleanup (fake RPC)', async () => {
  const dir = root(), spawned = [];
  let runtime;
  const spawnImpl = (_bin, args, options) => {
    const child = new EventEmitter(); child.pid = process.pid; child.exitCode = null;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { if (child.exitCode === null) { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); } };
    child.stdin = { end() {}, write(line) {
      const command = JSON.parse(line), token = options.env.PI_A2A_CREATE;
      runtime.store.tx(s => { s.sessions[`pi/worker-${spawned.length}`] = { address: `pi/worker-${spawned.length}`, create: token, pid: child.pid }; });
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'response', id: command.id, success: true }) + '\n')));
    } };
    spawned.push({ child, args, options }); queueMicrotask(() => child.emit('spawn')); return child;
  };
  runtime = make(dir, 'owner', { spawnImpl }); runtime.start();
  try {
    const opts = { model: 'openai-codex/gpt-5.4', directory: dir, tools: [], nest: false };
    const first = await runtime.createWorker(opts); const second = await runtime.createWorker(opts);
    assert.equal(first.parent, 'pi/owner'); assert.equal(first.replyOwner, 'pi/owner'); assert.equal(first.nested, false);
    assert.ok(!JSON.stringify(first).includes('undefined')); assert.notEqual(first.to, second.to);
    await assert.rejects(runtime.createWorker(opts), /Two-worker/);
    assert.equal(spawned.length, 2);
    spawned[0].child.stdout.emit('data', Buffer.from('{"type":"agent_end"}\n'));
    assert.equal(spawned[0].child.exitCode, null);
    spawned[0].child.stdout.emit('data', Buffer.from('{"type":"agent_settled"}\n'));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(spawned[0].child.exitCode, 0);
  } finally { await runtime.close(); }
  assert.equal(runtime.children.size, 0);
});
test('blocked UI is nonterminal; dedup does not repeat OpenCode effect; expired requests never turn completed', async () => {
  const dir = root(); let sends = 0;
  const oc = { url: 'http://127.0.0.1:1', async send() { sends++; }, async events() {}, async outcome() { return { status: 'completed', answer: 'too late' }; } };
  const a = make(dir, 'a', { oc }), b = make(dir, 'b'); a.start(); b.start();
  try {
    const r = await a.send('pi/b', 'x'); await reconcileUntil(b,()=>b.active?.id===r.id,'receiver dispatches before UI block'); b.blocked(true);
    assert.equal(a.store.read().requests[r.id].status, 'blocked'); b.blocked(false);
    assert.equal(a.store.read().requests[r.id].status, 'queued');
    const opts = { id: 'stable' }; await a.send('oc/ses_fake_test', 'x', opts); await a.send('oc/ses_fake_test', 'x', opts);
    assert.equal(sends, 1); a.now = () => Date.now() + 200000;
    await reconcileUntil(a,()=>a.store.read().requests.stable.status==='timeout','expired OC request times out');
    assert.equal(a.store.read().requests.stable.status, 'timeout');
    assert.equal(sends, 1,'deadline reconciliation never repeats the external send');
  } finally { await b.close(); await a.close(); }
});
test('inbound logical request stays open across detached nested reply; no interim final', async () => {
  const dir = root(), a = make(dir, 'a'), b = make(dir, 'b'), c = make(dir, 'c'); a.start(); b.start(); c.start();
  try {
    const original = await a.send('pi/b', 'delegate'); await reconcileUntil(b,()=>b.active?.id===original.id,'parent dispatch'); inbound(b);
    const nested = await b.send('pi/c', 'compute'); answer(b, 'interim delegation'); b.settled();
    assert.equal(a.store.read().requests[original.id].status, 'blocked');
    await a.reconcile(); assert.equal(a.messages.length, 0);
    await reconcileUntil(c,()=>c.active?.id===nested.id,'nested child dispatch'); inbound(c); answer(c, 'nested answer'); c.settled();
    await reconcileUntil(b,()=>hasReply(b,nested.id),'nested return queued'); assert.equal(b.store.read().requests[nested.id].notified, false); reply(b, nested.id);
    answer(b, 'synthesized final'); b.settled(); await reconcileUntil(a,()=>hasReply(a,original.id),'synthesized final queued');
    assert.match(a.messages[0][0].content, /synthesized final/);
  } finally { await c.close(); await b.close(); await a.close(); }
});

for (const earlyInjection of [false, true]) test(`terminal child before parent settlement; early injection=${earlyInjection}`, async () => {
  const dir = root(), a = make(dir, 'a'), b = make(dir, 'b'), c = make(dir, 'c'); a.start(); b.start(); c.start();
  try {
    const original = await a.send('pi/b', 'delegate'); await reconcileUntil(b,()=>b.active?.id===original.id,'parent dispatch before early return'); inbound(b);
    const child = await b.send('pi/c', 'compute'); answer(b, 'INTERIM');
    await reconcileUntil(c,()=>c.active?.id===child.id,'early-return child dispatch'); inbound(c); answer(c, 'child'); c.settled();
    if (earlyInjection) { await reconcileUntil(b,()=>hasReply(b,child.id),'early correlated reply queued'); reply(b, child.id); }
    b.settled();
    assert.equal(a.store.read().requests[original.id].status, 'blocked');
    b.message({ message: { role: 'user', content: 'unrelated human turn' } }); answer(b, 'UNRELATED'); b.settled();
    assert.equal(a.store.read().requests[original.id].status, 'blocked');
    if (earlyInjection) {
      // Already consumed, but interrupted before synthesis: never guess a final.
      assert.equal(b.active.answer, ''); return;
    }
    await reconcileUntil(b,()=>hasReply(b,child.id),'late correlated reply queued'); reply(b, child.id); answer(b, 'SYNTHESIS'); b.settled();
    assert.equal(a.store.read().requests[original.id].answer, 'SYNTHESIS');
  } finally { await c.close(); await b.close(); await a.close(); }
});

test('reply before original settlement can synthesize, and duplicate end event does not erase synthesis', async () => {
  const dir = root(), a = make(dir, 'a'), b = make(dir, 'b'), c = make(dir, 'c'); a.start(); b.start(); c.start();
  try {
    const original = await a.send('pi/b', 'delegate'); await reconcileUntil(b,()=>b.active?.id===original.id,'parent dispatch before duplicate-event test'); inbound(b);
    const child = await b.send('pi/c', 'compute'); answer(b, 'INTERIM');
    await reconcileUntil(c,()=>c.active?.id===child.id,'duplicate-event child dispatch'); inbound(c); answer(c, 'child'); c.settled(); await reconcileUntil(b,()=>hasReply(b,child.id),'reply before parent settlement queued');
    const m = reply(b, child.id); answer(b, 'SYNTHESIS');
    b.message({ type: 'message_end', message: { role: 'custom', ...m } }); b.settled();
    assert.equal(a.store.read().requests[original.id].answer, 'SYNTHESIS');
  } finally { await c.close(); await b.close(); await a.close(); }
});

const hasReply=(r,id)=>r.messages.some(([m])=>m.details?.replyId===`${id}-reply`);
for (const controlled of [false,true]) test(`three-level nested return requires synthesis at every ancestor in adverse order${controlled?' with a shared pre-settlement snapshot':''}`, async () => {
  const dir = root(), peers = ['a', 'b', 'c', 'd'].map(id => make(dir, id)); const [a, b, c, d] = peers;
  let release=()=>{};
  for (const r of peers) r.start();
  try {
    const ab = await a.send('pi/b', 'delegate'); await reconcileUntil(b,()=>b.active?.id===ab.id,'three-level parent dispatch'); inbound(b);
    const bc = await b.send('pi/c', 'delegate'); answer(b, 'B INTERIM');
    const sibling = await b.send('pi/d', 'sibling');
    await reconcileUntil(d,()=>d.active?.id===sibling.id,'sibling dispatch'); inbound(d); answer(d, 'sibling answer'); d.settled(); await reconcileUntil(b,()=>hasReply(b,sibling.id),'sibling reply queued'); reply(b, sibling.id);
    answer(b, 'still interim'); b.settled();
    assert.equal(a.store.read().requests[ab.id].status, 'blocked');
    await reconcileUntil(c,()=>c.active?.id===bc.id,'middle child dispatch'); inbound(c); const cd = await c.send('pi/d', 'deep'); answer(c, 'C INTERIM');
    await reconcileUntil(d,()=>d.active?.id===cd.id,'deep child dispatch'); inbound(d); answer(d, 'deep answer'); d.settled();
    c.settled(); assert.equal(a.store.read().requests[bc.id].status, 'blocked');
    let existing;
    if (controlled) {
      await b.reconcile();
      const turn=b.turn.bind(b);let turns=0,ready;
      const snapshot=new Promise(resolve=>{ready=resolve;});
      const gate=new Promise(resolve=>{release=resolve;});
      b.turn=async()=>{const result=await turn();if(++turns===2){ready();await gate;}return result;};
      existing=b.reconcile();
      await Promise.race([snapshot,existing.then(()=>{throw Error('pass ended before controlled snapshot gate');})]);
      assert.equal(a.store.read().requests[bc.id].status,'blocked');
    }
    await reconcileUntil(c,()=>hasReply(c,cd.id),'deep child reply queued'); reply(c, cd.id); answer(c, 'C SYNTHESIS'); c.settled();
    assert.equal(a.store.read().requests[bc.id].answer, 'C SYNTHESIS');
    answer(b, 'UNRELATED'); b.settled(); assert.equal(a.store.read().requests[ab.id].status, 'blocked');
    if (controlled) {
      assert.equal(b.reconcile(),existing,'call joins pre-settlement snapshot, not a new pass');
      release();await existing;
      assert.equal(hasReply(b,bc.id),false,'old snapshot cannot enqueue a newly settled return');
      assert.equal(b.moreWork,true,'final snapshot schedules the missing return');
    }
    await reconcileUntil(b,()=>hasReply(b,bc.id),'middle synthesis reply queued'); reply(b, bc.id); answer(b, 'B SYNTHESIS'); b.settled();
    assert.equal(a.store.read().requests[ab.id].answer, 'B SYNTHESIS');
    for (const [r,id] of [[b,sibling.id],[c,cd.id],[b,bc.id]]) assert.equal(r.messages.filter(([m])=>m.details?.replyId===`${id}-reply`).length,1,'exactly one queued correlated reply');
  } finally { release();for (const r of peers.reverse()) await r.close(); }
});

test('independent outgoing request cannot hold or resolve an inbound request', async () => {
  const dir = root(), a = make(dir, 'a'), b = make(dir, 'b'), c = make(dir, 'c'); a.start(); b.start(); c.start();
  try {
    const independent = await b.send('pi/c', 'independent');
    const original = await a.send('pi/b', 'direct'); await reconcileUntil(b,()=>b.active?.id===original.id,'independent-return parent dispatch'); inbound(b); answer(b, 'DIRECT'); b.settled();
    assert.equal(a.store.read().requests[original.id].answer, 'DIRECT');
    assert.equal(a.store.read().requests[independent.id].parentRequest, undefined);
  } finally { await c.close(); await b.close(); await a.close(); }
});

test('final candidate and UI hook survive real cross-process root lock release with no model event', async () => {
  const { spawn } = await import('node:child_process');
  const dir = root(), a = make(dir, 'a'), b = make(dir, 'b'); a.start(); b.start();
  let child;
  try {
    const original = await a.send('pi/b', 'answer'); await reconcileUntil(b,()=>b.active?.id===original.id,'candidate dispatch before cross-process lock'); inbound(b); answer(b, 'FINAL');
    const storeURL = new URL('../src/store.mjs', import.meta.url).href;
    child = spawn(process.execPath, ['--input-type=module', '-e', `import {Store} from ${JSON.stringify(storeURL)}; new Store(${JSON.stringify(dir)}).tx(() => { process.stdout.write('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250); });`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(Error(`lock child ${code}`))); child.once('error', reject); });
    await new Promise(resolve => child.stdout.once('data', resolve));
    b.blocked(true); b.settled(); assert.equal(b.active.candidate.answer, 'FINAL');
    assert.notEqual(a.store.read().requests[original.id].status, 'completed');
    await exited;
    // The lock/state filesystem events, not a new model run, drive reconciliation.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { watcher.close(); reject(Error('candidate not reconciled')); }, 2000);
      const watcher = fs.watch(dir, () => { if (a.store.read().requests[original.id].status === 'completed') { clearTimeout(timer); watcher.close(); resolve(); } });
      if (a.store.read().requests[original.id].status === 'completed') { clearTimeout(timer); watcher.close(); resolve(); }
    });
    assert.equal(a.store.read().requests[original.id].answer, 'FINAL'); assert.equal(b.active, null); assert.equal(b.pendingWrites.size, 0);
  } finally { if (child?.exitCode === null) child.kill('SIGKILL'); await b.close(); await a.close(); }
});

test('completion retry budget retains candidate, fails closed, and deadline releases active slot', async () => {
  const dir = root(), a = make(dir, 'a'), b = make(dir, 'b'); a.start(); b.start();
  try {
    const original = await a.send('pi/b', 'x'); await reconcileUntil(b,()=>b.active?.id===original.id,'candidate dispatch before retry-budget test'); inbound(b); answer(b, 'FINAL');
    b.store.tx(() => { for (let i = 0; i < 40; i++) b.settled(); });
    assert.equal(b.active.candidateAttempts, 32); assert.equal(b.active.candidate.answer, 'FINAL');
    await b.reconcile(); assert.notEqual(a.store.read().requests[original.id].status, 'completed');
    b.now = () => Date.now() + 200000; await b.reconcile(); await b.reconcile();
    assert.equal(a.store.read().requests[original.id].status, 'timeout'); assert.equal(b.active, null);
  } finally { await b.close(); await a.close(); }
});
