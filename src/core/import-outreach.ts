import {randomUUID,createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {bindSourceRequestInTransaction} from './request-lifecycle.js';
import {runtimeAllows,type RuntimeScope} from './runtime-scope.js';
export type ImportRoute={conversationId:string;contactId:string;accountId:string;platform:'max'|'whatsapp';externalId:string;recipientId:string;excluded:boolean};
export type ImportLookup=(contactId:string,accountId:string,platform:'max'|'whatsapp')=>Promise<{found:false}|{found:true;route:ImportRoute}>;
export class ImportOutreach {
 constructor(private pool:Pool,private scope:RuntimeScope,private lookup:ImportLookup){}
 private async tx<T>(fn:(c:PoolClient)=>Promise<T>){const c=await this.pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 private async blocked(c:Pool|PoolClient,id:string){
  const r=(await c.query(`SELECT CASE WHEN opted_out_at IS NOT NULL THEN 'opted_out'
   WHEN EXISTS(SELECT 1 FROM ai_conversations WHERE contact_id=$1 AND manager_hold) THEN 'manager_hold'
   WHEN EXISTS(SELECT 1 FROM ai_outbox WHERE contact_id=$1 AND state IN ('dispatching','unknown')) THEN 'uncertain_send'
   WHEN EXISTS(SELECT 1 FROM ai_requests WHERE contact_id=$1) THEN 'existing_request'
   WHEN EXISTS(SELECT 1 FROM ai_outbox WHERE contact_id=$1) THEN 'existing_dialogue'
   WHEN EXISTS(SELECT 1 FROM ai_inbox i JOIN ai_conversations v ON v.id=i.conversation_id WHERE v.contact_id=$1) THEN 'existing_dialogue'
   WHEN EXISTS(SELECT 1 FROM ai_conversations WHERE contact_id=$1 AND (automation_epoch>0 OR automation_mode='manual' OR business_status<>'new')) THEN 'existing_dialogue'
   END AS reason FROM ai_contacts WHERE id=$1`,[id])).rows[0];return r?.reason;
 }
 async tick(){
  const token=randomUUID();
  const job=await this.tx(async c=>(await c.query(`WITH candidate AS (
   SELECT j.id FROM ai_import_outreach_jobs j JOIN ai_import_outreach_batches b ON b.id=j.batch_id
   WHERE b.state='active' AND j.state IN ('pending','resolving') AND j.retry_at<=now() AND (j.lease_until IS NULL OR j.lease_until<now())
   ORDER BY j.retry_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED)
   UPDATE ai_import_outreach_jobs j SET state='resolving',lease_token=$1,lease_until=now()+interval '120 seconds',updated_at=now()
   FROM candidate WHERE j.id=candidate.id RETURNING j.*`,[token])).rows[0]);
  if(!job)return;
  const timer=setInterval(()=>{void this.pool.query("UPDATE ai_import_outreach_jobs SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND lease_token=$2 AND state='resolving'",[job.id,token]).catch(()=>{});},30000);timer.unref();
  const finish=async(state:string,reason:string|null)=>this.pool.query(`UPDATE ai_import_outreach_jobs SET state=$3,reason=$4,lease_token=NULL,lease_until=NULL,retry_at=now()+interval '60 seconds',updated_at=now() WHERE id=$1 AND lease_token=$2`,[job.id,token,state,reason]);
  try{
   const blocked=await this.blocked(this.pool,job.contact_id);if(blocked){await finish('skipped',blocked);return;}
   const batch=(await this.pool.query('SELECT * FROM ai_import_outreach_batches WHERE id=$1',[job.batch_id])).rows[0];
   const contact=(await this.pool.query('SELECT phone_e164 FROM ai_contacts WHERE id=$1',[job.contact_id])).rows[0];
   // A test deployment must never probe arbitrary uploaded phone numbers.
   if(this.scope.testOnly&&!this.scope.authorIds.includes(contact.phone_e164?.slice(1)+'@c.us')&&!(await this.pool.query('SELECT 1 FROM ai_remote_identities WHERE contact_id=$1 AND verified_phone=$2 AND remote_user_id=ANY($3::text[])',[job.contact_id,contact.phone_e164,this.scope.authorIds])).rowCount){await finish('pending','outside_test_scope');return;}
   let chosen:ImportRoute|undefined;
   for(const platform of batch.platforms as ('max'|'whatsapp')[]){
    const accounts=(await this.pool.query('SELECT id,enabled,auth_error FROM integrations WHERE id=ANY($1::uuid[]) AND platform::text=$2 ORDER BY array_position($1::uuid[],id)',[batch.account_ids,platform])).rows;
    if(!accounts.length)throw Error('sender_unavailable');
    for(const a of accounts){
     if(!a.enabled||a.auth_error||this.scope.testOnly&&!this.scope.accountIds.includes(a.id))throw Error('sender_unavailable');
     if((await this.pool.query('SELECT state FROM ai_import_outreach_batches WHERE id=$1',[job.batch_id])).rows[0].state!=='active'){await finish('pending',null);return;}
     const found=await this.lookup(job.contact_id,a.id,platform);
     if(found.found){chosen=found.route;if(chosen.accountId!==a.id||chosen.platform!==platform||chosen.contactId!==job.contact_id||chosen.excluded||!runtimeAllows(this.scope,a.id,chosen.recipientId))throw Error('route_unverified');break;}
    }
    if(chosen)break;
   }
   if(!chosen){await finish('not_found','not_found');return;}
   const route=chosen;
   await this.tx(async c=>{
    await c.query('SELECT id FROM ai_contacts WHERE id=$1 FOR UPDATE',[job.contact_id]);
    const locked=(await c.query("SELECT * FROM ai_import_outreach_jobs WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state='resolving' FOR UPDATE",[job.id,token])).rows[0];if(!locked)return;
    const b=(await c.query('SELECT state FROM ai_import_outreach_batches WHERE id=$1 FOR SHARE',[job.batch_id])).rows[0];if(b.state!=='active'){await c.query("UPDATE ai_import_outreach_jobs SET state='pending',lease_token=NULL,lease_until=NULL WHERE id=$1",[job.id]);return;}
    const reason=await this.blocked(c,job.contact_id);if(reason){await c.query("UPDATE ai_import_outreach_jobs SET state='skipped',reason=$2,lease_until=NULL,lease_token=NULL WHERE id=$1",[job.id,reason]);return;}
    const settings=(await c.query('SELECT * FROM ai_outreach_settings WHERE id=1 FOR SHARE')).rows[0];
    if(!settings.template.trim()||!settings.platforms.includes(route.platform)||!settings.account_ids.includes(route.accountId))throw Error('settings_changed');
    if(!(await c.query(`SELECT 1 FROM ai_verified_routes v JOIN integrations a ON a.id=v.account_id WHERE v.conversation_id=$1 AND v.contact_id=$2 AND v.account_id=$3 AND v.platform=$4 AND v.external_id=$5 AND v.recipient_id=$6 AND v.verified_phone=$7 AND a.enabled`,[route.conversationId,job.contact_id,route.accountId,route.platform,route.externalId,route.recipientId,contact.phone_e164])).rowCount)throw Error('route_unverified');
    const bound=await bindSourceRequestInTransaction(c,{expectedContactId:job.contact_id,conversationId:route.conversationId,accountId:route.accountId,platform:route.platform,chatId:'import:'+job.id,messageId:job.id,authorId:route.recipientId,recipientId:route.recipientId});
    if(!bound.created||!bound.activated)throw Error('request_not_activated');
    const fingerprint=createHash('sha256').update(JSON.stringify(['import',job.id,bound.requestId])).digest('hex');
    await c.query('INSERT INTO ai_outreach_runs(id,fingerprint) VALUES($1,$2)',[job.id,fingerprint]);
    await c.query('INSERT INTO ai_outreach_items(run_id,request_id,contact_id,conversation_id) VALUES($1,$2,$3,$4)',[job.id,bound.requestId,job.contact_id,route.conversationId]);
    await c.query("UPDATE ai_import_outreach_jobs SET state='ready',reason=NULL,request_id=$3,conversation_id=$4,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[job.id,token,bound.requestId,route.conversationId]);
   });
  }catch{await finish('pending','lookup_deferred');}finally{clearInterval(timer);}
 }
}
