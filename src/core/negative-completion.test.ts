import {AiEngineStore} from './ai-engine.js';
import test,{before,beforeEach,after} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import pg from 'pg';
import {applyAiManagerMigration} from './ai-manager-migration.js';import {AiManagerStore} from './ai-manager.js';import {AiOrchestrator} from './ai-orchestrator.js';import {bindSourceRequest} from './request-lifecycle.js';import {ConversationWorkflow} from './conversation-workflow.js';import {DialogueRetention} from './dialogue-retention.js';
const url=process.env.AI_MANAGER_TEST_DATABASE_URL,skip=!url;let pool:pg.Pool,schema:string,store:AiManagerStore;
before(async()=>{if(!url)return;if(new URL(url).pathname!='/relayboard_ai_manager_test')throw Error('Dedicated AI DB required');schema='negative_'+randomUUID().replaceAll('-','');const c=new pg.Client({connectionString:url});await c.connect();await c.query('CREATE SCHEMA '+schema);await c.end();pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public'});await pool.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(pool);store=new AiManagerStore(pool);});
beforeEach(async()=>{if(pool){await pool.query('TRUNCATE ai_contacts,integrations CASCADE');await pool.query('UPDATE ai_engine_settings SET settings=settings||$1::jsonb',[JSON.stringify({qualificationEnabled:true,greetingMessage:'Здравствуйте!',unqualifiedMessage:'Спасибо за обращение, всего доброго.',fields:[{key:'volume',question:'Объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);}});
after(async()=>{if(pool){await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}});
async function fixture(volume=5){
 const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','Synthetic','fake') RETURNING id")).rows[0].id,contact=await store.createContact('Synthetic'),v=await store.createConversation({contactId:contact.id,accountId:account,externalId:'303'});
 const source={conversationId:v.id,accountId:account,platform:'max' as const,chatId:'-10',messageId:'source-one',authorId:'200'},bound=await bindSourceRequest(pool,source);
 const e=await store.ingest({version:1,platform:'max',accountId:account,conversationId:'303',messageId:'volume',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:String(volume)});
 const result=await new AiOrchestrator(pool).process(v.id,e.event.event_key,{kind:'fixture',async complete(){return{replyDraft:'',extracted:[{field:'volume',value:volume,evidenceMessageId:'volume',evidenceQuote:String(volume)}],replyKind:'none',askFields:[],knowledgeKeys:[],proposedStatus:volume<10?'unqualified':'qualified',handoffReason:null};}});
 const action=await store.enqueueQualificationNotice(result.decision.id);return{account,v:v.id,source,request:bound.requestId,action,decision:result.decision};
}
async function dispatch(f:Awaited<ReturnType<typeof fixture>>,outcome:'confirmed'|'unknown'|'rejected'='confirmed'){
 return store.dispatch(f.action.id,{target:{accountId:f.account,externalConversationId:'303',platform:'max'},start:a=>({acknowledgement:Promise.resolve(outcome==='confirmed'?{operationId:a.operationId,outcome,externalMessageId:'synthetic-farewell',code:'synthetic_receipt',retryCondition:'never'}:outcome==='unknown'?{operationId:a.operationId,outcome,code:'timeout',retryCondition:'reconcile_or_manual_review'}:{operationId:a.operationId,outcome,dispatchState:'not_started',code:'disconnected',retryCondition:'never'})})});
}
async function current(f:Awaited<ReturnType<typeof fixture>>){return(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[f.v])).rows[0];}
test('confirmed negative farewell closes and archives the request once, starts TTL, and sends no manager alert',{skip},async()=>{
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
