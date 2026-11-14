import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import pg from "pg";
import { applyAiManagerMigration } from "./ai-manager-migration.js";
import { AiManagerStore } from "./ai-manager.js";
import { AiEngineStore } from "./ai-engine.js";
import { bindSourceRequest } from "./request-lifecycle.js";
const url = process.env.AI_MANAGER_TEST_DATABASE_URL;
const skip = !url;
let pool: pg.Pool, store: AiManagerStore, schema: string;
before(async () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('/relayboard_ai_manager_test')) throw Error('Dedicated test database required');
  schema='requests_'+randomUUID().replaceAll('-','');
  const admin=new pg.Client({connectionString:url});await admin.connect();
  try {await admin.query('CREATE SCHEMA '+schema);} finally {await admin.end();}
  pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public'});
  await pool.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));
  await applyAiManagerMigration(pool);store=new AiManagerStore(pool);
});
beforeEach(async()=>{
  if (!pool)return;
  await pool.query('TRUNCATE ai_contacts,integrations CASCADE');
  await pool.query(`UPDATE ai_engine_settings SET settings=settings || $1::jsonb`,[JSON.stringify({qualificationEnabled:true,fields:[{key:'volume',question:'Объём?',required:true}],rules:[{field:'volume',op:'gte',value:10}]})]);
});
after(async()=>{if(pool){await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}});
async function fixture(){
 const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','synthetic','fake') RETURNING id")).rows[0].id;
 const contact=await store.createContact('synthetic');
 const v=await store.createConversation({contactId:contact.id,accountId:account,externalId:'private-author'});
 return {conversationId:v.id,accountId:account,platform:'max' as const,chatId:'source',messageId:'one',authorId:'author'};
}
test('twenty concurrent copies bind one source/request and one phase', {skip},async()=>{
 const f=await fixture();const rows=await Promise.all(Array.from({length:20},()=>bindSourceRequest(pool,f)));
 assert.equal(new Set(rows.map(r=>r.requestId)).size,1);assert.equal(rows.filter(r=>r.created).length,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_request_phases')).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_request_sources')).rows[0].n,1);
});
test('new source after close resets state, archives history, old source never reopens', {skip},async()=>{
 const f=await fixture(), old=await bindSourceRequest(pool,f);
 await pool.query(`UPDATE ai_engine_state SET fields='{"volume":12}',reply_count=4 WHERE conversation_id=$1`,[f.conversationId]);
 await pool.query("UPDATE ai_conversations SET business_status='closed',automation_mode='paused' WHERE id=$1",[f.conversationId]);
 assert.equal((await bindSourceRequest(pool,f)).requestId,old.requestId);
 assert.equal((await pool.query('SELECT business_status FROM ai_conversations WHERE id=$1',[f.conversationId])).rows[0].business_status,'closed');
 const next=await bindSourceRequest(pool,{...f,messageId:'two'});assert.notEqual(next.requestId,old.requestId);assert.equal(next.created,true);
 const state=(await pool.query('SELECT * FROM ai_engine_state WHERE conversation_id=$1',[f.conversationId])).rows[0];assert.deepEqual(state.fields,{});assert.equal(state.reply_count,0);
 const archived=(await pool.query('SELECT * FROM ai_request_phases WHERE request_id=$1',[old.requestId])).rows[0];assert.deepEqual(archived.fields_snapshot,{volume:12});assert.equal(archived.reply_count_snapshot,4);assert.ok(archived.closed_at);
 const replay=await bindSourceRequest(pool,f);assert.equal(replay.duplicate,true);assert.equal(replay.requestId,old.requestId);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_requests')).rows[0].n,2);
});
test('hold, opt-out and uncertain send prevent a new source without losing its retry', {skip},async()=>{
 const f=await fixture();await bindSourceRequest(pool,f);
 await pool.query('UPDATE ai_conversations SET manager_hold=true WHERE id=$1',[f.conversationId]);
 await assert.rejects(bindSourceRequest(pool,{...f,messageId:'hold'}),/manager_hold/);
 await pool.query("UPDATE ai_conversations SET manager_hold=false,business_status='closed' WHERE id=$1",[f.conversationId]);
 await pool.query('UPDATE ai_contacts SET opted_out_at=now()');
 await assert.rejects(bindSourceRequest(pool,{...f,messageId:'opt-out'}),/contact_opted_out/);
 await pool.query('UPDATE ai_contacts SET opted_out_at=NULL');
 const contact=(await pool.query('SELECT contact_id FROM ai_conversations WHERE id=$1',[f.conversationId])).rows[0].contact_id;
 await pool.query(`INSERT INTO ai_outbox(contact_id,conversation_id,logical_key,kind,text,fingerprint,automation_epoch,state) VALUES($1,$2,'uncertain','reply','test','fingerprint',0,'unknown')`,[contact,f.conversationId]);
 await assert.rejects(bindSourceRequest(pool,{...f,messageId:'uncertain'}),/uncertain_send/);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_request_sources')).rows[0].n,1);
});
test('source account or author substitution cannot bind a second identity', {skip},async()=>{
 const f=await fixture();await bindSourceRequest(pool,f);
 await assert.rejects(bindSourceRequest(pool,{...f,accountId:randomUUID()}),/source_account_mismatch/);
 await assert.rejects(bindSourceRequest(pool,{...f,authorId:'other'}),/source_identity_conflict/);
});

