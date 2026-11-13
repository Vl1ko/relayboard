import {setTimeout as delay} from 'node:timers/promises';
import {createGigaChatProvider} from '../core/gigachat-provider.js';
import {createYandexProvider} from '../core/yandex-provider.js';
import {AiManagerStore} from '../core/ai-manager.js';
import {conservativeFixtureProvider} from '../core/ai-orchestrator.js';
import {ConversationWorkflow} from '../core/conversation-workflow.js';
import {config} from '../core/config.js';
import {pool} from '../core/db.js';
import {syntheticTransport} from '../core/outreach-runner.js';
import {AiExecutionRuntime,type RuntimeTransport} from '../core/ai-execution-runtime.js';
import {runtimeAllowsConversation} from '../core/runtime-scope.js';
import {maxWorkerRequest} from '../core/max-worker-client.js';
import {withExecutionSlot} from '../core/execution-slot.js';
const stop=new AbortController();process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
async function run(signal:AbortSignal){
 const live=config.AI_SEND_MODE==='live';
 const provider=config.AI_PROVIDER_MODE==='yandex'?createYandexProvider({apiKey:config.YANDEX_API_KEY!,folderId:config.YANDEX_FOLDER_ID!}):config.AI_PROVIDER_MODE==='gigachat'?createGigaChatProvider({pool,authKey:config.GIGACHAT_AUTH_KEY!,scope:config.GIGACHAT_SCOPE}):conservativeFixtureProvider;
 const messages=new AiManagerStore(pool),workflow=new ConversationWorkflow(pool);
 const scope={testOnly:config.AI_TEST_ONLY,accountIds:config.AI_TEST_ACCOUNT_IDS,authorIds:config.AI_TEST_AUTHOR_IDS};
 const transport:RuntimeTransport=live?{
  allowsConversation:id=>runtimeAllowsConversation(pool,scope,id),
  async dispatchAction(id,target){if(target.platform!=='max')throw Error('whatsapp_ai_owner_not_ready');return maxWorkerRequest(`/actions/${id}/dispatch`,'POST');},
  dispatchNotification:id=>maxWorkerRequest(`/notifications/${id}/dispatch`,'POST'),
 }:{
  allowsConversation:async()=>true,
  dispatchAction:async(id,target)=>messages.dispatch(id,syntheticTransport(target)),
  async dispatchNotification(id){const n=(await pool.query('SELECT * FROM ai_handoff_notifications WHERE id=$1',[id])).rows[0];if(!n)return;const target=n.target_account_id?{accountId:n.target_account_id,externalId:n.target_external_id}:await workflow.managerTarget();if(!target)return;return workflow.dispatchNotification(id,{target,start:a=>({acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'confirmed',code:'synthetic_confirmation',externalMessageId:'synthetic:'+a.operationId,retryCondition:'never'})})});},
 };
 const runtime=new AiExecutionRuntime(pool,provider,transport,signal);
 console.log(live?'AI worker: owned live MAX transport':'AI worker: synthetic transport');
 while(!signal.aborted){
  try{await runtime.tick();}catch{if(!signal.aborted)console.error('AI iteration deferred; durable state retained');}
  try{await delay(1000,undefined,{signal});}catch{break;}
 }
}
async function main(){
 try{
  if(config.AI_SEND_MODE==='disabled'){console.log('AI worker disabled');return;}
  if(config.AI_PROVIDER_MODE==='yandex'&&(!config.AI_ALLOW_EXTERNAL_REQUESTS||!config.YANDEX_API_KEY||!config.YANDEX_FOLDER_ID))throw Error('Yandex external request flag and credentials required');
  if(config.AI_PROVIDER_MODE==='gigachat'&&(!config.AI_ALLOW_EXTERNAL_REQUESTS||!config.GIGACHAT_AUTH_KEY))throw Error('GigaChat external request flag and credentials required');
  if(config.AI_SEND_MODE==='live'){
   if(config.AI_PROVIDER_MODE!=='gigachat'||!config.MAX_WORKER_URL||!config.MAX_WORKER_SECRET)throw Error('Live AI requires GigaChat and owned MAX transport');
   if(config.AI_TEST_ONLY&&(!config.AI_TEST_ACCOUNT_IDS.length||!config.AI_TEST_AUTHOR_IDS.length))throw Error('Test account and author allowlists required');
   if(config.NODE_ENV==='production'&&!config.AI_TEST_ONLY&&config.GIGACHAT_SCOPE==='GIGACHAT_API_PERS')throw Error('Commercial GigaChat access required');
  }
  await withExecutionSlot(pool,'worker:ai-execution',run,stop.signal);
 }catch(error){if(!stop.signal.aborted){console.error(error instanceof Error&&/required|requires/.test(error.message)?error.message:'AI owner stopped');process.exitCode=1;}}
 finally{await pool.end();}
}
void main();
