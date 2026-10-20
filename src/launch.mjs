import fs from 'node:fs';
import path from 'node:path';
import { windowsHelper, windowsPath } from './platform.mjs';

// Resolve the actual host entry, not the npm .cmd shim. All arguments remain
// separate argv elements. Overrides are trusted operator configuration, not tools.
export function piLaunch(args, { platform = process.platform, env = process.env, execPath = process.execPath,
  version = process.versions.node, hostEntry = process.argv[1], verify = windowsHelper, io = fs } = {}) {
  if (platform !== 'win32') return { file:env.PI_A2A_PI_BIN ?? 'pi', args };
  const bad = () => { throw Object.assign(Error('Unsupported native Pi launcher'), { code:'UNSUPPORTED_SECURITY' }); };
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || major < 22 || (major === 22 && minor < 19)) bad();
  const node = windowsPath(execPath), entry = windowsPath(env.PI_A2A_PI_ENTRY ?? hostEntry);
  if (path.win32.basename(node).toLowerCase() !== 'node.exe' || !/\.(?:m?js)$/i.test(entry)) bad();
  verify('launch', node); verify('launch', entry);
  for (const f of [node, entry]) { const s = io.lstatSync(f); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) bad(); }
  // Current Pi host argv or explicit reviewed entry must agree with package bin
  // metadata. No PATH search, shim interpretation, shell, or guessed install path.
  let dir = path.win32.dirname(entry), found = false;
  for (let n = 0; n < 6; n++) {
    const metadata = path.win32.join(dir,'package.json');
    if (io.existsSync(metadata)) {
      verify('launch', metadata);
      const s = io.lstatSync(metadata); if (!s.isFile() || s.nlink !== 1 || s.size > 262144) bad();
      let pkg; try { pkg = JSON.parse(io.readFileSync(metadata,'utf8')); } catch { bad(); }
      if (pkg.name === '@earendil-works/pi-coding-agent') {
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
        if (typeof bin !== 'string' || path.win32.resolve(dir,bin).toLowerCase() !== entry.toLowerCase()) bad();
        found = true; break;
      }
    }
    const parent = path.win32.dirname(dir); if (parent === dir) break; dir = parent;
  }
  if (!found) bad();
  return { file:node, args:[entry,...args] };
}
