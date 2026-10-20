import { Store, id, live } from './src/store.mjs';
import { envelope, admit } from './src/protocol.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local trusted OS-user companion, not an OpenCode plugin or authenticated peer.
const [command, to, body] = process.argv.slice(2);
try {
  const store = new Store(process.env.PI_A2A_STATE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '.state'));
  if (command === 'list') console.log(JSON.stringify(Object.values(store.read().sessions)));
  else if (command === 'read') console.log(JSON.stringify(Object.values(store.read().requests).filter(r => r.id === to).map(r => ({ ...r, untrusted: true }))));
  else if (command === 'send') {
    const own = `pi/cli-${id()}`;
    const r = envelope(own, to, body);
    if (!to.startsWith('pi/')) throw Error('Companion sends to Pi only');
    store.tx(s => {
      const target = s.sessions[to]; if (!target?.online || !live(target.pid)) throw Error('Target offline');
      admit(s, r);
    });
    console.log(JSON.stringify({ id: r.id, reply: `node cli.mjs read ${r.id}`, automaticWakeOfOpenCode: false }));
  } else throw Error('Usage: node cli.mjs list | send pi/<id> "text" | read <request-id>');
} catch (e) { console.error(e.message); process.exitCode = 1; }
