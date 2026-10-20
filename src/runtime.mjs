import fs from 'node:fs';
import { Store, live, key } from './store.mjs';
import { address, envelope, admit, terminal, assistantText, clip } from './protocol.mjs';
import { OpenCode, chiefTarget } from './opencode.mjs';
import { createWorker } from './worker.mjs';
import { id } from './store.mjs';
import { claim, content, TYPE, reconcileProof } from './external.mjs';

export class Runtime {
  constructor({ root, session, cwd, sendMessage, extension, piBin = process.env.PI_A2A_PI_BIN ?? 'pi', oc, parent = process.env.PI_A2A_PARENT,
    create = process.env.PI_A2A_CREATE, chiefFile, now = Date.now, spawnImpl, transcript = () => undefined }) {
    this.store = new Store(root); this.self = `pi/${key(session)}`; this.cwd = cwd;
    this.sendMessage = sendMessage; this.extension = extension; this.piBin = piBin;
    this.oc = oc ?? (process.env.PI_A2A_OC_URL ? new OpenCode({ url: process.env.PI_A2A_OC_URL }) : null);
    this.parent = parent; this.create = create; this.chiefFile = chiefFile; this.now = now;
    this.children = new Map(); this.active = null; this.closed = false; this.working = false;
    this.spawnImpl = spawnImpl;
    this.transcript = transcript; this.inFlight = new Set(); this.observedReplies = new Set(); this.pendingWrites = new Map();
    this.epoch = id(); this.externalWrites = new Map();
  }
  start() {
    this.store.tx(s => {
      const old = s.sessions[this.self];
      if (old?.online && live(old.pid)) throw Error('Transcript already owned by another Pi process');
      if (!old && Object.keys(s.sessions).length >= 128) throw Error('Session registry limit reached; offline archive required');
      s.sessions[this.self] = { address: this.self, cwd: this.cwd, pid: process.pid, online: true,
        externalV1: true, epoch: this.epoch, heartbeat: this.now(), persistence: !!this.transcript(), transcript: this.transcript(),
        ...(this.parent ? { parent: this.parent } : {}), ...(this.create ? { create: this.create } : {}) };
      for (const r of Object.values(s.requests)) if (r.to === this.self && r.injected && !terminal(r)) {
        r.status = 'blocked'; r.reason = 'Reload interrupted an admitted turn; no automatic replay. Operator must reconcile.';
      }
      for (const r of Object.values(s.external)) if (r.to === this.self && r.claim && !r.proof) {
        r.state = 'uncertain'; r.uncertainty = true;
      }
    });
    this.watcher = fs.watch(this.store.root, (_event, name) => { if (name === 'state.json' || name === 'transaction.lock') this.schedule(); });
    this.watcher.on('error', () => { this.watcher?.close(); });
    this.sweep = setInterval(() => this.schedule(), 30000); this.sweep.unref();
    this.schedule();
    if (this.parent && this.create) {
      // Child-side watchdog survives loss/SIGKILL of its RPC process owner.
      this.hardLimit = setTimeout(() => this.stopOwnWorker(), 600000);
    }
  }
  stopOwnWorker() {
    if (!this.parent || !this.create) return;
    const pid = process.pid;
    process.kill(pid, 'SIGTERM');
    setTimeout(() => process.kill(pid, 'SIGKILL'), 2000);
  }
  schedule(delay = 30) {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = null; this.reconcile().catch(() => {}); }, delay);
  }
  async send(to, text, opts = {}) {
    let pinned;
    if (to === 'chief') { pinned = chiefTarget(this.chiefFile); to = pinned.to; }
    const target = address(to);
    if (target.kind === 'oc' && !this.oc) throw Error('Set explicit PI_A2A_OC_URL for OpenCode');
    const r = envelope(this.self, to, text, opts, this.active?.focus ? this.active : null);
    if (pinned) r.chiefDirectory = pinned.directory;
    if (target.kind === 'oc') r.ocOrigin = this.oc.url;
    let duplicate = false;
    this.store.tx(s => {
      duplicate = !!s.requests[r.id];
      if (target.kind === 'pi') {
        const peer = s.sessions[to];
        if (!peer?.online || !live(peer.pid)) throw Error('Pi target offline; resume target before sending');
      }
      admit(s, r);
    });
    // Durable admission precedes every external effect; reconnect never re-POSTs.
    if (target.kind === 'oc' && !duplicate) {
      try { await this.oc.send(r); this.update(r.id, { status: 'sent' }); this.connectEvents(); }
      catch (error) { this.update(r.id, { status: 'blocked', reason: `OpenCode admission uncertain or refused (${error.name === 'Error' ? error.message : 'transport error'}); inspect target before retry, never automatically replayed` }); }
    }
    this.schedule();
    const saved = this.store.read().requests[r.id];
    return { id: r.id, to, replyPending: r.expectReply, status: saved.status, ...(saved.reason ? { reason: saved.reason } : {}) };
  }
  update(id, data) { this.store.tx(s => { Object.assign(s.requests[id], data); }); }
  hookWrite(id, data) {
    // Only local, idempotent hook state is retried. Never replay an admission/effect.
    this.pendingWrites.set(id, { ...this.pendingWrites.get(id), ...data });
    try {
      this.store.tx(s => { const data = this.pendingWrites.get(id); if (!data.status || !terminal(s.requests[id])) Object.assign(s.requests[id], data); });
      this.pendingWrites.delete(id);
    }
    catch (e) { if (e.code !== 'A2A_BUSY') throw e; }
  }
  consumedReplies() {
    // Pi emits message_end BEFORE appending to its transcript. Read the actual
    // file on reconciliation, not the facade return or in-memory session tree.
    const file = this.transcript();
    if (!file || !fs.existsSync(file) || fs.statSync(file).size > 16 * 1024 * 1024) return new Set();
    const ids = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      try { const e = JSON.parse(line); if (e.type === 'custom_message' && e.customType === 'pi-a2a-reply') ids.add(e.details?.replyId); } catch { /* partial final append is not an ack */ }
    }
    return ids;
  }
  connectEvents() {
    if (!this.oc || this.eventAbort || this.closed) return;
    const controller = new AbortController(); this.eventAbort = controller;
    this.oc.events(controller.signal, () => this.schedule()).catch(() => {}).finally(() => { if (this.eventAbort === controller) this.eventAbort = null; });
  }
  async reconcile() {
    if (this.working || this.closed) return;
    this.working = true;
    try {
      this.reconcileExternal();
      for (const [id, data] of this.pendingWrites) this.hookWrite(id, data);
      this.completeCandidate();
      let requests = Object.values(this.store.read().requests);
      for (const r of requests) {
        if ((r.from === this.self || r.to === this.self) && !terminal(r) && this.now() >= r.deadline) {
          this.update(r.id, { status: 'timeout', answer: 'Request deadline expired; external work may still be running.' });
          continue;
        }
        if (r.from === this.self && r.to.startsWith('oc/') && !terminal(r) && this.oc && r.ocOrigin === this.oc.url) {
          this.connectEvents();
          try { const result = await this.oc.outcome(r); if (result) this.update(r.id, result); } catch { /* bounded reconciliation next event/sweep */ }
        }
      }
      if (this.closed) return;
      requests = Object.values(this.store.read().requests);
      const consumed = this.consumedReplies();
      for (const r of requests) if (r.from === this.self && r.expectReply && terminal(r) && !r.notified) {
        if (consumed.has(`${r.id}-reply`)) {
          this.hookWrite(r.id, { notified: true }); this.inFlight.delete(r.id); continue;
        }
        // One enqueue per process lifetime; busy Pi queues are volatile. A new
        // owner retries only if the stable ID is absent from its saved transcript.
        if (this.inFlight.has(r.id) || this.observedReplies.has(r.id)) continue;
        this.inFlight.add(r.id);
        this.sendMessage({ customType: 'pi-a2a-reply', content: `[Untrusted a2a ${r.status} from ${r.to}; request ${r.id}]\n${r.answer ?? r.reason ?? '(No text)'}`,
          display: true, details: { request: r.id, replyId: `${r.id}-reply`, status: r.status } }, { triggerTurn: true, deliverAs: 'followUp' });
      }
      if (!this.active) {
        const r = requests.find(x => x.to === this.self && !terminal(x) && !x.injected);
        if (r) {
          this.update(r.id, { injected: true, status: 'queued' }); this.active = { ...r, seen: false, focus: false, assistantSeen: false, answer: '', outcome: 'completed' };
          if (this.parent && this.create) this.requestLimit = setTimeout(() => {
            try { this.update(r.id, { status: 'timeout', answer: 'Bounded Pi worker deadline expired' }); } finally { this.stopOwnWorker(); }
          }, Math.max(1, r.deadline - this.now()));
          this.sendMessage({ customType: 'pi-a2a-request', content: `[Untrusted a2a request ${r.id} from ${r.from}. Answer normally; automatic return is handled by pi-a2a. Do not send a second reply.]\n${r.text}`,
            display: true, details: { request: r.id } }, { triggerTurn: true, deliverAs: r.delivery });
        }
      }
    } finally {
      this.working = false;
      // fs.watch is advisory (including lock-release events). Retry only local
      // idempotent writes, never admission or an injection claim/effect.
      if (this.pendingWrites.size || (this.active?.candidate && (this.active.candidateAttempts ?? 0) < 32)) this.schedule(250);
    }
  }
  message(event) {
    const m = event.message;
    if (m?.customType === TYPE) {
      if (this.active && !this.active.candidate) { this.active.focus = false; this.active.answer = ''; this.active.assistantSeen = false; }
      // Event observation is not append evidence. Defer reconciliation until the hook returns.
      const r = Object.values(this.store.read().external).find(r => r.internal === m.details?.internal && r.claim === m.details?.claim && r.digest === m.details?.digest && m.content === content(r));
      if (r) this.externalWrites.set(r.internal, { ...this.externalWrites.get(r.internal), observed: true });
      this.schedule(); return;
    }
    if (m?.customType === 'pi-a2a-reply') {
      const child = this.store.read().requests[m.details?.request];
      if (child?.from === this.self && terminal(child) && m.details?.replyId === `${child.id}-reply` && !this.observedReplies.has(child.id)) {
        this.observedReplies.add(child.id);
        if (this.active && child.parentRequest === this.active.id && !this.active.candidate) {
          this.active.focus = true; this.active.answer = ''; this.active.assistantSeen = false; this.active.outcome = 'completed';
        } else if (this.active && !this.active.candidate) this.active.focus = false;
      }
      this.schedule();
    } else if (m?.customType === 'pi-a2a-request' && m.details?.request === this.active?.id) {
      this.active.seen = true; this.active.focus = true;
    } else if (this.active && !this.active.candidate && (m?.role === 'user' || m?.role === 'custom')) {
      this.active.focus = false; this.active.answer = ''; this.active.assistantSeen = false;
    }
    if (this.active?.focus && !this.active.candidate && m?.role === 'assistant') {
      if (event.type !== 'message_start') this.active.assistantSeen = true;
      this.active.answer = clip(assistantText(m));
      if (m.stopReason === 'error') this.active.outcome = 'error';
      if (m.stopReason === 'aborted') this.active.outcome = 'abort';
    }
  }
  beforeSettle(event) {
    if (this.active?.focus && !this.active.candidate) this.active.outcome = ({ aborted: 'abort', error: 'error', completed: 'completed' })[event.outcome] ?? 'error';
  }
  blocked(waiting) {
    if (this.active && !this.active.candidate && !terminal(this.store.read().requests[this.active.id])) this.hookWrite(this.active.id, { status: waiting ? 'blocked' : 'queued', reason: waiting ? 'Target waiting on UI/permission' : '' });
  }
  settled() {
    if (this.active?.focus && !this.active.candidate) {
      const r = this.active;
      const pendingReturn = Object.values(this.store.read().requests).some(x => x.from === this.self && x.parentRequest === r.id && x.expectReply && (!terminal(x) || !this.observedReplies.has(x.id)));
      r.focus = false;
      if (r.outcome === 'completed' && (pendingReturn || !r.assistantSeen)) {
        this.hookWrite(r.id, { status: 'blocked', reason: 'Awaiting correlated a2a return and subsequent synthesis; no final reply yet' });
      } else {
        r.candidate = { status: r.outcome, answer: r.answer || '(No text reply)' };
      }
    }
    this.completeCandidate();
    this.schedule();
  }
  completeCandidate() {
    const r = this.active;
    if (r && terminal(this.store.read().requests[r.id])) {
      this.pendingWrites.delete(r.id); this.active = null; clearTimeout(this.requestLimit); return;
    }
    if (!r?.candidate || r.candidateAttempts >= 32 || this.now() >= r.deadline) return;
    try {
      this.store.tx(s => { if (!terminal(s.requests[r.id])) Object.assign(s.requests[r.id], r.candidate); });
      this.pendingWrites.delete(r.id); this.active = null; clearTimeout(this.requestLimit);
    } catch (e) {
      if (e.code !== 'A2A_BUSY') throw e;
      r.candidateAttempts = (r.candidateAttempts ?? 0) + 1;
    }
  }
  list() { return Object.values(this.store.read().sessions).map(s => ({ ...s, online: s.online && live(s.pid) })); }
  async read(to, limit = 5) {
    if (to === 'chief') to = chiefTarget(this.chiefFile).to;
    const a = address(to); limit = Math.min(30, Math.max(1, Number(limit) || 5));
    if (a.kind === 'oc') { if (!this.oc) throw Error('OpenCode not configured'); return { untrusted: true, excerpt: clip(JSON.stringify((await this.oc.records(a.session)).slice(0, limit))) }; }
    return { untrusted: true, excerpt: clip(JSON.stringify(Object.values(this.store.read().requests).filter(r => r.to === to || r.from === to).slice(-limit))) };
  }
  createWorker(opts) { return createWorker(this, opts); }
  reconcileExternal() {
    // One transaction for local monotonic updates, proof, and heartbeat. Avoid a
    // write-triggered watcher loop when nothing has changed.
    const before = this.store.read(); const peer = before.sessions[this.self];
    const pending = this.now() - (this.lastExternalScan ?? 0) >= 1000 && Object.values(before.external).some(r => r.to === this.self && r.claim && !r.proof);
    if (this.externalWrites.size || pending || this.now() - (peer?.heartbeat ?? 0) > 20000) {
      this.store.tx(s => {
        const p = s.sessions[this.self]; if (p?.epoch !== this.epoch) return;
        p.heartbeat = this.now();
        for (const r of Object.values(s.external)) {
          const update = this.externalWrites.get(r.internal); if (update && !r.proof) Object.assign(r, update);
          if (r.to === this.self && r.claim && !r.proof && this.now() >= r.deadline) { r.state = 'uncertain'; r.uncertainty = true; }
        }
        reconcileProof(s, this.self);
      });
      this.externalWrites.clear();
      this.lastExternalScan = this.now();
    }
    for (const [k, r] of Object.entries(before.external)) if (r.to === this.self && !r.claim && r.state === 'admitted') {
      const taken = claim(this.store, k, this.self, this.epoch, this.now());
      if (!taken) continue;
      // Claim is irreversible, including if the process dies before this call.
      try {
        const result = this.sendMessage({ customType: TYPE, content: content(taken), display: true,
          details: { internal: taken.internal, claim: taken.claim, digest: taken.digest } },
        { triggerTurn: true, deliverAs: taken.delivery === 'queue' ? 'followUp' : 'steer' });
        Promise.resolve(result).then(() => {
          if (!this.closed) { this.externalWrites.set(taken.internal, { ...this.externalWrites.get(taken.internal), injected: true, state: 'injected' }); this.schedule(); }
        }, () => {
          if (!this.closed) { this.externalWrites.set(taken.internal, { state: 'uncertain', uncertainty: true }); this.schedule(); }
        });
      } catch { this.externalWrites.set(taken.internal, { state: 'uncertain', uncertainty: true }); }
    }
  }
  async close() {
    if (this.closed) return; this.closed = true;
    clearTimeout(this.scheduled); clearInterval(this.sweep); clearTimeout(this.hardLimit); clearTimeout(this.requestLimit); this.watcher?.close(); this.eventAbort?.abort();
    const waits = [];
    for (const child of this.children.values()) if (child.exitCode === null && child.pid) {
      waits.push(new Promise(resolve => {
        const t = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
        child.stdin.end(); child.kill('SIGTERM');
      }));
    }
    await Promise.all(waits);
    this.store.tx(s => { const self = s.sessions[this.self]; if (self?.pid === process.pid) self.online = false; });
  }
}
