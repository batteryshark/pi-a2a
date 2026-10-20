import fs from 'node:fs';
import crypto from 'node:crypto';
import { live, id } from './store.mjs';
import { accountIdentity } from './platform.mjs';

export const TYPE = 'pi-a2a-external-v1';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const fault = code => Object.assign(Error(code), { code });
export const requestKey = x => hash(JSON.stringify(['pi-a2a/external/key/v1', accountIdentity(), x.caller, x.id]));
export const digest = x => hash(JSON.stringify(['pi-a2a/external/body/v1', x.to, x.text, x.delivery, false]));
export const content = r => `[Untrusted external no-reply wake; ${r.internal}; ${r.digest}]\n${r.text}`;
export function receipt(r) {
  return { state: r.state, facts: { admitted: !!r.admitted, claimed: !!r.claim, injected: !!r.injected,
    observed: !!r.observed, consumed: !!r.proof, historicalUncertainty: !!r.uncertainty },
    evidence: r.evidence ?? 'not_checked', cancelAvailable: !r.claim && !['cancelled', 'failed'].includes(r.state),
    retry: 'same_key_only' };
}
function capable(p, now, epoch) {
  if (p?.externalV1 !== true || p.persistence !== true || typeof p.epoch !== 'string') throw fault('UNSUPPORTED_TARGET');
  if (!p.online || !live(p.pid) || !Number.isFinite(p.heartbeat) || p.heartbeat > now + 1000 || now - p.heartbeat > 65000 || (epoch && p.epoch !== epoch)) throw fault('UNAVAILABLE');
}
export function operate(store, x, now = Date.now()) {
  const k = requestKey(x);
  return store.tx(s => {
    let r = s.external[k];
    if (r?.state === 'admitted' && !r.claim && now >= r.deadline) { r.state = 'failed'; r.evidence = 'deadline'; }
    if (x.op === 'status') {
      if (!r) throw fault('UNKNOWN');
      if (r.claim && !r.proof) reconcileProof(s, r.to);
      return receipt(r);
    }
    if (x.op === 'cancel') {
      if (r?.claim) throw fault('TOO_LATE');
      if (!r) { capacity(s); r = s.external[k] = { state: 'cancelled' }; }
      if (r.state !== 'failed') r.state = 'cancelled';
      return receipt(r);
    }
    if (r) {
      if (r.digest && r.digest !== digest(x)) throw fault('CONFLICT');
      if (r.state === 'cancelled') throw fault('CANCELLED');
      return receipt(r); // lookup precedes all target checks
    }
    capacity(s); const p = s.sessions[x.to]; capable(p, now);
    r = s.external[k] = { internal: id(), digest: digest(x), to: x.to, text: x.text, delivery: x.delivery,
      epoch: p.epoch, admitted: true, state: 'admitted', deadline: now + 300000 };
    return receipt(r);
  });
}
function capacity(s) {
  // Fixed identity/byte ceilings reserve space for transitions and saved proofs.
  if (Object.keys(s.external).length >= 128 || Buffer.byteLength(JSON.stringify(s.external)) > 6 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(s)) > 12 * 1024 * 1024) throw fault('CAPACITY');
}
export function claim(store, k, self, epoch, now) {
  return store.tx(s => {
    const r = s.external[k];
    if (!r || r.to !== self || r.claim || r.state !== 'admitted') return null;
    if (now >= r.deadline) { r.state = 'failed'; r.evidence = 'deadline'; return null; }
    try { capable(s.sessions[self], now, r.epoch); if (epoch !== r.epoch) throw fault('UNAVAILABLE'); }
    catch { r.state = 'failed'; r.evidence = 'owner_unavailable'; return null; }
    r.claim = id(); r.state = 'uncertain'; r.uncertainty = true;
    r.file = s.sessions[self].transcript; r.session = self.slice(3);
    return { ...r };
  });
}
// Only newline-complete saved records count. Incremental, bounded work per call;
// missing/partial/oversized/mismatched data is never treated as consumption.
export function reconcileProof(s, to) {
  const pending = Object.values(s.external).filter(r => r.to === to && r.claim && !r.proof);
  if (!pending.length) return;
  for (const r of pending) { r.state = 'uncertain'; r.uncertainty = true; }
  const p = s.sessions[to];
  for (const file of new Set(pending.map(r => r.file))) {
    const rows = pending.filter(r => r.file === file);
    const evidence = value => { for (const r of rows) r.evidence = value; };
    let fd;
    try {
      if (!file) { evidence('missing'); continue; }
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid()) { evidence('unsafe'); continue; }
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (stat.ino !== st.ino || stat.dev !== st.dev) { evidence('changed'); continue; }
      const prefix = Buffer.alloc(8192), n = fs.readSync(fd, prefix, 0, prefix.length, 0);
      const end = prefix.subarray(0, n).indexOf(10);
      if (end < 0) { evidence('partial_header'); continue; }
      const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, end)));
      if (header.type !== 'session' || rows.some(r => r.session !== header.id)) { evidence('session_mismatch'); continue; }
      const identity = `${stat.dev}:${stat.ino}:${header.id}`;
      let scan = p?.proofScan;
      if (!scan || scan.identity !== identity || scan.offset > stat.size) scan = { identity, offset: end + 1 };
      const buf = Buffer.alloc(262144), size = fs.readSync(fd, buf, 0, buf.length, scan.offset);
      let start = 0;
      for (let i = 0; i < size; i++) if (buf[i] === 10) {
        const raw = buf.subarray(start, i); start = i + 1;
        if (raw.length > 229376) { evidence('oversized_record'); continue; }
        let e; try { e = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { evidence('invalid_record'); continue; }
        for (const r of rows) if (e.type === 'custom_message' && e.customType === TYPE && e.id &&
          e.details?.internal === r.internal && e.details?.claim === r.claim && e.details?.digest === r.digest && e.content === content(r)) {
          r.proof = { entry: e.id, record: hash(raw) }; r.injected = true; r.observed = true;
          r.state = 'consumed'; r.evidence = 'saved_exact';
        }
      }
      scan.offset += start;
      if (p) p.proofScan = scan;
      for (const r of rows) if (!r.proof) r.evidence = size - start > 229376 ? 'oversized_record' : size > start ? 'partial_record' : scan.offset < stat.size ? 'scanning' : 'absent';
    } catch { evidence('unreadable'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}
