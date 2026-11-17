import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {applyAiManagerMigration} from './ai-manager-migration.js';
import {AiManagerStore} from './ai-manager.js';
import {AiEngineStore,type AiProvider} from './ai-engine.js';
import {MaxQualificationSession} from './max-qualification-session.js';
import {beginConfiguredQualification} from './begin-qualification.js';
const url=process.env.AI_MANAGER_TEST_DATABASE_URL;let pool:pg.Pool,schema:string;
before(async()=>{if(!url)return;if(new URL(url).pathname!='/relayboard_ai_manager_test')throw Error('Dedicated test DB required');schema='max_session_'+randomUUID().replaceAll('-','');const c=new pg.Client({connectionString:url});await c.connect();await c.query('CREATE SCHEMA '+schema);await c.end();pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public'});await pool.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(pool);});
beforeEach(async()=>{if(pool)await pool.query('TRUNCATE ai_contacts,integrations CASCADE');});
after(async()=>{if(pool){await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}});
async function fixture(provider:AiProvider,ignoreIds:string[]=[]){
 const engine=new AiEngineStore(pool),settings=await engine.settings();await engine.saveSettings({expectedVersion:settings.version,settings:{...settings.settings,greetingMessage:'Здравствуйте, тестовый клиент!',qualifiedMessage:'Спасибо, ожидайте менеджера.',unqualifiedMessage:'Спасибо за обращение. Всего доброго!',qualificationEnabled:true,fields:[{key:'volume',question:'Какой объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]}});
 const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext)VALUES('max','synthetic','fake')RETURNING id")).rows[0].id;
 const store=new AiManagerStore(pool),contact=await store.createContact('synthetic'),conversation=await store.createConversation({contactId:contact.id,accountId:account,externalId:'303'});await beginConfiguredQualification(pool,conversation.id);
 let items:any[]=[],sent=0;const sentTexts:string[]=[];const socket={connected:true,async send(op:number,body:any){if(op===49)return{messages:items};assert.equal(op,64);assert.equal(body.chatId,303);sentTexts.push(body.message.text);sent++;return{message:{id:'service-'+sent}};}};
 const session=new MaxQualificationSession({pool,provider,socket,close:()=>{},accountId:account,conversationId:conversation.id,dialogId:'303',authorId:'202',selfId:101,since:Date.now()-1000,ignoreIds});
 return{session,store,conversation,account,socket,set:(m:any[])=>items=m,sent:()=>sent,sentTexts};
}
const ask:AiProvider={kind:'fixture',async complete(){return{replyDraft:'never send',extracted:[],replyKind:'ask_fields',askFields:['volume'],knowledgeKeys:[],proposedStatus:'insufficient_data',handoffReason:null};}};
const m=(id:string,text:string,sender=202)=>({id,text,sender,time:Date.now(),type:'USER'});
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');}
test('MAX private session asks missing field, deduplicates polls, then qualifies from grounded reply',{skip:!url},async()=>{
 const provider:AiProvider={kind:'fixture',async complete(input){const last=input.data.messages.filter(m=>m.origin==='customer').at(-1)!;return last.text==='12'?{replyDraft:'',extracted:[{field:'volume',value:12,evidenceMessageId:last.messageId,evidenceQuote:'12'}],replyKind:'none',askFields:[],knowledgeKeys:[],proposedStatus:'qualified',handoffReason:null}:ask.complete(input);}};
 const f=await fixture(provider);f.set([m('one','Здравствуйте')]);await f.session.poll();await until(()=>f.sent()===1);await f.session.poll();assert.equal(f.sent(),1);
 f.set([m('one','Здравствуйте'),m('two','12')]);await f.session.poll();await until(()=>!f.session.active);const status=await f.session.status();assert.equal(status.businessStatus,'qualified');assert.equal(status.fields.volume,12);assert.equal(f.sent(),2);
 const decision=(await pool.query("SELECT id FROM ai_engine_decisions WHERE conversation_id=$1 AND reason='qualified'",[f.conversation.id])).rows[0];const notice=await f.store.enqueueQualificationNotice(decision.id);assert.equal(notice.state,'confirmed');await f.store.dispatch(notice.id,{target:{accountId:f.account,externalConversationId:'303',platform:'max'},start(){throw Error('Must not repeat completion');}});assert.equal(f.sent(),2);
});
test('native manager message while model is pending cancels late reply',{skip:!url},async()=>{
 let release!:(value:any)=>void,started=false;const deferred:AiProvider={kind:'fixture',complete(){started=true;return new Promise(r=>release=r);}};const f=await fixture(deferred);f.set([m('one','Здравствуйте')]);await f.session.poll();await until(()=>started);
 f.set([m('manager','Я отвечу сам',101)]);await f.session.poll();release(await ask.complete({}as any));await until(()=>!f.session.active);assert.equal(f.sent(),0);assert.equal((await f.session.status()).mode,'manual');
});
test('confirmed service echoes do not take over; other senders and refusal cannot trigger sends',{skip:!url},async()=>{
 const f=await fixture(ask);f.set([m('other','ignore',999)]);await f.session.poll();assert.equal(f.sent(),0);
 f.set([m('one','Здравствуйте')]);await f.session.poll();await until(()=>f.sent()===1);await until(async()=>!!(await pool.query("SELECT 1 FROM ai_outbox WHERE conversation_id=$1 AND state='confirmed'",[f.conversation.id])).rowCount);
 f.set([m('service-1','Какой объём?',101)]);await f.session.poll();assert.equal(f.session.active,true);
 f.set([m('stop','Стоп')]);await f.session.poll();await until(()=>!f.session.active);assert.equal((await f.session.status()).businessStatus,'refused');assert.equal(f.sent(),1);
});
test('uncertain send stops session and cannot be restarted by a new qualification phase',{skip:!url},async()=>{
 const f=await fixture(ask);f.socket.send=async(op:number)=>{if(op===49)return{messages:[m('one','Здравствуйте')]};throw Error('network');};await f.session.poll();await until(()=>!f.session.active);assert.equal(f.session.reason,'uncertain_send');await assert.rejects(beginConfiguredQualification(pool,f.conversation.id),/uncertain_send/);
});
test('explicit new qualification adopts current rules without rewriting historical settings, and respects opt-out',{skip:!url},async()=>{
 const f=await fixture(ask),engine=new AiEngineStore(pool),previous=await engine.settings();
 const next=await engine.saveSettings({expectedVersion:previous.version,settings:{...previous.settings,rules:[{field:'volume',op:'gte',value:20}]}});
 await beginConfiguredQualification(pool,f.conversation.id);assert.equal((await f.session.status()).settingsVersion,next.version);
 const historical=(await pool.query('SELECT settings FROM ai_engine_settings WHERE version=$1',[previous.version])).rows[0].settings;
 assert.equal(historical.rules[0].value,10);
 await f.store.optOut(f.conversation.contact_id,'test refusal');await assert.rejects(beginConfiguredQualification(pool,f.conversation.id),/forbidden/);
});

test('explicit restart ignores historical manager messages but processes a new customer answer',{skip:!url},async()=>{const f=await fixture(ask,['previous-manager']);f.set([m('previous-manager','Историческое сообщение',101),m('fresh-customer','Здравствуйте')]);await f.session.poll();await until(()=>f.sent()===1);assert.equal(f.session.active,true);await f.session.stop();});

test('completion notice is cancelled if manager takes over before its dispatch',{skip:!url},async()=>{
 const {AiOrchestrator}=await import('./ai-orchestrator.js');
 const provider:AiProvider={kind:'fixture',async complete(input){const m=input.data.messages.at(-1)!;return{replyDraft:'',extracted:[{field:'volume',value:12,evidenceMessageId:m.messageId,evidenceQuote:'12'}],replyKind:'none',askFields:[],knowledgeKeys:[],proposedStatus:'qualified',handoffReason:null};}};
 const f=await fixture(provider),o=new AiOrchestrator(pool);const event=await o.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'done',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'12'});const result=await o.process(f.conversation.id,event.event.event_key,provider);
 const notice=await f.store.enqueueQualificationNotice(result.decision.id);
 await f.store.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'manager-after',occurredAt:new Date().toISOString(),direction:'outbound',origin:'human',text:'Дальше я'});
 await f.store.dispatch(notice.id,{target:{accountId:f.account,externalConversationId:'303',platform:'max'},start(){throw Error('Must not send after takeover');}});
 assert.equal((await pool.query('SELECT state FROM ai_outbox WHERE id=$1',[notice.id])).rows[0].state,'cancelled');
});

test('greeting is configured and sent once; successful qualification remains blocked until manager closes',{skip:!url},async()=>{
 const f=await fixture(ask);f.set([m('g1','Здравствуйте')]);await f.session.poll();await until(()=>f.sent()===1);assert.ok(f.sentTexts[0].startsWith('Здравствуйте, тестовый клиент!'));
 f.set([m('g1','Здравствуйте'),m('g2','Не знаю')]);await f.session.poll();await until(()=>f.sent()===2);assert.equal(f.sentTexts[1],'Какой объём?');await f.session.stop();
 const {AiOrchestrator}=await import('./ai-orchestrator.js'),{ConversationWorkflow}=await import('./conversation-workflow.js');await f.store.setMode(f.conversation.id,'auto');
 const o=new AiOrchestrator(pool),e=await o.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'final-12',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'12'});
 const provider:AiProvider={kind:'fixture',async complete(){return{replyDraft:'',extracted:[{field:'volume',value:12,evidenceMessageId:'final-12',evidenceQuote:'12'}],replyKind:'none',askFields:[],knowledgeKeys:[],proposedStatus:'qualified',handoffReason:null};}};
 await o.process(f.conversation.id,e.event.event_key,provider);await assert.rejects(f.store.setMode(f.conversation.id,'auto'),/manager_hold/);await assert.rejects(beginConfiguredQualification(pool,f.conversation.id),/manager_hold/);
 const wf=new ConversationWorkflow(pool);await assert.rejects(wf.control({conversationId:f.conversation.id,action:'resume'}));await wf.setStatus({conversationId:f.conversation.id,status:'closed',reason:'manager closed'});assert.equal((await pool.query('SELECT manager_hold FROM ai_conversations WHERE id=$1',[f.conversation.id])).rows[0].manager_hold,false);
});
test('negative suggestion waits for human review without sending client farewell',{skip:!url},async()=>{
 const provider:AiProvider={kind:'fixture',async complete(input){const c=input.data.messages.at(-1)!;return{replyDraft:'',extracted:[{field:'volume',value:5,evidenceMessageId:c.messageId,evidenceQuote:'5'}],replyKind:'none',askFields:[],knowledgeKeys:[],proposedStatus:'unqualified',handoffReason:null};}};
 const f=await fixture(provider);f.set([m('low','5')]);await f.session.poll();await until(()=>!f.session.active);assert.equal((await f.session.status()).businessStatus,'manager_required');assert.deepEqual(f.sentTexts,[]);assert.equal((await pool.query('SELECT state FROM ai_handoff_notifications WHERE conversation_id=$1',[f.conversation.id])).rows[0].state,'pending');
});

