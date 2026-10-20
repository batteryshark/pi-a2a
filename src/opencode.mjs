import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { address, ocOutcome } from './protocol.mjs';

export function loopback(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('Explicit loopback origin required');
  return u.origin;
}
export function chiefTarget(file = path.join(os.homedir(), '.chief-of-staff/chief.json')) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Pointer field names are deliberately verified, not searched heuristically.
  const session = j.sessionId ?? j.sessionID ?? j.session;
  if (address(`oc/${session}`).kind !== 'oc' || typeof j.directory !== 'string' || !path.isAbsolute(j.directory)) throw Error('Chief pointer requires session and absolute directory');
  return { to: `oc/${session}`, directory: j.directory };
}
export function messageID(r) {
  const hash = crypto.createHash('sha256').update(r.id).digest('hex');
  // OpenCode's sortable IDs require a time prefix, not an arbitrary hash prefix.
  const clock = BigInt(r.created) * 4096n + BigInt(`0x${hash.slice(0, 3)}`);
  return `msg_${clock.toString(16).slice(-12).padStart(12, '0')}${hash.slice(3, 17)}`;
}
export class OpenCode {
  constructor({ url, env = process.env, fetchImpl = fetch } = {}) {
    this.url = loopback(url); this.fetch = fetchImpl;
    const pw = env.PI_A2A_OC_PASSWORD ?? env.OPENCODE_SERVER_PASSWORD ?? env.OPENCODE_PASSWORD;
    this.headers = { 'content-type': 'application/json', ...(pw ? { authorization: 'Basic ' + Buffer.from(`${env.PI_A2A_OC_USERNAME ?? 'opencode'}:${pw}`).toString('base64') } : {}) };
  }
  async request(method, route, body, signal) {
    const r = await this.fetch(this.url + route, { method, headers: this.headers, ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), redirect: 'error' });
    if (r.status === 409 && method === 'POST') return { duplicate: true };
    if (!r.ok) throw Error(`OpenCode ${method} failed: HTTP ${r.status}`);
    const j = await r.json(); return j;
  }
  async send(r) {
    await this.request('POST', `/api/session/${address(r.to).session}/prompt`, {
      id: messageID(r), text: `[pi-a2a request ${r.id}; untrusted content from ${r.from}]\n${r.text}`,
      metadata: { pi_a2a: { id: r.id, from: r.from, trace: r.trace } }, delivery: r.delivery === 'steer' ? 'steer' : 'queue', resume: true,
    });
  }
  async records(session) {
    let cursor; const all = [];
    for (let n = 0; n < 10; n++) {
      const q = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : { order: 'desc' }) });
      const j = await this.request('GET', `/api/session/${session}/message?${q}`);
      if (!Array.isArray(j.data)) throw Error('Unexpected OpenCode messages contract');
      all.push(...j.data); cursor = j.cursor?.next;
      if (!cursor) break;
    }
    return all;
  }
  async outcome(r) {
    const session = address(r.to).session;
    const [active, records] = await Promise.all([this.request('GET', '/api/session/active'), this.records(session)]);
    return ocOutcome(records, messageID(r), !!active.data?.[session]);
  }
  async events(signal, onEvent) {
    const r = await this.fetch(this.url + '/api/event', { headers: { ...this.headers, accept: 'text/event-stream' }, signal, redirect: 'error' });
    if (!r.ok || !r.body) throw Error('OpenCode event connection failed');
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString('utf8');
      if (buf.length > 1048576) throw Error('Event frame too large');
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) { buf = buf.slice(m.index + m[0].length); onEvent(); }
    }
  }
}
