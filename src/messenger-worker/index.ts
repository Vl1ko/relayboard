import {DeliveryError} from '../core/delivery-policy.js';
import {dispatchOwnedMaxPublication} from '../core/owned-max-publication.js';
import express from 'express';
import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {config} from '../core/config.js';
import {pool} from '../core/db.js';
import {withExecutionSlot} from '../core/execution-slot.js';
import {MaxConnections} from '../core/max-connections.js';
import {dispatchOwnedMax,recoverOwnedMax} from '../core/owned-max-dispatch.js';
import {dispatchMaxManagerNotification} from '../core/max-manager-notification.js';
const stop=new AbortController();process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
async function owned(signal:AbortSignal){
 signal.throwIfAborted();
 await recoverOwnedMax(pool);signal.throwIfAborted();
 const connections=new MaxConnections(pool,signal),app=express();
 app.use(express.json({limit:'32kb'}));
 app.use((req,res,next)=>{
  const actual=Buffer.from(req.header('authorization')??''),expected=Buffer.from('Bearer '+config.MAX_WORKER_SECRET);
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return res.status(401).json({error:'Unauthorized'});
  if(signal.aborted)return res.status(503).json({error:'Owner stopped'});next();
 });
 app.get('/health',(_req,res)=>res.json({ready:!signal.aborted,platform:'max'}));
 app.get('/accounts/:id/groups',async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id);res.json((await connections.get(id)).groups);
 });
 app.post('/deliveries/:id/dispatch',async(req,res)=>res.json(await dispatchOwnedMaxPublication(pool,connections,z.string().uuid().parse(req.params.id),signal,config.SEND_TIMEOUT_MS)));
 app.post('/actions/:id/dispatch',async(req,res)=>res.json(await dispatchOwnedMax(pool,connections,z.string().uuid().parse(req.params.id),signal)));
 app.post('/notifications/:id/dispatch',async(req,res)=>res.json(await dispatchMaxManagerNotification(pool,z.string().uuid().parse(req.params.id),undefined,async id=>(await connections.get(id)).socket)));
 app.use(((error,_req,res,_next)=>res.status(error instanceof z.ZodError?400:503).json({error:error instanceof z.ZodError?'Invalid request':'MAX operation deferred; inspect durable outcome before retry',kind:error instanceof DeliveryError?error.kind:'ambiguous'})) as express.ErrorRequestHandler);
 const server=app.listen(config.MAX_WORKER_PORT,config.MAX_WORKER_HOST,()=>console.log('MAX session owner listening'));
 const maintenance=setInterval(()=>void connections.refresh().catch(()=>console.error('MAX session refresh deferred')),5000);maintenance.unref();
 try{
  await new Promise<void>((resolve,reject)=>{
   server.once('error',reject);
   const shutdown=()=>{connections.close();server.close(error=>error?reject(error):resolve());};
   signal.addEventListener('abort',shutdown,{once:true});if(signal.aborted)shutdown();
  });
 }finally{clearInterval(maintenance);connections.close();}
}
async function main(){
 try{
  if(!config.MAX_WORKER_ENABLED){console.log('MAX worker disabled');return;}
  if(config.AI_SEND_MODE==='synthetic')throw Error('Cannot mix synthetic AI and live MAX ownership');
  if(!config.MAX_WORKER_SECRET)throw Error('MAX worker secret required');
  await withExecutionSlot(pool,'worker:max-sessions',owned,stop.signal);
 }catch{if(!stop.signal.aborted){console.error('MAX session owner stopped');process.exitCode=1;}}
 finally{await pool.end();}
}
void main();
