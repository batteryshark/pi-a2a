import fs from 'node:fs';
import { Store, live, key } from './store.mjs';
import { address, envelope, admit, terminal, assistantText, clip } from './protocol.mjs';
import { OpenCode, chiefTarget } from './opencode.mjs';
import { createWorker } from './worker.mjs';
import { id } from './store.mjs';
import { claim, content, matchesContent, TYPE, reconcileProof } from './external.mjs';
import path from 'node:path';
import { securePath } from './platform.mjs';

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
    this.turns = new Set(); this.cursors = {}; this.laneNext = 0; this.ocPending = new Set();
    this.proofRequested = true;
  }
  start() {
    if (process.platform === 'win32' && this.transcript()) {
      const file = this.transcript();
      securePath(path.dirname(file), true, {transcript:true});
      if (fs.existsSync(file)) securePath(file, false, {transcript:true});
    }
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
    this.watch();
    this.sweep = setInterval(() => { this.watch(); this.proofRequested = true; this.schedule(); }, 30000); this.sweep.unref();
    this.schedule();
    if (this.parent && this.create) {
      // Child-side watchdog survives loss/SIGKILL of its RPC process owner.
      this.hardLimit = setTimeout(() => this.stopOwnWorker(), 600000);
    }
  }
  watch() {
    // Reattach on each bounded existing sweep, including silently invalidated
    // watches after directory recreation. No new polling service or effect retry.
    this.watcher?.close(); this.watcher = null;
    try {
      this.watcher = fs.watch(this.store.root, () => this.schedule(30, true));
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; this.schedule(); });
    } catch { this.schedule(); }
  }
  stopOwnWorker() {
    if (!this.parent || !this.create) return;
    const pid = process.pid;
    process.kill(pid, 'SIGTERM');
    setTimeout(() => process.kill(pid, 'SIGKILL'), 2000);
  }
  schedule(delay = 30, watchEvent = false) {
    if (this.closed || this.lostOwner) return;
    if (this.working) { if (!watchEvent) this.wakeRequested = true; return; }
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = null; this.reconcile().catch(() => {}); }, delay);
  }
  owner(s) {
    const p = s.sessions[this.self];
    return p?.pid === process.pid && p.epoch === this.epoch && p.online === true ? p : null;
  }
  ownedTx(fn) {
    if (this.closed || this.lostOwner) throw Object.assign(Error('Runtime owner changed'), {code:'A2A_OWNER_LOST'});
    let heartbeat;
    const result = this.store.tx(s => {
      const p = this.owner(s);
      if (!p) { this.lostOwner = true; throw Object.assign(Error('Runtime owner changed'), {code:'A2A_OWNER_LOST'}); }
      const now = this.now();
      // Normal work proves only OUR exact live PID/epoch is active. Never set
      // online or renew another peer (including from the companion).
      if (now - p.heartbeat > 20000) p.heartbeat = now;
      heartbeat = p.heartbeat;
      return fn(s);
    });
    this.lastHeartbeat = heartbeat; // scheduling hint, NEVER an ownership/security cache
    return result;
  }
  turn() {
    if (this.closed || this.lostOwner) return Promise.resolve(false);
    return new Promise(resolve => {
      const entry = {resolve, timer:null};
      entry.timer = setTimeout(() => { this.turns.delete(entry); resolve(!this.closed && !this.lostOwner); }, 0);
      this.turns.add(entry);
    });
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
    this.ownedTx(s => {
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
  update(id, data) { this.ownedTx(s => { Object.assign(s.requests[id], data); }); }
  hookWrite(id, data) {
    // Only local, idempotent hook state is retried. Never replay an admission/effect.
    this.pendingWrites.set(id, { ...this.pendingWrites.get(id), ...data });
    this.flushWrite(id);
  }
  flushWrite(id) {
    try {
      this.ownedTx(s => {
        const data=this.pendingWrites.get(id), r=s.requests[id];
        if (!data || !r || (data.status && terminal(r))) return;
        if (data.status && terminal(data) && this.now()>=r.deadline) Object.assign(r,{status:'timeout',answer:'Request deadline expired; external work may still be running.'});
        else Object.assign(r,data);
      });
      this.pendingWrites.delete(id);
    }
    catch (e) { if (e.code !== 'A2A_BUSY') throw e; this.busySeen=true; }
  }
  consumedReplies() {
    // Pi emits message_end BEFORE appending to its transcript. Read the actual
    // file on reconciliation, not the facade return or in-memory session tree.
    const file = this.transcript();
    if (!file || !fs.existsSync(file) || fs.statSync(file).size > 16 * 1024 * 1024) return new Set();
    if (process.platform === 'win32') { try { securePath(file, false, {transcript:true}); } catch { return new Set(); } }
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
  reconcile() {
    if (this.closed || this.lostOwner) return Promise.resolve();
    if (this.reconciling) return this.reconciling;
    this.working = true; this.wakeRequested = false;
    this.reconciling = this.reconcilePass().finally(() => {
      this.working = false; this.reconciling = null;
      if (this.moreWork || this.wakeRequested || this.pendingWrites.size || this.externalWrites.size ||
          (this.active?.candidate && (this.active.candidateAttempts ?? 0) < 32)) this.schedule(250);
    });
    return this.reconciling;
  }
  rotated(lane, ids) {
    const previous = ids.indexOf(this.cursors[lane]);
    return previous < 0 ? ids : [...ids.slice(previous + 1), ...ids.slice(0, previous + 1)];
  }
  async reconcilePass() {
    this.moreWork = false; this.busySeen = false;
    try {
      if (!await this.turn()) return;
      const before = this.store.read();
      if (!this.owner(before)) { this.lostOwner = true; return; }
      this.lastHeartbeat = before.sessions[this.self].heartbeat;
      if (!await this.turn()) return;
      const requests = Object.values(before.requests);
      const replies = requests.filter(r => r.from === this.self && r.expectReply && terminal(r) && !r.notified);
      const consumed = replies.length ? this.consumedReplies() : new Set();
      if (replies.length && !await this.turn()) return;
      const queues = {
        native:this.rotated('native', requests.filter(r => !terminal(r) && (r.from === this.self || r.to === this.self) &&
          (this.now()>=r.deadline || (r.from===this.self && r.to.startsWith('oc/') && this.oc && r.ocOrigin===this.oc.url && !this.ocPending.has(r.id)))).map(r => r.id)),
        replies:this.rotated('replies', replies.filter(r=>consumed.has(`${r.id}-reply`) || (!this.inFlight.has(r.id)&&!this.observedReplies.has(r.id))).map(r => r.id)),
        external:this.rotated('external', Object.keys(before.external).filter(k => { const r=before.external[k]; return r.to===this.self && !r.claim && r.state==='admitted'; })),
        dispatch:this.active ? [] : requests.filter(r => r.to===this.self && !terminal(r) && !r.injected).slice(0,1).map(r=>r.id)
      };
      const lanes = ['maintenance','pending','candidate','native','replies','dispatch','external'];
      let maintained = false, candidateDone = false;
      const pendingDone=new Set();
      for (let budget=0; budget<8 && !this.closed && !this.lostOwner; budget++) {
        if (this.busySeen) {this.moreWork=true;return;}
        let action;
        if (this.now()-this.lastHeartbeat>20000) action=()=>this.ownedTx(()=>{});
        for (let tries=0; tries<lanes.length && !action; tries++) {
          const lane=lanes[this.laneNext]; this.laneNext=(this.laneNext+1)%lanes.length;
          if (lane==='maintenance') {
            const peer=before.sessions[this.self];
            const proofDue=this.proofRequested && this.now()-(this.lastExternalScan??0)>=1000 && Object.values(before.external).some(r=>r.to===this.self && r.claim && !r.proof);
            if (this.externalWrites.size || (!maintained && (proofDue || this.now()-peer.heartbeat>20000))) {
              action=()=>this.reconcileExternal(); maintained=true;
            }
          } else if (lane==='candidate') {
            // Terminal cleanup releases a hung/timed-out slot even when no
            // settlement candidate ever existed. Nonterminal waits stay active.
            if (!candidateDone && this.active) {candidateDone=true;action=()=>this.completeCandidate();}
          } else {
            const id=lane==='pending' ? this.rotated('pending',[...this.pendingWrites.keys()].filter(id=>!pendingDone.has(id)))[0] : queues[lane].shift();
            if (id!==undefined) {
              if (lane==='pending') pendingDone.add(id);
              this.cursors[lane]=id;
              action=()=>{
                if (lane==='pending') this.flushWrite(id);
                if (lane==='native') this.reconcileNative(id);
                if (lane==='replies') this.deliverReply(id,consumed);
                if (lane==='dispatch') this.dispatchNative(id);
                if (lane==='external') this.dispatchExternal(id);
              };
            }
          }
        }
        if (!action) break;
        action();
        if (this.busySeen) {this.moreWork=true;return;}
        // A real timer turn, OUTSIDE Store.tx. Keep the working guard held.
        if (!await this.turn()) return;
      }
      const after=this.store.read();
      if (!this.owner(after)) {this.lostOwner=true;return;}
      this.moreWork=Object.values(after.external).some(r=>r.to===this.self&&!r.claim&&r.state==='admitted') ||
        Object.values(after.requests).some(r=>
          (!terminal(r)&&(r.from===this.self||r.to===this.self)&&this.now()>=r.deadline) ||
          (r.from===this.self&&r.expectReply&&terminal(r)&&!r.notified&&!this.inFlight.has(r.id)&&!this.observedReplies.has(r.id)) ||
          (!this.active&&r.to===this.self&&!terminal(r)&&!r.injected));
    } catch(e) {
      if (e.code==='A2A_BUSY') {this.moreWork=true;return;}
      if (e.code==='A2A_OWNER_LOST') {this.lostOwner=true;return;}
      throw e;
    }
  }
  reconcileNative(id) {
    // Read-only network collection must not manufacture a write/watch loop.
    // Never await the network promise while holding the reconciliation guard.
    const snapshot=this.store.read();
    if (!this.owner(snapshot)) {this.lostOwner=true;throw Object.assign(Error('Runtime owner changed'),{code:'A2A_OWNER_LOST'});}
    const current=snapshot.requests[id];
    if (!current || terminal(current)) return;
    if (this.now()<current.deadline) {
      if (!current.to.startsWith('oc/') || current.from!==this.self || !this.oc || current.ocOrigin!==this.oc.url || this.ocPending.has(id)) return;
      this.collectOutcome(current); return;
    }
    // Timeout is one transaction in its own later unit, not read+write here.
    this.pendingWrites.set(id,{status:'timeout',answer:'Request deadline expired; external work may still be running.'});
    this.wakeRequested=true;
  }
  collectOutcome(r) {
    const id=r.id;
    this.connectEvents(); this.ocPending.add(id); const epoch=this.epoch;
    Promise.resolve().then(()=>this.closed||this.lostOwner||this.epoch!==epoch ? null : this.oc.outcome(r)).then(result=>{
      if (result && !this.closed && !this.lostOwner && this.epoch===epoch) {
        this.pendingWrites.set(id,{...this.pendingWrites.get(id),...result});this.schedule();
      }
    },()=>{}).finally(()=>this.ocPending.delete(id));
  }
  deliverReply(id, consumed) {
    const r=this.ownedTx(s=>{
      const r=s.requests[id]; if (!r || r.from!==this.self || !r.expectReply || !terminal(r) || r.notified) return null;
      if (consumed.has(`${id}-reply`)) {r.notified=true;this.inFlight.delete(id);return null;}
      if (this.inFlight.has(id)||this.observedReplies.has(id)) return null;
      return {...r};
    });
    if (!r) return;
    this.inFlight.add(id);
    Promise.resolve(this.sendMessage({customType:'pi-a2a-reply',content:`[Untrusted a2a ${r.status} from ${r.to}; request ${id}]\n${r.answer??r.reason??'(No text)'}`,display:true,details:{request:id,replyId:`${id}-reply`,status:r.status}},{triggerTurn:true,deliverAs:'followUp'})).catch(()=>{});
  }
  dispatchNative(id) {
    if (this.active) return;
    const r=this.ownedTx(s=>{
      const r=s.requests[id]; if (!r || r.to!==this.self || terminal(r) || r.injected) return null;
      if (this.now()>=r.deadline) {r.status='timeout';return null;}
      r.injected=true;r.status='queued';return {...r};
    });
    if (!r) return;
    this.active={...r,seen:false,focus:false,assistantSeen:false,answer:'',outcome:'completed'};
    if (this.parent&&this.create) this.requestLimit=setTimeout(()=>{
      try {this.update(id,{status:'timeout',answer:'Bounded Pi worker deadline expired'});} finally {this.stopOwnWorker();}
    },Math.max(1,r.deadline-this.now()));
    Promise.resolve(this.sendMessage({customType:'pi-a2a-request',content:`[Untrusted a2a request ${id} from ${r.from}. Answer normally; automatic return is handled by pi-a2a. Do not send a second reply.]\n${r.text}`,display:true,details:{request:id}},{triggerTurn:true,deliverAs:r.delivery})).catch(()=>{});
  }
  message(event) {
    const m = event.message;
    if (m?.customType === TYPE) {
      if (this.active && !this.active.candidate) { this.active.focus = false; this.active.answer = ''; this.active.assistantSeen = false; }
      // Event observation is not append evidence. Defer reconciliation until the hook returns.
      const r = Object.values(this.store.read().external).find(r => r.internal === m.details?.internal && r.claim === m.details?.claim && r.digest === m.details?.digest && matchesContent(r, m.content));
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
      const completed=this.ownedTx(s => { if (this.now()>=r.deadline && !terminal(s.requests[r.id])) return false; if (!terminal(s.requests[r.id])) Object.assign(s.requests[r.id], r.candidate); return true; });
      if (!completed) return;
      this.pendingWrites.delete(r.id); this.active = null; clearTimeout(this.requestLimit);
    } catch (e) {
      if (e.code !== 'A2A_BUSY') throw e;
      this.busySeen = true;
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
    const batch=new Map(this.externalWrites);
    this.ownedTx(s => {
      const now=this.now();
      for (const r of Object.values(s.external)) {
        if (r.to!==this.self) continue;
        // Claimed rows are compact: their original epoch is deliberately gone.
        // The immutable internal/claim association and THIS collector's ownedTx
        // guard, not discarded payload metadata, authorize monotonic local facts.
        const update=batch.get(r.internal); if (update && r.claim && !r.proof) Object.assign(r,update);
        if (r.claim && !r.proof && now>=r.deadline) {r.state='uncertain';r.uncertainty=true;}
      }
      reconcileProof(s,this.self);
    });
    for (const [id,value] of batch) if(this.externalWrites.get(id)===value) this.externalWrites.delete(id);
    this.proofRequested=false; this.lastExternalScan=this.now();
  }
  dispatchExternal(k) {
      const taken = claim({tx:fn=>this.ownedTx(fn)}, k, this.self, this.epoch, () => this.now());
      if (!taken) return;
      const epoch=this.epoch;
      // Claim is irreversible, including if the process dies before this call.
      try {
        const result = this.sendMessage({ customType: TYPE, content: content(taken), display: true,
          details: { internal: taken.internal, claim: taken.claim, digest: taken.digest } },
        { triggerTurn: true, deliverAs: taken.delivery === 'queue' ? 'followUp' : 'steer' });
        Promise.resolve(result).then(() => {
          if (!this.closed && !this.lostOwner && this.epoch===epoch) { this.proofRequested=true; this.externalWrites.set(taken.internal, { ...this.externalWrites.get(taken.internal), injected: true, state: 'injected' }); this.schedule(); }
        }, () => {
          if (!this.closed && !this.lostOwner && this.epoch===epoch) { this.proofRequested=true; this.externalWrites.set(taken.internal, { state: 'uncertain', uncertainty: true }); this.schedule(); }
        });
      } catch { this.externalWrites.set(taken.internal, { state: 'uncertain', uncertainty: true }); }
  }
  async close() {
    if (this.closed) return; this.closed = true;
    clearTimeout(this.scheduled); clearInterval(this.sweep); clearTimeout(this.hardLimit); clearTimeout(this.requestLimit); this.watcher?.close(); this.eventAbort?.abort();
    for (const entry of this.turns) {clearTimeout(entry.timer);entry.resolve(false);} this.turns.clear();
    const waits = [];
    for (const child of this.children.values()) if (child.exitCode === null && child.pid) {
      waits.push(new Promise(resolve => {
        const t = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
        child.stdin.end(); child.kill('SIGTERM');
      }));
    }
    await Promise.all(waits);
    await this.reconciling;
    this.store.tx(s => { const self = s.sessions[this.self]; if (self?.pid === process.pid && self.epoch===this.epoch) self.online = false; });
  }
}
