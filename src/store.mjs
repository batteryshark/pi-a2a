import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { accountIdentity, securePath, windowsHelper, windowsPath } from './platform.mjs';
import { compact, NATIVE_BYTES, STATE_BYTES } from './ledger.mjs';

export const id = () => crypto.randomUUID();
export const live = pid => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
export function key(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(s)) throw Error('Invalid bounded ID');
  return s;
}
const empty = () => ({ v:2, sessions:{}, requests:{}, creates:{}, external:{} });
export function retryIO(fn, { platform = process.platform, wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms) } = {}) {
  for (let n = 0; ; n++) try { return fn(); } catch (e) {
    if (platform !== 'win32' || !['EPERM','EACCES','EBUSY'].includes(e.code) || n === 3) throw e;
    wait(10 * (n + 1));
  }
}
export class Store {
  constructor(root, { readOnly = false } = {}) {
    accountIdentity();
    if (!path.isAbsolute(root)) throw Error('Absolute state root required');
    this.readOnly = readOnly;
    if (process.platform === 'win32') {
      windowsPath(root);
      windowsHelper(readOnly ? 'inspectRoot' : 'root', root);
    } else {
      if (!readOnly) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (fs.existsSync(root)) {
        securePath(root, true);
        if (fs.realpathSync(root) !== path.resolve(root)) throw Error('Symlinked state path refused');
      } else {
        let p = path.dirname(root); while (!fs.existsSync(p)) p = path.dirname(p);
        if (fs.realpathSync(p) !== p) throw Error('Symlinked state path refused');
      }
    }
    this.root = root;
    this.file = path.join(root, 'state.json');
    this.lock = path.join(root, 'transaction.lock');
  }
  read() {
    if (!fs.existsSync(this.root)) return empty();
    if (process.platform === 'win32') windowsHelper('verifyRoot', this.root); else securePath(this.root, true);
    if (!fs.existsSync(this.file)) return empty();
    securePath(this.file);
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.fstatSync(fd).size > STATE_BYTES) throw Error('State size limit reached');
      const s = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (s.v !== 2) throw Error('Unknown state version; use an empty v2 root, no automatic migration');
      return s;
    } finally { fs.closeSync(fd); }
  }
  tx(fn) {
    if (this.readOnly) throw Error('Read-only inspection');
    if (process.platform === 'win32') windowsHelper('verifyRoot', this.root); else securePath(this.root, true);
    // No waiting/polling. A contended short transaction fails for caller retry.
    try { fs.mkdirSync(this.lock, { mode: 0o700 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      securePath(this.lock, true);
      let owner;
      try { securePath(path.join(this.lock, 'owner')); if (fs.statSync(path.join(this.lock, 'owner')).size > 1024) throw Error('owner limit'); owner = JSON.parse(fs.readFileSync(path.join(this.lock, 'owner'), 'utf8')); } catch { throw Error('State lock incomplete; manual reconciliation required'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw Error('State lock owner unknown; manual reconciliation required');
      if (live(owner.pid)) throw Object.assign(Error('State transaction busy'), { code: 'A2A_BUSY' });
      throw Error('Stale state lock: stop owners and reconcile lock manually; admission is not replayed');
    }
    const owner = path.join(this.lock, 'owner');
    const tmp = path.join(this.root, `${id()}.tmp`);
    let committed = false, failure, result;
    try {
      securePath(this.lock, true);
      const ownerFd = fs.openSync(owner, 'wx', 0o600);
      try { securePath(owner); fs.writeFileSync(ownerFd, JSON.stringify({ pid: process.pid })); } finally { fs.closeSync(ownerFd); }
      const s = this.read(); compact(s); result = fn(s); compact(s);
      // Keep native growth from consuming the external transition reserve.
      if (Buffer.byteLength(JSON.stringify({ sessions:s.sessions, requests:s.requests, creates:s.creates })) > NATIVE_BYTES) throw Error('Native state capacity reached');
      const body = JSON.stringify(s);
      if (Buffer.byteLength(body) > STATE_BYTES) throw Error('State size limit reached; retained identities must not be evicted');
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { securePath(tmp); fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (fs.existsSync(this.file)) securePath(this.file);
      retryIO(() => fs.renameSync(tmp, this.file)); committed = true;
      // Windows has no supported Node directory-fsync contract. File is flushed
      // before replacement; power-loss durability of directory metadata is unknown.
      if (process.platform !== 'win32') { const d = fs.openSync(this.root, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }
    } catch (e) { failure = e; }
    try {
      if (fs.existsSync(tmp)) retryIO(() => fs.unlinkSync(tmp));
      if (fs.existsSync(owner)) retryIO(() => fs.unlinkSync(owner));
      retryIO(() => fs.rmdirSync(this.lock));
    } catch (e) { failure ??= e; }
    if (failure) {
      if (committed) throw Object.assign(Error('State commit or cleanup uncertain; inspect same identity'), { code:'STORAGE_UNCERTAIN' });
      throw failure;
    }
    return result;
  }
}
