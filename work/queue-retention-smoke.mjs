import Redis from 'ioredis';
// Dedicated ephemeral Redis, synthetic jobs only; no application worker/model/messenger.
import assert from 'node:assert/strict';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';import {createServer} from 'node:net';import {setTimeout as delay} from 'node:timers/promises';import dotenv from 'dotenv';import {Worker} from 'bullmq';
const file=process.env.SYNTHETIC_ENV_FILE;if(!file)throw Error('Synthetic env required');Object.assign(process.env,dotenv.parse(await readFile(file)));process.env.DOTENV_CONFIG_PATH=file;
const root=await mkdtemp(join(tmpdir(),'relayboard-queue-retention-')),probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));process.env.REDIS_URL='redis://127.0.0.1:'+port;process.env.QUEUE_NAME='synthetic-retention-'+randomUUID();
const redis=spawn('redis-server',['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no','--dir',root],{stdio:['ignore','pipe','pipe']});let ready=false,ended=false;redis.stdout.on('data',c=>{if(String(c).includes('Ready to accept connections'))ready=true;});redis.stderr.on('data',()=>{});redis.on('exit',()=>ended=true);
async function until(check,label){const end=Date.now()+30000;while(Date.now()<end){if(await check())return;await delay(20);}throw Error(label);}
let queue,worker,release,observer;const hold=new Promise(r=>release=r);let active=false;
try{
 await until(()=>ready,'Redis startup failed');const module=await import('../dist-node/core/queue.js');queue=module.publishingQueue;
 worker=new Worker(queue.name,async job=>{if(job.name==='hold'){active=true;await hold;return;}if(job.name==='fail')throw Error('Synthetic failure');return{synthetic:true};},{connection:{...module.redisConnection,maxRetriesPerRequest:null},concurrency:20});worker.on('error',()=>{});
 await queue.add('hold',{synthetic:true},{jobId:'protected-active'});await until(()=>active,'Active test job did not start');await queue.add('future',{synthetic:true},{jobId:'protected-delayed',delay:3600000});
 await queue.addBulk(Array.from({length:2005},(_,i)=>({name:'ok',data:{synthetic:true},opts:{jobId:'ok-'+i}})));await queue.addBulk(Array.from({length:2005},(_,i)=>({name:'fail',data:{synthetic:true},opts:{jobId:'fail-'+i}})));
 await until(async()=>{const n=await queue.getJobCounts('wait','active','completed','failed');return n.wait===0&&n.active===1&&n.completed===2000&&n.failed===2000;},'Completed/failed records did not converge to bounded counts');
 assert.equal(await(await queue.getJob('protected-active')).getState(),'active');assert.equal(await(await queue.getJob('protected-delayed')).getState(),'delayed');observer=new Redis(process.env.REDIS_URL);const info=await observer.info('memory');
 console.log(JSON.stringify({result:'PASS',completed:2000,failed:2000,activeProtected:true,delayedProtected:true,redisUsedMemoryBytes:Number(info.match(/^used_memory:(\d+)/m)?.[1]),scope:'ephemeral synthetic Redis only'}));
}finally{
 release?.();if(observer)await observer.quit();if(worker)await worker.close();if(queue){await queue.obliterate({force:true});await queue.close();}redis.kill('SIGTERM');await until(()=>ended,'Redis shutdown failed');await rm(root,{recursive:true,force:true});
}