test('new phase model context excludes all old request messages', {skip},async()=>{
 const f=await fixture();await bindSourceRequest(pool,f);
 const event=(id:string,text:string)=>({version:1,platform:'max',accountId:f.accountId,conversationId:'private-author',messageId:id,occurredAt:'2026-11-13T10:00:00Z',direction:'inbound',origin:'customer',text});
 await store.ingest(event('old','OLD REQUEST VOLUME 999'));
 await pool.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[f.conversationId]);
 await bindSourceRequest(pool,{...f,messageId:'new-source'});
 const received=await store.ingest(event('new','NEW REQUEST ONLY'));
 let texts:string[]=[];
 await new AiEngineStore(pool).evaluate(f.conversationId,received.event.event_key,{kind:'fixture',async complete(input){texts=input.data.messages.map(m=>m.text);return {replyDraft:'',extracted:[],replyKind:'ask_fields',askFields:['volume'],knowledgeKeys:[],proposedStatus:'insufficient_data',handoffReason:null};}});
 assert.deepEqual(texts,['NEW REQUEST ONLY']);
});
test('verified second channel joins the open request; manager close archives both phases', {skip},async()=>{
 const f=await fixture(),first=await bindSourceRequest(pool,f);
 const old=(await pool.query('SELECT contact_id FROM ai_conversations WHERE id=$1',[f.conversationId])).rows[0];
 const account=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('whatsapp','synthetic','fake') RETURNING id")).rows[0].id;
 const v=await store.createConversation({contactId:old.contact_id,accountId:account,externalId:'other-channel'});
 const second=await bindSourceRequest(pool,{...f,conversationId:v.id,accountId:account,platform:'whatsapp',chatId:'other-source',allowAdditionalChannel:true});
 assert.equal(second.requestId,first.requestId);assert.equal(second.created,false);
 await pool.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[f.conversationId]);
 const phases=(await pool.query('SELECT closed_at FROM ai_request_phases WHERE request_id=$1',[first.requestId])).rows;
 assert.equal(phases.length,2);assert.ok(phases.every(p=>p.closed_at));
 assert.equal((await pool.query('SELECT business_status FROM ai_conversations WHERE id=$1',[v.id])).rows[0].business_status,'closed');
});

