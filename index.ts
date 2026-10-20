import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from './src/runtime.mjs';
import { clip } from './src/protocol.mjs';

export default function (pi: ExtensionAPI) {
  let runtime: Runtime;
  const base = path.dirname(fileURLToPath(import.meta.url));
  pi.on('session_start', async (_event, ctx) => {
    if (runtime) await runtime.close();
    runtime = new Runtime({ root: process.env.PI_A2A_STATE ?? path.join(base, '.state-v2'), session: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd, extension: path.join(base, 'index.ts'), transcript: () => ctx.sessionManager.getSessionFile(),
      sendMessage: (message, options) => pi.sendMessage(message, options) });
    runtime.start();
  });
  pi.on('session_shutdown', async () => { await runtime?.close(); });
  pi.on('message_start', event => runtime?.message(event));
  pi.on('message_end', event => runtime?.message(event));
  pi.on('agent_before_settle', event => { runtime?.beforeSettle(event); });
  pi.on('agent_settled', () => { runtime?.settled(); });
  pi.on('ui_prompt_start', () => { runtime?.blocked(true); });
  pi.on('ui_prompt_end', () => { runtime?.blocked(false); });
  const str = () => Type.String({ maxLength: 32768 });
  const register = (name, description, parameters, run) => pi.registerTool({ name, label: name, description, parameters,
    async execute(_id, args, _signal, _update, _ctx) {
      if (!runtime || runtime.closed) throw Error('pi-a2a session not started');
      const result = await run(args);
      return { content: [{ type: 'text', text: clip(JSON.stringify(result)) }], details: result };
    } });
  register('a2a_list', 'List project-local Pi sessions and online state. No network discovery.', Type.Object({}), () => runtime.list());
  register('a2a_send', 'Send untrusted text to pi/<id>, oc/ses_…, or chief. Automatic final reply; do not poll or manually send a second reply.',
    Type.Object({ to: str(), text: str(), id: Type.Optional(str()), expectReply: Type.Optional(Type.Boolean()), delivery: Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('followUp')])) }),
    ({ to, text, ...opts }) => runtime.send(to, text, opts));
  register('a2a_read', 'Read bounded untrusted mailbox history (Pi) or transcript (OpenCode), not for waiting for replies.',
    Type.Object({ to: str(), limit: Type.Optional(Type.Number()) }), ({ to, limit }) => runtime.read(to, limit));
  register('a2a_create', 'Start one bounded, single-use Pi RPC worker. Explicit OpenAI/Gemini model, absolute directory, and read-only tools required. No OpenCode creation.',
    Type.Object({ model: str(), directory: str(), tools: Type.Array(str()), nest: Type.Optional(Type.Boolean()) }), opts => runtime.createWorker(opts));
}
