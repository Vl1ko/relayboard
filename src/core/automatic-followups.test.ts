import {AiOrchestrator} from './ai-orchestrator.js';
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {applyAiManagerMigration} from './ai-manager-migration.js';
import {AiManagerStore} from './ai-manager.js';
import {bindSourceRequest} from './request-lifecycle.js';
import {ConversationWorkflow} from './conversation-workflow.js';
import {BusinessEvents} from './business-events.js';
import {AutomaticFollowups} from './automatic-followups.js';
const url=process.env.WORKFLOW_TEST_DATABASE_URL,skip=!url;let pool:pg.Pool,schema:string,workflow:ConversationWorkflow,store:AiManagerStore,business:BusinessEvents;
before(async()=>{if(!url)return;if(new URL(url).pathname!='/relayboard_workflow_test')throw Error('Dedicated workflow test DB required');schema='auto_follow_'+randomUUID().replaceAll('-','');const c=new pg.Client({connectionString:url});await c.connect();await c.query('CREATE SCHEMA '+schema);await c.end();pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public'});await pool.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(pool);workflow=new ConversationWorkflow(pool);store=new AiManagerStore(pool);business=new BusinessEvents(pool);});
beforeEach(async()=>{if(!pool)return;await pool.query('TRUNCATE ai_contacts,integrations,ai_followup_rules CASCADE');await pool.query('UPDATE ai_engine_settings SET settings=settings||$1::jsonb',[JSON.stringify({qualificationEnabled:true,fields:[{key:'volume',question:'Объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);});
after(async()=>{if(pool){await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}});
const rule={scenario:'no_reply' as const,enabled:true,timezone:'UTC',weekdays:[1,2,3,4,5,6,7],startMinute:0,endMinute:1440,steps:[{delaySeconds:10,text:'Synthetic first follow-up'},{delaySeconds:20,text:'Synthetic second follow-up'}],maxSends:2};
async function fixture(sent=true){
 for(const scenario of ['no_reply','not_booked','not_completed','requested_later'] as const)await workflow.saveFollowupRule({...rule,scenario,label:'Настраиваемый этап',channel:'current'});
 const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','Synthetic','fake') RETURNING id")).rows[0].id,contact=await store.createContact('Synthetic'),v=await store.createConversation({contactId:contact.id,accountId:account,externalId:'303'});await bindSourceRequest(pool,{conversationId:v.id,accountId:account,platform:'max',chatId:'-10',messageId:'source',authorId:'200'});
 const current=(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[v.id])).rows[0],action=(await store.enqueue({conversationId:v.id,expectedEpoch:current.automation_epoch,logicalKey:'first',kind:'reply',text:'Synthetic initial reply'})).action;
 if(sent)await dispatch(action.id);return{account,contact:contact.id,v:current,action};
}
async function dispatch(id:string){const v=(await pool.query('SELECT v.* FROM ai_outbox a JOIN ai_conversations v ON v.id=a.conversation_id WHERE a.id=$1',[id])).rows[0];await store.dispatch(id,{target:{accountId:v.account_id,externalConversationId:v.external_id,platform:v.platform},start:a=>({acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'confirmed',externalMessageId:'synthetic-'+a.operationId,code:'synthetic',retryCondition:'never'})})});}
async function event(f:Awaited<ReturnType<typeof fixture>>,kind:'booking_offered'|'booking_confirmed'|'order_started'|'order_completed'|'requested_later'|'stop_followups',notBefore?:string){const d=await business.detail(f.v.id);return business.record({operationId:randomUUID(),conversationId:f.v.id,expectedRevision:d.state.revision,kind,notBefore});}
async function jobs(){return(await pool.query('SELECT * FROM ai_followup_jobs ORDER BY created_at,step')).rows;}
test('confirmed receipt automatically schedules one no-reply sequence across twenty workers and restart',{skip},async()=>{
 const f=await fixture(false);await new AutomaticFollowups(pool).reconcile();assert.equal((await jobs()).length,0);await dispatch(f.action.id);
 await Promise.all(Array.from({length:20},()=>new AutomaticFollowups(pool).reconcile()));assert.equal((await jobs()).length,2);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_automatic_followup_triggers')).rows[0].n,1);await new AutomaticFollowups(pool).reconcile();assert.equal((await jobs()).length,2);
 const started=(await pool.query('SELECT dispatch_started_at FROM ai_outbox WHERE id=$1',[f.action.id])).rows[0].dispatch_started_at;assert.ok(new Date((await jobs())[0].due_at).getTime()>=new Date(started).getTime()+10000);
});
test('unconfirmed/unknown receipt cannot schedule a wait sequence or reopen it after restart',{skip},async()=>{
 const f=await fixture(false);await store.dispatch(f.action.id,{target:{accountId:f.account,externalConversationId:'303',platform:'max'},start:a=>({acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'unknown',code:'timeout',retryCondition:'reconcile_or_manual_review'})})});await new AutomaticFollowups(pool).reconcile();assert.equal((await jobs()).length,0);
});
test('business marks choose specific scenarios and preserve exact not-before without fake customer inbox',{skip},async()=>{
 const f=await fixture();await new AutomaticFollowups(pool).reconcile();await event(f,'booking_offered');await new AutomaticFollowups(pool).reconcile();assert.equal((await jobs()).filter(j=>j.state==='pending')[0].scenario,'not_booked');await event(f,'order_started');await new AutomaticFollowups(pool).reconcile();assert.equal((await jobs()).filter(j=>j.state==='pending')[0].scenario,'not_completed');
 const when=new Date(Date.now()+3600000).toISOString();await event(f,'requested_later',when);await new AutomaticFollowups(pool).reconcile();const active=(await jobs()).filter(j=>j.state==='pending');assert.equal(active.length,2);assert.equal(active[0].scenario,'requested_later');assert.ok(new Date(active[0].due_at)>=new Date(when));assert.equal((await pool.query('SELECT count(*)::int n FROM ai_inbox')).rows[0].n,0);
});
test('booking/order completion stop automation and qualified manager hold cannot be bypassed by stage marks',{skip},async()=>{
 const f=await fixture();await new AutomaticFollowups(pool).reconcile();await pool.query("UPDATE ai_conversations SET business_status='qualified',automation_mode='paused',manager_hold=true WHERE id=$1",[f.v.id]);await event(f,'booking_offered');await new AutomaticFollowups(pool).reconcile();assert.equal((await jobs()).filter(j=>j.state==='pending').length,0);await assert.rejects(workflow.control({conversationId:f.v.id,action:'resume'}));
 await event(f,'booking_confirmed');const v=(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[f.v.id])).rows[0];assert.equal(v.manager_hold,true);assert.equal(v.automation_mode,'paused');assert.equal(v.business_status,'qualified');
 await event(f,'order_completed');await assert.rejects(event(f,'order_started'),/request_completed/);assert.equal((await jobs()).filter(j=>j.state!=='cancelled').length,0);
});
test('customer reply in another channel cancels wait and supersedes an old automatic response',{skip},async()=>{
 const f=await fixture();await new AutomaticFollowups(pool).reconcile();const due=(await jobs())[0],materialized=await workflow.materializeFollowup(due.id,new Date(Date.now()+20000));assert.equal(materialized.state,'enqueued');
 const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('whatsapp','Other','fake') RETURNING id")).rows[0].id,other=await store.createConversation({contactId:f.contact,accountId:account,externalId:'200@c.us'});await bindSourceRequest(pool,{conversationId:other.id,accountId:account,platform:'whatsapp',chatId:'private',messageId:'reply-source',authorId:'200@c.us',allowAdditionalChannel:true});
 await store.ingest({version:1,platform:'whatsapp',accountId:account,conversationId:'200@c.us',messageId:'customer-new',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Ответил в другом канале'});
 await new AutomaticFollowups(pool).reconcile();assert.equal((await jobs()).filter(j=>j.state!=='cancelled').length,0);await dispatch(materialized.outbox_id);assert.equal((await pool.query('SELECT state FROM ai_outbox WHERE id=$1',[materialized.outbox_id])).rows[0].state,'cancelled');
});
test('disable then re-enable never revives a scheduled sequence; business operation replay remains factual',{skip},async()=>{
 const f=await fixture();await new AutomaticFollowups(pool).reconcile();await workflow.saveFollowupRule({...rule,enabled:false});await workflow.saveFollowupRule(rule);await new AutomaticFollowups(pool).reconcile();assert.equal((await jobs()).filter(j=>j.state!=='cancelled').length,0);
 const input={operationId:randomUUID(),conversationId:f.v.id,expectedRevision:0,kind:'booking_offered' as const};await business.record(input);assert.equal((await business.record(input)).replayed,true);await assert.rejects(business.record({...input,note:'different'}),/operation_conflict/);await pool.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[f.v.id]);assert.equal((await business.record(input)).replayed,true);
});
test('changing follow-up channel never creates a second sequence for the same confirmed receipt',{skip},async()=>{
 await fixture();await new AutomaticFollowups(pool).reconcile();await workflow.saveFollowupRule({...rule,channel:'whatsapp'});await new AutomaticFollowups(pool).reconcile();assert.equal((await pool.query('SELECT count(*)::int n FROM ai_automatic_followup_triggers')).rows[0].n,1);assert.equal((await jobs()).length,2);
});

test('twenty concurrent requested-later handlers create one factual event and literal acknowledgement without a model call',{skip},async()=>{
 const f=await fixture();
 await workflow.saveFollowupRule({...rule,scenario:'requested_later',acknowledgementMessage:'Да, вернёмся к вопросу позже.'});
 const input=await store.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'later-request',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Напишите завтра в 15:30'});
 const provider={kind:'fixture' as const,async complete(){throw Error('Model must not be invoked');}};
 const results=await Promise.all(Array.from({length:20},()=>new AiOrchestrator(pool).process(f.v.id,input.event.event_key,provider)));
 assert.equal(new Set(results.map(r=>r.action.id)).size,1);const action=results[0].action;assert.equal(action.text,'Да, вернёмся к вопросу позже.');
 assert.equal((await pool.query('SELECT count(*)::int n FROM ai_business_events')).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM ai_engine_decisions')).rows[0].n,1);
 await dispatch(action.id);await new AutomaticFollowups(pool).reconcile();
 const active=(await jobs()).filter(j=>j.state==='pending');assert.equal(active.length,2);assert.equal(active[0].scenario,'requested_later');
 const detail=await business.detail(f.v.id);assert.ok(new Date(active[0].due_at)>=new Date(detail.events[0].not_before));
 const replay=await new AiOrchestrator(pool).process(f.v.id,input.event.event_key,provider);assert.equal(replay.action.id,action.id);assert.equal(replay.action.text,action.text);
});
test('first requested-later acknowledgement pins greeting once and manager hold prevents literal bypass',{skip},async()=>{
 const f=await fixture(false);await pool.query('DELETE FROM ai_outbox WHERE id=$1',[f.action.id]);
 const input=await store.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'later-first',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Напишите через час'});
 const provider={kind:'fixture' as const,async complete(){throw Error('No model');}};
 const result=await new AiOrchestrator(pool).process(f.v.id,input.event.event_key,provider);assert.ok(result.action.text.endsWith('Хорошо, свяжемся позже.'));assert.notEqual(result.action.text,'Хорошо, свяжемся позже.');
 await dispatch(result.action.id);assert.equal((await store.enqueueAiReply(result.decision.id)).text,result.action.text);
 await pool.query("UPDATE ai_conversations SET manager_hold=true,automation_mode='paused',business_status='qualified' WHERE id=$1",[f.v.id]);
 const next=await store.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'later-held',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Напишите позже'});
 await assert.rejects(new AiOrchestrator(pool).process(f.v.id,next.event.event_key,provider));assert.equal((await pool.query('SELECT count(*)::int n FROM ai_business_events')).rows[0].n,1);
});
test('new customer input in another request channel blocks an already accepted qualification handoff',{skip},async()=>{
 const f=await fixture();
 const input=await store.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'volume-ten',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'10 тонн'});
 const {AiEngineStore}=await import('./ai-engine.js');const engine=new AiEngineStore(pool);
 const decision=await engine.evaluate(f.v.id,input.event.event_key,{kind:'fixture',async complete(){return{replyDraft:'',extracted:[{field:'volume',value:10,evidenceMessageId:'volume-ten',evidenceQuote:'10'}],replyKind:'ask_fields',askFields:[],knowledgeKeys:[],proposedStatus:'qualified',handoffReason:null};}});assert.equal(decision.business_status,'qualified');
 const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('whatsapp','Other','fake') RETURNING id")).rows[0].id,other=await store.createConversation({contactId:f.contact,accountId:account,externalId:'200@c.us'});
 await bindSourceRequest(pool,{conversationId:other.id,accountId:account,platform:'whatsapp',chatId:'private',messageId:'second-channel',authorId:'200@c.us',allowAdditionalChannel:true});
 await store.ingest({version:1,platform:'whatsapp',accountId:account,conversationId:'200@c.us',messageId:'corrected',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'Уточняю объём'});
 await assert.rejects(new AiOrchestrator(pool).process(f.v.id,input.event.event_key,{kind:'fixture',async complete(){throw Error('Saved decision');}}),/superseded_customer_event/);
 assert.equal((await pool.query('SELECT count(*)::int n FROM ai_handoff_notifications')).rows[0].n,0);assert.equal((await pool.query('SELECT manager_hold FROM ai_conversations WHERE id=$1',[f.v.id])).rows[0].manager_hold,false);
});
