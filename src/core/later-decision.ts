import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {lockBusinessConversation,recordBusinessEventInTransaction} from './business-events.js';
import {parseRequestedLater} from './requested-later.js';
import {latestRequestCustomerSequence} from './customer-sequence.js';
/** A configured literal acknowledgement needs no model call and cannot supply qualification facts. */
export async function acceptRequestedLater(pool:Pool,conversationId:string,eventKey:string){
 const candidate=(await pool.query("SELECT text,occurred_at,received_at FROM ai_inbox WHERE event_key=$1 AND conversation_id=$2 AND origin='customer'",[eventKey,conversationId])).rows[0];if(!candidate)return;
 const rule=(await pool.query("SELECT * FROM ai_followup_rules WHERE scenario='requested_later' AND enabled")).rows[0];
 if(!rule||!rule.automatic_enabled_at||new Date(candidate.received_at)<new Date(rule.automatic_enabled_at))return;
 const parsed=parseRequestedLater(candidate.text,new Date(candidate.occurred_at),rule.timezone);if(!parsed)return;
 const c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  const existing=(await c.query('SELECT * FROM ai_engine_decisions WHERE conversation_id=$1 AND event_key=$2',[conversationId,eventKey])).rows[0];if(existing){await c.query('COMMIT');return existing;}
  const {contact,conversation:v,phase}=await lockBusinessConversation(c,conversationId);
  const accepted=(await c.query('SELECT * FROM ai_engine_decisions WHERE conversation_id=$1 AND event_key=$2',[conversationId,eventKey])).rows[0];if(accepted){await c.query('COMMIT');return accepted;}
  if(contact.opted_out_at||v.manager_hold||v.automation_mode!=='auto'||['closed','refused','qualified','unqualified'].includes(v.business_status)){await c.query('COMMIT');return;}
  const input=(await c.query("SELECT * FROM ai_inbox WHERE event_key=$1 AND conversation_id=$2 AND request_phase_id=$3 AND origin='customer'",[eventKey,conversationId,phase.id])).rows[0];
  if(!input||String(input.ingest_sequence)!==await latestRequestCustomerSequence(c,v.id)){await c.query('COMMIT');return;}
  await c.query('INSERT INTO ai_engine_state(conversation_id,settings_version) SELECT $1,max(version) FROM ai_engine_settings ON CONFLICT(conversation_id) DO NOTHING',[v.id]);
  const pinned=(await c.query('SELECT s.*,k.settings FROM ai_engine_state s JOIN ai_engine_settings k ON k.version=s.settings_version WHERE s.conversation_id=$1 FOR UPDATE OF s',[v.id])).rows[0];
  const state=(await c.query('SELECT * FROM ai_request_business_state WHERE request_id=$1',[phase.request_id])).rows[0];
  if(!pinned||pinned.reply_count>=pinned.settings.replyLimit||state?.followups_stopped||state?.order_state==='completed'){await c.query('COMMIT');return;}
  const fresh=(await c.query("SELECT * FROM ai_followup_rules WHERE scenario='requested_later' AND enabled FOR SHARE")).rows[0];if(!fresh||!fresh.automatic_enabled_at||new Date(input.received_at)<new Date(fresh.automatic_enabled_at)){await c.query('COMMIT');return;}
  const final=parseRequestedLater(input.text,new Date(input.occurred_at),fresh.timezone);if(!final){await c.query('COMMIT');return;}
  await recordBusinessEventInTransaction(c,{operationId:randomUUID(),conversationId:v.id,expectedRevision:state?.revision??0,kind:'requested_later',notBefore:final.notBefore},'customer',eventKey);
  const decision=(await c.query(`INSERT INTO ai_engine_decisions(conversation_id,event_key,settings_version,automation_epoch,disposition,business_status,reply,reason,fields)
   VALUES($1,$2,$3,$4,'reply','ai_dialog',$5,'customer_requested_later',$6) ON CONFLICT(conversation_id,event_key) DO NOTHING RETURNING *`,[v.id,eventKey,pinned.settings_version,v.automation_epoch,fresh.acknowledgement_message,pinned.fields])).rows[0];
  if(decision)await c.query('UPDATE ai_engine_state SET reply_count=reply_count+1 WHERE conversation_id=$1',[v.id]);
  await c.query('COMMIT');return decision;
 }catch(error){await c.query('ROLLBACK');if(error instanceof Error&&/^business_(request_closed|conversation_missing)$/.test(error.message))return;throw error;}finally{c.release();}
}
