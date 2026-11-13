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
async function fixture(provider:AiProvider){
 const engine=new AiEngineStore(pool),settings=await engine.settings();await engine.saveSettings({expectedVersion:settings.version,settings:{...settings.settings,qualificationEnabled:true,fields:[{key:'volume',question:'Какой объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]}});
 const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext)VALUES('max','synthetic','fake')RETURNING id")).rows[0].id;
 const store=new AiManagerStore(pool),contact=await store.createContact('synthetic'),conversation=await store.createConversation({contactId:contact.id,accountId:account,externalId:'303'});await beginConfiguredQualification(pool,conversation.id);
 let items:any[]=[],sent=0;const socket={connected:true,async send(op:number,body:any){if(op===49)return{messages:items};assert.equal(op,64);assert.equal(body.chatId,303);sent++;return{message:{id:'service-'+sent}};}};
 const session=new MaxQualificationSession({pool,provider,socket,close:()=>{},accountId:account,conversationId:conversation.id,dialogId:'303',authorId:'202',selfId:101,since:Date.now()-1000});
 return{session,store,conversation,account,socket,set:(m:any[])=>items=m,sent:()=>sent};
}
const ask:AiProvider={kind:'fixture',async complete(){return{replyDraft:'never send',extracted:[],replyKind:'ask_fields',askFields:['volume'],knowledgeKeys:[],proposedStatus:'insufficient_data',handoffReason:null};}};
const m=(id:string,text:string,sender=202)=>({id,text,sender,time:Date.now(),type:'USER'});
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');}
test('MAX private session asks missing field, deduplicates polls, then qualifies from grounded reply',{skip:!url},async()=>{
 const provider:AiProvider={kind:'fixture',async complete(input){const last=input.data.messages.filter(m=>m.origin==='customer').at(-1)!;return last.text==='12'?{replyDraft:'',extracted:[{field:'volume',value:12,evidenceMessageId:last.messageId,evidenceQuote:'12'}],replyKind:'none',askFields:[],knowledgeKeys:[],proposedStatus:'qualified',handoffReason:null}:ask.complete(input);}};
 const f=await fixture(provider);f.set([m('one','Здравствуйте')]);await f.session.poll();await until(()=>f.sent()===1);await f.session.poll();assert.equal(f.sent(),1);
 f.set([m('one','Здравствуйте'),m('two','12')]);await f.session.poll();await until(()=>!f.session.active);const status=await f.session.status();assert.equal(status.businessStatus,'qualified');assert.equal(status.fields.volume,12);assert.equal(f.sent(),1);
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
