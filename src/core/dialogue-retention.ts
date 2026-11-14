import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
export const EXPIRED_TEXT='[Срок хранения текста истёк]';
const settingsSchema=z.object({expectedRevision:z.number().int().nonnegative(),dialogueDays:z.number().int().min(1).max(3650)}).strict();
const safeRequest=`r.lifecycle='closed' AND r.content_expired_at IS NULL AND r.closed_at<=$1::timestamptz-make_interval(days=>$2::int)
 AND EXISTS(SELECT 1 FROM ai_request_phases p WHERE p.request_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM ai_request_phases p JOIN ai_conversations v ON v.id=p.conversation_id WHERE p.request_id=r.id AND (p.closed_at IS NULL OR v.active_phase_id=p.id AND v.manager_hold))
 AND NOT EXISTS(SELECT 1 FROM ai_outbox a JOIN ai_request_phases p ON p.id=a.request_phase_id WHERE p.request_id=r.id AND a.state IN ('pending','dispatching','unknown'))
 AND NOT EXISTS(SELECT 1 FROM ai_handoff_notifications n JOIN ai_request_phases p ON p.id=n.request_phase_id WHERE p.request_id=r.id AND n.state IN ('pending','dispatching','unknown'))
 AND NOT EXISTS(SELECT 1 FROM ai_followup_jobs j JOIN ai_request_phases p ON p.id=j.request_phase_id WHERE p.request_id=r.id AND j.state='pending')`;
