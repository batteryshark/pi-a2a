import { Store } from '../src/store.mjs';
import { operate, claim, requestKey } from '../src/external.mjs';
import fs from 'node:fs';
import path from 'node:path';
let input='';
for await (const chunk of process.stdin) input+=chunk;
const job=JSON.parse(input), store=new Store(job.dir);
const original=store.tx.bind(store);
store.tx=fn=>original(s=>{
  if(job.hold) {
    process.send({type:'locked'});
    const deadline=Date.now()+5000, pause=new Int32Array(new SharedArrayBuffer(4));
    // Synchronous Store callback cannot receive IPC. Parent creates this owned
    // fixture marker ONLY after observing the other participant's A2A_BUSY.
    while(!fs.existsSync(job.release)) {
      if(Date.now()>=deadline) throw Error('Parent release deadline exceeded');
      Atomics.wait(pause,0,0,10);
    }
  }
  return fn(s);
});
process.send({type:'ready'});
process.once('message',()=>{
  try {
    const value=job.action==='claim'?claim(store,requestKey(job.x),'pi/target','race-epoch',Date.now):operate(store,job.x);
    if(job.action==='claim' && value) fs.appendFileSync(path.join(job.dir,'invocations'),'facade-attempt\n');
    process.send({type:'result',value});
  } catch(e) {process.send({type:'result',error:e.code??'UNEXPECTED'});}
  process.disconnect();
});
