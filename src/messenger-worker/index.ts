import {startSourceHeartbeat} from '../core/source-runtime-health.js';
import {MaxSourcePoller} from '../core/max-source-poller.js';
import {AiManagerStore} from '../core/ai-manager.js';
import {resolveMaxSourceRoute} from '../core/max-source-route.js';
import {resolveMaxContactRoute} from '../core/max-contact-route.js';
import {MaxPrivatePoller} from '../core/max-private-poller.js';
import {runtimeAllows} from '../core/runtime-scope.js';
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
 const heartbeat=await startSourceHeartbeat(pool,'max-reader',config.SOURCE_MONITOR_ENABLED&&config.AI_SEND_MODE==='live',signal);
 const connections=new MaxConnections(pool,signal),app=express();
 const scope={testOnly:config.AI_TEST_ONLY,accountIds:config.AI_TEST_ACCOUNT_IDS,authorIds:config.AI_TEST_AUTHOR_IDS};
 const poller=new MaxPrivatePoller(pool,connections,signal,scope);

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
 app.post('/leads/:id/resolve',async(req,res)=>{
  const accountId=z.string().uuid().optional().parse(req.body?.accountId);
  res.json(await resolveMaxSourceRoute(pool,connections,scope,{leadId:z.string().uuid().parse(req.params.id),accountId}));
 });
 app.post('/contacts/:id/resolve',async(req,res)=>{
  const accountId=z.string().uuid().parse(req.body?.accountId);
  res.json(await resolveMaxContactRoute(pool,connections,scope,{contactId:z.string().uuid().parse(req.params.id),accountId}));
 });
 app.post('/deliveries/:id/dispatch',async(req,res)=>res.json(await dispatchOwnedMaxPublication(pool,connections,z.string().uuid().parse(req.params.id),signal,config.SEND_TIMEOUT_MS)));
 app.post('/conversations/:id/sync',async(req,res)=>res.json(await poller.poll(z.string().uuid().parse(req.params.id))));
 app.post('/actions/:id/dispatch',async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id),action=(await pool.query('SELECT conversation_id FROM ai_outbox WHERE id=$1',[id])).rows[0];
  if(!action)throw new DeliveryError('Действие не найдено','permanent');
  const preflight=await new AiManagerStore(pool).preflight(id);if(!preflight.ready)return res.json({state:preflight.state,deferred:true});
  if(!(await poller.poll(action.conversation_id)).complete)throw new DeliveryError('Личка ожидает синхронизации или разрешения тестового адресата','waiting');
  res.json(await dispatchOwnedMax(pool,connections,id,signal));
 });
 app.post('/notifications/:id/dispatch',async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id);
  const source=(await pool.query(`SELECT v.account_id,s.recipient_id,s.reader_account_id,s.author_id FROM ai_handoff_notifications n JOIN ai_conversations v ON v.id=n.conversation_id JOIN ai_request_phases p ON p.id=n.request_phase_id JOIN ai_request_sources s ON s.request_id=p.request_id AND s.conversation_id=v.id WHERE n.id=$1 ORDER BY s.created_at DESC LIMIT 1`,[id])).rows[0];
  if(!source||(!runtimeAllows(scope,source.account_id,source.recipient_id)||!runtimeAllows(scope,source.reader_account_id,source.author_id)))throw new DeliveryError('Источник уведомления вне разрешённой тестовой области','waiting');
  res.json(await dispatchMaxManagerNotification(pool,id,undefined,async account=>(await connections.get(account)).socket));
 });
 app.use(((error,_req,res,_next)=>res.status(error instanceof z.ZodError?400:503).json({error:error instanceof z.ZodError?'Invalid request':'MAX operation deferred; inspect durable outcome before retry',kind:error instanceof DeliveryError?error.kind:'ambiguous'})) as express.ErrorRequestHandler);
 const server=app.listen(config.MAX_WORKER_PORT,config.MAX_WORKER_HOST,()=>console.log('MAX session owner listening'));
 let polling=false,inboxWork:Promise<void>|undefined;
 const inboxTimer=setInterval(()=>{
  if(config.AI_SEND_MODE!=='live'||polling||signal.aborted)return;polling=true;
  inboxWork=(async()=>{
   const active=(await pool.query(`SELECT id,account_id FROM ai_conversations WHERE platform='max' AND active_phase_id IS NOT NULL ORDER BY coalesce((SELECT updated_at FROM ai_max_private_cursors WHERE conversation_id=ai_conversations.id),'-infinity'::timestamptz),account_id,id LIMIT 100`)).rows;
   const accounts=[...new Set(active.map(v=>v.account_id))];
   await Promise.all(accounts.map(async account=>{for(const v of active.filter(v=>v.account_id===account)){try{await poller.poll(v.id);}catch{console.error('MAX private sync deferred; cursor retained');}}}));
  })().catch(()=>console.error('MAX inbox iteration deferred')).finally(()=>{polling=false;});
 },config.MAX_POLL_INTERVAL_MS);inboxTimer.unref();
 const sourcePoller=new MaxSourcePoller(pool,connections,signal,scope);let sourceWork:Promise<void>|undefined;
 const sourceTimer=setInterval(()=>{
  if(!config.SOURCE_MONITOR_ENABLED||config.AI_SEND_MODE!=='live'||signal.aborted||sourceWork)return;
  sourceWork=(async()=>{
   const sources=(await pool.query("SELECT s.account_id,s.chat_id FROM ai_search_sources s JOIN ai_monitor_settings m ON m.id=1 AND m.mode<>'stopped' WHERE s.platform='max' ORDER BY s.account_id,s.chat_id LIMIT 5")).rows;
   await Promise.all([...new Set(sources.map(s=>s.account_id))].map(async account=>{for(const source of sources.filter(s=>s.account_id===account))try{await sourcePoller.poll(account,source.chat_id);}catch{if(!signal.aborted)console.error('MAX source sync deferred; cursor retained');}}));
  })().catch(()=>console.error('MAX source iteration deferred')).finally(()=>{sourceWork=undefined;});
 },config.MAX_POLL_INTERVAL_MS);sourceTimer.unref();
 const maintenance=setInterval(()=>void connections.refresh().catch(()=>console.error('MAX session refresh deferred')),5000);maintenance.unref();
 try{
  await new Promise<void>((resolve,reject)=>{
   server.once('error',reject);
   const shutdown=()=>{connections.close();server.close(error=>error?reject(error):resolve());};
   signal.addEventListener('abort',shutdown,{once:true});if(signal.aborted)shutdown();
  });
 }finally{clearInterval(inboxTimer);clearInterval(sourceTimer);clearInterval(maintenance);connections.close();await inboxWork;await sourceWork;await heartbeat.close();}
}
async function main(){
 try{
  if(!config.MAX_WORKER_ENABLED){console.log('MAX worker disabled');return;}
  if(config.AI_SEND_MODE==='synthetic')throw Error('Cannot mix synthetic AI and live MAX ownership');
  if(config.AI_SEND_MODE==='live'&&config.AI_TEST_ONLY&&(!config.AI_TEST_ACCOUNT_IDS.length||!config.AI_TEST_AUTHOR_IDS.length))throw Error('Test allowlists required');
  if(!config.MAX_WORKER_SECRET)throw Error('MAX worker secret required');
  await withExecutionSlot(pool,'worker:max-sessions',owned,stop.signal);
 }catch(error){if(!stop.signal.aborted){console.error(error instanceof Error&&/required|Cannot mix/.test(error.message)?error.message:'MAX session owner stopped');process.exitCode=1;}}
 finally{await pool.end();}
}
void main();
