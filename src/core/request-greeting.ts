import type {Pool,PoolClient} from 'pg';
/** A criteria revision is a new phase, not a new request or another greeting. */
export async function requestHasOutgoing(db:Pool|PoolClient,conversationId:string){
 const result=await db.query(`WITH current AS(
  SELECT v.id,v.contact_id,p.request_id FROM ai_conversations v LEFT JOIN ai_request_phases p ON p.id=v.active_phase_id WHERE v.id=$1
 ) SELECT 1 FROM current v WHERE EXISTS(
  SELECT 1 FROM ai_outbox a LEFT JOIN ai_request_phases p ON p.id=a.request_phase_id
  WHERE a.contact_id=v.contact_id AND a.dispatch_started_at IS NOT NULL AND (a.dispatch_state IS DISTINCT FROM 'not_started' OR a.state IN ('confirmed','unknown','dispatching'))
  AND (v.request_id IS NOT NULL AND p.request_id=v.request_id OR v.request_id IS NULL AND a.conversation_id=v.id AND a.request_phase_id IS NULL)
 ) OR EXISTS(
  SELECT 1 FROM ai_inbox i JOIN ai_conversations c ON c.id=i.conversation_id LEFT JOIN ai_request_phases p ON p.id=i.request_phase_id
  WHERE c.contact_id=v.contact_id AND i.direction='outbound' AND i.origin='human'
  AND (v.request_id IS NOT NULL AND p.request_id=v.request_id OR v.request_id IS NULL AND i.conversation_id=v.id AND i.request_phase_id IS NULL)
 ) LIMIT 1`,[conversationId]);return!!result.rowCount;
}
