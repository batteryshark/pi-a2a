import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { id, live } from './store.mjs';
import { piLaunch } from './launch.mjs';
export const workerTools = ['read', 'grep', 'find', 'ls', 'a2a_list', 'a2a_read', 'a2a_send'];
export function workerArgs({ model, directory, extension, transcript, tools }) {
  if (!/^(openai|openai-codex|google|google-gemini-cli)\/[A-Za-z0-9._:/-]+$/.test(model ?? '')) throw Error('Explicit allowed OpenAI/Gemini provider/model required');
  if (!path.isAbsolute(directory ?? '') || !fs.statSync(directory).isDirectory()) throw Error('Explicit existing absolute cwd required');
  if (!path.isAbsolute(extension) || !path.isAbsolute(transcript)) throw Error('Absolute extension/transcript required');
  if (!Array.isArray(tools) || tools.some(t => !workerTools.includes(t))) throw Error('Explicit read-only tool policy required');
  return ['--mode', 'rpc', '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes',
    '--extension', extension, '--session', transcript, '--model', model, ...(tools.length ? ['--tools', tools.join(',')] : ['--no-tools'])];
}
export async function createWorker(runtime, opts) {
  if (runtime.parent) throw Error('Workers cannot create more workers');
  const token = id(); const transcript = path.join(runtime.store.root, `${token}.jsonl`);
  const args = workerArgs({ ...opts, extension: runtime.extension, transcript });
  const launch = piLaunch(args, { env:{...process.env, PI_A2A_PI_BIN:runtime.piBin} });
  // Reserve before spawning. An ambiguous/crashed create is never replayed.
  runtime.store.tx(s => {
    if (Object.values(s.creates).filter(c => c.status === 'reserved' || (c.status === 'running' && live(c.pid))).length >= 2) throw Error('Two-worker limit reached');
    s.creates[token] = { owner: runtime.self, parent: runtime.self, nested: opts.nest !== false, status: 'reserved', transcript };
  });
  const child = (runtime.spawnImpl ?? spawn)(launch.file, launch.args, { shell:false, windowsHide:true, cwd: opts.directory, env: { ...process.env, PI_A2A_STATE: runtime.store.root, PI_A2A_PARENT: runtime.self,
    PI_A2A_CREATE: token, PI_A2A_NESTED: opts.nest === false ? '0' : '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  runtime.children.set(token, child);
  let force, requestTimer;
  const stop = () => { if (child.exitCode === null && child.pid) {
    child.stdin.end(); child.kill('SIGTERM');
    if (!force) force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
  } };
  // Hard bounded process, including permission/UI waits; identify by ChildProcess PID only.
  const timer = setTimeout(stop, 600000);
  child.once('exit', () => { clearTimeout(timer); clearTimeout(force); clearTimeout(requestTimer); runtime.children.delete(token);
    try { runtime.store.tx(s => { s.creates[token].status = 'exited'; }); } catch {} });
  child.stderr.on('data', () => {}); // drain, never persist credentials/provider diagnostics
  let buf = '';
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, result) => { if (done) return; done = true; clearTimeout(startup); err ? (stop(), reject(err)) : resolve(result); };
    const startup = setTimeout(() => finish(Error('Pi worker startup timeout; not replayed')), 15000);
    child.once('error', () => finish(Error('Pi executable failed')));
    child.once('exit', () => finish(Error('Pi worker exited before readiness')));
    child.on('spawn', () => {
      try {
        runtime.store.tx(s => { Object.assign(s.creates[token], { status: 'running', pid: child.pid }); });
        child.stdin.write(JSON.stringify({ id: token, type: 'get_state' }) + '\n');
      } catch { finish(Error('Worker ownership admission failed; reconcile reserved create')); }
    });
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (buf.length > 4 * 1024 * 1024) { finish(Error('RPC frame too large')); stop(); return; }
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n); buf = buf.slice(n + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'response' && event.id === token) {
          try {
            const session = Object.values(runtime.store.read().sessions).find(x => x.create === token && x.pid === child.pid);
            if (!event.success || !session) return finish(Error('Worker extension did not register'));
            finish(null, { to: session.address, nested: opts.nest !== false, parent: runtime.self, replyOwner: runtime.self, pid: child.pid });
          } catch { finish(Error('Worker registry read failed')); }
        }
        if (event.type === 'agent_start' && !requestTimer) requestTimer = setTimeout(() => {
          stop();
        }, 180000);
        if (event.type === 'agent_settled') {
          // Extension commits the correlated reply first. Detached a2a waits
          // are not final, even if this low-level Pi invocation has settled.
          try {
            const state = runtime.store.read();
            const worker = Object.values(state.sessions).find(x => x.create === token);
            const pending = worker && Object.values(state.requests).some(r => r.to === worker.address && !['completed', 'error', 'abort', 'timeout'].includes(r.status));
            if (!pending) stop();
          } catch { stop(); }
        }
      }
    });
  });
}
