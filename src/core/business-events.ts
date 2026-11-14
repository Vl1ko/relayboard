import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {latestRequestCustomerSequence} from './customer-sequence.js';
export const businessEventKinds=['booking_offered','booking_confirmed','order_started','order_completed','requested_later','stop_followups'] as const;
export const businessEventSchema=z.object({operationId:z.string().uuid(),conversationId:z.string().uuid(),expectedRevision:z.number().int().nonnegative(),kind:z.enum(businessEventKinds),notBefore:z.string().datetime({offset:true}).optional(),note:z.string().trim().max(1000).default('')}).strict();
export type BusinessEventInput=z.input<typeof businessEventSchema>;
export async function lockBusinessConversation(c:PoolClient,id:string){
 const initial=(await c.query('SELECT contact_id FROM ai_conversations WHERE id=$1',[id])).rows[0];if(!initial)throw Error('business_conversation_missing');
 const contact=(await c.query('SELECT * FROM ai_contacts WHERE id=$1 FOR UPDATE',[initial.contact_id])).rows[0];
 const v=(await c.query('SELECT * FROM ai_conversations WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(v.contact_id!==contact.id)throw Error('business_conversation_changed');
 const phase=(await c.query('SELECT p.*,r.lifecycle FROM ai_request_phases p JOIN ai_requests r ON r.id=p.request_id WHERE p.id=$1',[v.active_phase_id])).rows[0];
 if(!phase||phase.closed_at||phase.lifecycle!=='open'||v.business_status==='closed')throw Error('business_request_closed');
 return{contact,conversation:v,phase};
}
/** Caller already holds contact/conversation locks. Manager facts never enter customer inbox. */
export async function recordBusinessEventInTransaction(c:PoolClient,input:BusinessEventInput,actor:'manager'|'customer'='manager',sourceEventKey?:string){
 const d=businessEventSchema.parse(input);
 const fingerprint=createHash('sha256').update(JSON.stringify([d,actor,sourceEventKey??null])).digest('hex');
 const prior=(await c.query('SELECT * FROM ai_business_events WHERE id=$1',[d.operationId])).rows[0];
 if(prior){if(prior.fingerprint!==fingerprint)throw Error('business_operation_conflict');return{event:prior,replayed:true};}
 const context=await lockBusinessConversation(c,d.conversationId),v=context.conversation,phase=context.phase;
 if(actor==='manager'&&d.kind==='requested_later'&&!(await c.query("SELECT 1 FROM ai_outbox a JOIN ai_request_phases p ON p.id=a.request_phase_id WHERE p.request_id=$1 AND a.state='confirmed' LIMIT 1",[phase.request_id])).rowCount)throw Error('business_first_contact_required');
 if(actor==='customer'){
  if(d.kind!=='requested_later'||!sourceEventKey)throw Error('business_customer_proof_required');
  if(!(await c.query("SELECT 1 FROM ai_inbox WHERE event_key=$1 AND conversation_id=$2 AND request_phase_id=$3 AND origin='customer'",[sourceEventKey,v.id,phase.id])).rowCount)throw Error('business_customer_proof_required');
 }
 await c.query('INSERT INTO ai_request_business_state(request_id) VALUES($1) ON CONFLICT DO NOTHING',[phase.request_id]);
 const state=(await c.query('SELECT * FROM ai_request_business_state WHERE request_id=$1 FOR UPDATE',[phase.request_id])).rows[0];
 if(state.revision!==d.expectedRevision)throw Error('business_state_changed');
 if(state.order_state==='completed'&&['booking_offered','order_started','requested_later'].includes(d.kind))throw Error('business_request_completed');
 if(d.notBefore&&d.kind!=='requested_later')throw Error('business_time_not_applicable');
 const updated=(await c.query(`UPDATE ai_request_business_state SET revision=revision+1,
  booking_state=CASE WHEN $2='booking_offered' THEN 'offered' WHEN $2='booking_confirmed' THEN 'booked' ELSE booking_state END,
  order_state=CASE WHEN $2='order_started' THEN 'started' WHEN $2='order_completed' THEN 'completed' ELSE order_state END,
  requested_contact_at=CASE WHEN $2='requested_later' THEN $3::timestamptz ELSE NULL END,
  followups_stopped=($2 IN ('booking_confirmed','order_completed','stop_followups')),updated_at=now() WHERE request_id=$1 RETURNING *`,[phase.request_id,d.kind,d.notBefore??null])).rows[0];
 const seq=await latestRequestCustomerSequence(c,v.id);
 const event=(await c.query(`INSERT INTO ai_business_events(id,request_id,conversation_id,request_phase_id,kind,actor,fingerprint,note,not_before,source_event_key,automation_epoch,customer_sequence,business_revision)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[d.operationId,phase.request_id,v.id,phase.id,d.kind,actor,fingerprint,d.note,d.notBefore??null,sourceEventKey??null,v.automation_epoch,seq,updated.revision])).rows[0];
 // A state change cancels wait sequences without pretending a manager note was a customer answer.
 await c.query(`UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason=$2,updated_at=now() WHERE request_phase_id IN(SELECT id FROM ai_request_phases WHERE request_id=$1) AND state IN ('pending','enqueued')`,[phase.request_id,'business_'+d.kind]);
 await c.query(`UPDATE ai_outbox SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END,cancellation_requested=true,updated_at=now() WHERE id IN(SELECT outbox_id FROM ai_followup_jobs WHERE request_phase_id IN(SELECT id FROM ai_request_phases WHERE request_id=$1)) AND state IN ('pending','dispatching')`,[phase.request_id]);
 if(d.kind==='requested_later')await c.query(`UPDATE ai_outbox SET state='cancelled',cancellation_requested=true,updated_at=now() WHERE request_phase_id IN(SELECT id FROM ai_request_phases WHERE request_id=$1) AND kind IN ('reply','first_message') AND state='pending'`,[phase.request_id]);
 if(['booking_confirmed','order_completed'].includes(d.kind)){
  const linked=(await c.query('SELECT id FROM ai_conversations WHERE active_phase_id IN(SELECT id FROM ai_request_phases WHERE request_id=$1) ORDER BY id FOR UPDATE',[phase.request_id])).rows.map(r=>r.id);
  await c.query("UPDATE ai_conversations SET automation_mode='paused',automation_epoch=automation_epoch+1,business_status=CASE WHEN manager_hold THEN business_status ELSE 'manager_working' END WHERE id=ANY($1::uuid[])",[linked]);
  await c.query("UPDATE ai_outbox SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END,cancellation_requested=true,updated_at=now() WHERE conversation_id=ANY($1::uuid[]) AND state IN ('pending','dispatching')",[linked]);
 }
 return{event,state:updated,replayed:false};
}
export class BusinessEvents{
 constructor(private pool:Pool){}
 async record(input:BusinessEventInput){
  const d=businessEventSchema.parse(input),c=await this.pool.connect();
  try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[d.operationId]);const result=await recordBusinessEventInTransaction(c,d);await c.query('COMMIT');return result;}
  catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 async detail(conversationId:string,db:Pool|PoolClient=this.pool){
  z.string().uuid().parse(conversationId);const v=(await db.query('SELECT active_phase_id FROM ai_conversations WHERE id=$1',[conversationId])).rows[0];
  const phase=(await db.query('SELECT request_id FROM ai_request_phases WHERE id=$1',[v?.active_phase_id])).rows[0];if(!phase)return{state:null,events:[]};
  return{state:(await db.query('SELECT * FROM ai_request_business_state WHERE request_id=$1',[phase.request_id])).rows[0]??{request_id:phase.request_id,revision:0,booking_state:'none',order_state:'none',followups_stopped:false,requested_contact_at:null},events:(await db.query('SELECT * FROM ai_business_events WHERE request_id=$1 ORDER BY created_at DESC,id LIMIT 100',[phase.request_id])).rows};
 }
}
