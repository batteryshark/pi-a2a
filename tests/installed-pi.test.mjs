import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Runtime } from '../src/runtime.mjs';
import { operate, requestKey } from '../src/external.mjs';

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

test('genuine installed Pi agent loop/writer: external message_end precedes exact saved proof (synthetic stream, NO NETWORK)', { timeout:20000 }, async () => {
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
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pi-a2a-real-loop-')));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw Error('NETWORK FORBIDDEN by installed proof fixture');};
  let runtime, session;
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
    for(const item of cases) operate(runtime.store,item);
    await runtime.reconcile(); await Promise.all(sends);
    assert.equal(beforeAppend,3); assert.ok(requests>=2);
    for(const item of cases) assert.equal(status(item).state,'consumed');
    assert.equal(status().facts.historicalUncertainty,true);
  } finally {
    await runtime?.close(); session?.dispose(); globalThis.fetch=originalFetch;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
