import {readChatCriteria} from './chat-criteria.js';
import type {Pool} from 'pg';
import {z} from 'zod';
import {bindSourceRequestInTransaction} from './request-lifecycle.js';
import {channelMessageKey} from './channel-contracts.js';
import {monitorCriteriaFingerprint,monitorSettingsSchema} from './source-monitor-settings.js';
import {checkLeadEvidence} from './lead-intake.js';
import {runtimeAllows,type RuntimeScope} from './runtime-scope.js';
const opaque=z.string().min(1).max(512);
export const verifiedSourceRouteSchema=z.object({
 leadId:z.string().uuid(),revision:z.number().int().nonnegative(),contactId:z.string().uuid(),conversationId:z.string().uuid(),accountId:z.string().uuid(),platform:z.enum(['max','whatsapp']),dialogId:opaque,recipientId:opaque,
 sourceAccountId:z.string().uuid(),sourcePlatform:z.enum(['max','whatsapp']),sourceChatId:opaque,messageId:opaque,authorId:opaque,text:z.string().min(1).max(8000),
}).passthrough();
export type VerifiedSourceRoute=z.infer<typeof verifiedSourceRouteSchema>;
/** Routing is attested by the owner before this transaction; the model supplies none of these IDs. */
export async function activateSource(pool:Pool,scope:RuntimeScope,input:VerifiedSourceRoute,mode:'automatic'|'manual'){
 const route=verifiedSourceRouteSchema.parse(input),c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  const lead=(await c.query('SELECT * FROM ai_leads WHERE id=$1 FOR UPDATE',[route.leadId])).rows[0];if(!lead)throw Error('source_lead_missing');
  if(lead.status==='approved'){
   const old=(await c.query('SELECT conversation_id FROM ai_request_sources WHERE lead_id=$1',[lead.id])).rows[0];await c.query('COMMIT');return{requestId:lead.request_id,conversationId:old?.conversation_id,activated:false,replayed:true};
  }
  if(lead.status!=='pending'||lead.revision!==route.revision)throw Error('source_lead_changed');
  if(lead.platform!==route.sourcePlatform||lead.account_id!==route.sourceAccountId||lead.chat_id!==route.sourceChatId||lead.message_id!==route.messageId||lead.author_id!==route.authorId||lead.original_text!==route.text)throw Error('source_route_changed');
  if(!runtimeAllows(scope,route.sourceAccountId,route.authorId)||!runtimeAllows(scope,route.accountId,route.recipientId))throw Error('outside_runtime_scope');
  const policy=(await c.query('SELECT * FROM ai_monitor_settings WHERE id=1 FOR SHARE')).rows[0],{settings,fingerprint}=await readChatCriteria(c,lead.platform,lead.chat_id,monitorSettingsSchema.parse(policy.settings));
  if(policy.mode==='stopped'||mode==='automatic'&&policy.mode!=='active')throw Error('source_monitor_inactive');
  const source=(await c.query('SELECT * FROM ai_source_messages WHERE id=$1',[lead.source_message_id])).rows[0];
  if(!source||source.state!=='classified'||source.monitor_epoch!==policy.epoch||source.platform!==lead.platform||source.account_id!==lead.account_id||source.chat_id!==lead.chat_id||source.message_id!==lead.message_id||source.author_id!==lead.author_id)throw Error('source_monitor_generation_changed');
  if(mode==='automatic'&&(lead.revision!==0||!settings.autoContact||lead.classification?.intent!=='demand'||lead.classification?.criteriaFingerprint!==fingerprint||lead.confidence<settings.confidenceThreshold))throw Error('source_requires_review');
  if(!(await c.query('SELECT 1 FROM ai_search_sources WHERE account_id=$1 AND platform=$2 AND chat_id=$3 FOR SHARE',[lead.account_id,lead.platform,lead.chat_id])).rowCount)throw Error('source_not_selected');
  const outreach=(await c.query('SELECT * FROM ai_outreach_settings WHERE id=1 FOR SHARE')).rows[0];
  if(!outreach.platforms.includes(route.platform)||!outreach.account_ids.includes(route.accountId))throw Error('source_sender_not_allowed');
  if(!(await c.query('SELECT 1 FROM ai_verified_routes WHERE conversation_id=$1 AND account_id=$2 AND platform=$3 AND external_id=$4 AND recipient_id=$5 AND contact_id=$6',[route.conversationId,route.accountId,route.platform,route.dialogId,route.recipientId,route.contactId])).rowCount)throw Error('source_private_route_unverified');
  if(!(await c.query('SELECT 1 FROM integrations WHERE id=$1 AND platform::text=$2 AND enabled AND auth_error IS NULL FOR SHARE',[route.accountId,route.platform])).rowCount)throw Error('source_sender_unavailable');
  const binding=await bindSourceRequestInTransaction(c,{expectedContactId:route.contactId,conversationId:route.conversationId,accountId:route.accountId,platform:route.platform,chatId:lead.chat_id,messageId:lead.message_id,authorId:lead.author_id,sourceAccountId:lead.account_id,sourcePlatform:lead.platform,recipientId:route.recipientId,occurredAt:new Date(lead.occurred_at).toISOString()});
  const attached=await c.query(`UPDATE ai_request_sources SET lead_id=$5 WHERE reader_account_id=$1 AND platform=$2 AND external_chat_id=$3 AND external_message_id=$4 AND (lead_id IS NULL OR lead_id=$5) RETURNING request_id`,[lead.account_id,lead.platform,lead.chat_id,lead.message_id,lead.id]);if(!attached.rowCount)throw Error('source_lead_conflict');
  await c.query("UPDATE ai_leads SET status='approved',revision=revision+1,contact_id=$2,request_id=$3,review_reason=$4,reviewed_at=now() WHERE id=$1",[lead.id,route.contactId,binding.requestId,mode==='manual'?'manual_approved_source':'automatic_threshold']);
  const v=(await c.query('SELECT v.*,p.request_id,r.lifecycle FROM ai_conversations v LEFT JOIN ai_request_phases p ON p.id=v.active_phase_id LEFT JOIN ai_requests r ON r.id=p.request_id WHERE v.id=$1',[route.conversationId])).rows[0];
  let activated=false;
  if(binding.initialContact&&v.request_id===binding.requestId&&v.lifecycle==='open'&&v.automation_mode==='auto'&&!v.manager_hold&&!['closed','refused'].includes(v.business_status)){
   const hadStart=(await c.query(`SELECT 1 FROM ai_outbox a JOIN ai_request_phases p ON p.id=a.request_phase_id WHERE p.request_id=$1 AND a.dispatch_started_at IS NOT NULL AND a.dispatch_state IS DISTINCT FROM 'not_started'`,[binding.requestId])).rowCount;
   const hadCustomer=(await c.query("SELECT 1 FROM ai_inbox WHERE conversation_id=$1 AND request_phase_id=$2 AND origin='customer' LIMIT 1",[v.id,v.active_phase_id])).rowCount;
   if(!hadStart&&!hadCustomer){
    const event={version:1,platform:route.platform,accountId:route.accountId,conversationId:route.dialogId,messageId:'group-source:'+lead.chat_id+':'+lead.message_id,occurredAt:new Date(lead.occurred_at).toISOString(),direction:'inbound',origin:'customer',text:lead.original_text};
    const inserted=await c.query(`INSERT INTO ai_inbox(event_key,conversation_id,external_message_id,occurred_at,direction,origin,disposition,text) VALUES($1,$2,$3,$4,'inbound','customer','process_customer',$5) ON CONFLICT(event_key) DO NOTHING RETURNING event_key`,[channelMessageKey(event),v.id,event.messageId,event.occurredAt,event.text]);
    if(inserted.rowCount){
     checkLeadEvidence(lead.original_text,lead.params);
     const pinned=(await c.query('SELECT k.settings FROM ai_engine_state s JOIN ai_engine_settings k ON k.version=s.settings_version WHERE s.conversation_id=$1',[v.id])).rows[0].settings;
     if(lead.params.some((p:{key:string;value:unknown})=>!pinned.fields.some((f:{key:string})=>f.key===p.key)||pinned.rules.some((r:{field:string;op:string})=>r.field===p.key&&['gte','lte'].includes(r.op))&&typeof p.value!=='number'))throw Error('source_parameters_changed');
     const grounded=Object.fromEntries(lead.params.map((p:{key:string;value:string|number;evidenceQuote:string})=>[p.key,{value:p.value,evidenceMessageId:event.messageId,evidenceQuote:p.evidenceQuote}]));
     await c.query('UPDATE ai_engine_state SET fields=fields||$2::jsonb WHERE conversation_id=$1',[v.id,JSON.stringify(grounded)]);
     await c.query('UPDATE ai_conversations SET automation_epoch=automation_epoch+1 WHERE id=$1',[v.id]);
     await c.query("UPDATE ai_outbox SET state='cancelled',cancellation_requested=true,updated_at=now() WHERE conversation_id=$1 AND state='pending'",[v.id]);
     await c.query("UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason='source_request_activated',updated_at=now() WHERE conversation_id=$1 AND state IN ('pending','enqueued')",[v.id]);activated=true;
    }
   }
  }
  await c.query('COMMIT');return{requestId:binding.requestId,conversationId:route.conversationId,activated,replayed:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