test('qualified manager notification reaches only configured group and cannot be sent twice',{skip:!url},async()=>{
 const f=await fixture(ask),{AiOrchestrator}=await import('./ai-orchestrator.js'),{ConversationWorkflow}=await import('./conversation-workflow.js'),{dispatchMaxManagerNotification}=await import('./max-manager-notification.js');
 const workflow=new ConversationWorkflow(pool);await workflow.saveManagerTarget({accountId:f.account,externalId:'-456'});
 const o=new AiOrchestrator(pool),e=await o.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'manager-notify',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'12'});
 const provider:AiProvider={kind:'fixture',async complete(){return{replyDraft:'',extracted:[{field:'volume',value:12,evidenceMessageId:'manager-notify',evidenceQuote:'12'}],replyKind:'none',askFields:[],knowledgeKeys:[],proposedStatus:'qualified',handoffReason:null};}};
 const result=await o.process(f.conversation.id,e.event.event_key,provider),id=('notification'in result?result.notification:null)!.id;let sends=0;
 const socket={connected:true,async send(op:number,body:any){if(op===48)return{chats:[{type:'CHAT',id:-456}]};assert.equal(op,64);assert.equal(body.chatId,-456);assert.match(body.message.text,/Заявка прошла квалификацию/);assert.match(body.message.text,/Какой объём\?: 12/);sends++;return{message:{id:'manager-confirmed'}};}};
 assert.equal((await dispatchMaxManagerNotification(pool,id,{accountId:f.account,socket})as any).state,'confirmed');await dispatchMaxManagerNotification(pool,id,{accountId:f.account,socket});assert.equal(sends,1);
});

