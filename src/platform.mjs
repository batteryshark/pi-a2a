import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const unsupported = () => Object.assign(Error('Unsupported security platform'), { code: 'UNSUPPORTED_SECURITY' });
export function windowsPath(p) {
  if (typeof p !== 'string' || p.length > 240 || !/^[A-Za-z]:\\/.test(p) || /[\x00-\x1f<>"|?*\/]/.test(p) || p.slice(2).includes(':')) throw unsupported();
  const parts = p.slice(3).split('\\');
  if (parts.some(x => !x || /[. ]$/.test(x) || x === '.' || x === '..' || /^(con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(x))) throw unsupported();
  return path.win32.normalize(p);
}
// Fixed trusted package script, no generated PowerShell or user values in argv.
// spawnSync bounds wall time/output; stdin carries only the small operation/path.
export function windowsHelper(op, target, { run = spawnSync, env = process.env } = {}) {
  if (!['identity','root','verifyRoot','inspectRoot','file','directory','launch'].includes(op)) throw unsupported();
  if (target !== undefined) windowsPath(target);
  const system = windowsPath(env.SystemRoot);
  const helper = fileURLToPath(new URL('./windows-security.ps1', import.meta.url));
  const result = run(path.win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-File',helper],
    { input: JSON.stringify({ op, ...(target === undefined ? {} : { path:target }) }), encoding:'utf8', timeout:10000, maxBuffer:8192, windowsHide:true, shell:false });
  if (result.error || result.status !== 0) throw unsupported();
  let value; try { value = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()); } catch { throw unsupported(); }
  if (value.ok !== true || !/^S-1-5-(?:[0-9]+-)*[0-9]+$/.test(value.sid)) throw unsupported();
  return value;
}
export function accountIdentity({ platform = process.platform, getuid = process.getuid, helper = windowsHelper } = {}) {
  if (platform === 'win32') return `windows:${helper('identity').sid}`;
  if (typeof getuid !== 'function') throw unsupported();
  return `posix:${getuid()}`;
}
export function securePath(p, dir = false, { platform = process.platform, helper = windowsHelper, transcript = false } = {}) {
  if (platform === 'win32') {
    helper(dir ? 'directory' : 'file', p);
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) throw unsupported();
    return;
  }
  const s = fs.lstatSync(p);
  if (s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile()) || s.uid !== process.getuid() || s.nlink !== (dir ? s.nlink : 1) || (!transcript && (s.mode & 0o077))) throw Error('State must be owner-only, regular, and not symlinked');
}
