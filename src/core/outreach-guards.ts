import {sourceRuntimeReady} from './source-runtime-health.js';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
/** Static SQL predicate: the current outbox row must be aliased a. */
export const firstOutreachSql=`(EXISTS(SELECT 1 FROM ai_outreach_items WHERE action_id=a.id) OR EXISTS(
 SELECT 1 FROM ai_request_phases p JOIN ai_request_sources s ON s.request_id=p.request_id AND s.conversation_id=p.conversation_id
 WHERE p.id=a.request_phase_id AND s.initial_contact AND s.lead_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM ai_outbox o JOIN ai_request_phases op ON op.id=o.request_phase_id WHERE op.request_id=p.request_id AND o.id<>a.id AND o.dispatch_started_at IS NOT NULL AND (o.dispatch_state IS DISTINCT FROM 'not_started' OR o.state IN ('confirmed','unknown','dispatching')))
 AND NOT EXISTS(SELECT 1 FROM ai_inbox i JOIN ai_request_phases ip ON ip.id=i.request_phase_id WHERE ip.request_id=p.request_id AND i.origin='human' AND i.direction='outbound')
))`;
/** Called with contact/conversation/action locks already held; never awaits transport. */
export async function outreachGuard(client:PoolClient,action:{id:string;text:string;kind:string},conversation:{account_id:string;platform:string;contact_id:string},reserve:boolean):Promise<'ready'|'wait'|'cancel'> {
 const item=(await client.query(`SELECT r.id,r.state FROM ai_outreach_items i JOIN ai_outreach_runs r ON r.id=i.run_id WHERE i.action_id=$1 ORDER BY r.id LIMIT 1 FOR SHARE OF r`,[action.id])).rows[0];
 if(!item){
  if(action.kind==='manual_reply'||!(await client.query(`SELECT 1 FROM ai_outbox a WHERE a.id=$1 AND ${firstOutreachSql}`,[action.id])).rowCount)return 'ready';
  const source=(await client.query(`SELECT s.*,l.status,m.mode,m.epoch AS current_epoch,r.monitor_epoch FROM ai_outbox a JOIN ai_request_phases p ON p.id=a.request_phase_id JOIN ai_request_sources s ON s.request_id=p.request_id AND s.conversation_id=a.conversation_id JOIN ai_leads l ON l.id=s.lead_id JOIN ai_source_messages r ON r.id=l.source_message_id CROSS JOIN ai_monitor_settings m WHERE a.id=$1 AND s.initial_contact AND m.id=1 ORDER BY s.created_at LIMIT 1 FOR SHARE OF l,m`,[action.id])).rows[0];
  if(!source||source.status!=='approved'||source.mode==='stopped'||source.current_epoch!==source.monitor_epoch)return 'cancel';
  if(source.mode!=='active'||!await sourceRuntimeReady(client,[source.platform]))return 'wait';
  if(!(await client.query('SELECT 1 FROM ai_search_sources WHERE account_id=$1 AND platform=$2 AND chat_id=$3 FOR SHARE',[source.reader_account_id,source.platform,source.external_chat_id])).rowCount)return 'cancel';
 }else{
  if(item.state==='stopped')return 'cancel';
  if(item.state!=='active')return 'wait';
 }
 const s=(await client.query('SELECT * FROM ai_outreach_settings WHERE id=1 FOR SHARE')).rows[0];
 if(item&&!s.template.trim())return 'wait';
 if(!s.account_ids.includes(conversation.account_id)||!s.platforms.includes(conversation.platform))return 'cancel';
 const blocked=(await client.query("SELECT 1 FROM ai_conversations v LEFT JOIN ai_request_phases p ON p.id=v.active_phase_id WHERE v.contact_id=$1 AND v.business_status<>'closed' AND (v.automation_mode='manual' OR v.business_status='refused') AND (p.id IS NULL OR p.closed_at IS NULL) LIMIT 1",[conversation.contact_id])).rowCount;
 if(blocked)return 'cancel';
 await client.query('INSERT INTO ai_outreach_clocks(account_id) VALUES($1) ON CONFLICT DO NOTHING',[conversation.account_id]);
 const clock=(await client.query(`SELECT last_started_at IS NULL OR last_started_at+($2*interval '1 second')<=clock_timestamp() AS ready FROM ai_outreach_clocks WHERE account_id=$1 FOR UPDATE`,[conversation.account_id,s.interval_seconds])).rows[0];
 if(!clock.ready)return 'wait';
 const uncertain=(await client.query(`SELECT 1 FROM ai_outbox a JOIN ai_conversations v ON v.id=a.conversation_id WHERE v.account_id=$1 AND a.id<>$2 AND a.state IN ('dispatching','unknown') LIMIT 1`,[conversation.account_id,action.id])).rowCount;
 if(uncertain)return 'wait';
 const parallel=(await client.query("SELECT 1 FROM ai_outbox WHERE contact_id=$1 AND id<>$2 AND kind='first_message' AND state IN ('dispatching','unknown') LIMIT 1",[conversation.contact_id,action.id])).rowCount;
 if(parallel)return 'wait';
 if(reserve&&item){
  // Refresh text at the initiation boundary, leaving already-started operations immutable.
  action.text=s.template;
  const fingerprint=createHash('sha256').update(JSON.stringify([action.kind,action.text])).digest('hex');
  await client.query('UPDATE ai_outbox SET text=$2,fingerprint=$3 WHERE id=$1',[action.id,action.text,fingerprint]);
 }
 return 'ready';
}
