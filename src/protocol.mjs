import { id, key } from './store.mjs';
export const terminal = r => ['completed', 'error', 'abort', 'timeout'].includes(r.status);
export const text = s => {
  if (typeof s !== 'string' || !s.trim() || Buffer.byteLength(s) > 32768) throw Error('Text required, maximum 32768 UTF-8 bytes');
  return s;
};
export const clip = s => Buffer.from(String(s)).subarray(0, 32768).toString('utf8');
export function address(s) {
  if (s === 'chief') return { kind: 'chief' };
  const m = /^(pi|oc)\/([A-Za-z0-9][A-Za-z0-9_-]{0,95})$/.exec(s);
  if (!m || (m[1] === 'oc' && !m[2].startsWith('ses_'))) throw Error('Use pi/<session-id>, oc/ses_…, or chief');
  return { kind: m[1], session: key(m[2]) };
}
export function envelope(from, to, body, opts = {}, inbound = null) {
  address(from); address(to); text(body);
  const route = inbound ? [...inbound.route, inbound.to] : [from];
  if (from === to || route.includes(to) || route.length > 4) throw Error('Self-send, route loop, or hop limit refused');
  return { id: key(opts.id ?? id()), from, to, text: body, expectReply: opts.expectReply !== false,
    delivery: opts.delivery === 'steer' ? 'steer' : 'followUp', route,
    trace: inbound?.trace ?? id(), ...(inbound ? { parentRequest: inbound.id } : {}), created: Date.now(), deadline: Date.now() + 180000,
    status: 'admitted', injected: false, seen: false, notified: false };
}
export function admit(s, r) {
  const old = s.requests[r.id];
  if (old) {
    if (old.from !== r.from || old.to !== r.to || old.text !== r.text || old.expectReply !== r.expectReply || old.delivery !== r.delivery || old.parentRequest !== r.parentRequest) throw Error('ID collision');
    return old;
  }
  if (Object.values(s.requests).some(x => x.to === r.to && x.expectReply && !terminal(x))) throw Error('Target already has a reply-bearing request; wait for automatic return');
  if (Object.keys(s.requests).length >= 2048) throw Error('Request limit reached; offline archive required');
  s.requests[r.id] = r; return r;
}
export function assistantText(m) { return (m?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join(''); }
// Strict correlation: never infer a reply when the actual request is off-page.
export function ocOutcome(newest, requestID, active) {
  if (active) return null;
  const i = newest.findIndex(x => x.id === requestID);
  if (i < 0) return null;
  let close = -1;
  for (let j = i - 1; j >= 0; j--) if (newest[j].type === 'idle') { close = j; break; }
  if (close < 0) return null;
  const idle = newest[close];
  const answer = newest.slice(close + 1, i).find(x => x.type === 'assistant' && assistantText(x));
  return { status: ({ succeeded: 'completed', failed: 'error', interrupted: 'abort' })[idle.outcome] ?? 'error',
    answer: clip(answer ? assistantText(answer) : '(No text reply)'), reason: idle.outcome };
}