for(const legacyVersion of [12,14])test('upgrade from version '+legacyVersion+' preserves fields, sources and replay protection',{skip},async()=>{
 const {createHash}=await import('node:crypto');const legacySchema='upgrade_'+randomUUID().replaceAll('-','');await pool.query('CREATE SCHEMA '+legacySchema);
 const legacy=new pg.Pool({connectionString:url,options:'-c search_path='+legacySchema+',public'});
 try{
  await legacy.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));
  await legacy.query('CREATE TABLE ai_schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  const files=['ai-manager.sql','ai-manager-import.sql','ai-manager-outreach.sql','ai-manager-outreach-runs.sql','ai-manager-ai-engine.sql','ai-manager-workflows.sql','ai-manager-leads.sql','ai-manager-manual.sql','ai-manager-ingest-order.sql','ai-manager-search-sources.sql','ai-manager-qualification-notice.sql','ai-manager-manager-hold.sql','ai-manager-request-phases.sql','ai-manager-max-cursors.sql'];
  for(const [i,name] of files.slice(0,legacyVersion).entries()){
   const sql=await readFile(new URL('../../database/'+name,import.meta.url),'utf8');await legacy.query(sql);await legacy.query('INSERT INTO ai_schema_migrations(version,checksum) VALUES($1,$2)',[i+1,createHash('sha256').update(sql).digest('hex')]);
  }
  const oldStore=new AiManagerStore(legacy),contact=await oldStore.createContact('legacy');
  const account=(await legacy.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','legacy','fake') RETURNING id")).rows[0].id;
  const conversation=await oldStore.createConversation({contactId:contact.id,accountId:account,externalId:'legacy'});
  if(legacyVersion>=13){
   const request=randomUUID();await legacy.query('INSERT INTO ai_requests(id,contact_id) VALUES($1,$2)',[request,contact.id]);
   const phase=(await legacy.query('INSERT INTO ai_request_phases(request_id,conversation_id,settings_version) VALUES($1,$2,1) RETURNING id',[request,conversation.id])).rows[0].id;
   await legacy.query('UPDATE ai_conversations SET active_phase_id=$2 WHERE id=$1',[conversation.id,phase]);
   await legacy.query("INSERT INTO ai_request_sources(account_id,platform,external_chat_id,external_message_id,author_id,request_id,conversation_id) VALUES($1,'max','-456','source-one','202',$2,$3)",[account,request,conversation.id]);
  }
  await oldStore.ingest({version:1,platform:'max',accountId:account,conversationId:'legacy',messageId:'group-source:-456:source-one',occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:'synthetic'});
  await legacy.query(`UPDATE ai_engine_state SET fields='{"volume":25}',reply_count=3 WHERE conversation_id=$1`,[conversation.id]);await legacy.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[conversation.id]);
  assert.deepEqual(await applyAiManagerMigration(legacy),{version:21,applied:true});
  const phase=(await legacy.query('SELECT * FROM ai_request_phases WHERE conversation_id=$1',[conversation.id])).rows[0];assert.deepEqual(phase.fields_snapshot,{volume:25});assert.equal(phase.reply_count_snapshot,3);assert.ok(phase.closed_at);
  const replay=await bindSourceRequest(legacy,{conversationId:conversation.id,accountId:account,platform:'max',chatId:'-456',messageId:'source-one',authorId:'202'});assert.equal(replay.duplicate,true);assert.equal(replay.requestId,phase.request_id);
  const source=(await legacy.query('SELECT * FROM ai_request_sources')).rows[0];assert.equal(source.reader_account_id,account);assert.equal(source.recipient_id,'202');assert.equal(source.initial_contact,false);
  assert.equal((await legacy.query('SELECT count(*)::int n FROM ai_requests')).rows[0].n,1);assert.deepEqual(await applyAiManagerMigration(legacy),{version:21,applied:false});
 }finally{await legacy.end();await pool.query('DROP SCHEMA '+legacySchema+' CASCADE');}
});

test('pre-ledger group-source inbox identity remains deduplicated after upgrade and close', {skip},async()=>{
 const f=await fixture(),first=await bindSourceRequest(pool,f);
 await store.ingest({version:1,platform:'max',accountId:f.accountId,conversationId:'private-author',messageId:'group-source:'+f.chatId+':'+f.messageId,occurredAt:'2026-11-13T10:00:00Z',direction:'inbound',origin:'customer',text:'old source'});
 await pool.query('DELETE FROM ai_request_sources');
 await pool.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[f.conversationId]);
 const replay=await bindSourceRequest(pool,f);assert.equal(replay.requestId,first.requestId);assert.equal(replay.duplicate,true);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_requests')).rows[0].n,1);
});

