import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Runtime } from '../src/runtime.mjs';
import { operate, requestKey } from '../src/external.mjs';
import { fixtureRoot, reconcileUntil } from './fixture.mjs';
import { setTimeout as timerTurn } from 'node:timers/promises';

function cleanupFixture(dir, passed) {
  if (!passed && process.env.PI_A2A_TEST_RETAIN_FAILURE === '1') console.error(`Retained owned installed-Pi failure fixture: ${dir}`);
  else fs.rmSync(dir,{recursive:true,force:true});
}

// Optional host-contract regression; all IDs/messages are synthetic.
// Point at an already installed Pi package, never a fixed release location.
// Runtime reconstruction below is in ONE Node process, not an OS/native restart.
for (const controlled of [false,true]) test(`installed Pi busy queue loss retries stable reply after same-process Runtime reconstruction; only saved transcript acknowledges${controlled?' with controlled old snapshots':''}`, async () => {
  const installed = process.env.PI_A2A_PI_PACKAGE;
  assert.ok(installed && path.isAbsolute(installed), 'Set PI_A2A_PI_PACKAGE to the absolute installed pi-coding-agent package directory');
  const { AgentSession } = await import(pathToFileURL(path.join(installed, 'dist/core/agent-session.js')).href);
  const { SessionManager } = await import(pathToFileURL(path.join(installed, 'dist/core/session-manager.js')).href);
  const dir = fixtureRoot('pi-a2a-installed-');
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: 'user', content: 'zero-model persistence fixture', timestamp: Date.now() });
  const queue = [], adapter = { isStreaming: true, agent: { followUp: m => queue.push(m) } };
  const sendMessage = (m, o) => { void AgentSession.prototype.sendCustomMessage.call(adapter, m, o); };
  const runtimes=[];
  const make = (session, deliver = sendMessage) => {
    const r=new Runtime({ root: dir, session, cwd: dir,
      extension: fileURLToPath(new URL('../index.ts', import.meta.url)), sendMessage: deliver,
      transcript: () => manager.getSessionFile() });runtimes.push(r);return r;
  };
  // Only pause after an actual timer turn, outside Store locks. The shared
  // progress helper must NOT erase these exact old-pass assertions.
  function gateAfterTurn(r,n) {
    const turn=r.turn.bind(r);let count=0,ready,release;
    const reached=new Promise(resolve=>{ready=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    r.turn=async()=>{const result=await turn();if(++count===n){ready();await gate;}return result;};
    const existing=r.reconcile();
    return {existing,held:Promise.race([reached,existing.then(()=>{throw Error('pass ended before controlled real turn');})]),release,restore:()=>{r.turn=turn;}};
  }
  const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw Error('NETWORK FORBIDDEN by installed reconstruction fixture');};
  let passed=false,gate;
  let a = make('fake_sender'); const b = make('fake_receiver', () => {}); a.start(); b.start();
  try {
    const original = await a.send('pi/fake_receiver', 'synthetic task'); await reconcileUntil(b,()=>b.active?.id===original.id,'installed receiver dispatch');
    b.message({ message: { role: 'custom', customType: 'pi-a2a-request', details: { request: b.active.id } } });
    b.message({ message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic answer' }], stopReason: 'stop' } });
    if(controlled) {
      await a.reconcile();gate=gateAfterTurn(a,2);await gate.held;
      assert.equal(a.store.read().requests[original.id].status,'queued');assert.equal(queue.length,0);
    }
    b.settled();
    if(controlled) {
      assert.equal(a.reconcile(),gate.existing,'post-settlement caller joins pre-settlement pass');
      gate.release();await gate.existing;gate.restore();gate=null;
      assert.equal(queue.length,0,'old snapshot omits the newly settled reply');
      assert.equal(a.store.read().requests[original.id].notified,false);assert.equal(a.moreWork,true);
    }
    await reconcileUntil(a,()=>queue.some(m=>m.details?.replyId===`${original.id}-reply`),'installed correlated reply queued');
    assert.equal(queue.length, 1); assert.equal(a.store.read().requests[original.id].notified, false);
    assert.equal(queue[0].details.replyId,`${original.id}-reply`);
    await timerTurn(0);await a.reconcile(); assert.equal(queue.length, 1);
    const stable = queue.pop(); await a.close();
    a = make('fake_sender'); a.start(); await reconcileUntil(a,()=>queue.some(m=>m.details?.replyId===stable.details.replyId),'reconstructed Runtime queues same stable reply');
    assert.equal(queue.length, 1); assert.equal(queue[0].details.replyId, stable.details.replyId);
    assert.equal(a.store.read().requests[original.id].notified,false);
    const m = queue.pop(); a.message({ type: 'message_start', message: m });
    a.message({ type: 'message_end', message: m }); await timerTurn(0);await a.reconcile();
    assert.equal(a.store.read().requests[original.id].notified, false);
    assert.equal(queue.length,0);
    assert.equal(fs.readFileSync(manager.getSessionFile(),'utf8').includes(stable.details.replyId),false);
    if(controlled) {await a.reconcile();gate=gateAfterTurn(a,3);await gate.held;}
    manager.appendCustomMessageEntry(m.customType, m.content, m.display, m.details);
    if(controlled) {
      const saved=fs.readFileSync(manager.getSessionFile(),'utf8').split('\n').filter(Boolean).map(JSON.parse);
      assert.equal(saved.filter(e=>e.type==='custom_message'&&e.details?.replyId===stable.details.replyId).length,1);
      assert.equal(a.reconcile(),gate.existing,'post-append caller joins pre-append consumed-set pass');
      gate.release();await gate.existing;gate.restore();gate=null;
      assert.equal(a.store.read().requests[original.id].notified,false,'old consumed snapshot cannot acknowledge the later saved entry');
      assert.equal(queue.length,0);
    }
    await reconcileUntil(a,()=>a.store.read().requests[original.id].notified===true,'real SessionManager append acknowledged'); assert.equal(a.store.read().requests[original.id].notified, true);
    await a.close(); a = make('fake_sender'); a.start(); await timerTurn(0);await a.reconcile();
    assert.equal(queue.length, 0);
    a.update(original.id, { notified: false }); await reconcileUntil(a,()=>a.store.read().requests[original.id].notified===true,'saved proof restores explicitly reset receipt'); assert.equal(queue.length, 0);
    assert.equal(a.store.read().requests[original.id].notified, true);
    passed=true;
  } finally {
    gate?.release();
    try {
      for(const r of runtimes.reverse()) {await r.close();assert.equal(r.turns.size,0);assert.equal(r.children.size,0);assert.equal(r.reconciling,null);}
    } catch(e) {passed=false;throw e;}
    finally {globalThis.fetch=originalFetch;cleanupFixture(dir,passed);}
  }
});

test('genuine installed Pi agent loop/writer: external message_end precedes exact saved proof (synthetic stream, NO NETWORK)', { timeout:process.platform==='win32'?540000:20000 }, async () => {
  const installed=process.env.PI_A2A_PI_PACKAGE;
  assert.ok(installed && path.isAbsolute(installed));
  const load = file => import(pathToFileURL(path.join(installed,file)).href);
  const sibling = file => import(pathToFileURL(path.resolve(installed,'..',file)).href);
  const {AgentSession}=await load('dist/core/agent-session.js');
  const {SessionManager}=await load('dist/core/session-manager.js');
  const {SettingsManager}=await load('dist/core/settings-manager.js');
  const {DefaultResourceLoader}=await load('dist/core/resource-loader.js');
  const {Agent}=await sibling('pi-agent-core/dist/agent.js');
  const {AssistantMessageEventStream}=await sibling('pi-ai/dist/utils/event-stream.js');
  const dir=fixtureRoot('pi-a2a-real-loop-');
  const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw Error('NETWORK FORBIDDEN by installed proof fixture');};
  let runtime, session, passed=false;
  try {
    const manager=SessionManager.create(dir,dir), settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
    const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
    await loader.reload();
    const model={id:'local-fixture',name:'Local fixture',api:'openai-completions',provider:'fixture',baseUrl:'http://invalid.invalid',reasoning:false,input:['text'],contextWindow:65536,maxTokens:128,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
    let requests=0;
    const agent=new Agent({initialState:{model,thinkingLevel:'off'},streamFn:()=>{
      requests++; const stream=new AssistantMessageEventStream();
      const message={role:'assistant',content:[{type:'text',text:'Synthetic no-network response'}],api:model.api,provider:model.provider,model:model.id,stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      stream.push({type:'done',reason:'stop',message}); stream.end(); return stream;
    }});
    const modelRuntime={getModel:()=>model,getPhysicalModel:()=>model,getAuth:async()=>undefined,isUsingOAuth:()=>false,getAvailableSnapshot:()=>[model],hasConfiguredAuth:()=>false,checkAuth:async()=>undefined};
    session=new AgentSession({agent,sessionManager:manager,settingsManager:settings,resourceLoader:loader,modelRuntime,cwd:dir,initialActiveToolNames:[],baseToolsOverride:{}});
    const sends=[];
    runtime=new Runtime({root:dir,session:manager.getSessionId(),cwd:dir,transcript:()=>manager.getSessionFile(),sendMessage:(m,o)=>{const p=session.sendCustomMessage(m,o); sends.push(p); return p;}}); runtime.start();
    const x={v:1,op:'send',caller:'fixture',id:'real-loop',to:runtime.self,text:'Synthetic no-network wake',delivery:'queue',expectReply:false};
    const cases=[x,{...x,id:'real-queue'},{...x,id:'real-steer',delivery:'steer'}];
    const status=(item=x)=>operate(runtime.store,{v:1,op:'status',caller:item.caller,id:item.id});
    let beforeAppend=0;
    session.subscribe(event=>{
      if(event.type==='message_start'||event.type==='message_end') runtime.message(event);
      if(event.type==='message_end' && event.message.customType==='pi-a2a-external-v1') {
        const item=cases.find(item=>runtime.store.read().external[requestKey(item)]?.internal===event.message.details.internal);
        assert.ok(item); assert.equal(status(item).facts.consumed,false); beforeAppend++;
      }
    });
    // Sender and owner are cohosted here. Model independently scheduled callers
    // with REAL timer turns and completion of normal owner work, not a manual
    // heartbeat or Promise.resolve/await of synchronous operate(). Not a native
    // availability/throughput substitute for a separate-process target proof.
    for(const item of cases) {operate(runtime.store,item);await timerTurn(0);await runtime.reconcile();}
    await runtime.reconcile(); await Promise.all(sends);
    assert.equal(beforeAppend,3); assert.ok(requests>=2);
    for(const item of cases) assert.equal(status(item).state,'consumed');
    assert.equal(status().facts.historicalUncertainty,true);
    passed=true;
  } finally {
    try {await runtime?.close();} catch(e) {passed=false;throw e;}
    finally {session?.dispose();globalThis.fetch=originalFetch;cleanupFixture(dir,passed);}
  }
});
