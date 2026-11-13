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
 const second=await bindSourceRequest(pool,{...f,conversationId:v.id,accountId:account,platform:'whatsapp',chatId:'other-source'});
 assert.equal(second.requestId,first.requestId);assert.equal(second.created,false);
 await pool.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[f.conversationId]);
 const phases=(await pool.query('SELECT closed_at FROM ai_request_phases WHERE request_id=$1',[first.requestId])).rows;
 assert.equal(phases.length,2);assert.ok(phases.every(p=>p.closed_at));
 assert.equal((await pool.query('SELECT business_status FROM ai_conversations WHERE id=$1',[v.id])).rows[0].business_status,'closed');
});

test('upgrade from version 12 preserves legacy fields and receipts in an archived phase', {skip},async()=>{
 const {createHash}=await import('node:crypto');
 const legacySchema='upgrade_'+randomUUID().replaceAll('-','');
 await pool.query('CREATE SCHEMA '+legacySchema);
 const legacy=new pg.Pool({connectionString:url,options:'-c search_path='+legacySchema+',public'});
 try {
  await legacy.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));
  await legacy.query('CREATE TABLE ai_schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const [i,name] of ['ai-manager.sql','ai-manager-import.sql','ai-manager-outreach.sql','ai-manager-outreach-runs.sql','ai-manager-ai-engine.sql','ai-manager-workflows.sql','ai-manager-leads.sql','ai-manager-manual.sql','ai-manager-ingest-order.sql','ai-manager-search-sources.sql','ai-manager-qualification-notice.sql','ai-manager-manager-hold.sql'].entries()){
   const sql=await readFile(new URL('../../database/'+name,import.meta.url),'utf8');await legacy.query(sql);
   await legacy.query('INSERT INTO ai_schema_migrations(version,checksum) VALUES($1,$2)',[i+1,createHash('sha256').update(sql).digest('hex')]);
  }
  const oldStore=new AiManagerStore(legacy),contact=await oldStore.createContact('legacy');
  const account=(await legacy.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('max','legacy','fake') RETURNING id")).rows[0].id;
  const conversation=await oldStore.createConversation({contactId:contact.id,accountId:account,externalId:'legacy'});
  await legacy.query(`UPDATE ai_engine_state SET fields='{"volume":25}',reply_count=3 WHERE conversation_id=$1`,[conversation.id]);
  await legacy.query("UPDATE ai_conversations SET business_status='closed' WHERE id=$1",[conversation.id]);
  assert.deepEqual(await applyAiManagerMigration(legacy),{version:13,applied:true});
  const phase=(await legacy.query('SELECT * FROM ai_request_phases WHERE conversation_id=$1',[conversation.id])).rows[0];
  assert.deepEqual(phase.fields_snapshot,{volume:25});assert.equal(phase.reply_count_snapshot,3);assert.ok(phase.closed_at);
  assert.equal((await legacy.query('SELECT lifecycle FROM ai_requests WHERE id=$1',[phase.request_id])).rows[0].lifecycle,'closed');
  assert.deepEqual(await applyAiManagerMigration(legacy),{version:13,applied:false});
 } finally {await legacy.end();await pool.query('DROP SCHEMA '+legacySchema+' CASCADE');}
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
