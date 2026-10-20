import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Runtime } from '../src/runtime.mjs';

// Optional host-contract regression; all IDs/messages are synthetic.
// Point at an already installed Pi package, never a fixed release location.
test('installed Pi busy queue loss retries stable reply after restart; only saved transcript acknowledges', async () => {
  const installed = process.env.PI_A2A_PI_PACKAGE;
  assert.ok(installed && path.isAbsolute(installed), 'Set PI_A2A_PI_PACKAGE to the absolute installed pi-coding-agent package directory');
  const { AgentSession } = await import(pathToFileURL(path.join(installed, 'dist/core/agent-session.js')).href);
  const { SessionManager } = await import(pathToFileURL(path.join(installed, 'dist/core/session-manager.js')).href);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-a2a-installed-')));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: 'user', content: 'zero-model persistence fixture', timestamp: Date.now() });
  const queue = [], adapter = { isStreaming: true, agent: { followUp: m => queue.push(m) } };
  const sendMessage = (m, o) => { void AgentSession.prototype.sendCustomMessage.call(adapter, m, o); };
  const make = (session, deliver = sendMessage) => new Runtime({ root: dir, session, cwd: dir,
    extension: fileURLToPath(new URL('../index.ts', import.meta.url)), sendMessage: deliver,
    transcript: () => manager.getSessionFile() });
  let a = make('fake_sender'); const b = make('fake_receiver', () => {}); a.start(); b.start();
  try {
    const original = await a.send('pi/fake_receiver', 'synthetic task'); await b.reconcile();
    b.message({ message: { role: 'custom', customType: 'pi-a2a-request', details: { request: b.active.id } } });
    b.message({ message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic answer' }], stopReason: 'stop' } });
    b.settled(); await a.reconcile();
    assert.equal(queue.length, 1); assert.equal(a.store.read().requests[original.id].notified, false);
    await a.reconcile(); assert.equal(queue.length, 1);
    const stable = queue.pop(); await a.close();
    a = make('fake_sender'); a.start(); await a.reconcile();
    assert.equal(queue.length, 1); assert.equal(queue[0].details.replyId, stable.details.replyId);
    const m = queue.pop(); a.message({ type: 'message_start', message: m });
    a.message({ type: 'message_end', message: m }); await a.reconcile();
    assert.equal(a.store.read().requests[original.id].notified, false);
    manager.appendCustomMessageEntry(m.customType, m.content, m.display, m.details);
    await a.reconcile(); assert.equal(a.store.read().requests[original.id].notified, true);
    await a.close(); a = make('fake_sender'); a.start(); await a.reconcile();
    assert.equal(queue.length, 0);
    a.update(original.id, { notified: false }); await a.reconcile(); assert.equal(queue.length, 0);
    assert.equal(a.store.read().requests[original.id].notified, true);
  } finally { await a.close(); await b.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
