import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const id = () => crypto.randomUUID();
export const live = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
export function key(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(s)) throw Error('Invalid bounded ID');
  return s;
}
function secure(p, dir = false) {
  const s = fs.lstatSync(p);
  if (s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile()) || s.uid !== process.getuid() || (s.mode & 0o077)) throw Error('State must be owner-only, regular, and not symlinked');
}
export class Store {
  constructor(root) {
    if (!path.isAbsolute(root)) throw Error('Absolute state root required');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    secure(root, true);
    if (fs.realpathSync(root) !== path.resolve(root)) throw Error('Symlinked state path refused');
    this.root = root;
    this.file = path.join(root, 'state.json');
    this.lock = path.join(root, 'transaction.lock');
  }
  read() {
    if (!fs.existsSync(this.file)) return { v: 1, sessions: {}, requests: {}, creates: {} };
    secure(this.file);
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.fstatSync(fd).size > 16 * 1024 * 1024) throw Error('State size limit reached');
      const s = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (s.v !== 1) throw Error('Unknown state version');
      return s;
    } finally { fs.closeSync(fd); }
  }
  tx(fn) {
    // No waiting/polling. A contended short transaction fails for caller retry.
    try { fs.mkdirSync(this.lock, { mode: 0o700 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      secure(this.lock, true);
      let owner;
      try { owner = JSON.parse(fs.readFileSync(path.join(this.lock, 'owner'), 'utf8')); } catch { throw Error('State lock incomplete; manual reconciliation required'); }
      if (live(owner.pid)) throw Object.assign(Error('State transaction busy'), { code: 'A2A_BUSY' });
      throw Error('Stale state lock: stop owners and reconcile lock manually; admission is not replayed');
    }
    const owner = path.join(this.lock, 'owner');
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    const tmp = path.join(this.root, `${id()}.tmp`);
    try {
      const s = this.read(); const result = fn(s);
      const body = JSON.stringify(s);
      if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw Error('State size limit reached; archive terminal records offline');
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      const d = fs.openSync(this.root, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
      return result;
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      fs.unlinkSync(owner); fs.rmdirSync(this.lock);
    }
  }
}
