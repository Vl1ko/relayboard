import {AiEngineStore} from './ai-engine.js';
import test,{before,beforeEach,after} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import pg from 'pg';
import {loadAiManagerMigrations,applyAiManagerMigration} from './ai-manager-migration.js';import {AiManagerStore} from './ai-manager.js';import {AiOrchestrator} from './ai-orchestrator.js';import {bindSourceRequest} from './request-lifecycle.js';import {ConversationWorkflow} from './conversation-workflow.js';import {DialogueRetention} from './dialogue-retention.js';
const url=process.env.AI_MANAGER_TEST_DATABASE_URL,skip=!url;let pool:pg.Pool,schema:string,store:AiManagerStore;
before(async()=>{if(!url)return;if(new URL(url).pathname!='/relayboard_ai_manager_test')throw Error('Dedicated AI DB required');schema='negative_'+randomUUID().replaceAll('-','');const c=new pg.Client({connectionString:url});await c.connect();await c.query('CREATE SCHEMA '+schema);await c.end();pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public'});await pool.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(pool);store=new AiManagerStore(pool);});
beforeEach(async()=>{if(pool){await pool.query('TRUNCATE ai_contacts,integrations CASCADE');await pool.query('UPDATE ai_engine_settings SET settings=settings||$1::jsonb',[JSON.stringify({qualificationEnabled:true,greetingMessage:'Здравствуйте!',unqualifiedMessage:'Спасибо за обращение, всего доброго.',fields:[{key:'volume',question:'Объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);}});
after(async()=>{if(pool){await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}});
async function fixture(volume=5,approve=true){
 const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','Synthetic','fake') RETURNING id")).rows[0].id,contact=await store.createContact('Synthetic'),v=await store.createConversation({contactId:contact.id,accountId:account,externalId:'303'});
 const source={conversationId:v.id,accountId:account,platform:'max' as const,chatId:'-10',messageId:'source-one',authorId:'200'},bound=await bindSourceRequest(pool,source);
 const e=await store.ingest({version:1,platform:'max',accountId:account,conversationId:'303',messageId:'volume',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:String(volume)});
 const result=await new AiOrchestrator(pool).process(v.id,e.event.event_key,{kind:'fixture',async complete(){return{replyDraft:'',extracted:[{field:'volume',value:volume,evidenceMessageId:'volume',evidenceQuote:String(volume)}],replyKind:'none',askFields:[],knowledgeKeys:[],proposedStatus:volume<10?'unqualified':'qualified',handoffReason:null};}});
 if(volume<10&&approve){const state=(await pool.query('SELECT automation_epoch FROM ai_conversations WHERE id=$1',[v.id])).rows[0];await new ConversationWorkflow(pool).decideQualification({conversationId:v.id,decisionId:result.decision.id,action:'reject',reason:'Синтетическое подтверждение менеджера',expectedRequestId:bound.requestId,expectedEpoch:state.automation_epoch});}
 const action:any=volume>=10||approve?await store.enqueueQualificationNotice(result.decision.id):null;return{account,v:v.id,source,request:bound.requestId,action,decision:result.decision};
}
async function dispatch(f:Awaited<ReturnType<typeof fixture>>,outcome:'confirmed'|'unknown'|'rejected'='confirmed'){
 return store.dispatch(f.action.id,{target:{accountId:f.account,externalConversationId:'303',platform:'max'},start:a=>({acknowledgement:Promise.resolve(outcome==='confirmed'?{operationId:a.operationId,outcome,externalMessageId:'synthetic-farewell',code:'synthetic_receipt',retryCondition:'never'}:outcome==='unknown'?{operationId:a.operationId,outcome,code:'timeout',retryCondition:'reconcile_or_manual_review'}:{operationId:a.operationId,outcome,dispatchState:'not_started',code:'disconnected',retryCondition:'never'})})});
}
async function current(f:Awaited<ReturnType<typeof fixture>>){return(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[f.v])).rows[0];}
test('human-approved negative farewell closes and archives the request only after receipt',{skip},async()=>{
 const f=await fixture();assert.equal((await current(f)).business_status,'unqualified');assert.equal((await pool.query('SELECT lifecycle FROM ai_requests WHERE id=$1',[f.request])).rows[0].lifecycle,'open');
 await dispatch(f);assert.equal((await current(f)).business_status,'closed');const request=(await pool.query('SELECT * FROM ai_requests WHERE id=$1',[f.request])).rows[0];assert.equal(request.lifecycle,'closed');assert.ok(request.closed_at);
 const phase=(await pool.query('SELECT * FROM ai_request_phases WHERE request_id=$1',[f.request])).rows[0];assert.ok(phase.closed_at);assert.equal(phase.fields_snapshot.volume.value,5);
 assert.equal((await pool.query('SELECT state FROM ai_handoff_notifications')).rows[0].state,'rejected');assert.equal((await store.finalizeNegativeCompletions()),0);assert.equal((await pool.query("SELECT count(*)::int n FROM ai_workflow_status_history WHERE reason='negative_qualification_completed'")).rows[0].n,1);
 assert.equal((await new DialogueRetention(pool).preview(new Date(new Date(request.closed_at).getTime()+31*86400000))).eligibleRequests,1);
});
for(const outcome of ['unknown','rejected'] as const)test(outcome+' farewell cannot close a request or start TTL',{skip},async()=>{const f=await fixture();await dispatch(f,outcome);assert.equal((await current(f)).business_status,'unqualified');assert.equal(await store.finalizeNegativeCompletions(),0);const request=(await pool.query('SELECT lifecycle,closed_at FROM ai_requests WHERE id=$1',[f.request])).rows[0];assert.equal(request.lifecycle,'open');assert.equal(request.closed_at,null);});
test('late verified receipt repair and twenty recovery workers close once without another send',{skip},async()=>{
 const f=await fixture();await dispatch(f,'unknown');
 // Simulate the exact-message receipt reconciliation already covered by transport tests.
 await pool.query("UPDATE ai_outbox SET state='confirmed',external_message_id='synthetic-late-verified' WHERE id=$1",[f.action.id]);
 const closed=await Promise.all(Array.from({length:20},()=>new AiManagerStore(pool).finalizeNegativeCompletions()));assert.equal(closed.reduce((a,b)=>a+b,0),1);assert.equal((await current(f)).business_status,'closed');assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,1);
});
test('manager takeover while farewell is awaiting acknowledgement prevents automatic close',{skip},async()=>{
 const f=await fixture();let started=false,resolve!:(value:unknown)=>void;const ack=new Promise(r=>resolve=r);
 const sending=store.dispatch(f.action.id,{target:{accountId:f.account,externalConversationId:'303',platform:'max'},start:()=>{started=true;return{acknowledgement:ack};}});
 while(!started)await new Promise(r=>setTimeout(r,5));await store.setMode(f.v,'manual');resolve({operationId:f.action.id,outcome:'confirmed',externalMessageId:'synthetic-actual-receipt',code:'receipt',retryCondition:'never'});await sending;
 assert.equal((await current(f)).automation_mode,'manual');assert.equal((await current(f)).business_status,'manager_working');assert.equal((await pool.query('SELECT lifecycle FROM ai_requests WHERE id=$1',[f.request])).rows[0].lifecycle,'open');
});
test('new source after negative close creates a separate request; old source and receipt never close or reopen the new one',{skip},async()=>{
 const f=await fixture();await dispatch(f);const next=await bindSourceRequest(pool,{...f.source,messageId:'source-two'});assert.notEqual(next.requestId,f.request);
 const replay=await bindSourceRequest(pool,f.source);assert.equal(replay.requestId,f.request);assert.equal(replay.duplicate,true);assert.equal(await store.finalizeNegativeCompletions(),0);assert.equal((await current(f)).business_status,'ai_dialog');assert.equal((await pool.query('SELECT lifecycle FROM ai_requests WHERE id=$1',[next.requestId])).rows[0].lifecycle,'open');
 assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,1);
});
test('qualified completion never closes the waiting-manager request or releases its hold',{skip},async()=>{
 const f=await fixture(12);await dispatch(f);assert.equal((await current(f)).business_status,'qualified');assert.equal((await current(f)).manager_hold,true);assert.equal((await pool.query('SELECT lifecycle FROM ai_requests WHERE id=$1',[f.request])).rows[0].lifecycle,'open');assert.equal(await store.finalizeNegativeCompletions(),0);
});

test('late service echo belongs to its receipt phase and never enters the new request model context',{skip},async()=>{
 const f=await fixture();await dispatch(f);await bindSourceRequest(pool,{...f.source,messageId:'new-echo-source'});
 const echo=await store.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'synthetic-farewell',occurredAt:new Date().toISOString(),direction:'outbound',origin:'service',text:f.action.text});
 assert.equal(echo.event.request_phase_id,f.action.request_phase_id);
 const input=await store.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'new-customer',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Новый вопрос'});let seen:string[]=[];
 await new AiEngineStore(pool).evaluate(f.v,input.event.event_key,{kind:'fixture',async complete(i){seen=i.data.messages.map(m=>m.messageId);return{replyDraft:'',extracted:[],replyKind:'ask_fields',askFields:['volume'],knowledgeKeys:[],proposedStatus:'insufficient_data',handoffReason:null};}});
 assert.deepEqual(seen,['new-customer']);
});
test('a previously unseen echo after TTL cannot restore expired text inside the new active request',{skip},async()=>{
 const f=await fixture();await dispatch(f);const closed=(await pool.query('SELECT closed_at FROM ai_requests WHERE id=$1',[f.request])).rows[0].closed_at;await bindSourceRequest(pool,{...f.source,messageId:'new-after-ttl'});
 assert.equal((await new DialogueRetention(pool).expire(new Date(new Date(closed).getTime()+31*86400000))).expiredRequests,1);
 const echo=await store.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'synthetic-farewell',occurredAt:new Date().toISOString(),direction:'outbound',origin:'service',text:f.action.text});
 assert.equal(echo.event.request_phase_id,f.action.request_phase_id);assert.equal(echo.event.text,'[Срок хранения текста истёк]');assert.equal((await current(f)).business_status,'ai_dialog');
});

test('AI negative suggestion notifies managers, holds request and cannot enqueue farewell before approval',{skip},async()=>{
 const f=await fixture(5,false),v=await current(f);assert.equal(v.business_status,'manager_required');assert.equal(v.manager_hold,true);assert.equal(f.action,null);
 const n=(await pool.query('SELECT reason,state FROM ai_handoff_notifications')).rows[0];assert.deepEqual(n,{reason:'qualification_review',state:'pending'});
 await assert.rejects(store.enqueueQualificationNotice(f.decision.id),/manager_rejection_required/);
 await store.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'additional',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Я здесь, жду'});
 assert.equal((await current(f)).automation_epoch,v.automation_epoch);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,0);assert.equal(await store.finalizeNegativeCompletions(),0);
 const workflow=new ConversationWorkflow(pool,{requireRequestContext:true});await assert.rejects(workflow.decideQualification({conversationId:f.v,decisionId:f.decision.id,action:'reject',reason:'test',expectedRequestId:randomUUID(),expectedEpoch:v.automation_epoch}),/stale_request_context/);
 const command={conversationId:f.v,decisionId:f.decision.id,action:'reject' as const,reason:'Менеджер подтвердил',expectedRequestId:f.request,expectedEpoch:v.automation_epoch};
 await Promise.all([workflow.decideQualification(command),workflow.decideQualification(command)]);await store.enqueueQualificationNotice(f.decision.id);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,1);
 await assert.rejects(workflow.decideQualification({...command,action:'takeover'}),/already_decided/);
});
test('manager disagreement takes over and forbids a later negative farewell',{skip},async()=>{const f=await fixture(5,false),v=await current(f);await new ConversationWorkflow(pool).decideQualification({conversationId:f.v,decisionId:f.decision.id,action:'takeover',reason:'Подходит, уточню сам',expectedRequestId:f.request,expectedEpoch:v.automation_epoch});assert.equal((await current(f)).business_status,'manager_working');assert.equal((await current(f)).automation_mode,'manual');await assert.rejects(store.enqueueQualificationNotice(f.decision.id),/manager_rejection_required/);assert.equal((await pool.query('SELECT state FROM ai_qualification_reviews')).rows[0].state,'taken');});
test('native manager reply dismisses review and never confirms a rejection',{skip},async()=>{const f=await fixture(5,false);await store.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'human-reply',occurredAt:new Date().toISOString(),direction:'outbound',origin:'human',text:'Я менеджер, сейчас помогу'});assert.equal((await pool.query('SELECT state FROM ai_qualification_reviews')).rows[0].state,'taken');await assert.rejects(store.enqueueQualificationNotice(f.decision.id),/manager_rejection_required/);});

