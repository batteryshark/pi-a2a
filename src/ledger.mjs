import crypto from 'node:crypto';

export const IDENTITIES = 50000, ACTIVE = 128;
export const NATIVE_BYTES = 8 * 1024 * 1024, STATE_BYTES = 128 * 1024 * 1024;
export const ADMISSION_BYTES = 112 * 1024 * 1024, TRANSITION_BYTES = 1024;
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const framed = r => `[Untrusted external no-reply wake; ${r.internal}; ${r.digest}]\n${r.text}`;
export const scanKey = file => hash(file);

// In the SAME atomic ledger replacement as the terminal/claim fact. In-flight
// facade callers hold their own copy; the durable ledger never replays it.
export function compact(s) {
  s.externalScans ??= {};
  for (const p of Object.values(s.sessions)) if (p.proofScan) {
    if (p.transcript) s.externalScans[scanKey(p.transcript)] = p.proofScan;
    delete p.proofScan;
  }
  for (const r of Object.values(s.external)) if (r.state !== 'admitted') {
    if (r.claim && r.text !== undefined) r.contentDigest ??= hash(framed(r));
    delete r.text; delete r.delivery; delete r.epoch; delete r.deadline;
    if (r.proof) { delete r.file; delete r.session; }
  }
  // Cursors are only accelerators, never barriers or evidence. Release them
  // once no unresolved claim needs that file. No identity or proof is removed.
  const needed = new Set(Object.values(s.external).filter(r => r.claim && !r.proof && r.file).map(r => scanKey(r.file)));
  for (const k of Object.keys(s.externalScans)) if (!needed.has(k)) delete s.externalScans[k];
}
