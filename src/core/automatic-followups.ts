import type {Pool} from 'pg';
import {ConversationWorkflow,type FollowupRule} from './conversation-workflow.js';
import {latestRequestCustomerSequence} from './customer-sequence.js';
/** Derive wait sequences from factual receipts/business events, never from an import row. */
export class AutomaticFollowups{
 private workflow:ConversationWorkflow;
 constructor(private pool:Pool){this.workflow=new ConversationWorkflow(pool);}
 async reconcile(){
  await this.pool.query(`UPDATE ai_followup_jobs j SET state='cancelled',cancellation_reason='automatic_trigger_changed',updated_at=now()
   WHERE j.state IN ('pending','enqueued') AND j.trigger_customer_sequence IS NOT NULL AND (
    ai_latest_request_customer_sequence(j.conversation_id)>j.trigger_customer_sequence OR NOT EXISTS(
     SELECT 1 FROM ai_request_phases p JOIN ai_conversations v ON v.active_phase_id=p.id JOIN ai_requests r ON r.id=p.request_id JOIN ai_request_business_state b ON b.request_id=r.id
     WHERE p.id=j.request_phase_id AND p.closed_at IS NULL AND r.lifecycle='open' AND b.revision=j.business_revision AND NOT b.followups_stopped))`);
  const requests=(await this.pool.query(`SELECT DISTINCT p.request_id FROM ai_request_phases p JOIN ai_conversations v ON v.active_phase_id=p.id JOIN ai_requests r ON r.id=p.request_id JOIN ai_contacts c ON c.id=v.contact_id
   WHERE p.closed_at IS NULL AND r.lifecycle='open' AND v.automation_mode='auto' AND NOT v.manager_hold AND v.business_status NOT IN ('closed','refused','qualified','unqualified','manager_working','manager_required') AND c.opted_out_at IS NULL ORDER BY p.request_id LIMIT 100`)).rows;
  for(const request of requests){try{await this.plan(request.request_id);}catch{/* A concurrent reply/status change invalidates this candidate; no fallback. */}}
 }
 private async plan(requestId:string){
  const state=(await this.pool.query('SELECT * FROM ai_request_business_state WHERE request_id=$1',[requestId])).rows[0]??{revision:0,booking_state:'none',order_state:'none',followups_stopped:false};
  if(state.followups_stopped||state.order_state==='completed')return;
  const event=(await this.pool.query(`SELECT e.* FROM ai_business_events e JOIN ai_conversations v ON v.id=e.conversation_id
   WHERE e.request_id=$1 AND e.business_revision=$2 AND e.request_phase_id=v.active_phase_id AND e.automation_epoch=v.automation_epoch AND v.automation_mode='auto' AND NOT v.manager_hold
    AND e.kind IN ('booking_offered','order_started','requested_later') ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,[requestId,state.revision])).rows[0];
  if(!event&&state.booking_state==='booked')return;
  const action=(await this.pool.query(`SELECT a.*,v.account_id,v.platform,v.active_phase_id,v.automation_epoch AS current_epoch FROM ai_outbox a JOIN ai_request_phases p ON p.id=a.request_phase_id JOIN ai_conversations v ON v.id=a.conversation_id
   WHERE p.request_id=$1 AND a.request_phase_id=v.active_phase_id AND p.closed_at IS NULL AND v.automation_mode='auto' AND NOT v.manager_hold AND a.automation_epoch=v.automation_epoch AND a.state='confirmed' AND a.kind IN ('first_message','reply')
    AND ($2::uuid IS NULL OR a.conversation_id=$2) AND a.customer_sequence=ai_latest_request_customer_sequence(v.id)
   ORDER BY a.dispatch_started_at DESC,a.id DESC LIMIT 1`,[requestId,event?.conversation_id??null])).rows[0];
  if(!action?.dispatch_started_at)return;
  const scenario:FollowupRule['scenario']=event?.kind==='booking_offered'?'not_booked':event?.kind==='order_started'?'not_completed':event?.kind==='requested_later'?'requested_later':'no_reply';
  const rule=(await this.pool.query('SELECT * FROM ai_followup_rules WHERE scenario=$1',[scenario])).rows[0];if(!rule?.enabled||!rule.automatic_enabled_at)return;
  const anchor=new Date(Math.max(new Date(action.dispatch_started_at).getTime(),event?new Date(event.created_at).getTime():0));
  if(anchor<new Date(rule.automatic_enabled_at))return;
  const logical='auto:'+scenario+':'+(event?.id??action.id);
  if((await this.pool.query('SELECT 1 FROM ai_automatic_followup_triggers WHERE logical_key=$1',[logical])).rowCount)return;
  let target=action;
  if(rule.channel!=='current'&&rule.channel!==action.platform){
   target=(await this.pool.query(`SELECT v.*,v.automation_epoch AS current_epoch FROM ai_conversations v JOIN ai_request_phases p ON p.id=v.active_phase_id JOIN ai_verified_routes r ON r.conversation_id=v.id AND r.account_id=v.account_id AND r.contact_id=v.contact_id AND r.external_id=v.external_id JOIN integrations a ON a.id=v.account_id
    WHERE p.request_id=$1 AND p.closed_at IS NULL AND v.platform=$2 AND v.automation_mode='auto' AND NOT v.manager_hold AND a.enabled AND a.auth_error IS NULL
    ORDER BY (SELECT max(i.ingest_sequence) FROM ai_inbox i WHERE i.conversation_id=v.id) DESC NULLS LAST,v.id LIMIT 1`,[requestId,rule.channel])).rows[0];
   if(!target)return;
   target={...target,conversation_id:target.id};
  }
  if(String(await latestRequestCustomerSequence(this.pool,target.conversation_id))!==String(action.customer_sequence))return;
  await this.workflow.scheduleFollowup({conversationId:target.conversation_id,scenario,key:logical,anchorAt:anchor.toISOString(),proof:{actionId:action.id,eventId:event?.id,expectedEpoch:target.current_epoch,expectedPhaseId:target.active_phase_id,businessRevision:state.revision,customerSequence:String(action.customer_sequence),...(event?.not_before?{notBefore:new Date(event.not_before).toISOString()}:{})}});
 }
}
