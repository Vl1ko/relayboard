import {createGigaChatProvider} from '../core/gigachat-provider.js';
import {createYandexProvider} from '../core/yandex-provider.js';
import {AiManagerStore} from '../core/ai-manager.js';
import {AiOrchestrator,conservativeFixtureProvider} from '../core/ai-orchestrator.js';
import {ConversationWorkflow} from '../core/conversation-workflow.js';
import {verifyAiQualification} from '../core/ai-engine.js';
import {config} from '../core/config.js';
import {pool} from '../core/db.js';
import {OutreachRunner,syntheticTransport} from '../core/outreach-runner.js';
let stopped=false;
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function main(){
 if(config.AI_SEND_MODE!=='synthetic'){console.log('AI worker disabled; no transport enabled');await pool.end();return;}
 console.log('AI worker: SYNTHETIC transport only; no platform delivery');
 if(config.AI_PROVIDER_MODE==='yandex'&&(!config.AI_ALLOW_EXTERNAL_REQUESTS||!config.YANDEX_API_KEY||!config.YANDEX_FOLDER_ID)){console.error('Yandex requires explicit external-request flag and server credentials');await pool.end();return;}
 if(config.AI_PROVIDER_MODE==='gigachat'&&(!config.AI_ALLOW_EXTERNAL_REQUESTS||!config.GIGACHAT_AUTH_KEY)){console.error('GigaChat requires explicit external-request flag and server credentials');await pool.end();return;}
 const provider=config.AI_PROVIDER_MODE==='yandex'?createYandexProvider({apiKey:config.YANDEX_API_KEY!,folderId:config.YANDEX_FOLDER_ID!}):config.AI_PROVIDER_MODE==='gigachat'?createGigaChatProvider({authKey:config.GIGACHAT_AUTH_KEY!,scope:config.GIGACHAT_SCOPE}):conservativeFixtureProvider;
 const runner=new OutreachRunner(pool),workflow=new ConversationWorkflow(pool,{verifyQualification:verifyAiQualification}),orchestrator=new AiOrchestrator(pool),messages=new AiManagerStore(pool);
 process.on('SIGTERM',()=>{stopped=true;});process.on('SIGINT',()=>{stopped=true;});
 while(!stopped){try{
  for(const event of await orchestrator.pending()){try{await orchestrator.process(event.conversation_id,event.event_key,provider);}catch{console.error('AI decision deferred or invalidated');}}
  for(const job of await workflow.dueFollowups())await workflow.materializeFollowup(job.id);
  await runner.tick(async target=>syntheticTransport(target));
  const pending=await pool.query(`SELECT a.id,c.account_id AS "accountId",c.external_id AS "externalConversationId",c.platform FROM ai_outbox a JOIN ai_conversations c ON c.id=a.conversation_id WHERE a.state='pending' AND a.kind IN ('reply','follow_up','manual_reply') ORDER BY a.created_at LIMIT 100`);
  for(const a of pending.rows)await messages.dispatch(a.id,syntheticTransport(a));
  const notifications=await pool.query("SELECT * FROM ai_handoff_notifications WHERE state='pending' ORDER BY created_at LIMIT 100");
  for(const n of notifications.rows){const target=n.target_account_id?{accountId:n.target_account_id,externalId:n.target_external_id}:await workflow.managerTarget();if(!target)continue;await workflow.dispatchNotification(n.id,{target,start:a=>({acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'confirmed',code:'synthetic_confirmation',externalMessageId:'synthetic:'+a.operationId,retryCondition:'never'})})});}
 }catch{console.error('AI worker iteration failed; durable state retained');}await sleep(1000);}
 await pool.end();
}
void main();
