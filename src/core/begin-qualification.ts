import type {Pool} from 'pg';
import {aiSettingsSchema} from './ai-engine.js';
/** Explicit user-started qualification phase; historical settings/decisions remain immutable. */
export async function beginConfiguredQualification(pool:Pool,conversationId:string){
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  const target=(await c.query('SELECT contact_id FROM ai_conversations WHERE id=$1',[conversationId])).rows[0];if(!target)throw Error('conversation_missing');
  const contact=(await c.query('SELECT opted_out_at FROM ai_contacts WHERE id=$1 FOR UPDATE',[target.contact_id])).rows[0];
  const conversation=(await c.query('SELECT * FROM ai_conversations WHERE id=$1 FOR UPDATE',[conversationId])).rows[0];
  if(contact.opted_out_at||['closed','refused'].includes(conversation.business_status))throw Error('qualification_forbidden');
  if((await c.query("SELECT 1 FROM ai_outbox WHERE conversation_id=$1 AND state IN ('dispatching','unknown')",[conversationId])).rowCount)throw Error('uncertain_send');
  const settings=(await c.query('SELECT version,settings FROM ai_engine_settings ORDER BY version DESC LIMIT 1 FOR SHARE')).rows[0];
  if(!aiSettingsSchema.parse(settings.settings).qualificationEnabled)throw Error('qualification_disabled');
  await c.query("UPDATE ai_outbox SET state='cancelled',cancellation_requested=true,updated_at=now() WHERE conversation_id=$1 AND state='pending'",[conversationId]);
  await c.query("UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason='new_qualification_phase',updated_at=now() WHERE conversation_id=$1 AND state IN ('pending','enqueued')",[conversationId]);
  await c.query("UPDATE ai_conversations SET automation_epoch=automation_epoch+1,automation_mode='auto',business_status='ai_dialog' WHERE id=$1",[conversationId]);
  await c.query(`UPDATE ai_engine_state SET fields=CASE WHEN settings_version=$2 THEN fields ELSE '{}'::jsonb END,reply_count=CASE WHEN settings_version=$2 THEN reply_count ELSE 0 END,settings_version=$2 WHERE conversation_id=$1`,[conversationId,settings.version]);
  await c.query('COMMIT');return settings.version;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
