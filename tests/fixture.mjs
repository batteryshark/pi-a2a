import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { windowsHelper } from '../src/platform.mjs';

export function fixtureRoot(prefix = 'pi-a2a-test-') {
  if (process.platform !== 'win32') return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const parent = process.env.PI_A2A_TEST_PARENT;
  if (!parent || !path.isAbsolute(parent)) throw Error('Native tests require PI_A2A_TEST_PARENT: an existing protected, owned NTFS proof parent (never ambient Temp)');
  windowsHelper('verifyRoot', parent);
  const root = path.join(parent, prefix + randomUUID());
  if (fs.existsSync(root)) throw Error('Fixture already exists');
  windowsHelper('root', root); // restrictive DACL supplied at creation, before payload
  return root;
}
