import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
/** Called with contact/conversation/action locks already held; never awaits transport. */
export async function outreachGuard(client:PoolClient,action:{id:string;text:string;kind:string},conversation:{account_id:string;platform:string;contact_id:string},reserve:boolean):Promise<'ready'|'wait'|'cancel'> {
 const item=(await client.query(`SELECT r.id,r.state FROM ai_outreach_items i JOIN ai_outreach_runs r ON r.id=i.run_id WHERE i.action_id=$1 ORDER BY r.id LIMIT 1 FOR SHARE OF r`,[action.id])).rows[0];
 if(!item)return 'ready';
 if(item.state==='stopped')return 'cancel';
 if(item.state!=='active')return 'wait';
 const s=(await client.query('SELECT * FROM ai_outreach_settings WHERE id=1 FOR SHARE')).rows[0];
 if(!s.template.trim())return 'wait';
 if(!s.account_ids.includes(conversation.account_id)||!s.platforms.includes(conversation.platform))return 'cancel';
 const blocked=(await client.query("SELECT 1 FROM ai_conversations WHERE contact_id=$1 AND (automation_mode='manual' OR business_status IN ('closed','refused')) LIMIT 1",[conversation.contact_id])).rowCount;
 if(blocked)return 'cancel';
 await client.query('INSERT INTO ai_outreach_clocks(account_id) VALUES($1) ON CONFLICT DO NOTHING',[conversation.account_id]);
 const clock=(await client.query(`SELECT last_started_at IS NULL OR last_started_at+($2*interval '1 second')<=clock_timestamp() AS ready FROM ai_outreach_clocks WHERE account_id=$1 FOR UPDATE`,[conversation.account_id,s.interval_seconds])).rows[0];
 if(!clock.ready)return 'wait';
 const uncertain=(await client.query(`SELECT 1 FROM ai_outbox a JOIN ai_conversations v ON v.id=a.conversation_id WHERE v.account_id=$1 AND a.id<>$2 AND a.state IN ('dispatching','unknown') LIMIT 1`,[conversation.account_id,action.id])).rowCount;
 if(uncertain)return 'wait';
 const parallel=(await client.query("SELECT 1 FROM ai_outbox WHERE contact_id=$1 AND id<>$2 AND kind='first_message' AND state IN ('dispatching','unknown') LIMIT 1",[conversation.contact_id,action.id])).rowCount;
 if(parallel)return 'wait';
 if(reserve){
  // Refresh text at the initiation boundary, leaving already-started operations immutable.
  action.text=s.template;
  const fingerprint=createHash('sha256').update(JSON.stringify([action.kind,action.text])).digest('hex');
  await client.query('UPDATE ai_outbox SET text=$2,fingerprint=$3 WHERE id=$1',[action.id,action.text,fingerprint]);
 }
 return 'ready';
}
