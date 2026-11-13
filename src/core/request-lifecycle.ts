import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {aiSettingsSchema} from './ai-engine.js';
const opaque=z.string().min(1).max(512).refine(v=>!!v.trim());
const sourceSchema=z.object({
 conversationId:z.string().uuid(),accountId:z.string().uuid(),platform:z.enum(['max','whatsapp']),
 chatId:opaque,messageId:opaque,authorId:opaque,
 sourceAccountId:z.string().uuid().optional(),sourcePlatform:z.enum(['max','whatsapp']).optional(),
 recipientId:opaque.optional(),requestId:z.string().uuid().optional(),
 occurredAt:z.string().datetime({offset:true}).optional(),
 // Only a verified incoming personal reply may attach a second active channel.
 allowAdditionalChannel:z.boolean().optional(),
});
/** Only a transport-verified source/recipient may reach this boundary. Never pass model output. */
export async function bindSourceRequest(pool:Pool,input:z.input<typeof sourceSchema>){
 const s=sourceSchema.parse(input),c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  const target=(await c.query('SELECT contact_id FROM ai_conversations WHERE id=$1',[s.conversationId])).rows[0];if(!target)throw Error('conversation_missing');
  const contact=(await c.query('SELECT * FROM ai_contacts WHERE id=$1 FOR UPDATE',[target.contact_id])).rows[0];
  const v=(await c.query('SELECT * FROM ai_conversations WHERE id=$1 FOR UPDATE',[s.conversationId])).rows[0];
  if(v.account_id!==s.accountId||v.platform!==s.platform)throw Error('source_account_mismatch');
  const reader=s.sourceAccountId??s.accountId,sourcePlatform=s.sourcePlatform??s.platform,recipient=s.recipientId??s.authorId;
  if(sourcePlatform!==s.platform&&!s.recipientId)throw Error('cross_channel_recipient_required');
  const key=[reader,sourcePlatform,s.chatId,s.messageId];
  const finish=async(requestId:string,created=false,duplicate=false,activated=false,initialContact=false)=>{await c.query('COMMIT');return{requestId,created,duplicate,activated,initialContact};};
  const persist=async(requestId:string,initialContact=false)=>c.query(`INSERT INTO ai_request_sources(reader_account_id,platform,external_chat_id,external_message_id,author_id,request_id,conversation_id,account_id,recipient_id,occurred_at,initial_contact) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[...key,s.authorId,requestId,v.id,s.accountId,recipient,s.occurredAt??new Date().toISOString(),initialContact]);
  const existing=(await c.query('SELECT * FROM ai_request_sources WHERE reader_account_id=$1 AND platform=$2 AND external_chat_id=$3 AND external_message_id=$4',key)).rows[0];
  if(existing){
   if(existing.conversation_id!==v.id||existing.author_id!==s.authorId||existing.account_id!==s.accountId||existing.recipient_id!==recipient||(s.requestId&&existing.request_id!==s.requestId))throw Error('source_identity_conflict');
   return finish(existing.request_id,false,true,false,existing.initial_contact);
  }
  // Preserve the pre-ledger v12 transport dedup history after upgrade.
  if(reader===s.accountId&&sourcePlatform===s.platform){
   const legacy=(await c.query(`SELECT p.request_id FROM ai_inbox i JOIN ai_request_phases p ON p.id=i.request_phase_id WHERE i.conversation_id=$1 AND i.external_message_id=$2`,[v.id,'group-source:'+s.chatId+':'+s.messageId])).rows[0];
   if(legacy){if(s.requestId&&s.requestId!==legacy.request_id)throw Error('source_identity_conflict');await persist(legacy.request_id);return finish(legacy.request_id,false,true);}
  }
  if(!(await c.query('SELECT 1 FROM integrations WHERE id=$1 AND platform::text=$2 AND enabled',[reader,sourcePlatform])).rowCount)throw Error('source_reader_unavailable');
  if(s.requestId){const explicit=(await c.query('SELECT * FROM ai_requests WHERE id=$1',[s.requestId])).rows[0];if(!explicit||explicit.contact_id!==contact.id||explicit.lifecycle!=='open')throw Error('request_identity_conflict');}
  // A delayed old source is not a new post-close request, even if first processed later.
  if(s.occurredAt&&!s.requestId){
   const old=(await c.query("SELECT id FROM ai_requests WHERE contact_id=$1 AND lifecycle='closed' AND closed_at >= $2::timestamptz ORDER BY closed_at,id LIMIT 1",[contact.id,s.occurredAt])).rows[0];
   if(old){await persist(old.id);return finish(old.id);}
  }
  if(contact.opted_out_at)throw Error('contact_opted_out');
  if((await c.query('SELECT 1 FROM ai_conversations WHERE contact_id=$1 AND manager_hold',[contact.id])).rowCount)throw Error('manager_hold');
  if((await c.query("SELECT 1 FROM ai_outbox WHERE contact_id=$1 AND state IN ('dispatching','unknown')",[contact.id])).rowCount)throw Error('uncertain_send');
  if(v.business_status==='refused')throw Error('qualification_forbidden');
  const active=(await c.query('SELECT p.*,r.lifecycle FROM ai_request_phases p JOIN ai_requests r ON r.id=p.request_id WHERE p.id=$1',[v.active_phase_id])).rows[0];
  if(active?.lifecycle==='open'&&!active.closed_at){
   if(s.requestId&&s.requestId!==active.request_id)throw Error('active_request_exists');
   await persist(active.request_id);return finish(active.request_id);
  }
  const open=(await c.query(`SELECT r.id FROM ai_requests r WHERE r.contact_id=$1 AND r.lifecycle='open' AND EXISTS(SELECT 1 FROM ai_request_phases p WHERE p.request_id=r.id AND p.closed_at IS NULL) ORDER BY r.created_at,r.id`,[contact.id])).rows;
  if(open.length>1)throw Error('multiple_open_requests_require_review');
  if(s.requestId&&open.length&&open[0].id!==s.requestId)throw Error('active_request_exists');
  if(open.length&&!s.allowAdditionalChannel){await persist(open[0].id);return finish(open[0].id);}
  const settings=(await c.query('SELECT version,settings FROM ai_engine_settings ORDER BY version DESC LIMIT 1 FOR SHARE')).rows[0];
  if(!aiSettingsSchema.parse(settings.settings).qualificationEnabled)throw Error('qualification_disabled');
  const requestId=s.requestId??open[0]?.id??randomUUID(),created=!s.requestId&&!open.length;
  if(created)await c.query('INSERT INTO ai_requests(id,contact_id) VALUES($1,$2)',[requestId,contact.id]);
  const first=(await c.query('SELECT coalesce(max(ingest_sequence),0)::bigint+1 AS n FROM ai_inbox WHERE conversation_id=$1',[v.id])).rows[0].n;
  const phase=(await c.query('INSERT INTO ai_request_phases(request_id,conversation_id,first_ingest_sequence,settings_version) VALUES($1,$2,$3,$4) RETURNING id',[requestId,v.id,first,settings.version])).rows[0];
  await c.query("UPDATE ai_outbox SET state='cancelled',cancellation_requested=true,updated_at=now() WHERE conversation_id=$1 AND state='pending'",[v.id]);
  await c.query("UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason='new_request',updated_at=now() WHERE conversation_id=$1 AND state IN ('pending','enqueued')",[v.id]);
  await c.query("UPDATE ai_engine_state SET fields='{}',reply_count=0,settings_version=$2 WHERE conversation_id=$1",[v.id,settings.version]);
  await c.query("UPDATE ai_conversations SET active_phase_id=$2,automation_epoch=automation_epoch+1,business_status='ai_dialog',automation_mode='auto',manager_hold=false WHERE id=$1",[v.id,phase.id]);
  const initialContact=created||!!s.requestId&&!open.length;await persist(requestId,initialContact);
  return finish(requestId,created,false,true,initialContact);
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
