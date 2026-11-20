import type {PoolClient} from 'pg';
import {latestRequestCustomerSequence} from './customer-sequence.js';
/** Called while the contact and destination conversation are locked. */
export async function automaticFollowupGate(c:PoolClient,job:any):Promise<'ready'|'cancel'> {
 if(job.trigger_customer_sequence==null)return 'ready'; // Explicit legacy/manual schedule.
 const phase=(await c.query('SELECT p.request_id,p.closed_at,v.active_phase_id FROM ai_request_phases p JOIN ai_conversations v ON v.id=p.conversation_id WHERE p.id=$1',[job.request_phase_id])).rows[0];
 if(!phase||phase.closed_at||phase.active_phase_id!==job.request_phase_id)return 'cancel';
 const state=(await c.query('SELECT * FROM ai_request_business_state WHERE request_id=$1',[phase.request_id])).rows[0];
 if(!state||state.followups_stopped||state.revision!==job.business_revision)return 'cancel';
 if(BigInt(await latestRequestCustomerSequence(c,job.conversation_id))>BigInt(job.trigger_customer_sequence))return 'cancel';
 if(job.trigger_action_id){
  const anchor=(await c.query(`SELECT a.state,a.customer_sequence,a.request_phase_id,a.automation_epoch,v.active_phase_id,v.automation_epoch AS current_epoch,v.automation_mode,v.manager_hold,p.request_id FROM ai_outbox a JOIN ai_conversations v ON v.id=a.conversation_id JOIN ai_request_phases p ON p.id=a.request_phase_id WHERE a.id=$1`,[job.trigger_action_id])).rows[0];
  if(!anchor||String(anchor.customer_sequence)!==String(job.trigger_customer_sequence)||anchor.state!=='confirmed'||anchor.request_phase_id!==anchor.active_phase_id||anchor.automation_epoch!==anchor.current_epoch||anchor.request_id!==phase.request_id||anchor.automation_mode!=='auto'||anchor.manager_hold)return 'cancel';
 }
 if(job.business_event_id){
  const event=(await c.query(`SELECT e.*,v.automation_epoch AS current_epoch,v.active_phase_id FROM ai_business_events e JOIN ai_conversations v ON v.id=e.conversation_id WHERE e.id=$1`,[job.business_event_id])).rows[0];
  if(!event||event.request_id!==phase.request_id||event.request_phase_id!==event.active_phase_id||event.automation_epoch!==event.current_epoch||event.business_revision!==state.revision||String(event.customer_sequence)!==String(job.trigger_customer_sequence))return 'cancel';
  if(job.scenario==='not_booked'&&(event.kind!=='booking_offered'||state.booking_state!=='offered'))return 'cancel';
  if(job.scenario==='not_completed'&&(event.kind!=='order_started'||state.order_state!=='started'))return 'cancel';
  if(job.scenario==='requested_later'&&event.kind!=='requested_later')return 'cancel';
 }
 if(job.scenario==='no_reply'&&(state.booking_state==='booked'||state.order_state==='completed'))return 'cancel';
 return 'ready';
}
export type AutomaticFollowupProof={actionId:string;eventId?:string;expectedEpoch:string;expectedPhaseId:string;businessRevision:number;customerSequence:string;notBefore?:string};
