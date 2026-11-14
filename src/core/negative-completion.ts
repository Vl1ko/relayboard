import type {PoolClient} from 'pg';
/** Caller holds the contact lock and the completion action. A receipt, never a send intent, closes the request. */
export async function finalizeNegativeCompletion(c:PoolClient,actionId:string){
 const proof=(await c.query(`SELECT v.id,v.contact_id,v.active_phase_id,p.request_id FROM ai_outbox a JOIN ai_engine_decisions d ON a.logical_key='qualification-notice:'||d.id::text AND a.conversation_id=d.conversation_id JOIN ai_conversations v ON v.id=a.conversation_id JOIN ai_request_phases p ON p.id=a.request_phase_id JOIN ai_requests r ON r.id=p.request_id
  WHERE a.id=$1 AND a.kind='qualification_notice' AND a.state='confirmed' AND a.external_message_id IS NOT NULL AND d.disposition='handoff' AND d.business_status='unqualified'
   AND d.request_phase_id=a.request_phase_id AND v.active_phase_id=p.id AND p.closed_at IS NULL AND r.lifecycle='open' AND v.business_status='unqualified' AND v.automation_mode='paused' AND NOT v.manager_hold
   AND a.automation_epoch=v.automation_epoch AND d.automation_epoch+1=v.automation_epoch
   AND EXISTS(SELECT 1 FROM ai_handoff_notifications n WHERE n.conversation_id=v.id AND n.logical_key='ai-handoff:'||d.id::text)
   AND NOT EXISTS(SELECT 1 FROM ai_request_phases other JOIN ai_conversations ov ON ov.active_phase_id=other.id WHERE other.request_id=p.request_id AND ov.manager_hold)
   AND NOT EXISTS(SELECT 1 FROM ai_outbox other JOIN ai_request_phases op ON op.id=other.request_phase_id WHERE op.request_id=p.request_id AND other.state IN ('pending','dispatching','unknown'))`,[actionId])).rows[0];
 if(!proof)return false;
 const linked=(await c.query('SELECT v.id,v.business_status FROM ai_conversations v JOIN ai_request_phases p ON p.id=v.active_phase_id WHERE p.request_id=$1 ORDER BY v.id FOR UPDATE OF v',[proof.request_id])).rows;
 for(const v of linked)if(v.business_status!=='closed')await c.query("INSERT INTO ai_workflow_status_history(conversation_id,from_status,to_status,reason) VALUES($1,$2,'closed','negative_qualification_completed')",[v.id,v.business_status]);
 // The common close trigger archives every phase and closes all channels of this request.
 await c.query("UPDATE ai_conversations SET business_status='closed',automation_mode='paused',automation_epoch=automation_epoch+1 WHERE id=$1",[proof.id]);
 await c.query("UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason='negative_qualification_completed',updated_at=now() WHERE request_phase_id IN(SELECT id FROM ai_request_phases WHERE request_id=$1) AND state IN ('pending','enqueued')",[proof.request_id]);
 return true;
}
