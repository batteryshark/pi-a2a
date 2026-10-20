import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { windowsHelper, accountIdentity, securePath } from '../src/platform.mjs';
import { Store } from '../src/store.mjs';
import { fixtureRoot } from './fixture.mjs';
import { openPrivateNew } from '../src/private-create.mjs';

const native = process.platform === 'win32';
test('native descriptor policy: TrustedInstaller OS roles, strict payload roles and untrusted negatives', {skip:!native}, () => {
  const r=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./windows-policy.test.ps1',import.meta.url))],
    {encoding:'utf8',timeout:20000,shell:false});
  assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/passed=36/);
});
test('native exclusive incomplete/live locks are never adopted or stolen', {skip:!native,timeout:90000},()=>{
  const root=fixtureRoot('native-lock-');
  try {
    const store=new Store(root);
    assert.equal(windowsHelper('createLock',store.lock).created,true);
    assert.throws(()=>store.tx(()=>assert.fail('incomplete lock adopted')),/lock incomplete/);
    const p=path.join(store.lock,'owner');
    const fd=openPrivateNew(p);
    try {
      assert.throws(()=>store.tx(()=>assert.fail('empty owner adopted')),/lock incomplete/);
      fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));
    } finally {fs.closeSync(fd);}
    assert.throws(()=>store.tx(()=>assert.fail('live lock stolen')),{code:'A2A_BUSY'});
    assert.equal(JSON.parse(fs.readFileSync(p,'utf8')).pid,process.pid);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
for(const fault of ['timeout','lostAck']) test(`native file-create ${fault}: conservative retained lock, no callback (injected transport fault)`, {skip:!native,timeout:90000},()=>{
  const root=fixtureRoot('native-ack-'); let callbacks=0, calls=0;
  try {
    const store=new Store(root,{createFile:p=>openPrivateNew(p,{helper:(op,target)=>windowsHelper(op,target,{run:(file,args,options)=>{
      calls++;
      if(fault==='timeout') return spawnSync(file,args,{...options,timeout:1});
      const result=spawnSync(file,args,options);
      assert.equal(result.status,0,'real creation must complete before discarding acknowledgment');
      return {...result,stdout:''};
    }})})});
    assert.throws(()=>store.tx(()=>callbacks++),e=>e.creationUncertain===true);
    assert.equal(calls,1); assert.equal(callbacks,0); assert.equal(fs.existsSync(store.lock),true);
    assert.throws(()=>new Store(root).tx(()=>callbacks++),/lock incomplete/);
    assert.equal(callbacks,0);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('native protected root, inherited payload, transaction lock/temp and restart', {skip:!native,timeout:170000}, () => {
  const root=fixtureRoot('native-');
  try {
    const identity=accountIdentity(); assert.match(identity,/^windows:S-1-5-/);
    assert.equal(identity,`windows:${windowsHelper('identity').sid}`);
    const store=new Store(root);
    const rename=fs.renameSync; let temps=0, callbacks=0;
    fs.renameSync=(from,to)=>{securePath(from);temps++;return rename(from,to);};
    try {store.tx(s=>{
      callbacks++; windowsHelper('directory',store.lock); securePath(path.join(store.lock,'owner'));
      assert.throws(()=>new Store(root).tx(()=>assert.fail('contended callback')),e=>e.code==='A2A_BUSY');
      s.marker=7;
    });} finally {fs.renameSync=rename;}
    assert.equal(callbacks,1); assert.equal(temps,1);
    assert.equal(new Store(root).read().marker,7); securePath(store.file);
    // Real replacement with an injected postcommit verification failure, not an
    // ACL repair. The committed bytes survive and callback is never replayed.
    const lstat=fs.lstatSync; let replaced=false, postCallbacks=0;
    fs.renameSync=(...args)=>{rename(...args);replaced=true;};
    fs.lstatSync=(p,...args)=>{if(replaced && p===store.file) throw Error('injected postcommit verification fault');return lstat(p,...args);};
    try {assert.throws(()=>store.tx(s=>{postCallbacks++;s.marker=8;}),{code:'STORAGE_UNCERTAIN'});}
    finally {fs.renameSync=rename;fs.lstatSync=lstat;}
    assert.equal(postCallbacks,1); assert.equal(new Store(root).read().marker,8);
    const link=path.join(root,'hardlink'); fs.linkSync(store.file,link);
    assert.throws(()=>securePath(link)); fs.unlinkSync(link);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('native internal helper framing: bounded optional encoding signature and strict negatives', {skip:!native,timeout:90000},t=>{
  const root=fixtureRoot('native-\ufeff-framing-');let passed=false;
  const helper=fileURLToPath(new URL('../src/windows-security.ps1',import.meta.url));
  const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const identity='{"op":"identity"}';
  const boundary=JSON.stringify({op:'identity',padding:'x'.repeat(2048-JSON.stringify({op:'identity',padding:''}).length)});
  const probe=(name,input,status)=>{
    const r=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-File',helper],{input,encoding:'utf8',timeout:10000,maxBuffer:8192,shell:false,windowsHide:true});
    assert.equal(r.status,status,`${name}: ${r.stdout}${r.stderr}`);assert.equal(r.stderr,'');
    const response=JSON.parse(r.stdout.replace(/^\ufeff/,''));assert.equal(response.ok,status===0,name);
    t.diagnostic(`${name}: exit ${r.status}`);
  };
  try {
    probe('no signature',Buffer.from(identity),0);
    probe('single raw UTF8 signature (decoder handling unobserved)',Buffer.from('\ufeff'+identity),0);
    // Three raw signatures leave repeated decoded prefixes even if Console
    // consumes one encoding signature; do not claim which decoder path ran.
    probe('repeated framing prefixes',Buffer.from('\ufeff\ufeff\ufeff'+identity),3);
    probe('noninitial signature is not whitespace',Buffer.from(' \ufeff'+identity),3);
    probe('malformed JSON',Buffer.from('\ufeff{'),3);
    probe('strict invalid UTF8 inside otherwise valid JSON',Buffer.concat([Buffer.from('{"op":"identity","padding":"'),Buffer.from([0xc3,0x28]),Buffer.from('"}')]),3);
    assert.equal(boundary.length,2048);probe('raw character boundary',Buffer.from(boundary),0);
    probe('raw over2048 characters',Buffer.from(boundary+' '),3);
    probe('signature cannot rescue over2048 body',Buffer.from('\ufeff'+boundary+' '),3);
    assert.equal(fs.existsSync(root.replace('\ufeff','')),false);
    probe('inside-string path signature is preserved',Buffer.from(JSON.stringify({op:'verifyRoot',path:root})),0);
    probe('unknown operation is rejected',Buffer.from(JSON.stringify({op:'unknown'})),3);
    passed=true;
  } finally {
    if(!passed&&process.env.PI_A2A_TEST_RETAIN_FAILURE==='1')console.error(`Retained owned framing fixture: ${root}`);
    else fs.rmSync(root,{recursive:true,force:true});
  }
});
for(const mode of ['creation','evidence','reader']) test(`native explicit constructors/exclusivity and evidence roles: ${mode}`, {skip:!native,timeout:90000}, t=>{
  const root=fixtureRoot('native-create-');
  let passed=false;
  try {
    const r=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./windows-create-native.ps1',import.meta.url)),root,mode],
      {encoding:'utf8',timeout:80000,shell:false});
    if(mode==='evidence' && r.status===77) {passed=true;t.skip('Token cannot construct an Administrators-owned synthetic evidence fixture; descriptor-policy coverage is separate');return;}
    assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/native-fixtures passed/);
    passed=true;
  } finally {
    if(!passed&&process.env.PI_A2A_TEST_RETAIN_FAILURE==='1') console.error(`Retained owned native failure fixture: ${root}`);
    else fs.rmSync(root,{recursive:true,force:true});
  }
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
