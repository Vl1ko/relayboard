import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {applyAiManagerMigration} from './ai-manager-migration.js';
import {AiManagerStore} from './ai-manager.js';
import {bindSourceRequest} from './request-lifecycle.js';
import {WhatsAppAiReceipts} from './whatsapp-ai-receipts.js';
import {WhatsAppPrivatePoller,type WhatsAppPrivateHistory,type WhatsAppHistoryMessage} from './whatsapp-private-poller.js';
const url=process.env.AI_MANAGER_TEST_DATABASE_URL,skip=!url;let pool:pg.Pool,schema:string;
before(async()=>{if(!url)return;if(new URL(url).pathname!='/relayboard_ai_manager_test')throw Error('Dedicated AI test DB required');schema='wa_poll_'+randomUUID().replaceAll('-','');const a=new pg.Client({connectionString:url});await a.connect();await a.query('CREATE SCHEMA '+schema);await a.end();pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public'});await pool.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(pool);});
beforeEach(async()=>{if(pool){await pool.query('TRUNCATE ai_contacts,integrations CASCADE');await pool.query(`UPDATE ai_engine_settings SET settings=settings||$1::jsonb`,[JSON.stringify({qualificationEnabled:true,fields:[{key:'volume',question:'Объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);}});after(async()=>{if(pool){await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}});
async function fixture(){
 const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('whatsapp','synthetic','fake') RETURNING id")).rows[0].id,store=new AiManagerStore(pool),contact=await store.createContact('Synthetic'),conversation=await store.createConversation({contactId:contact.id,accountId:account,externalId:'200@c.us'});
 const source={conversationId:conversation.id,accountId:account,platform:'whatsapp' as const,chatId:'source@g.us',messageId:'source',authorId:'200@c.us'};await bindSourceRequest(pool,source);
 const phase=(await pool.query('SELECT active_phase_id FROM ai_conversations WHERE id=$1',[conversation.id])).rows[0].active_phase_id,base=Math.floor(Date.now()/1000)*1000;
 await pool.query('UPDATE ai_request_phases SET started_at=to_timestamp($2::double precision/1000) WHERE id=$1',[phase,base]);
 let time=base+5000,calls=0,history:WhatsAppPrivateHistory={targetId:'200@c.us',recipientAliases:['200@c.us','201@lid'],selfAliases:['100@c.us'],messages:[],exhausted:true};const stop=new AbortController(),scope={testOnly:true,accountIds:[account],authorIds:['200@c.us']};
 const read=async()=>{calls++;return history;},poller=()=>new WhatsAppPrivatePoller(pool,read,stop.signal,scope,()=>time);
 const message=(id:string,own=false):WhatsAppHistoryMessage=>({id,from:own?'100@c.us':'200@c.us',to:own?'200@c.us':'100@c.us',fromMe:own,timestamp:base/1000+1,body:'Synthetic',ack:1,type:'chat'});
 return{account,store,conversation,phase,base,scope,stop,read,poller,message,source,set:(h:Partial<WhatsAppPrivateHistory>)=>{history={...history,...h};},calls:()=>calls,setTime:(t:number)=>time=t};
}
test('WhatsApp history catch-up persists 250 same-second messages, deduplicates restart and concurrent polls',{skip},async()=>{
 const f=await fixture();f.set({messages:Array.from({length:250},(_,i)=>f.message(String(i)))});const p=f.poller();await Promise.all(Array.from({length:20},()=>p.poll(f.conversation.id)));assert.equal(f.calls(),1);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_inbox')).rows[0].n,250);
 f.setTime(f.base+6000);await f.poller().poll(f.conversation.id);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_inbox')).rows[0].n,250);
});
test('WhatsApp unknown reserved echo with exact server ack reconciles without native takeover',{skip},async()=>{
 const f=await fixture(),v=(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[f.conversation.id])).rows[0],action=(await f.store.enqueue({conversationId:v.id,expectedEpoch:v.automation_epoch,kind:'reply',logicalKey:'reply',text:'Synthetic'})).action;
 await new WhatsAppAiReceipts(pool).reserve({actionId:action.id,accountId:f.account,conversationId:v.id,messageId:'reserved',targetId:v.external_id,recipientAliases:[v.external_id],selfAliases:['100@c.us']});
 await f.store.dispatch(action.id,{target:{accountId:f.account,externalConversationId:v.external_id,platform:'whatsapp'},start:a=>({acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'unknown',code:'timeout',retryCondition:'reconcile_or_manual_review'})})});
 f.set({messages:[{...f.message('reserved',true),ack:0}]});await f.poller().poll(v.id);assert.equal((await pool.query('SELECT state FROM ai_outbox WHERE id=$1',[action.id])).rows[0].state,'unknown');f.setTime(f.base+20000);f.set({messages:[f.message('reserved',true)]});await f.poller().poll(v.id);assert.equal((await pool.query('SELECT state FROM ai_outbox WHERE id=$1',[action.id])).rows[0].state,'confirmed');assert.equal((await pool.query('SELECT origin FROM ai_inbox')).rows[0].origin,'service');assert.equal((await pool.query('SELECT automation_mode FROM ai_conversations WHERE id=$1',[v.id])).rows[0].automation_mode,'auto');
});
test('WhatsApp native own message wins same-second customer batch and blocks AI',{skip},async()=>{
 const f=await fixture();f.set({messages:[f.message('a-own',true),f.message('z-customer')]});await f.poller().poll(f.conversation.id);const v=(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[f.conversation.id])).rows[0];assert.equal(v.automation_mode,'manual');assert.equal(v.business_status,'manager_working');
});
test('WhatsApp denied scope never reads; incomplete history and invalid sender never advance cursor',{skip},async()=>{
 const f=await fixture();assert.equal((await new WhatsAppPrivatePoller(pool,f.read,f.stop.signal,{...f.scope,authorIds:[]}).poll(f.conversation.id)).complete,false);assert.equal(f.calls(),0);
 f.set({exhausted:false,messages:[f.message('recent')]});await assert.rejects(f.poller().poll(f.conversation.id),/backfill_limit/);const cursor=(await pool.query('SELECT * FROM ai_whatsapp_private_cursors')).rows[0];assert.equal(cursor.last_error,'wa_history_backfill_limit');assert.equal(Number(cursor.through_time),f.base-1);
 f.set({exhausted:true,messages:[{...f.message('wrong'),from:'300@c.us'}]});await assert.rejects(f.poller().poll(f.conversation.id),/sender_unverified/);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_inbox')).rows[0].n,0);
});
test('WhatsApp stale phase batch cannot become input of a newly created request',{skip},async()=>{
 const f=await fixture();let release!:()=>void;const wait=new Promise<void>(r=>release=r);const poller=new WhatsAppPrivatePoller(pool,async()=>{await wait;return f.read();},f.stop.signal,f.scope,()=>f.base+5000);f.set({messages:[f.message('stale')]});const work=poller.poll(f.conversation.id);await new Promise(r=>setTimeout(r,30));
 await pool.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[f.conversation.id]);await bindSourceRequest(pool,{...f.source,messageId:'next'});release();await assert.rejects(work,/request_phase_changed/);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_inbox')).rows[0].n,0);
});

test('WhatsApp consumes closed-period opt-out and redacts private text before storage',{skip},async()=>{
 const f=await fixture();const {ConversationWorkflow}=await import('./conversation-workflow.js');await new ConversationWorkflow(pool).setStatus({conversationId:f.conversation.id,status:'closed',reason:'Synthetic completed request'});
 f.set({messages:[{...f.message('idle-stop'),body:'Не пишите мне'}]});assert.equal((await f.poller().poll(f.conversation.id)).complete,true);
 const row=(await pool.query("SELECT * FROM ai_inbox WHERE external_message_id='idle-stop'")).rows[0];assert.equal(row.request_phase_id,null);assert.equal(row.text,'[Сообщение вне активной заявки]');assert.ok((await pool.query('SELECT opted_out_at FROM ai_contacts WHERE id=$1',[f.conversation.contact_id])).rows[0].opted_out_at);
 await assert.rejects(bindSourceRequest(pool,{...f.source,messageId:'after-refusal'}),/contact_opted_out/);
});
test('WhatsApp phase switch catches unread gap refusal without adding it to new qualification',{skip},async()=>{
 const f=await fixture();f.set({messages:[]});await f.poller().poll(f.conversation.id);
 const {ConversationWorkflow}=await import('./conversation-workflow.js');await new ConversationWorkflow(pool).setStatus({conversationId:f.conversation.id,status:'closed',reason:'Synthetic completed request'});await bindSourceRequest(pool,{...f.source,messageId:'next-gap'});
 await pool.query('UPDATE ai_request_phases SET started_at=to_timestamp($2::double precision/1000) WHERE id=(SELECT active_phase_id FROM ai_conversations WHERE id=$1)',[f.conversation.id,f.base+10000]);f.setTime(f.base+15000);f.set({messages:[{...f.message('gap-stop'),timestamp:f.base/1000+7,body:'unsubscribe'}]});await f.poller().poll(f.conversation.id);
 const row=(await pool.query("SELECT * FROM ai_inbox WHERE external_message_id='gap-stop'")).rows[0];assert.equal(row.request_phase_id,null);assert.ok((await pool.query('SELECT opted_out_at FROM ai_contacts WHERE id=$1',[f.conversation.contact_id])).rows[0].opted_out_at);
});