async function scrubLead(c:PoolClient,id:string,at:Date){
 await c.query("UPDATE ai_leads SET original_text=$2,params='[]',classification='{}',review_reason=NULL,activation_error=NULL,content_expired_at=$3 WHERE id=$1 AND content_expired_at IS NULL",[id,EXPIRED_TEXT,at]);
 // Receipts may contain the entire old lead. Retain only immutable operation identity/result.
 await c.query(`UPDATE ai_lead_operations o SET result=jsonb_build_object('id',l.id,'request_id',l.request_id,'contact_id',l.contact_id,'status',l.status,'revision',l.revision,'content_expired',true) FROM ai_leads l WHERE o.lead_id=l.id AND l.id=$1`,[id]);
 await c.query('UPDATE ai_source_messages SET original_text=NULL WHERE id=(SELECT source_message_id FROM ai_leads WHERE id=$1)',[id]);
}
export class DialogueRetention{
 constructor(private pool:Pool){}
 async settings(){return(await this.pool.query('SELECT revision,dialogue_days AS "dialogueDays",updated_at AS "updatedAt" FROM ai_storage_settings WHERE id=1')).rows[0];}
 async save(input:unknown){const d=settingsSchema.parse(input);const result=(await this.pool.query('UPDATE ai_storage_settings SET dialogue_days=$2,revision=revision+1,updated_at=now() WHERE id=1 AND revision=$1 RETURNING revision,dialogue_days AS "dialogueDays"',[d.expectedRevision,d.dialogueDays])).rows[0];if(!result)throw Error('storage_settings_changed');return result;}
 async preview(at=new Date()){
  const settings=await this.settings();const ready=(await this.pool.query(`SELECT count(*)::int AS requests FROM ai_requests r WHERE ${safeRequest}`,[at,settings.dialogueDays])).rows[0];
  const protectedCount=(await this.pool.query(`SELECT count(*)::int AS requests FROM ai_requests WHERE lifecycle='closed' AND content_expired_at IS NULL AND closed_at<=$1::timestamptz-make_interval(days=>$2::int)`,[at,settings.dialogueDays])).rows[0].requests-ready.requests;
  return{...settings,eligibleRequests:ready.requests,protectedRequests:protectedCount};
 }
 async expire(at=new Date(),limit=25){
  if(!Number.isFinite(at.getTime())||!Number.isInteger(limit)||limit<1||limit>100)throw Error('invalid_retention_batch');
  const settings=await this.settings();
  const candidates=(await this.pool.query(`SELECT r.id,r.contact_id FROM ai_requests r WHERE ${safeRequest} ORDER BY r.closed_at,r.id LIMIT $3`,[at,settings.dialogueDays,limit])).rows;
  let expired=0;
  for(const candidate of candidates){const c=await this.pool.connect();try{
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
   // Same serialization boundary as ingestion, closing, source activation and sends.
   await c.query('SELECT id FROM ai_contacts WHERE id=$1 FOR UPDATE',[candidate.contact_id]);
   await c.query('SELECT id FROM ai_requests WHERE id=$1 FOR UPDATE',[candidate.id]);
   // A concurrent extension of the policy must take effect before destruction.
   const policy=(await c.query('SELECT dialogue_days FROM ai_storage_settings WHERE id=1 FOR SHARE')).rows[0];
   if(!(await c.query(`SELECT 1 FROM ai_requests r WHERE r.id=$3 AND ${safeRequest}`,[at,policy.dialogue_days,candidate.id])).rowCount){await c.query('COMMIT');continue;}
   const phases=(await c.query('SELECT id,conversation_id FROM ai_request_phases WHERE request_id=$1',[candidate.id])).rows,ids=phases.map(p=>p.id);
   await c.query('SELECT id FROM ai_conversations WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[phases.map(p=>p.conversation_id)]);
   for(const table of ['ai_inbox','ai_outbox','ai_followup_jobs'])await c.query(`UPDATE ${table} SET text=$2 WHERE request_phase_id=ANY($1::uuid[])`,[ids,EXPIRED_TEXT]);
   await c.query("UPDATE ai_engine_decisions SET reply=CASE WHEN reply IS NULL THEN NULL ELSE $2 END,fields='{}' WHERE request_phase_id=ANY($1::uuid[])",[ids,EXPIRED_TEXT]);
   await c.query("UPDATE ai_request_phases SET fields_snapshot='{}' WHERE id=ANY($1::uuid[])",[ids]);
   await c.query("UPDATE ai_engine_state s SET fields='{}' FROM ai_conversations v WHERE s.conversation_id=v.id AND v.active_phase_id=ANY($1::uuid[])",[ids]);
   await c.query("UPDATE ai_handoff_notifications SET summary=$2,parameters='{}',source='{}',contact_snapshot='{}',channel_snapshot='{}' WHERE request_phase_id=ANY($1::uuid[])",[ids,EXPIRED_TEXT]);
   await c.query("UPDATE ai_followup_jobs SET rule_snapshot='{}' WHERE request_phase_id=ANY($1::uuid[])",[ids]);
   await c.query('UPDATE ai_business_events SET note=$2 WHERE request_id=$1',[candidate.id,EXPIRED_TEXT]);
   await c.query('UPDATE ai_workflow_status_history SET reason=$2 WHERE request_phase_id=ANY($1::uuid[])',[ids,EXPIRED_TEXT]);
   const leads=(await c.query('SELECT id FROM ai_leads WHERE request_id=$1 FOR UPDATE',[candidate.id])).rows;
   for(const lead of leads)await scrubLead(c,lead.id,at);
   await c.query(`UPDATE ai_source_messages s SET original_text=NULL WHERE EXISTS(SELECT 1 FROM ai_request_sources x WHERE x.request_id=$1 AND x.platform=s.platform AND x.external_chat_id=s.chat_id AND x.external_message_id=s.message_id)`,[candidate.id]);
   await c.query('UPDATE ai_requests SET content_expired_at=$2 WHERE id=$1',[candidate.id,at]);await c.query('COMMIT');expired++;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  // Rejected candidates have no request. Keep their dedup identity, not their text or quotes.
  const c=await this.pool.connect();let rejected=0;try{
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");const policy=(await c.query('SELECT dialogue_days FROM ai_storage_settings WHERE id=1 FOR SHARE')).rows[0];
   const leads=(await c.query("SELECT id FROM ai_leads WHERE status='rejected' AND request_id IS NULL AND content_expired_at IS NULL AND reviewed_at<=$1::timestamptz-make_interval(days=>$2::int) ORDER BY reviewed_at,id LIMIT $3 FOR UPDATE SKIP LOCKED",[at,policy.dialogue_days,limit])).rows;
   for(const lead of leads)await scrubLead(c,lead.id,at);rejected=leads.length;await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  return{expiredRequests:expired,expiredRejectedLeads:rejected};
 }
}
export function startDialogueMaintenance(pool:Pool,enabled:boolean,intervalMs:number){
 let running:Promise<void>|undefined;
 const tick=()=>{if(!enabled||running)return;running=(async()=>{if(!(await pool.query("SELECT to_regclass('ai_storage_settings') AS table")).rows[0].table)return;const result=await new DialogueRetention(pool).expire();if(result.expiredRequests||result.expiredRejectedLeads)console.log('Dialogue maintenance',result);})().catch(()=>console.error('Dialogue maintenance failed; no text logged')).finally(()=>{running=undefined;});};
 tick();const timer=setInterval(tick,intervalMs);timer.unref();return async()=>{clearInterval(timer);await running;};
}
