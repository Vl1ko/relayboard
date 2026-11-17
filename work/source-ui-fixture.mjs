// Isolated browser acceptance fixture: fake data, no workers/connectors/model calls.
// SYNTHETIC_IMPORT_UI exposes queue creation only; no processing/sending owner is started.
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawn} from 'node:child_process';import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';import dotenv from 'dotenv';
import {AiManagerStore} from '../dist-node/core/ai-manager.js';
import {bindSourceRequest} from '../dist-node/core/request-lifecycle.js';
import {ConversationWorkflow} from '../dist-node/core/conversation-workflow.js';
import {applyAiManagerMigration} from '../dist-node/core/ai-manager-migration.js';
const envFile=process.env.SYNTHETIC_ENV_FILE;if(!envFile)throw Error('Synthetic env file required');
const env={...process.env,...dotenv.parse(await readFile(envFile))};
const url=new URL(process.env.SEARCH_TEST_DATABASE_URL||'');if(url.pathname!='/relayboard_search_test')throw Error('Dedicated synthetic search DB required');
const schema='source_ui_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.toString()}),temp=await mkdtemp(join(tmpdir(),'relayboard-source-ui-')),children=[];
await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');const db=new pg.Pool({connectionString:url.toString()});
async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const value=server.address().port;await new Promise(r=>server.close(r));return value;}
function child(cmd,args,childEnv){const process=spawn(cmd,args,{env:childEnv,stdio:['ignore','pipe','pipe']});const row={process,ended:false,output:''};children.push(row);process.stdout.on('data',c=>row.output+=c);process.stderr.on('data',c=>row.output+=c);process.on('exit',()=>row.ended=true);return row;}
let stopping=false;async function shutdown(){if(stopping)return;stopping=true;for(const row of children.reverse()){if(row.ended)continue;row.process.kill('SIGTERM');const deadline=Date.now()+10000;while(!row.ended&&Date.now()<deadline)await delay(25);if(!row.ended)row.process.kill('SIGKILL');}await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(temp,{recursive:true,force:true});}
process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown());
try{
 await db.query(await readFile(new URL('../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(db);await mkdir(join(temp,'uploads'));
 const account=(await db.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','Тестовый аккаунт MAX','synthetic-no-token') RETURNING id")).rows[0].id;
 for(let i=1;i<=6;i++)await db.query("INSERT INTO destinations(integration_id,external_id,title,kind) VALUES($1,$2,$3,'group')",[account,String(-100-i),'Тестовый чат '+i]);
 await db.query("INSERT INTO ai_search_sources(account_id,platform,chat_id) VALUES($1,'max','-101')",[account]);await db.query('UPDATE ai_outreach_settings SET account_ids=$1',[[account]]);
 await db.query('UPDATE ai_engine_settings SET settings=settings||$1::jsonb',[JSON.stringify({provider:'gigachat',model:'GigaChat',qualificationEnabled:true,fields:[{key:'volume',question:'Какой объём щебня нужен?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);
 await db.query('UPDATE ai_monitor_settings SET settings=$1',[JSON.stringify({instructions:'Искать запросы на покупку щебня. Объявления продавцов не подходят.',includeTerms:['щебень','гранит'],excludeTerms:['продам'],confidenceThreshold:0.92,autoContact:true})]);
 const source=(await db.query("INSERT INTO ai_source_messages(platform,account_id,chat_id,author_id,message_id,occurred_at,fingerprint,original_text,monitor_epoch,monitor_revision,state) VALUES('max',$1,'-101','200','synthetic-source',now(),'synthetic',NULL,0,0,'classified') RETURNING id",[account])).rows[0].id;
 await db.query(`INSERT INTO ai_leads(source_key,source_fingerprint,platform,account_id,chat_id,author_id,message_id,occurred_at,original_text,source_kind,params,confidence,source_message_id,classification) VALUES('synthetic-lead','synthetic','max',$1,'-101','200','synthetic-source',now(),'Нужно 12 тонн щебня','monitor',$2,0.72,$3,$4)`,[account,JSON.stringify([{key:'volume',value:12,evidenceQuote:'12 тонн'}]),source,JSON.stringify({intent:'ambiguous'})]);
 const store=new AiManagerStore(db),contact=await store.createContact('Тестовый клиент этапов'),conversation=await store.createConversation({contactId:contact.id,accountId:account,externalId:'200'});
 const priorRequest=await bindSourceRequest(db,{conversationId:conversation.id,accountId:account,platform:'max',chatId:'-101',messageId:'synthetic-card-source',authorId:'200'});
 await store.ingest({version:1,platform:'max',accountId:account,conversationId:'200',messageId:'group-source:-101:synthetic-card-source',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Архивная тестовая заявка: нужно5 тонн щебня'});
 await db.query('UPDATE ai_engine_state SET fields=$2 WHERE conversation_id=$1',[conversation.id,{volume:{value:5,evidenceMessageId:'group-source:-101:synthetic-card-source',evidenceQuote:'5 тонн'}}]);
 const workflow=new ConversationWorkflow(db);await workflow.setStatus({conversationId:conversation.id,status:'closed',reason:'Синтетическая проверка архива'});
 const activeRequest=await bindSourceRequest(db,{conversationId:conversation.id,accountId:account,platform:'max',chatId:'-101',messageId:'synthetic-current-source',authorId:'200'});
 await store.ingest({version:1,platform:'max',accountId:account,conversationId:'200',messageId:'group-source:-101:synthetic-current-source',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Новая тестовая заявка: нужно12 тонн щебня'});
 const waAccount=(await db.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('whatsapp','Тестовый аккаунт WhatsApp','synthetic-no-token') RETURNING id")).rows[0].id,wa=await store.createConversation({contactId:contact.id,accountId:waAccount,externalId:'200@c.us'});
 await bindSourceRequest(db,{conversationId:wa.id,accountId:waAccount,platform:'whatsapp',chatId:'500@g.us',messageId:'synthetic-wa-source',authorId:'200@c.us',allowAdditionalChannel:true});
 await store.ingest({version:1,platform:'whatsapp',accountId:waAccount,conversationId:'200@c.us',messageId:'synthetic-wa-answer',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Тестовое уточнение в WhatsApp:12 тонн'});
 await db.query('UPDATE ai_engine_state SET fields=$2 WHERE conversation_id=$1',[wa.id,{volume:{value:12,evidenceMessageId:'synthetic-wa-answer',evidenceQuote:'12 тонн'}}]);
for(const [scenario,label]of Object.entries({no_reply:'Ответ клиента',not_booked:'Согласование объёма',not_completed:'Подтверждение поставки',requested_later:'Связаться позже'}))await workflow.saveFollowupRule({scenario,label,enabled:false,channel:'current',timezone:'Europe/Moscow',weekdays:[1,2,3,4,5],startMinute:540,endMinute:1080,steps:[{delaySeconds:3600,text:'Тестовый дожим'}],maxSends:1});
 const redisPort=await port(),apiPort=await port();const redis=child('redis-server',['--bind','127.0.0.1','--port',String(redisPort),'--save','','--appendonly','no','--dir',temp],env);
 const waitUntil=async(check,label)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await delay(50);}throw Error(label);};
 await waitUntil(()=>redis.output.includes('Ready to accept connections'),'isolated Redis did not start');
 const api=child(process.execPath,['dist-node/api/server.js'],{...env,NODE_ENV:'production',DATABASE_URL:url.toString(),REDIS_URL:'redis://127.0.0.1:'+redisPort,QUEUE_NAME:'synthetic-ui-'+schema,HOST:'127.0.0.1',PORT:String(apiPort),PUBLIC_APP_URL:'http://localhost:'+apiPort,ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'source-ui-test',SESSION_COOKIE_NAME:'relayboard_source_ui_session',SESSION_COOKIE_SECURE:'false',CONTACT_IMPORT_ENABLED:'true',AI_SEND_MODE:process.env.SYNTHETIC_IMPORT_UI==='true'?'live':process.env.SYNTHETIC_MANUAL_UI==='true'?'synthetic':'disabled',SOURCE_MONITOR_ENABLED:'false',AI_ALLOW_EXTERNAL_REQUESTS:'false',AI_PROVIDER_MODE:'fixture',MESSENGER_SEND_MODE:'fake',MAX_WORKER_URL:'http://127.0.0.1:1',UPLOAD_DIR:join(temp,'uploads')});
 await waitUntil(()=>api.output.includes('Relayboard API listening'),'isolated API did not start');console.log('SYNTHETIC_UI_READY http://localhost:'+apiPort+' (admin / source-ui-test). No real profiles, contacts, provider calls or sends.');console.log('SYNTHETIC_CURRENT_LINK http://localhost:'+apiPort+'/?view=dialogs&contact='+contact.id+'&conversation='+conversation.id+'&request='+activeRequest.requestId);console.log('SYNTHETIC_ARCHIVE_LINK http://localhost:'+apiPort+'/?view=dialogs&contact='+contact.id+'&conversation='+conversation.id+'&request='+priorRequest.requestId);
 await new Promise(r=>{if(stopping)r();else{process.once('SIGTERM',r);process.once('SIGINT',r);}});
}finally{await shutdown();}
