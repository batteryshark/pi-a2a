import { operate, fault } from './external.mjs';

// Flat scalar JSON grammar deliberately excludes nested values. JSON.parse alone
// cannot reject duplicate members, malformed UTF-8, or escaped lone surrogates.
export function parse(bytes) {
  if (bytes.length > 262144) throw fault('INPUT_LIMIT');
  let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fault('INVALID_JSON'); }
  let i = 0; const x = Object.create(null); const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    const m = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(i));
    if (!m) throw fault('INVALID_JSON'); i += m[0].length;
    const s = JSON.parse(m[0]); if (!s.isWellFormed()) throw fault('INVALID_JSON'); return s;
  };
  ws(); if (text[i++] !== '{') throw fault('INVALID_JSON'); ws();
  if (text[i] !== '}') for (;;) {
    const k = string(); if (Object.hasOwn(x, k)) throw fault('INVALID_JSON');
    ws(); if (text[i++] !== ':') throw fault('INVALID_JSON'); ws();
    if (text[i] === '"') x[k] = string();
    else { const m = /^(?:false|true|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i)); if (!m) throw fault('INVALID_JSON'); x[k] = JSON.parse(m[0]); i += m[0].length; }
    ws(); if (text[i] !== ',') break; i++; ws();
  }
  if (text[i++] !== '}') throw fault('INVALID_JSON'); ws(); if (i !== text.length) throw fault('INVALID_JSON');
  const fields = x.op === 'send' ? ['v','op','caller','id','to','text','delivery','expectReply'] : ['v','op','caller','id'];
  if (Object.keys(x).length !== fields.length || fields.some(k => !Object.hasOwn(x,k)) || Object.keys(x).some(k => !fields.includes(k)) ||
    x.v !== 1 || !['send','status','cancel'].includes(x.op) || typeof x.caller !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(x.caller) ||
    typeof x.id !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/.test(x.id)) throw fault('SCHEMA');
  if (x.op === 'send' && (typeof x.to !== 'string' || !/^pi\/[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(x.to) ||
    typeof x.text !== 'string' || !x.text.trim() || Buffer.byteLength(x.text) > 32768 || !['queue','steer'].includes(x.delivery) || x.expectReply !== false)) throw fault('SCHEMA');
  return x;
}
export function input(stream, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const done = (err) => { clearTimeout(timer); stream.removeListener('data', data); stream.removeListener('end', end); stream.removeListener('error', error); stream.pause(); err ? reject(err) : resolve(Buffer.concat(chunks)); };
    const data = b => { size += b.length; if (size > 262144) done(fault('INPUT_LIMIT')); else chunks.push(b); };
    const end = () => done(); const error = () => done(fault('INVALID_JSON'));
    const timer = setTimeout(() => done(fault('INPUT_TIMEOUT')), timeout);
    stream.on('data', data).once('end', end).once('error', error);
  });
}
export const exits = { INVALID_JSON:2, SCHEMA:2, INPUT_LIMIT:2, INPUT_TIMEOUT:2, UNAVAILABLE:3, UNSUPPORTED_TARGET:3, UNSUPPORTED_SECURITY:3, CAPACITY:3,
  UNKNOWN:3, CONFLICT:4, CANCELLED:4, TOO_LATE:4, A2A_BUSY:5, STORAGE_UNCERTAIN:6 };
export async function machine(createStore) {
  let result, exit = 0;
  try { const x = parse(await input(process.stdin)); const store = createStore(); result = { v:1, ok:true, receipt:operate(store,x) }; }
  catch (e) { const code = Object.hasOwn(exits, e.code) ? e.code : 'STORAGE_UNCERTAIN'; exit = exits[code]; result = { v:1, ok:false, error:code, retry:'same_key_only' }; }
  const out = JSON.stringify(result); process.stdout.write(out.length <= 8191 ? out + '\n' : '{"v":1,"ok":false,"error":"STORAGE_UNCERTAIN"}\n'); process.exitCode = exit;
}