for(const reason of ['human_requested','insufficient_data','reply_limit'] as const){
 test('manager MAX dispatch supports '+reason+' with one confirmed send',{skip:!url},async()=>{
  const f=await fixture(ask),{ConversationWorkflow}=await import('./conversation-workflow.js'),{dispatchMaxManagerNotification}=await import('./max-manager-notification.js');
  const workflow=new ConversationWorkflow(pool);await workflow.saveManagerTarget({accountId:f.account,externalId:'-456'});
  const n=await workflow.handoff({conversationId:f.conversation.id,key:'all-reasons',reason,summary:'Synthetic summary',parameters:{volume:'12'}});let sends=0;
  const socket={connected:true,async send(op:number,body:any){if(op===48)return{chats:[{type:'CHAT',id:-456}]};assert.equal(op,64);assert.equal(body.chatId,-456);assert.match(body.message.text,/Synthetic summary/);assert.doesNotMatch(body.message.text,/Заявка прошла квалификацию/);sends++;return{message:{id:'server-confirmed'}};}};
  assert.equal((await dispatchMaxManagerNotification(pool,n.id,{accountId:f.account,socket})as any).state,'confirmed');await dispatchMaxManagerNotification(pool,n.id,{accountId:f.account,socket});assert.equal(sends,1);
 });
}