test('upgrade preserves old receipts but requires manager approval for an old unsent negative notice',{skip},async()=>{
 const legacySchema='negative_upgrade_'+randomUUID().replaceAll('-','');await pool.query('CREATE SCHEMA '+legacySchema);const legacy=new pg.Pool({connectionString:url,options:'-c search_path='+legacySchema+',public'});
 try{
  await legacy.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));await legacy.query('CREATE TABLE ai_schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT now())');for(const m of(await loadAiManagerMigrations()).filter(m=>m.version<=24)){await legacy.query(m.sql);await legacy.query('INSERT INTO ai_schema_migrations(version,checksum) VALUES($1,$2)',[m.version,m.checksum]);}
  await legacy.query('UPDATE ai_engine_settings SET settings=settings||$1::jsonb',[JSON.stringify({qualificationEnabled:true,unqualifiedMessage:'Прощание после решения менеджера',fields:[{key:'volume',question:'Объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);
  const account=(await legacy.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','synthetic','fake') RETURNING id")).rows[0].id,s=new AiManagerStore(legacy),contact=await s.createContact('synthetic'),v=await s.createConversation({contactId:contact.id,accountId:account,externalId:'303'});await bindSourceRequest(legacy,{conversationId:v.id,accountId:account,platform:'max',chatId:'-10',messageId:'old-source',authorId:'200'});
  const e=await s.ingest({version:1,platform:'max',accountId:account,conversationId:'303',messageId:'five',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'5'}),d=await new AiEngineStore(legacy).evaluate(v.id,e.event.event_key,{kind:'fixture',async complete(){return{replyDraft:'',extracted:[{field:'volume',value:5,evidenceMessageId:'five',evidenceQuote:'5'}],replyKind:'none',askFields:[],knowledgeKeys:[],proposedStatus:'unqualified',handoffReason:null};}});
  await legacy.query("UPDATE ai_conversations SET business_status='unqualified',automation_mode='paused',automation_epoch=automation_epoch+1 WHERE id=$1",[v.id]);
  await legacy.query("INSERT INTO ai_handoff_notifications(conversation_id,logical_key,fingerprint,reason,summary,parameters,contact_snapshot,channel_snapshot,state,outcome_code) VALUES($1,$2,'legacy','insufficient_data','synthetic','{}','{}','{}','rejected','qualification_not_passed')",[v.id,'ai-handoff:'+d.id]);
  const a=(await legacy.query("INSERT INTO ai_outbox(contact_id,conversation_id,logical_key,kind,text,fingerprint,automation_epoch) SELECT contact_id,id,$2,'qualification_notice',$3,'legacy',automation_epoch FROM ai_conversations WHERE id=$1 RETURNING id",[v.id,'qualification-notice:'+d.id,'Прощание после решения менеджера'])).rows[0];
  await applyAiManagerMigration(legacy);assert.equal((await legacy.query('SELECT state FROM ai_outbox WHERE id=$1',[a.id])).rows[0].state,'cancelled');assert.equal((await legacy.query('SELECT business_status FROM ai_conversations WHERE id=$1',[v.id])).rows[0].business_status,'manager_required');await assert.rejects(s.enqueueQualificationNotice(d.id),/manager_rejection_required/);
  await new ConversationWorkflow(legacy).decideQualification({conversationId:v.id,decisionId:d.id,action:'reject',reason:'Проверено менеджером'});assert.equal((await s.enqueueQualificationNotice(d.id)).id,a.id);assert.equal((await legacy.query('SELECT state FROM ai_outbox WHERE id=$1',[a.id])).rows[0].state,'pending');
 }finally{await legacy.end();await pool.query('DROP SCHEMA '+legacySchema+' CASCADE');}
});
