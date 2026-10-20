import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Store, retryIO, live } from '../src/store.mjs';
import { accountIdentity, windowsPath, windowsHelper } from '../src/platform.mjs';
import { piLaunch } from '../src/launch.mjs';
import { parse } from '../src/machine.mjs';
import { lookup } from '../src/external.mjs';
import { Runtime } from '../src/runtime.mjs';
import { EventEmitter } from 'node:events';

// Portable policy/helper-invocation mocks, NOT native PowerShell/NTFS evidence.
const roots=[];
const root=()=>{ const p=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'a2a-policy-'))); roots.push(p); return p; };
test.after(()=>{for(const p of roots) fs.rmSync(p,{recursive:true,force:true});});
const frame=x=>parse(Buffer.from(JSON.stringify(x)));
test('inspection schemas are strict, caller-free, and support Docket identity lengths',()=>{
  assert.equal(frame({v:1,op:'capabilities'}).op,'capabilities');
  assert.equal(frame({v:1,op:'lookup',to:'pi/fake'}).to,'pi/fake');
  for(const x of [{v:1,op:'capabilities',caller:'x'},{v:1,op:'lookup',to:'chief'},{v:1,op:'lookup',to:'pi/a',id:'x'}]) assert.throws(()=>frame(x));
  assert.equal(frame({v:1,op:'status',caller:'docket-'+'a'.repeat(32),id:'msg_'+'b'.repeat(32)}).op,'status');
});
function machine(dir,x) {
  const p=spawnSync(process.execPath,['cli.mjs','machine'],{cwd:path.resolve('.'),env:{...process.env,PI_A2A_STATE:dir},input:JSON.stringify(x),encoding:'utf8',timeout:10000});
  assert.equal(p.status,0,p.stdout); assert.equal(p.stderr,''); assert.ok(Buffer.byteLength(p.stdout)<=8192); return JSON.parse(p.stdout);
}
function snapshot(dir) { return fs.readdirSync(dir).sort().map(n=>[n,fs.readFileSync(path.join(dir,n)).toString('hex')]); }
test('pure CLI capabilities and lookup: absent roots stay absent, existing bytes stay identical',()=>{
  const parent=root(), absent=path.join(parent,'absent');
  assert.equal(machine(absent,{v:1,op:'capabilities'}).capabilities.inspection,'read_only');
  assert.deepEqual(machine(absent,{v:1,op:'lookup',to:'pi/fake'}).target,{to:'pi/fake',exists:false,live:false,capable:false,snapshot:true,reservation:false});
  assert.equal(fs.existsSync(absent),false);
  const store=new Store(path.join(parent,'existing'));
  store.tx(s=>{s.sessions['pi/old']={online:true,pid:process.pid}; s.sessions['pi/offline']={externalV1:true,persistence:true,epoch:'fake',online:false,heartbeat:Date.now(),pid:process.pid};});
  const before=snapshot(store.root);
  assert.equal(machine(store.root,{v:1,op:'lookup',to:'pi/old'}).target.capable,false);
  assert.equal(machine(store.root,{v:1,op:'lookup',to:'pi/offline'}).target.live,false);
  assert.equal(machine(store.root,{v:1,op:'lookup',to:'pi/offline'}).target.capable,true);
  assert.deepEqual(snapshot(store.root),before);
  assert.throws(()=>new Store(store.root,{readOnly:true}).tx(()=>{}),/Read-only/);
  const old=path.join(parent,'v1'); new Store(old).tx(s=>{s.v=1;}); const bytes=snapshot(old);
  assert.throws(()=>lookup(new Store(old,{readOnly:true}),'pi/old'),/Unknown state version/); assert.deepEqual(snapshot(old),bytes);
});
test('Windows path policy refuses network, devices, streams, ambiguity and reserved names (portable)',()=>{
  assert.equal(windowsPath('c:\\Secure Leaf\\mailbox'),'c:\\Secure Leaf\\mailbox');
  for(const p of ['relative','C:foo','\\\\host\\share','\\\\?\\C:\\x','C:\\x:stream','C:\\x.','C:\\x ','C:\\..\\x','C:\\AUX.txt','C:\\COM1','C:/x','C:\\x\\','C:\\x\\\\y']) assert.throws(()=>windowsPath(p));
});
test('Windows account seam never calls getuid; helper invocation fixed argv, JSON stdin, bounded and fail closed (MOCK)',()=>{
  let calls=0;
  assert.equal(accountIdentity({platform:'win32',getuid:()=>{throw Error('getuid');},helper:op=>{assert.equal(op,'identity');calls++;return {sid:'S-1-5-21-123'};}}),'windows:S-1-5-21-123');
  assert.equal(calls,1);
  const target='C:\\Secure Leaf\\mailbox';
  const opts={env:{SystemRoot:'C:\\Windows'},run:(bin,args,o)=>{
    assert.equal(bin,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.ok(args.at(-1).endsWith('windows-security.ps1')); assert.ok(!args.join(' ').includes(target));
    assert.deepEqual(JSON.parse(o.input),{op:'root',path:target}); assert.equal(o.shell,false); assert.equal(o.timeout,10000); assert.equal(o.maxBuffer,8192);
    return {status:0,stdout:'{"ok":true,"sid":"S-1-5-21-123"}'};
  }};
  assert.equal(windowsHelper('root',target,opts).ok,true);
  for(const result of [{status:3,stdout:'private error'},{status:0,stdout:'{}'},{status:0,stdout:'invalid'},{status:0,stdout:'{"ok":true,"sid":"fake"}'},{error:Error('timeout')}]) assert.throws(()=>windowsHelper('identity',undefined,{...opts,run:()=>result}),e=>e.code==='UNSUPPORTED_SECURITY');
});
test('fixed PowerShell source contains restrictive atomic-create and explicit fail-closed checks (source only)',()=>{
  const ps=fs.readFileSync(new URL('../src/windows-security.ps1',import.meta.url),'utf8');
  for(const text of ['WindowsIdentity]::GetCurrent().User','SetAccessRuleProtection($true,$false)','CreateDirectory($p,$d)','AreAccessRulesProtected','DiscretionaryAcl','ReparsePoint','DriveFormat','NTFS','AccessDenied','ancestor owner']) assert.ok(ps.includes(text),text);
  assert.ok(!ps.includes('Set-Acl')); assert.ok(!ps.includes('Invoke-Expression'));
});
test('native Node plus Pi JS entry uses separate argv, package metadata, minimum version (MOCK)',()=>{
  const entry='C:\\Packages\\pi\\dist\\cli.js', node='C:\\Runtime\\node.exe', seen=[];
  const config={platform:'win32',env:{PI_A2A_PI_ENTRY:entry},execPath:node,version:'22.23.3',verify:(...x)=>seen.push(x),io:{
    lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,nlink:1,size:100}),
    existsSync:p=>p==='C:\\Packages\\pi\\package.json',
    readFileSync:()=>JSON.stringify({name:'@earendil-works/pi-coding-agent',bin:{pi:'dist/cli.js'}})
  }};
  const args=['--session','C:\\Private Leaf\\synthetic.jsonl','& not code'];
  assert.deepEqual(piLaunch(args,config),{file:node,args:[entry,...args]}); assert.ok(seen.length>=3);
  for(const change of [{version:'22.12.0'},{execPath:'C:\\Runtime\\pi.cmd'},{env:{PI_A2A_PI_ENTRY:'C:\\x.cmd'}},{verify:()=>{throw Error('ACL');}},{io:{...config.io,readFileSync:()=>'{"name":"unrelated"}'}}]) assert.throws(()=>piLaunch(args,{...config,...change}));
});
test('sharing retry is finite and never reruns transaction callback; malformed PIDs fail closed',()=>{
  let attempts=0, waits=0;
  assert.equal(retryIO(()=>{if(++attempts<4) throw {code:'EPERM'}; return 7;},{platform:'win32',wait:()=>waits++}),7);
  assert.equal(attempts,4); assert.equal(waits,3); attempts=0;
  assert.throws(()=>retryIO(()=>{attempts++;throw {code:'EBUSY'};},{platform:'win32',wait:()=>{}})); assert.equal(attempts,4);
  for(const pid of [NaN,Infinity,0,-1,'1',1.2]) assert.equal(live(pid),false);
  const store=new Store(root()); let callbacks=0; const rename=fs.renameSync;
  fs.renameSync=()=>{throw Object.assign(Error('fixture'),{code:'EPERM'});};
  try {assert.throws(()=>store.tx(s=>{callbacks++;s.marker=true;}));} finally {fs.renameSync=rename;}
  assert.equal(callbacks,1); assert.equal(store.read().marker,undefined); assert.equal(fs.existsSync(store.lock),false);
});
test('owner creation failure cleans lock; post-commit cleanup failure is explicitly uncertain',()=>{
  const store=new Store(root()), open=fs.openSync;
  fs.openSync=(p,...args)=>{if(p===path.join(store.lock,'owner')) throw Error('fixture'); return open(p,...args);};
  try {assert.throws(()=>store.tx(()=>{}));} finally {fs.openSync=open;}
  assert.equal(fs.existsSync(store.lock),false);
  const rmdir=fs.rmdirSync; fs.rmdirSync=()=>{throw Error('fixture');};
  try {assert.throws(()=>store.tx(s=>{s.marker=1;}),e=>e.code==='STORAGE_UNCERTAIN');} finally {fs.rmdirSync=rmdir;}
  assert.equal(store.read().marker,1); fs.rmdirSync(store.lock);
});
test('watcher missing filenames, error and directory invalidation schedule bounded reconciliation and reattach',()=>{
  const dir=root(), runtime=new Runtime({root:dir,session:'fixture',cwd:dir,sendMessage:()=>{}});
  const watch=fs.watch; let events=0, closed=0, cb, fail=false;
  runtime.schedule=()=>{events++;};
  fs.watch=(_root,callback)=>{ if(fail) throw Error('directory absent'); cb=callback; const w=new EventEmitter(); w.close=()=>closed++; return w; };
  try {
    runtime.watch(); cb('rename',undefined); cb('change',Buffer.from('state.json')); assert.equal(events,2);
    runtime.watcher.emit('error',Error('fixture')); assert.equal(runtime.watcher,null); assert.equal(events,3);
    fail=true; runtime.watch(); assert.equal(events,4);
    fail=false; runtime.watch(); assert.ok(runtime.watcher); runtime.watch(); assert.ok(closed>=2);
  } finally {runtime.watcher?.close(); fs.watch=watch;}
});
