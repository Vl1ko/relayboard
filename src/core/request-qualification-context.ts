import type {Pool} from 'pg';
import type {GroundedFields} from './ai-engine.js';
/** One request owns qualification memory; transport message IDs are not globally unique. */
export async function requestQualificationContext(pool:Pool,conversationId:string,settingsVersion:number){
 const phases=(await pool.query(`SELECT p.id,p.conversation_id,p.settings_version,s.reply_count FROM ai_request_phases p
  JOIN ai_conversations v ON v.active_phase_id=p.id JOIN ai_engine_state s ON s.conversation_id=v.id
  WHERE p.request_id=(SELECT request_id FROM ai_request_phases WHERE id=(SELECT active_phase_id FROM ai_conversations WHERE id=$1)) AND p.closed_at IS NULL`,[conversationId])).rows;
 if(phases.length<2)return null;
 const ids=phases.map(p=>p.id),compatible=phases.every(p=>p.settings_version===settingsVersion);
 const messages=(await pool.query(`SELECT event_key,ingest_sequence,conversation_id,external_message_id AS "messageId",left(text,4000) AS text,origin FROM ai_inbox WHERE request_phase_id=ANY($1::uuid[]) ORDER BY ingest_sequence DESC LIMIT 40`,[ids])).rows.reverse();
 // State fields are accepted by the server, but each copied proof must still be a
 // customer quote in this exact request phase. Order by proof, not last state update.
 const proven=(await pool.query(`SELECT f.key,f.value,i.event_key,i.ingest_sequence FROM ai_request_phases p
  JOIN ai_conversations v ON v.active_phase_id=p.id JOIN ai_engine_state s ON s.conversation_id=v.id
  CROSS JOIN LATERAL jsonb_each(s.fields) f
  JOIN LATERAL(SELECT event_key,ingest_sequence FROM ai_inbox WHERE request_phase_id=p.id AND origin='customer'
   AND (external_message_id=f.value->>'evidenceMessageId' OR event_key=f.value->>'evidenceMessageId')
   AND position(f.value->>'evidenceQuote' in text)>0 ORDER BY ingest_sequence DESC LIMIT 1)i ON true
  WHERE p.id=ANY($1::uuid[]) ORDER BY i.ingest_sequence,f.key`,[ids])).rows;
 const fields:GroundedFields=Object.create(null);
 for(const proof of proven)fields[proof.key]={...proof.value,evidenceMessageId:proof.event_key};
 return{compatible,fields,messages:messages.map(m=>({...m,messageId:m.event_key})),replyCount:phases.reduce((n,p)=>n+p.reply_count,0)};
}
