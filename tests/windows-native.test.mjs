import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { windowsHelper, accountIdentity, securePath } from '../src/platform.mjs';
import { Store } from '../src/store.mjs';
import { fixtureRoot } from './fixture.mjs';

const native = process.platform === 'win32';
test('native descriptor policy: TrustedInstaller OS roles, strict payload roles and untrusted negatives', {skip:!native}, () => {
  const r=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./windows-policy.test.ps1',import.meta.url))],
    {encoding:'utf8',timeout:20000,shell:false});
  assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/passed=24/);
});
test('native protected root, inherited payload, transaction lock/temp and restart', {skip:!native,timeout:170000}, () => {
  const root=fixtureRoot('native-');
  try {
    const identity=accountIdentity(); assert.match(identity,/^windows:S-1-5-/);
    assert.equal(identity,`windows:${windowsHelper('identity').sid}`);
    const store=new Store(root);
    store.tx(s=>{windowsHelper('directory',store.lock); securePath(path.join(store.lock,'owner')); s.marker=7;});
    assert.equal(new Store(root).read().marker,7); securePath(store.file);
    const link=path.join(root,'hardlink'); fs.linkSync(store.file,link);
    assert.throws(()=>securePath(link)); fs.unlinkSync(link);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('native actual ordinary-grant and junction negatives, trusted OS descriptor', {skip:!native,timeout:90000}, () => {
  const root=fixtureRoot('native-negative-');
  try {
    const r=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./windows-fixtures.ps1',import.meta.url)),root],
      {encoding:'utf8',timeout:65000,shell:false});
    assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/filesystem-negatives passed=5/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('native machine capabilities/lookup remain pure and strict JSON stays on stdin', {skip:!native,timeout:65000}, () => {
  const parent=fixtureRoot('native-cli-');
  try {
    const root=path.join(parent,'absent');
    const run=input=>spawnSync(process.execPath,['cli.mjs','machine'],{
      env:{...process.env,PI_A2A_STATE:root},input,encoding:'utf8',timeout:15000,shell:false});
    let r=run('{"v":1,"op":"capabilities"}');
    assert.equal(r.status,0,r.stdout+r.stderr); assert.equal(JSON.parse(r.stdout).capabilities.inspection,'read_only');
    r=run('{"v":1,"op":"lookup","to":"pi/fixture"}');
    assert.equal(r.status,0,r.stdout+r.stderr); assert.equal(JSON.parse(r.stdout).target.exists,false);
    assert.equal(fs.existsSync(root),false);
    r=run('{"v":1,"op":"status","caller":"fixture","id":"fake","id":"other"}');
    assert.equal(r.status,2); assert.equal(JSON.parse(r.stdout).ok,false); assert.equal(r.stderr,'');
  } finally { fs.rmSync(parent,{recursive:true,force:true}); }
});
