import fs from 'node:fs';
import { securePath, windowsHelper } from './platform.mjs';

const uncertain = error => Object.assign(error, {creationUncertain:true});
export function acquirePrivateLock(p, {platform=process.platform, helper=windowsHelper, io=fs}={}) {
  if (platform !== 'win32') return io.mkdirSync(p,{mode:0o700});
  let result;
  try { result=helper('createLock',p); } catch(e) { throw uncertain(e); }
  if (result.created === false) throw Object.assign(Error('Lock exists'),{code:'EEXIST'});
  if (result.created !== true) throw uncertain(Error('Lock creation not acknowledged'));
}
export function samePrivateFile(a,b) {
  return a.isFile() && b.isFile() && a.nlink===1 && b.nlink===1 && a.dev===b.dev && a.ino===b.ino;
}
export function openPrivateNew(p, {platform=process.platform, helper=windowsHelper, io=fs, verify=securePath}={}) {
  if (platform !== 'win32') return io.openSync(p,'wx',0o600);
  let fd;
  try {
    if (helper('createFile',p).created !== true) throw Error('File creation not acknowledged');
    verify(p);
    const before=io.lstatSync(p);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink!==1 || before.size!==0) throw Error('Unsafe empty file');
    // Never create/truncate as a fallback. Helper already exclusively created it.
    fd=io.openSync(p,'r+');
    const opened=io.fstatSync(fd);
    verify(p);
    const after=io.lstatSync(p);
    if (!samePrivateFile(before,opened) || !samePrivateFile(opened,after) || opened.size!==0 || after.size!==0) throw Error('New file changed');
    return fd;
  } catch(e) {
    if (fd!==undefined) { try { io.closeSync(fd); } catch {} }
    // Timeout/lost ack/verification failure does not authorize deleting or
    // adopting the potentially created object. Retain its lock for inspection.
    throw uncertain(e);
  }
}
