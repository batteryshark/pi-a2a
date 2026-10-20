import fs from 'node:fs';
import { hash, framed, scanKey, IDENTITIES, ACTIVE, STATE_BYTES, ADMISSION_BYTES, TRANSITION_BYTES } from './ledger.mjs';
import { live, id } from './store.mjs';
import { accountIdentity, securePath } from './platform.mjs';

export const TYPE = 'pi-a2a-external-v1';
export const capabilities = () => ({ protocol:1, contract:'pi-a2a-external-v1', operations:['capabilities','lookup','send','status','cancel'],
  delivery:['queue','steer'], expectReply:false, maxCaller:48, maxRequestId:96, maxTextBytes:32768, maxInputBytes:262144, maxOutputBytes:8192,
  maxRetainedIdentities:IDENTITIES, maxActivePayloads:ACTIVE, capacityScope:'shared_ledger', maxStateBytes:STATE_BYTES,
  inspection:'read_only', targetSnapshot:true, reservation:false });
export function lookup(store, to, now = Date.now()) {
  const p = store.read().sessions[to];
  const capable = !!(p?.externalV1 === true && p.persistence === true && typeof p.epoch === 'string');
  return { to, exists:!!p, live:!!(p?.online && live(p.pid) && Number.isFinite(p.heartbeat) && p.heartbeat <= now + 1000 && now - p.heartbeat <= 65000),
    capable, snapshot:true, reservation:false };
}
export const fault = code => Object.assign(Error(code), { code });
export const requestKey = x => hash(JSON.stringify(['pi-a2a/external/key/v1', accountIdentity(), x.caller, x.id]));
export const digest = x => hash(JSON.stringify(['pi-a2a/external/body/v1', x.to, x.text, x.delivery, false]));
export const content = framed;
// UTF-8 hashing is exact only for well-formed strings: Node replaces lone
// surrogates with U+FFFD. Reject JSON-escaped lone surrogates before hashing.
export const matchesContent = (r, value) => typeof value === 'string' && value.isWellFormed() && hash(value) === (r.contentDigest ?? hash(content(r)));
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
      if (!r) { r = s.external[k] = { state: 'cancelled' }; capacity(s); }
      if (r.state !== 'failed') r.state = 'cancelled';
      return receipt(r);
    }
    if (r) {
      if (r.digest && r.digest !== digest(x)) throw fault('CONFLICT');
      if (r.state === 'cancelled') throw fault('CANCELLED');
      return receipt(r); // lookup precedes all target checks
    }
    const p = s.sessions[x.to]; capable(p, now);
    if (typeof p.transcript !== 'string' || Buffer.byteLength(p.transcript) > 4096 || p.epoch.length > 96) throw fault('UNSUPPORTED_TARGET');
    if (Object.values(s.external).filter(r => r.state === 'admitted').length >= ACTIVE) throw fault('CAPACITY');
    r = s.external[k] = { internal: id(), digest: digest(x), to: x.to, text: x.text, delivery: x.delivery,
      epoch: p.epoch, file:p.transcript, session:x.to.slice(3), admitted: true, state: 'admitted', deadline: now + 300000 };
    r.contentDigest = hash(content(r));
    capacity(s);
    return receipt(r);
  });
}
function capacity(s) {
  // Charge the candidate, including escaped payload/path, before committing.
  // 1 KiB per identity covers all later bounded facts, proof and file cursor.
  const count = Object.keys(s.external).length;
  if (count > IDENTITIES || Buffer.byteLength(JSON.stringify([s.external,s.externalScans,s.externalScanNext])) + count * TRANSITION_BYTES > ADMISSION_BYTES) throw fault('CAPACITY');
}
export function claim(store, k, self, epoch, now) {
  return store.tx(s => {
    const r = s.external[k];
    if (!r || r.to !== self || r.claim || r.state !== 'admitted') return null;
    if (now >= r.deadline) { r.state = 'failed'; r.evidence = 'deadline'; return null; }
    try { capable(s.sessions[self], now, r.epoch); if (epoch !== r.epoch) throw fault('UNAVAILABLE'); }
    catch { r.state = 'failed'; r.evidence = 'owner_unavailable'; return null; }
    r.claim = id(); r.state = 'uncertain'; r.uncertainty = true;
    return { ...r };
  });
}
// Only newline-complete saved records count. Incremental, bounded work per call;
// missing/partial/oversized/mismatched data is never treated as consumption.
export function reconcileProof(s, to) {
  const pending = Object.values(s.external).filter(r => r.to === to && r.claim && !r.proof);
  if (!pending.length) return;
  for (const r of pending) { r.state = 'uncertain'; r.uncertainty = true; }
  s.externalScans ??= {};
  s.externalScanNext ??= {};
  // One file window per transaction, round-robin even with many historical
  // unresolved files. Total I/O is bounded, not 256 KiB times lifetime IDs.
  const files = [...new Set(pending.map(r => r.file))];
  const previous = files.findIndex(file => (file ? scanKey(file) : 'missing') === s.externalScanNext[to]);
  const file = files[(previous + 1) % files.length];
  s.externalScanNext[to] = file ? scanKey(file) : 'missing';
  for (const file of [files[(previous + 1) % files.length]]) {
    const rows = pending.filter(r => r.file === file);
    const byInternal = new Map(rows.map(r => [r.internal,r]));
    const evidence = value => { for (const r of rows) if (!r.proof) r.evidence = value; };
    let fd;
    try {
      if (!file) { evidence('missing'); continue; }
      const st = fs.lstatSync(file);
      try { securePath(file, false, { transcript:true }); } catch { evidence('unsafe'); continue; }
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (stat.ino !== st.ino || stat.dev !== st.dev) { evidence('changed'); continue; }
      const prefix = Buffer.alloc(8192), n = fs.readSync(fd, prefix, 0, prefix.length, 0);
      const end = prefix.subarray(0, n).indexOf(10);
      if (end < 0) { evidence('partial_header'); continue; }
      const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, end)));
      if (header.type !== 'session' || rows.some(r => r.session !== header.id)) { evidence('session_mismatch'); continue; }
      const identity = hash(`${stat.dev}:${stat.ino}:${header.id}`);
      let scan = s.externalScans[scanKey(file)];
      if (!scan || scan.identity !== identity || scan.offset > stat.size) scan = { identity, offset: end + 1 };
      const buf = Buffer.alloc(262144), size = fs.readSync(fd, buf, 0, buf.length, scan.offset);
      let start = 0;
      for (let i = 0; i < size; i++) if (buf[i] === 10) {
        const raw = buf.subarray(start, i); start = i + 1;
        if (scan.discard) { scan.discard = false; continue; }
        if (raw.length > 229376) { evidence('oversized_record'); continue; }
        let e; try { e = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { evidence('invalid_record'); continue; }
        const r = byInternal.get(e?.details?.internal);
        if (r && e.type === 'custom_message' && e.customType === TYPE && e.id &&
          e.details?.internal === r.internal && e.details?.claim === r.claim && e.details?.digest === r.digest && matchesContent(r, e.content)) {
          r.proof = { entry: hash(JSON.stringify(e.id)), record: hash(raw) }; r.injected = true; r.observed = true;
          r.state = 'consumed'; r.evidence = 'saved_exact';
        }
      }
      // Carry only discard progress, never a discarded fragment as evidence.
      // Smaller partial records are reread from their start after an append.
      if (scan.discard || size - start > 229376) { scan.discard = true; start = size; }
      scan.offset += start;
      s.externalScans[scanKey(file)] = scan;
      for (const r of rows) if (!r.proof) r.evidence = scan.discard ? 'oversized_record' : size > start ? 'partial_record' : scan.offset < stat.size ? 'scanning' : 'absent';
    } catch { evidence('unreadable'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}
