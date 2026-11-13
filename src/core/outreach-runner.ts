import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {AiManagerStore,type PreparedChannelSend} from './ai-manager.js';
import {OutreachService,OutreachError,outreachPreviewSchema} from './outreach.js';
const uuid=z.string().uuid();
export class OutreachRunner {
 constructor(private pool:Pool){}
 private async tx<T>(fn:(c:PoolClient)=>Promise<T>){const c=await this.pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");const v=await fn(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async create(input:{id:string;revision:number;requestIds:string[]}){
  uuid.parse(input.id);outreachPreviewSchema.parse(input);
  const fingerprint=createHash('sha256').update(JSON.stringify([input.revision,[...input.requestIds].sort()])).digest('hex');
  const existing=(await this.pool.query('SELECT * FROM ai_outreach_runs WHERE id=$1',[input.id])).rows[0];
  if(existing){if(existing.fingerprint!==fingerprint)throw new OutreachError('run_identity_conflict');return existing;}
  const preview=await new OutreachService(this.pool).preview(input);
  if(preview.eligible!==input.requestIds.length)throw new OutreachError('run_has_blocked_requests');
  return this.tx(async c=>{
   // Revision lock ensures preview settings cannot change before the run is committed.
   const settings=(await c.query('SELECT revision FROM ai_outreach_settings WHERE id=1 FOR SHARE')).rows[0];
   if(settings.revision!==input.revision)throw new OutreachError('settings_changed');
   await c.query('INSERT INTO ai_outreach_runs(id,fingerprint) VALUES($1,$2) ON CONFLICT DO NOTHING',[input.id,fingerprint]);
   const run=(await c.query('SELECT * FROM ai_outreach_runs WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(run.fingerprint!==fingerprint)throw new OutreachError('run_identity_conflict');
   for(const r of preview.rows)await c.query('INSERT INTO ai_outreach_items(run_id,request_id,contact_id,conversation_id) VALUES($1,$2,$3,$4) ON CONFLICT(run_id,request_id) DO NOTHING',[input.id,r.requestId,r.contactId,r.route!.conversationId]);
   return run;
  });
 }
 async control(id:string,state:'active'|'paused'|'stopped'){
  uuid.parse(id);z.enum(['active','paused','stopped']).parse(state);
  const result=await this.pool.query("UPDATE ai_outreach_runs SET state=$2 WHERE id=$1 AND state IN ('active','paused') RETURNING *",[id,state]);
  if(!result.rowCount)throw new OutreachError('run_not_controllable');return result.rows[0];
 }
 async list(){return(await this.pool.query(`SELECT r.*,count(i.*)::int total,count(*) FILTER(WHERE a.state='confirmed')::int confirmed,count(*) FILTER(WHERE a.state IN ('unknown','dispatching'))::int review FROM ai_outreach_runs r LEFT JOIN ai_outreach_items i ON i.run_id=r.id LEFT JOIN ai_outbox a ON a.id=i.action_id GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100`)).rows;}
 async items(id:string){uuid.parse(id);return(await this.pool.query('SELECT i.*,a.state,a.text,a.outcome_code,a.dispatch_started_at FROM ai_outreach_items i LEFT JOIN ai_outbox a ON a.id=i.action_id WHERE run_id=$1 ORDER BY request_id',[id])).rows;}
 async prepare(runId:string,requestId:string){
  uuid.parse(runId);uuid.parse(requestId);
  return this.tx(async c=>{
   const found=(await c.query('SELECT * FROM ai_outreach_items WHERE run_id=$1 AND request_id=$2',[runId,requestId])).rows[0];if(!found)throw new OutreachError('run_item_not_found',404);
   const contact=(await c.query('SELECT * FROM ai_contacts WHERE id=$1 FOR UPDATE',[found.contact_id])).rows[0];
   const conversation=(await c.query('SELECT * FROM ai_conversations WHERE id=$1 FOR UPDATE',[found.conversation_id])).rows[0];
   const run=(await c.query('SELECT state FROM ai_outreach_runs WHERE id=$1 FOR SHARE',[runId])).rows[0];
   if(run.state!=='active')return null;
   const item=(await c.query('SELECT * FROM ai_outreach_items WHERE run_id=$1 AND request_id=$2 FOR UPDATE',[runId,requestId])).rows[0];
   if(item.action_id)return item.action_id as string;
   const logical='request:'+requestId;
   const existing=(await c.query("SELECT * FROM ai_outbox WHERE contact_id=$1 AND kind='first_message' AND logical_key=$2",[contact.id,logical])).rows[0];
   if(existing){await c.query('UPDATE ai_outreach_items SET action_id=$3 WHERE run_id=$1 AND request_id=$2',[runId,requestId,existing.id]);return existing.id as string;}
   if(contact.opted_out_at||conversation.automation_mode!=='auto'||['closed','refused'].includes(conversation.business_status)){await c.query("UPDATE ai_outreach_items SET skipped_reason='contact_guard_changed' WHERE run_id=$1 AND request_id=$2",[runId,requestId]);return null;}
   const settings=(await c.query('SELECT * FROM ai_outreach_settings WHERE id=1 FOR SHARE')).rows[0];if(!settings.template.trim())return null;
   const text=settings.template,fingerprint=createHash('sha256').update(JSON.stringify(['first_message',text])).digest('hex');
   const action=(await c.query(`INSERT INTO ai_outbox(contact_id,conversation_id,logical_key,kind,text,fingerprint,automation_epoch) VALUES($1,$2,$3,'first_message',$4,$5,$6) RETURNING id`,[contact.id,conversation.id,logical,text,fingerprint,conversation.automation_epoch])).rows[0];
   await c.query('UPDATE ai_outreach_items SET action_id=$3 WHERE run_id=$1 AND request_id=$2',[runId,requestId,action.id]);return action.id as string;
  });
 }
 async tick(factory:(target:PreparedChannelSend['target'])=>Promise<PreparedChannelSend>){
  const items=(await this.pool.query(`SELECT i.* FROM ai_outreach_items i JOIN ai_outreach_runs r ON r.id=i.run_id LEFT JOIN ai_outbox a ON a.id=i.action_id WHERE r.state='active' AND i.skipped_reason IS NULL AND (i.action_id IS NULL OR a.state='pending') ORDER BY r.created_at,i.request_id LIMIT 100`)).rows;
  for(const item of items){const id=await this.prepare(item.run_id,item.request_id);if(!id)continue;const target=(await this.pool.query(`SELECT c.account_id AS "accountId",c.external_id AS "externalConversationId",c.platform FROM ai_outbox a JOIN ai_conversations c ON c.id=a.conversation_id WHERE a.id=$1`,[id])).rows[0];await new AiManagerStore(this.pool).dispatch(id,await factory(target));}
  await this.pool.query(`UPDATE ai_outreach_runs r SET state=CASE WHEN EXISTS(SELECT 1 FROM ai_outreach_items i JOIN ai_outbox a ON a.id=i.action_id WHERE i.run_id=r.id AND a.state='unknown') THEN 'review' ELSE 'completed' END WHERE state='active' AND NOT EXISTS(SELECT 1 FROM ai_outreach_items i LEFT JOIN ai_outbox a ON a.id=i.action_id WHERE i.run_id=r.id AND i.skipped_reason IS NULL AND (i.action_id IS NULL OR a.state IN ('pending','dispatching')))`);
 }
}
/** Explicit fixture transport. No platform connection, token, phone or network is used. */
export function syntheticTransport(target:PreparedChannelSend['target']):PreparedChannelSend{return {target,start:action=>({acknowledgement:Promise.resolve({operationId:action.operationId,outcome:'confirmed',code:'synthetic_confirmation',externalMessageId:'synthetic:'+action.operationId,retryCondition:'never'})})};}
