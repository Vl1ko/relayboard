import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,beforeEach,after,test} from 'node:test';
import pg from 'pg';
import {applyAiManagerMigration} from './ai-manager-migration.js';
import {AiManagerStore} from './ai-manager.js';
import {bindSourceRequest} from './request-lifecycle.js';
import {MaxConnections} from './max-connections.js';
import {MaxPrivatePoller} from './max-private-poller.js';
import {encryptCredentials} from './crypto.js';
const url=process.env.AI_MANAGER_TEST_DATABASE_URL,skip=!url;let pool:pg.Pool,schema:string;
before(async()=>{if(!url)return;if(!new URL(url).pathname.endsWith('/relayboard_ai_manager_test'))throw Error('Dedicated test database required');schema='max_cursor_'+randomUUID().replaceAll('-','');const admin=new pg.Client({connectionString:url});await admin.connect();try{await admin.query('CREATE SCHEMA '+schema);}finally{await admin.end();}pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public'});await pool.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(pool);});
beforeEach(async()=>{if(!pool)return;await pool.query('TRUNCATE ai_contacts,integrations CASCADE');await pool.query(`UPDATE ai_engine_settings SET settings=settings||$1::jsonb`,[JSON.stringify({qualificationEnabled:true,fields:[{key:'volume',question:'Объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);});
after(async()=>{if(pool){await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}});
async function fixture(){
 const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','synthetic',$1) RETURNING id",[encryptCredentials({token:'synthetic'})])).rows[0].id;
 const store=new AiManagerStore(pool),contact=await store.createContact('synthetic'),conversation=await store.createConversation({contactId:contact.id,accountId:account,externalId:'303'});
 const source={conversationId:conversation.id,accountId:account,platform:'max' as const,chatId:'-456',messageId:'source',authorId:'202'};
 await bindSourceRequest(pool,source);const phase=(await pool.query('SELECT active_phase_id FROM ai_conversations WHERE id=$1',[conversation.id])).rows[0].active_phase_id;
 const base=Date.now();await pool.query('UPDATE ai_request_phases SET started_at=to_timestamp($2::double precision/1000) WHERE id=$1',[phase,base]);
 let time=base+1000,items:any[]=[],historyCalls=0,opens=0;const stop=new AbortController();
 const connections=new MaxConnections(pool,stop.signal,async()=>{opens++;return{selfId:101,groups:[],close(){},socket:{connected:true,async send(op,body){if(op===48)return{chats:[{id:303,type:'DIALOG',participants:{'101':{},'202':{}}}]};assert.equal(op,49);historyCalls++;return{messages:items.filter(m=>m.time<=Number(body.from)).sort((a,b)=>b.time-a.time||String(b.id).localeCompare(String(a.id))).slice(0,100)};}}};});
 const scope={testOnly:true,accountIds:[account],authorIds:['202']};
 const poller=()=>new MaxPrivatePoller(pool,connections,stop.signal,scope,()=>time);
 return{account,store,conversation,phase,base,stop,connections,scope,poller,set:(v:any[])=>items=v,setTime:(v:number)=>time=v,calls:()=>historyCalls,opens:()=>opens,source};
}
const message=(id:string,time:number,sender=202)=>({id,time,sender,text:'synthetic '+id,type:'USER'});
test('paged catch-up persists 250 messages; restart resumes the cursor without replay',{skip},async()=>{
 const f=await fixture();try{
  const items=Array.from({length:250},(_,i)=>message(String(i+1),f.base+i+1));f.set(items);
  const poller=f.poller();assert.equal((await poller.poll(f.conversation.id)).complete,true);assert.ok(f.calls()>=3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_inbox')).rows[0].n,250);
  const epoch=(await pool.query('SELECT automation_epoch FROM ai_conversations WHERE id=$1',[f.conversation.id])).rows[0].automation_epoch;
  f.setTime(f.base+2000);f.set([...items,message('new',f.base+1500)]);
  assert.equal((await f.poller().poll(f.conversation.id)).complete,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_inbox')).rows[0].n,251);
  assert.equal(BigInt((await pool.query('SELECT automation_epoch FROM ai_conversations WHERE id=$1',[f.conversation.id])).rows[0].automation_epoch),BigInt(epoch)+1n);
  await f.poller().poll(f.conversation.id);assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_inbox')).rows[0].n,251);
 }finally{f.stop.abort();}
});
test('native manager message takes over; a pending own receipt waits and confirmed echo stays service',{skip},async()=>{
 const f=await fixture();try{
  const epoch=(await pool.query('SELECT automation_epoch FROM ai_conversations WHERE id=$1',[f.conversation.id])).rows[0].automation_epoch;
  const action=(await f.store.enqueue({conversationId:f.conversation.id,expectedEpoch:epoch,kind:'reply',logicalKey:'test',text:'configured'})).action;
  await pool.query("UPDATE ai_outbox SET state='dispatching',attempt_token=$2 WHERE id=$1",[action.id,randomUUID()]);
  f.set([message('service',f.base+1,101)]);
  assert.equal((await f.poller().poll(f.conversation.id)).reason,'receipt_pending');assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_inbox')).rows[0].n,0);
  await pool.query("UPDATE ai_outbox SET state='confirmed',external_message_id='service' WHERE id=$1",[action.id]);
  await f.poller().poll(f.conversation.id);assert.equal((await pool.query('SELECT origin FROM ai_inbox')).rows[0].origin,'service');
  f.setTime(f.base+2000);f.set([message('native',f.base+1500,101)]);await f.poller().poll(f.conversation.id);
  const v=(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[f.conversation.id])).rows[0];assert.equal(v.automation_mode,'manual');assert.equal(v.business_status,'manager_working');
 }finally{f.stop.abort();}
});
test('unverified author scope never connects; full timestamp gap never advances or drops events',{skip},async()=>{
 const f=await fixture();try{
  const denied=new MaxPrivatePoller(pool,f.connections,f.stop.signal,{...f.scope,authorIds:[]});assert.equal((await denied.poll(f.conversation.id)).complete,false);assert.equal(f.opens(),0);
  f.set(Array.from({length:100},(_,i)=>message(String(i),f.base+1)));
  await assert.rejects(f.poller().poll(f.conversation.id),/page_stalled/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_inbox')).rows[0].n,0);
  const cursor=(await pool.query('SELECT * FROM ai_max_private_cursors')).rows[0];assert.equal(cursor.last_error,'max_history_page_stalled');assert.equal(Number(cursor.through_time),f.base-1);
 }finally{f.stop.abort();}
});
test('phase change rejects a stale inbound batch instead of assigning it to the new request',{skip},async()=>{
 const f=await fixture();try{
  await pool.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[f.conversation.id]);await bindSourceRequest(pool,{...f.source,messageId:'next-source'});
  await assert.rejects(f.store.ingest({version:1,platform:'max',accountId:f.account,conversationId:'303',messageId:'stale',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'old batch'},f.phase),error=>error instanceof Error&&error.message==='request_phase_changed');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_inbox')).rows[0].n,0);
 }finally{f.stop.abort();}
});

test('MAX consumes closed-period opt-out without storing its text or reopening a request',{skip},async()=>{
 const f=await fixture();try{
  const {ConversationWorkflow}=await import('./conversation-workflow.js');await new ConversationWorkflow(pool).setStatus({conversationId:f.conversation.id,status:'closed',reason:'Synthetic completed request'});
  f.set([{...message('idle-stop',f.base+500),text:'Не пишите мне, пожалуйста.'}]);assert.equal((await f.poller().poll(f.conversation.id)).complete,true);
  const row=(await pool.query("SELECT * FROM ai_inbox WHERE external_message_id='idle-stop'")).rows[0];assert.equal(row.request_phase_id,null);assert.equal(row.text,'[Сообщение вне активной заявки]');
  assert.ok((await pool.query('SELECT opted_out_at FROM ai_contacts WHERE id=$1',[f.conversation.contact_id])).rows[0].opted_out_at);
  await assert.rejects(bindSourceRequest(pool,{...f.source,messageId:'after-refusal'}),/contact_opted_out/);
 }finally{f.stop.abort();}
});
test('MAX phase switch catches an unread refusal from the gap before the replacement request',{skip},async()=>{
 const f=await fixture();try{
  f.set([]);await f.poller().poll(f.conversation.id);const gap=f.base+1500;
  const {ConversationWorkflow}=await import('./conversation-workflow.js');await new ConversationWorkflow(pool).setStatus({conversationId:f.conversation.id,status:'closed',reason:'Synthetic completed request'});
  await bindSourceRequest(pool,{...f.source,messageId:'next-gap'});await pool.query('UPDATE ai_request_phases SET started_at=to_timestamp($2::double precision/1000) WHERE id=(SELECT active_phase_id FROM ai_conversations WHERE id=$1)',[f.conversation.id,f.base+2000]);
  f.setTime(f.base+3000);f.set([{...message('gap-stop',gap),text:'стоп'}]);await f.poller().poll(f.conversation.id);
  const row=(await pool.query("SELECT * FROM ai_inbox WHERE external_message_id='gap-stop'")).rows[0];assert.equal(row.request_phase_id,null);assert.ok((await pool.query('SELECT opted_out_at FROM ai_contacts WHERE id=$1',[f.conversation.contact_id])).rows[0].opted_out_at);
 }finally{f.stop.abort();}
});
