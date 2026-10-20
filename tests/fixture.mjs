import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { windowsHelper } from '../src/platform.mjs';
import assert from 'node:assert/strict';
import { setTimeout as timerTurn } from 'node:timers/promises';

// Positive progress only: reconcile can join a pass with an older snapshot.
export async function reconcileUntil(runtime, condition, label) {
  for (let i=0;i<8&&!condition();i++) {await timerTurn(0);await runtime.reconcile();}
  assert.ok(condition(),`${label}: expected condition within eight normal reconciliation passes`);
}

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
