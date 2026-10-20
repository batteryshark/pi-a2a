import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureRoot } from './fixture.mjs';
import { acquirePrivateLock, openPrivateNew } from '../src/private-create.mjs';
import { securePath, windowsHelper } from '../src/platform.mjs';
import { Store } from '../src/store.mjs';

// Portable fault seams, NOT native .NET/NTFS proof.
test('Windows read-only evidence role never becomes Store verification; helper creation acknowledgments are strict (MOCK)',()=>{
  const root=fixtureRoot(), file=path.join(root,'synthetic');
  try {
    fs.writeFileSync(file,''); const seen=[];
    const options={platform:'win32',helper:op=>seen.push(op)};
    securePath(file,false,{...options,transcript:true});
    securePath(root,true,{...options,transcript:true});
    securePath(file,false,options); securePath(root,true,options);
    assert.deepEqual(seen,['evidence','evidenceDirectory','file','directory']);
    const invoke=(op,result)=>windowsHelper(op,'C:\\Fixture\\new',{env:{SystemRoot:'C:\\Windows'},run:()=>({status:0,stdout:JSON.stringify({ok:true,sid:'S-1-5-21-123',...result})})});
    assert.equal(invoke('createLock',{created:false}).created,false);
    assert.equal(invoke('createFile',{created:true}).created,true);
    for(const op of ['createFile','createLock']) assert.throws(()=>invoke(op,{}),{code:'UNSUPPORTED_SECURITY'});
    assert.throws(()=>invoke('createFile',{created:false}),{code:'UNSUPPORTED_SECURITY'});
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('Windows creation seam requires exclusive helper acknowledgment and opens r+ only after empty-file verification (MOCK)',()=>{
  const stat={isFile:()=>true,isSymbolicLink:()=>false,nlink:1,size:0,dev:1,ino:2};
  const calls=[];
  const options={platform:'win32',helper:(op,p)=>{calls.push(op);return {created:true};},verify:()=>calls.push('verify'),io:{
    lstatSync:()=>stat,fstatSync:()=>stat,openSync:(p,flags)=>{calls.push(flags);return 7;},closeSync:()=>calls.push('close')
  }};
  assert.equal(openPrivateNew('fixture',options),7);
  assert.deepEqual(calls,['createFile','verify','r+','verify']);
  for(const result of [{}, {created:false}]) {
    assert.throws(()=>openPrivateNew('fixture',{...options,helper:()=>result}),e=>e.creationUncertain===true);
  }
  for(const change of [{size:1},{nlink:2},{ino:3},{isFile:()=>false}]) {
    assert.throws(()=>openPrivateNew('fixture',{...options,io:{...options.io,fstatSync:()=>({...stat,...change})}}),e=>e.creationUncertain===true);
    assert.equal(calls.at(-1),'close');
  }
  assert.throws(()=>acquirePrivateLock('fixture',{platform:'win32',helper:()=>({created:false})}),{code:'EEXIST'});
  assert.throws(()=>acquirePrivateLock('fixture',{platform:'win32',helper:()=>({})}),e=>e.creationUncertain===true);
});

test('lost file-create acknowledgment retains incomplete lock/empty file without callback, adoption, cleanup or retry (MOCK)',()=>{
  const root=fixtureRoot(); let calls=0, callbacks=0;
  try {
    const store=new Store(root,{createFile:p=>openPrivateNew(p,{platform:'win32',verify:securePath,helper:()=>{
      calls++; fs.closeSync(fs.openSync(p,'wx',0o600)); throw Error('simulated timeout/lost acknowledgment');
    }})});
    assert.throws(()=>store.tx(()=>callbacks++),e=>e.creationUncertain===true);
    assert.equal(calls,1); assert.equal(callbacks,0);
    assert.equal(fs.statSync(path.join(store.lock,'owner')).size,0);
    assert.throws(()=>new Store(root).tx(()=>callbacks++),/lock incomplete/);
    assert.equal(callbacks,0); assert.equal(fs.existsSync(store.lock),true);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('lost exclusive-directory acknowledgment retains unknown directory, never adopts it (MOCK)',()=>{
  const root=fixtureRoot(); let calls=0;
  try {
    const store=new Store(root,{createLock:p=>acquirePrivateLock(p,{platform:'win32',helper:()=>{
      calls++; if(process.platform==='win32') windowsHelper('root',p); else fs.mkdirSync(p,{mode:0o700});
      throw Error('simulated helper timeout');
    }})});
    assert.throws(()=>store.tx(()=>assert.fail('callback')),e=>e.creationUncertain===true);
    assert.equal(calls,1); assert.deepEqual(fs.readdirSync(store.lock),[]);
    assert.throws(()=>new Store(root).tx(()=>assert.fail('adoption')),/lock incomplete/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('lost temporary-file acknowledgment retains lock/unknown temp and does not commit or replay callback (MOCK)',()=>{
  const root=fixtureRoot(); let callbacks=0, temp;
  try {
    const store=new Store(root,{createFile:p=>{
      if(path.basename(p)==='owner') return openPrivateNew(p);
      temp=p;
      return openPrivateNew(p,{platform:'win32',helper:()=>{
        fs.closeSync(fs.openSync(p,'wx',0o600)); throw Error('simulated lost temporary-file acknowledgment');
      }});
    }});
    assert.throws(()=>store.tx(s=>{callbacks++;s.marker=1;}),e=>e.creationUncertain===true);
    assert.equal(callbacks,1); assert.equal(fs.statSync(temp).size,0);
    assert.equal(store.read().marker,undefined);
    assert.throws(()=>new Store(root).tx(()=>callbacks++),{code:'A2A_BUSY'});
    assert.equal(callbacks,1); assert.equal(fs.existsSync(store.lock),true);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('postreplacement security failure is potentially committed and never replays callback',()=>{
  const root=fixtureRoot(), store=new Store(root); let callbacks=0, replaced=false;
  const rename=fs.renameSync, lstat=fs.lstatSync;
  fs.renameSync=(...args)=>{rename(...args);replaced=true;};
  fs.lstatSync=(p,...args)=>{if(replaced && p===store.file) throw Error('simulated postreplacement verification failure'); return lstat(p,...args);};
  try {assert.throws(()=>store.tx(s=>{callbacks++;s.marker=1;}),{code:'STORAGE_UNCERTAIN'});}
  finally {fs.renameSync=rename;fs.lstatSync=lstat;}
  try {assert.equal(callbacks,1);assert.equal(store.read().marker,1);assert.equal(fs.existsSync(store.lock),false);}
  finally {fs.rmSync(root,{recursive:true,force:true});}
});