test('twenty distinct simultaneous sources for the same author share one open request', {skip},async()=>{
 const f=await fixture();
 const rows=await Promise.all(Array.from({length:20},(_,i)=>bindSourceRequest(pool,{...f,messageId:'source-'+i})));
 assert.equal(new Set(rows.map(r=>r.requestId)).size,1);assert.equal(rows.filter(r=>r.created).length,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_request_sources')).rows[0].n,20);
});

test('socket owner verifies the private author and sends a durable action only once', {skip},async()=>{
 const {MaxConnections}=await import('./max-connections.js'),{dispatchOwnedMax}=await import('./owned-max-dispatch.js'),{encryptCredentials}=await import('./crypto.js');
 const f=await fixture();f.authorId='202';await pool.query("UPDATE ai_conversations SET external_id='303' WHERE id=$1",[f.conversationId]);
 await pool.query('UPDATE integrations SET credential_ciphertext=$2 WHERE id=$1',[f.accountId,encryptCredentials({token:'synthetic'})]);await bindSourceRequest(pool,f);
 const epoch=(await pool.query('SELECT automation_epoch FROM ai_conversations WHERE id=$1',[f.conversationId])).rows[0].automation_epoch;
 const action=(await store.enqueue({conversationId:f.conversationId,expectedEpoch:epoch,kind:'reply',logicalKey:'owned',text:'configured test'})).action;
 let sends=0,wrong=false;const stop=new AbortController();
 const connections=new MaxConnections(pool,stop.signal,async()=>({selfId:101,groups:[],close(){},socket:{connected:true,async send(op){if(op===48)return{chats:[{id:303,type:'DIALOG',participants:wrong?{'101':{},'999':{}}:{'101':{},'202':{}}}]};assert.equal(op,64);sends++;return{message:{id:'server-receipt'}};}}}));
 try{
  wrong=true;await assert.rejects(dispatchOwnedMax(pool,connections,action.id,stop.signal),/target_unverified/);assert.equal(sends,0);
  wrong=false;assert.equal((await dispatchOwnedMax(pool,connections,action.id,stop.signal)).state,'confirmed');
  await dispatchOwnedMax(pool,connections,action.id,stop.signal);assert.equal(sends,1);
 }finally{stop.abort();}
});

async function publicationFixture(send:(op:number,body:Record<string,unknown>)=>Promise<unknown>){
 const {MaxConnections}=await import('./max-connections.js'),{encryptCredentials}=await import('./crypto.js');
 const f=await fixture();await pool.query('UPDATE integrations SET credential_ciphertext=$2 WHERE id=$1',[f.accountId,encryptCredentials({token:'synthetic'})]);
 const destination=(await pool.query("INSERT INTO destinations(integration_id,external_id,title) VALUES($1,'-456','synthetic group') RETURNING id",[f.accountId])).rows[0].id;
 const post=(await pool.query("INSERT INTO posts(text,mode,status) VALUES('stored publication','now','active') RETURNING id")).rows[0].id;
 const delivery=(await pool.query("INSERT INTO deliveries(post_id,destination_id,occurrence_key,status) VALUES($1,$2,'synthetic','sending') RETURNING id",[post,destination])).rows[0].id;
 const stop=new AbortController(),connections=new MaxConnections(pool,stop.signal,async()=>({selfId:101,groups:[],close(){},socket:{connected:true,send}}));
 return {stop,connections,delivery,post};
}
test('twenty publication RPC retries initiate one MAX message and preserve its receipt',{skip},async()=>{
 const {dispatchOwnedMaxPublication}=await import('./owned-max-publication.js');let sends=0;
 const f=await publicationFixture(async(op,body)=>{assert.equal(op,64);assert.equal(body.chatId,-456);assert.equal((body.message as {text:string}).text,'stored publication');sends++;return{message:{id:'publication-receipt'}};});
 try{
  const results=await Promise.allSettled(Array.from({length:20},()=>dispatchOwnedMaxPublication(pool,f.connections,f.delivery,f.stop.signal,60000)));
  assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(sends,1);
  assert.deepEqual(await dispatchOwnedMaxPublication(pool,f.connections,f.delivery,f.stop.signal,60000),{externalMessageId:'publication-receipt'});assert.equal(sends,1);
 }finally{f.stop.abort();}
});
test('lost MAX publication receipt blocks retry; stopped publication never writes to the socket',{skip},async()=>{
 const {dispatchOwnedMaxPublication}=await import('./owned-max-publication.js');let sends=0;
 const f=await publicationFixture(async()=>{sends++;throw Error('unclassified connection loss');});
 try{
  await assert.rejects(dispatchOwnedMaxPublication(pool,f.connections,f.delivery,f.stop.signal,60000),/не подтверждена/);
  assert.equal((await pool.query('SELECT status FROM max_send_receipts WHERE delivery_id=$1',[f.delivery])).rows[0].status,'unknown');
  await assert.rejects(dispatchOwnedMaxPublication(pool,f.connections,f.delivery,f.stop.signal,60000),/требует проверки/);assert.equal(sends,1);
  await pool.query('DELETE FROM max_send_receipts WHERE delivery_id=$1',[f.delivery]);
  await pool.query("UPDATE posts SET status='stopped' WHERE id=$1",[f.post]);
  await assert.rejects(dispatchOwnedMaxPublication(pool,f.connections,f.delivery,f.stop.signal,60000),/остановлена/);assert.equal(sends,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM max_send_receipts WHERE delivery_id=$1',[f.delivery])).rows[0].n,0);
 }finally{f.stop.abort();}
});

test('explicit criteria restart archives the old phase; its pending notification cannot fire in the new phase',{skip},async()=>{
 const {beginConfiguredQualification}=await import('./begin-qualification.js'),{ConversationWorkflow}=await import('./conversation-workflow.js');
 const f=await fixture(),first=await bindSourceRequest(pool,f),workflow=new ConversationWorkflow(pool);
 const oldPhase=(await pool.query('SELECT active_phase_id FROM ai_conversations WHERE id=$1',[f.conversationId])).rows[0].active_phase_id;
 await pool.query(`UPDATE ai_engine_state SET fields='{"volume":12}',reply_count=2 WHERE conversation_id=$1`,[f.conversationId]);
 await workflow.saveManagerTarget({accountId:f.accountId,externalId:'-456'});
 const notice=await workflow.handoff({conversationId:f.conversationId,key:'old-phase',reason:'human_requested',summary:'synthetic'});
 const engine=new AiEngineStore(pool),settings=await engine.settings();await engine.saveSettings({expectedVersion:settings.version,settings:{...settings.settings,replyLimit:7}});
 await beginConfiguredQualification(pool,f.conversationId);
 const active=(await pool.query('SELECT active_phase_id FROM ai_conversations WHERE id=$1',[f.conversationId])).rows[0].active_phase_id;assert.notEqual(active,oldPhase);
 const old=(await pool.query('SELECT * FROM ai_request_phases WHERE id=$1',[oldPhase])).rows[0];assert.ok(old.closed_at);assert.deepEqual(old.fields_snapshot,{volume:12});assert.equal(old.reply_count_snapshot,2);
 const state=(await pool.query('SELECT * FROM ai_engine_state WHERE conversation_id=$1',[f.conversationId])).rows[0];assert.deepEqual(state.fields,{});assert.equal(state.reply_count,0);assert.equal(state.settings_version,settings.version+1);
 let sends=0;await workflow.dispatchNotification(notice.id,{target:{accountId:f.accountId,externalId:'-456'},start:()=>{sends++;throw Error('must never send');}});assert.equal(sends,0);assert.equal((await pool.query('SELECT state FROM ai_handoff_notifications WHERE id=$1',[notice.id])).rows[0].state,'rejected');
 assert.equal((await bindSourceRequest(pool,{...f,messageId:'same-request-new-source'})).requestId,first.requestId);
});

async function identityAccount(platform='max'){return (await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES($1,'synthetic','fake') RETURNING id",[platform])).rows[0].id as string;}
test('remote identity deduplicates across accounts while equal names remain different contacts',{skip},async()=>{
 const {bindRemoteIdentity}=await import('./remote-identities.js');const account=await identityAccount(),other=await identityAccount();
 const input={platform:'max' as const,remoteUserId:'202',accountId:account,verificationKind:'source_author' as const,displayName:'Same Name'};
 const results=await Promise.all(Array.from({length:20},()=>bindRemoteIdentity(pool,input)));assert.equal(new Set(results.map(r=>r.contactId)).size,1);assert.equal(results.filter(r=>r.created).length,1);
 assert.equal((await bindRemoteIdentity(pool,{...input,accountId:other})).contactId,results[0].contactId);
 assert.notEqual((await bindRemoteIdentity(pool,{...input,remoteUserId:'203'})).contactId,results[0].contactId);
 assert.equal((await pool.query('SELECT count(*)::int n FROM ai_contacts')).rows[0].n,2);
});
test('verified phone links MAX and WhatsApp to an imported excluded contact without overwriting its data',{skip},async()=>{
 const {bindRemoteIdentity}=await import('./remote-identities.js'),max=await identityAccount(),wa=await identityAccount('whatsapp');
 const old=(await pool.query("INSERT INTO ai_contacts(display_name,phone_e164,comment,opted_out_at) VALUES('Imported','+79991234567','keep',now()) RETURNING id")).rows[0].id;
 const first=await bindRemoteIdentity(pool,{platform:'max',remoteUserId:'202',accountId:max,verifiedPhone:'+79991234567',verificationKind:'max_contact',displayName:'Remote Name'});
 const second=await bindRemoteIdentity(pool,{platform:'whatsapp',remoteUserId:'79991234567@c.us',accountId:wa,verifiedPhone:'+79991234567',verificationKind:'whatsapp_contact'});
 assert.equal(first.contactId,old);assert.equal(second.contactId,old);assert.equal(first.optedOut,true);
 const before=(await pool.query("SELECT phone_verified_at FROM ai_remote_identities WHERE platform='max'")).rows[0].phone_verified_at;
 await bindRemoteIdentity(pool,{platform:'max',remoteUserId:'202',accountId:max,verificationKind:'source_author'});
 const contact=(await pool.query('SELECT * FROM ai_contacts WHERE id=$1',[old])).rows[0];assert.equal(contact.display_name,'Imported');assert.equal(contact.comment,'keep');assert.ok(contact.opted_out_at);
 assert.deepEqual((await pool.query("SELECT phone_verified_at FROM ai_remote_identities WHERE platform='max'")).rows[0].phone_verified_at,before);
 await assert.rejects(bindRemoteIdentity(pool,{platform:'max',remoteUserId:'203',accountId:max,verifiedPhone:'+79991234567',verificationKind:'max_contact'}),/identity_conflict/);
 await assert.rejects(bindRemoteIdentity(pool,{platform:'max',remoteUserId:'202',accountId:max,verifiedPhone:'+79991234568',verificationKind:'max_contact'}),/phone_changed/);
});
test('new public source on another channel attaches to the open request without starting another approach',{skip},async()=>{
 const f=await fixture(),first=await bindSourceRequest(pool,f),contact=(await pool.query('SELECT contact_id FROM ai_conversations WHERE id=$1',[f.conversationId])).rows[0].contact_id;
 const account=await identityAccount('whatsapp'),other=await store.createConversation({contactId:contact,accountId:account,externalId:'wa'});
 const result=await bindSourceRequest(pool,{...f,accountId:account,platform:'whatsapp',conversationId:other.id,messageId:'other-source'});
 assert.equal(result.requestId,first.requestId);assert.equal(result.activated,false);assert.equal(result.initialContact,false);
 const v=(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[other.id])).rows[0];assert.equal(v.active_phase_id,null);assert.equal(v.automation_mode,'paused');
});
test('a delayed source posted before manager close is never turned into a new request',{skip},async()=>{
 const f=await fixture(),first=await bindSourceRequest(pool,f),posted=new Date(Date.now()-1000).toISOString();
 await pool.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[f.conversationId]);
 const delayed=await bindSourceRequest(pool,{...f,messageId:'delayed',occurredAt:posted});assert.equal(delayed.requestId,first.requestId);assert.equal(delayed.created,false);assert.equal(delayed.initialContact,false);
 assert.equal((await pool.query('SELECT count(*)::int n FROM ai_requests')).rows[0].n,1);
});
test('source reader and selected sender are distinct; the same source cannot move to a second sender',{skip},async()=>{
 const f=await fixture(),reader=await identityAccount();
 const first=await bindSourceRequest(pool,{...f,sourceAccountId:reader});assert.equal(first.initialContact,true);
 const row=(await pool.query('SELECT * FROM ai_request_sources')).rows[0];assert.equal(row.reader_account_id,reader);assert.equal(row.account_id,f.accountId);assert.equal(row.recipient_id,f.authorId);
 const replay=await bindSourceRequest(pool,{...f,sourceAccountId:reader});assert.equal(replay.initialContact,true);assert.equal(replay.duplicate,true);
 const contact=(await pool.query('SELECT contact_id FROM ai_conversations WHERE id=$1',[f.conversationId])).rows[0].contact_id,other=await identityAccount();
 const v=await store.createConversation({contactId:contact,accountId:other,externalId:'other-private'});
 await assert.rejects(bindSourceRequest(pool,{...f,accountId:other,conversationId:v.id,sourceAccountId:reader}),/source_identity_conflict/);
});

test('imported contact resolves to a verified private route; no send occurs before the explicit outreach run',{skip},async()=>{
 const {encryptCredentials}=await import('./crypto.js'),{MaxConnections}=await import('./max-connections.js'),{resolveMaxContactRoute}=await import('./max-contact-route.js'),{OutreachService}=await import('./outreach.js'),{OutreachRunner}=await import('./outreach-runner.js'),{MaxPrivatePoller}=await import('./max-private-poller.js'),{dispatchOwnedMax}=await import('./owned-max-dispatch.js');
 const account=await identityAccount();await pool.query('UPDATE integrations SET credential_ciphertext=$2 WHERE id=$1',[account,encryptCredentials({token:'synthetic'})]);
 const contact=(await pool.query("INSERT INTO ai_contacts(display_name,phone_e164) VALUES('Imported','+79991234567') RETURNING id")).rows[0].id;
 let sends=0;const stop=new AbortController(),scope={testOnly:true,accountIds:[account],authorIds:['202']};
 const connections=new MaxConnections(pool,stop.signal,async()=>({selfId:101,groups:[],openDialog:async()=> '303',close(){},socket:{connected:true,async send(op,body){
  if(op===37)return{result:[{id:202,phone:79991234567}]};
  if(op===48)return{chats:[{id:303,type:'DIALOG',participants:{'101':{},'202':{}}}]};
  if(op===49)return{messages:[]};assert.equal(op,64);assert.equal(body.chatId,303);assert.equal((body.message as {text:string}).text,'Configured import greeting');sends++;return{message:{id:'import-confirmed'}};
 }}}));
 try{
  const route=await resolveMaxContactRoute(pool,connections,scope,{contactId:contact,accountId:account});assert.equal(route.recipientId,'202');assert.equal(sends,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,0);assert.equal((await pool.query('SELECT automation_mode FROM ai_conversations WHERE id=$1',[route.conversationId])).rows[0].automation_mode,'paused');
  await store.setMode(route.conversationId,'auto');const service=new OutreachService(pool),current=await service.settings();
  const settings=await service.save({...current,template:'Configured import greeting',platforms:['max'],accountIds:[account],intervalSeconds:1});const request=await service.createRequest({id:randomUUID(),contactId:contact});
  const runner=new OutreachRunner(pool),run=await runner.create({id:randomUUID(),revision:settings.revision,requestIds:[request.id]}),action=await runner.prepare(run.id,request.id);assert.ok(action);
  assert.equal((await new MaxPrivatePoller(pool,connections,stop.signal,scope).poll(route.conversationId)).complete,true);
  assert.equal((await dispatchOwnedMax(pool,connections,action!,stop.signal)).state,'confirmed');await dispatchOwnedMax(pool,connections,action!,stop.signal);assert.equal(sends,1);
 }finally{stop.abort();}
});

test('live source routing reads the selected group but opens the author private dialog from the selected sender only',{skip},async()=>{
 const {encryptCredentials}=await import('./crypto.js'),{MaxConnections}=await import('./max-connections.js'),{LeadIntakeStore}=await import('./lead-intake.js'),{OutreachService}=await import('./outreach.js'),{resolveMaxSourceRoute}=await import('./max-source-route.js');
 const reader=await identityAccount(),sender=await identityAccount();await pool.query('UPDATE integrations SET credential_ciphertext=$2 WHERE id=$1',[reader,encryptCredentials({token:'reader'})]);await pool.query('UPDATE integrations SET credential_ciphertext=$2 WHERE id=$1',[sender,encryptCredentials({token:'sender'})]);
 await pool.query("INSERT INTO ai_search_sources(account_id,chat_id,platform) VALUES($1,'-456','max')",[reader]);
 const service=new OutreachService(pool),settings=await service.settings();await service.save({...settings,template:'configured',platforms:['max'],accountIds:[sender]});
 const time=Date.now();let text='Нужен щебень',privateOpens=0,writes=0;const stop=new AbortController();
 const connections=new MaxConnections(pool,stop.signal,async token=>({selfId:token==='reader'?101:111,groups:[],close(){},async openDialog(id){assert.equal(token,'sender');assert.equal(id,202);privateOpens++;return'303';},socket:{connected:true,async send(op,body){
  if(op===64){writes++;throw Error('lookup cannot send');}
  if(op===32)return{contacts:[{id:202,names:[{firstName:'Test Author'}],phone:0}]};
  if(op===49){assert.equal(token,'reader');assert.equal(body.chatId,-456);return{messages:[{id:'source-message',time,sender:202,text,type:'USER'}]};}
  assert.equal(op,48);return token==='reader'?{chats:[{id:-456,type:'CHAT'}]}:{chats:[{id:303,type:'DIALOG',participants:{'111':{},'202':{}}}]};
 }}}));
 try{
  const intake=new LeadIntakeStore(pool),lead=await intake.ingest({platform:'max',accountId:reader,chatId:'-456',authorId:'202',messageId:'source-message',occurredAt:new Date(time).toISOString(),text,sourceKind:'manual',params:[],confidence:0.99});
  const id=lead.lead.id,scope={testOnly:true,accountIds:[reader,sender],authorIds:['202']};
  const route=await resolveMaxSourceRoute(pool,connections,scope,{leadId:id});assert.equal(route.accountId,sender);assert.equal(route.sourceAccountId,reader);assert.equal(route.recipientId,'202');assert.equal(route.dialogId,'303');assert.equal(writes,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_requests')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,0);
  assert.equal((await resolveMaxSourceRoute(pool,connections,scope,{leadId:id})).conversationId,route.conversationId);
  text='Source was edited';await assert.rejects(resolveMaxSourceRoute(pool,connections,scope,{leadId:id}),/source_changed/);assert.equal(privateOpens,2);assert.equal(writes,0);
 }finally{stop.abort();}
});

test('cross-messenger source preserves its author separately from the verified private recipient',{skip},async()=>{
 const {runtimeAllowsConversation}=await import('./runtime-scope.js');const f=await fixture(),sender=await identityAccount('whatsapp');
 const contact=(await pool.query('SELECT contact_id FROM ai_conversations WHERE id=$1',[f.conversationId])).rows[0].contact_id;
 const v=await store.createConversation({contactId:contact,accountId:sender,externalId:'79991234567@c.us'});
 const data={...f,accountId:sender,platform:'whatsapp' as const,conversationId:v.id,sourceAccountId:f.accountId,sourcePlatform:'max' as const};
 await assert.rejects(bindSourceRequest(pool,data),/cross_channel_recipient_required/);
 const result=await bindSourceRequest(pool,{...data,recipientId:'79991234567@c.us'});assert.equal(result.initialContact,true);
 const row=(await pool.query('SELECT * FROM ai_request_sources')).rows[0];assert.equal(row.platform,'max');assert.equal(row.author_id,f.authorId);assert.equal(row.recipient_id,'79991234567@c.us');assert.equal(row.account_id,sender);assert.equal(row.reader_account_id,f.accountId);
 const scope={testOnly:true,accountIds:[f.accountId,sender],authorIds:[f.authorId]};assert.equal(await runtimeAllowsConversation(pool,scope,v.id),false);
 assert.equal(await runtimeAllowsConversation(pool,{...scope,authorIds:[f.authorId,'79991234567@c.us']},v.id),true);
});


test('greeting is once per request across criteria phases; a later separate request greets again',{skip},async()=>{
 const {requestHasOutgoing}=await import('./request-greeting.js'),{beginConfiguredQualification}=await import('./begin-qualification.js');
 const f=await fixture();await bindSourceRequest(pool,f);assert.equal(await requestHasOutgoing(pool,f.conversationId),false);
 const store=new AiManagerStore(pool),v=(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[f.conversationId])).rows[0];
 const action=(await store.enqueue({conversationId:v.id,expectedEpoch:v.automation_epoch,kind:'reply',logicalKey:'greeting',text:'Synthetic greeting'})).action;
 await store.dispatch(action.id,{target:{accountId:f.accountId,externalConversationId:v.external_id,platform:'max'},start:a=>({acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'confirmed',externalMessageId:'synthetic-greeting',code:'synthetic',retryCondition:'never'})})});
 assert.equal(await requestHasOutgoing(pool,v.id),true);
 await beginConfiguredQualification(pool,v.id);assert.equal(await requestHasOutgoing(pool,v.id),true);
 await pool.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[v.id]);await bindSourceRequest(pool,{...f,messageId:'new-request'});assert.equal(await requestHasOutgoing(pool,v.id),false);
});
