import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {applyAiManagerMigration} from './ai-manager-migration.js';
import {AiManagerStore} from './ai-manager.js';
import {WhatsAppAiReceipts} from './whatsapp-ai-receipts.js';
const url=process.env.AI_MANAGER_TEST_DATABASE_URL,skip=!url;let pool:pg.Pool,schema:string,store:AiManagerStore,receipts:WhatsAppAiReceipts;
before(async()=>{if(!url)return;if(new URL(url).pathname!='/relayboard_ai_manager_test')throw Error('Dedicated AI test DB required');schema='wa_receipts_'+randomUUID().replaceAll('-','');const admin=new pg.Client({connectionString:url});await admin.connect();await admin.query('CREATE SCHEMA '+schema);await admin.end();pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public'});await pool.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));await applyAiManagerMigration(pool);store=new AiManagerStore(pool);receipts=new WhatsAppAiReceipts(pool);});
beforeEach(async()=>{if(pool)await pool.query('TRUNCATE ai_contacts,integrations CASCADE');});
after(async()=>{if(pool){await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();}});
async function fixture(){const accountId=(await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('whatsapp','synthetic','fake') RETURNING id")).rows[0].id;const contact=await store.createContact('Synthetic');let v=await store.createConversation({contactId:contact.id,accountId,externalId:'200@c.us'});v=await store.setMode(v.id,'auto');const action=(await store.enqueue({conversationId:v.id,expectedEpoch:v.automation_epoch,logicalKey:'first',kind:'reply',text:'Synthetic'})).action;const input={actionId:action.id,accountId,conversationId:v.id,messageId:'reserved-id',targetId:'200@c.us',recipientAliases:['200@c.us','201@lid'],selfAliases:['100@c.us']};await receipts.reserve(input);return{v,action,input,proof:{accountId,messageId:input.messageId,targetId:input.targetId,selfId:'100@c.us',ack:1,text:'Synthetic'}};}
const unknown=(f:any)=>({target:{accountId:f.input.accountId,externalConversationId:f.v.external_id,platform:'whatsapp' as const},start:(a:any)=>({acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'unknown',code:'synthetic_timeout',retryCondition:'reconcile_or_manual_review'})})});
test('WhatsApp reserved ID becomes service echo only after durable attempt, not a native manager',{skip},async()=>{
 const f=await fixture();assert.equal(await receipts.origin(f.input.accountId,f.v.id,f.input.messageId),'unresolved');await store.dispatch(f.action.id,unknown(f));assert.equal(await receipts.origin(f.input.accountId,f.v.id,f.input.messageId),'service');assert.equal(await receipts.origin(f.input.accountId,f.v.id,'native-id'),'human');
});
test('WhatsApp late exact server acknowledgement confirms unknown across receipt-store restart without send',{skip},async()=>{
 const f=await fixture();await store.dispatch(f.action.id,unknown(f));assert.equal(await new WhatsAppAiReceipts(pool).observe(f.proof),true);const row=(await pool.query('SELECT * FROM ai_outbox WHERE id=$1',[f.action.id])).rows[0];assert.equal(row.state,'confirmed');assert.equal(row.external_message_id,f.input.messageId);assert.equal(await receipts.reconcile(f.action.id),false);
});
test('WhatsApp acknowledgement before commit is retained and reconciles after dispatch',{skip},async()=>{
 const f=await fixture();await receipts.observe(f.proof);assert.equal((await pool.query('SELECT state FROM ai_outbox WHERE id=$1',[f.action.id])).rows[0].state,'pending');await store.dispatch(f.action.id,unknown(f));assert.equal(await receipts.reconcile(f.action.id),true);
});
test('WhatsApp text/time resemblance, ack0 and wrong account, target or self cannot confirm',{skip},async()=>{
 for(const changed of [{ack:0},{accountId:randomUUID()},{targetId:'201@lid'},{selfId:'300@c.us'},{messageId:'other-id'},{text:'different'}]){
  await pool.query('TRUNCATE ai_contacts,integrations CASCADE');const f=await fixture();await store.dispatch(f.action.id,unknown(f));await receipts.observe({...f.proof,...changed});assert.equal((await pool.query('SELECT state FROM ai_outbox WHERE id=$1',[f.action.id])).rows[0].state,'unknown');
 }
});
test('WhatsApp pause during preparation prevents sending and a later acknowledgement cannot revive cancellation',{skip},async()=>{
 const f=await fixture();await store.setMode(f.v.id,'paused');let starts=0;await store.dispatch(f.action.id,{...unknown(f),start:a=>{starts++;return unknown(f).start(a);}});assert.equal(starts,0);await receipts.observe(f.proof);assert.equal((await pool.query('SELECT state FROM ai_outbox WHERE id=$1',[f.action.id])).rows[0].state,'cancelled');
});
test('WhatsApp intent cannot be reused for another action, recipient, group or account',{skip},async()=>{
 const f=await fixture();await assert.rejects(receipts.reserve(f.input),/binding_changed/);await assert.rejects(receipts.reserve({...f.input,messageId:'new',accountId:randomUUID()}),/binding_changed/);await assert.rejects(receipts.reserve({...f.input,messageId:'group',targetId:'200@g.us'}),/unverified/);
});

test('WhatsApp imported phone route uses exact protocol PN/LID and preserves exclusion without sending',{skip},async()=>{
 const {resolveWhatsAppContactRoute}=await import('./whatsapp-contact-route.js');const f=await fixture();
 const contact=(await pool.query("UPDATE ai_contacts SET phone_e164='+79990000123',comment='keep',opted_out_at=now() WHERE id=$1 RETURNING *",[f.v.contact_id])).rows[0],pn='79990000123@c.us';
 const proof={phone:contact.phone_e164,pn,aliases:[pn,'123@lid'],selfAliases:['100@c.us'],privateId:'123@lid'},scope={testOnly:true,accountIds:[f.input.accountId],authorIds:[pn]};
 const result=await resolveWhatsAppContactRoute(pool,scope,{accountId:f.input.accountId,contactId:contact.id},async phone=>{assert.equal(phone,contact.phone_e164);return proof;});assert.equal(result.excluded,true);assert.equal(result.externalId,'123@lid');
 const v=(await pool.query('SELECT * FROM ai_conversations WHERE id=$1',[result.conversationId])).rows[0];assert.equal(v.automation_mode,'paused');assert.equal(v.active_phase_id,null);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_outbox')).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_requests')).rows[0].n,0);
 assert.equal((await pool.query('SELECT comment FROM ai_contacts WHERE id=$1',[contact.id])).rows[0].comment,'keep');assert.equal((await pool.query('SELECT count(*)::int n FROM ai_remote_identities WHERE contact_id=$1',[contact.id])).rows[0].n,2);
 for(const invalid of [{...proof,pn:'79990000124@c.us'},{...proof,privateId:'200@g.us'},{...proof,selfAliases:[pn]}])await assert.rejects(resolveWhatsAppContactRoute(pool,scope,{accountId:f.input.accountId,contactId:contact.id},async()=>invalid),/unverified/);
 let calls=0;await assert.rejects(resolveWhatsAppContactRoute(pool,{...scope,accountIds:[]},{accountId:f.input.accountId,contactId:contact.id},async()=>{calls++;return proof;}),/scope/);assert.equal(calls,0);
});


test('removing a WhatsApp integration retains minimal intent history and cannot requeue its old action',{skip},async()=>{
 const f=await fixture();await store.dispatch(f.action.id,unknown(f));await pool.query('DELETE FROM integrations WHERE id=$1',[f.input.accountId]);assert.equal((await pool.query('SELECT count(*)::int n FROM ai_whatsapp_send_intents WHERE action_id=$1',[f.action.id])).rows[0].n,1);assert.equal(await store.retryReady(),0);assert.equal((await pool.query('SELECT state FROM ai_outbox WHERE id=$1',[f.action.id])).rows[0].state,'unknown');
});
