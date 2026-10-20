import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-a2a-probe-')));
const stateRoot = path.join(temp, 'mailbox');
// An isolated working directory and agent directory avoid loading user packages.
const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(temp, 'agent'), PI_A2A_STATE: stateRoot, PI_TELEMETRY: '0' };
for (const name of ['PI_A2A_OC_URL', 'PI_A2A_PARENT', 'PI_A2A_CREATE', 'PI_A2A_NESTED']) delete env[name];
const child = spawn(process.env.PI_A2A_PI_BIN ?? 'pi', ['--mode', 'rpc', '--offline', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--tools', 'a2a_list,a2a_read,a2a_send,a2a_create', '-e', base, '-e', path.join(base, 'tests/probe-extension.ts')],
  { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] });
let ended = false;
const pending = new Map();
const exited = new Promise(resolve => {
  child.once('error', () => { ended = true; for (const p of pending.values()) p.reject(Error('Pi executable failed')); resolve(); });
  child.once('exit', () => { ended = true; for (const p of pending.values()) p.reject(Error('Probe process exited')); resolve(); });
});
let force;
const stop = () => { if (!ended) { child.stdin.end(); child.kill('SIGTERM'); force ??= setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 2000); } };
const watchdog = setTimeout(stop, 20000);
let buf = '', next = 0;
child.stderr.on('data', () => {}); // Drain without printing host/provider diagnostics.
child.stdout.on('data', c => {
  buf += c.toString();
  if (buf.length > 4 * 1024 * 1024) { stop(); return; }
  let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n); buf = buf.slice(n + 1);
    let e; try { e = JSON.parse(line); } catch { continue; }
    const p = e.type === 'response' && pending.get(e.id);
    if (p) { pending.delete(e.id); e.success ? p.resolve(e) : p.reject(Error('RPC command failed')); }
  }
});
const command = input => new Promise((resolve, reject) => {
  if (ended) return reject(Error('Probe already exited'));
  const id = `fake-probe-${++next}`; pending.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ ...input, id }) + '\n');
});
try {
  await command({ type: 'get_state' });
  const r = await command({ type: 'prompt', message: '/pi-a2a-load-probe' });
  assert.equal(r.data.disposition, 'handled');
  const messages = await command({ type: 'get_messages' });
  const probe = messages.data.messages.find(m => m.customType === 'pi-a2a-load-probe');
  assert.deepEqual(probe.details.names, ['a2a_create', 'a2a_list', 'a2a_read', 'a2a_send']);
  const state = JSON.parse(fs.readFileSync(path.join(stateRoot, 'state.json')));
  assert.equal(Object.values(state.sessions).filter(x => x.online && x.pid === child.pid).length, 1);
  assert.equal(Object.keys(state.requests).length, 0);
  console.log('PASS installed Pi package-directory manifest load, four tools, registry; zero model requests');
} catch { console.error('FAIL zero-model load probe (host diagnostics suppressed)'); process.exitCode = 1; }
finally {
  stop(); await exited; clearTimeout(force); clearTimeout(watchdog);
  try {
    const state = JSON.parse(fs.readFileSync(path.join(stateRoot, 'state.json')));
    assert.equal(Object.values(state.sessions)[0].online, false);
    console.log('PASS session_shutdown; owned probe exited');
  } catch { console.error('FAIL shutdown assertion'); process.exitCode = 1; }
  fs.rmSync(temp, { recursive: true, force: true });
}
