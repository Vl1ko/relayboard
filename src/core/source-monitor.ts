import {readChatCriteria} from './chat-criteria.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {runtimeAllows,type RuntimeScope} from './runtime-scope.js';
import {monitorSettingsSchema,monitorCriteriaFingerprint,type MonitorSettings} from './source-monitor-settings.js';
import {checkLeadEvidence,leadParamsSchema} from './lead-intake.js';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const opaque=z.string().min(1).max(512).refine(v=>!!v.trim());
export const monitoredSourceSchema=z.object({platform:z.enum(['max','whatsapp']),accountId:z.string().uuid(),chatId:opaque,authorId:opaque,messageId:opaque,occurredAt:z.string().datetime({offset:true}),text:z.string().min(1).max(8000).refine(v=>!!v.trim()),selfAuthorIds:z.array(opaque).min(1).max(8)}).strict();
export const sourceAssessmentSchema=z.object({intent:z.enum(['demand','offer','other','ambiguous']),confidence:z.number().min(0).max(1),demandQuote:z.string().max(2000),params:leadParamsSchema}).strict();
export interface SourceScorer{
 complete(input:{model:string|null;provider:string;settings:MonitorSettings;fields:{key:string;question:string}[];text:string;signal:AbortSignal}):Promise<unknown>;
 runExclusive?<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>;
}
/** Only authenticated group readers call capture; this module never selects a recipient or sends. */
export class SourceMonitor{
 constructor(private pool:Pool,private scope:RuntimeScope,private maxPending=5000){if(!Number.isSafeInteger(maxPending)||maxPending<1)throw Error('source_queue_limit_invalid');}
 async capture(input:z.input<typeof monitoredSourceSchema>){
  const s=monitoredSourceSchema.parse(input);
  if(!runtimeAllows(this.scope,s.accountId,s.authorId))return{captured:false,reason:'outside_runtime_scope'};
  if(s.selfAuthorIds.includes(s.authorId))return{captured:false,reason:'own_message'};
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
   const policy=(await c.query('SELECT * FROM ai_monitor_settings WHERE id=1 FOR SHARE')).rows[0];
   if(policy.mode==='stopped'){await c.query('COMMIT');return{captured:false,reason:'monitor_stopped'};}
   if(!(await c.query(`SELECT 1 FROM ai_search_sources s JOIN integrations i ON i.id=s.account_id WHERE s.account_id=$1 AND s.chat_id=$2 AND s.platform=$3 AND i.enabled AND i.auth_error IS NULL FOR SHARE OF s,i`,[s.accountId,s.chatId,s.platform])).rowCount){await c.query('COMMIT');return{captured:false,reason:'source_not_selected'};}
   const cutoff=new Date(policy.started_at).getTime(),occurred=new Date(s.occurredAt).getTime();
   if(occurred<(s.platform==='whatsapp'?Math.floor(cutoff/1000)*1000:cutoff)){await c.query('COMMIT');return{captured:false,reason:'before_monitor_start'};}
   const effective=await readChatCriteria(c,s.platform,s.chatId,monitorSettingsSchema.parse(policy.settings)),settings=effective.settings,text=s.text.toLocaleLowerCase();
   let reason:string|null=settings.excludeTerms.some(t=>text.includes(t.toLocaleLowerCase()))?'excluded_term':effective.includeGroups.some(group=>!group.some(t=>text.includes(t.toLocaleLowerCase())))?'no_included_term':null;
   if(!this.scope.testOnly&&(await c.query(`SELECT 1 FROM integrations WHERE platform::text=$1 AND (CASE WHEN platform='max' THEN max_self_id::text ELSE whatsapp_self_id END=$2 OR platform='whatsapp' AND whatsapp_self_aliases ? $2)`,[s.platform,s.authorId])).rowCount)reason='owned_account';
   if((await c.query(`SELECT 1 FROM ai_remote_identities i JOIN ai_contacts p ON p.id=i.contact_id WHERE i.platform=$1 AND i.remote_user_id=$2 AND i.namespace IN ('global',$3) AND p.opted_out_at IS NOT NULL`,[s.platform,s.authorId,'account:'+s.accountId])).rowCount)reason='contact_opted_out';
   const fingerprint=hash([s.platform,s.chatId,s.messageId,s.authorId,new Date(s.occurredAt).toISOString(),s.text]);
   if(!reason)await c.query("SELECT pg_advisory_xact_lock(hashtextextended('source-capture-capacity',0))");
   const existing=(await c.query('SELECT id,state,fingerprint FROM ai_source_messages WHERE platform=$1 AND chat_id=$2 AND message_id=$3',[s.platform,s.chatId,s.messageId])).rows[0];
   if(existing){if(existing.fingerprint!==fingerprint)throw Error('source_content_conflict');await c.query('COMMIT');return{captured:false,id:existing.id,state:existing.state,replayed:true};}
   if(!reason&&Number((await c.query("SELECT count(*) AS n FROM ai_source_messages WHERE state='pending'")).rows[0].n)>=this.maxPending)throw Error('source_capture_capacity');
   const inserted=await c.query(`INSERT INTO ai_source_messages(platform,account_id,chat_id,author_id,message_id,occurred_at,fingerprint,original_text,monitor_epoch,monitor_revision,state,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(platform,chat_id,message_id) DO NOTHING RETURNING id,state`,[s.platform,s.accountId,s.chatId,s.authorId,s.messageId,s.occurredAt,fingerprint,reason?null:s.text,policy.epoch,policy.revision,reason?'ignored':'pending',reason]);
   const row=inserted.rows[0]??(await c.query('SELECT id,state,fingerprint FROM ai_source_messages WHERE platform=$1 AND chat_id=$2 AND message_id=$3',[s.platform,s.chatId,s.messageId])).rows[0];
   if(!inserted.rowCount&&row.fingerprint!==fingerprint)throw Error('source_content_conflict');
   await c.query('COMMIT');return{captured:!!inserted.rowCount,id:row.id,state:row.state,replayed:!inserted.rowCount};
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 async pending(limit=20){return(await this.pool.query(`SELECT s.id FROM ai_source_messages s JOIN ai_monitor_settings p ON p.id=1 AND p.epoch=s.monitor_epoch WHERE p.mode='active' AND s.state='pending' AND (s.retry_after IS NULL OR s.retry_after<=clock_timestamp()) AND (s.lease_until IS NULL OR s.lease_until<=clock_timestamp()) ORDER BY s.captured_at,s.id LIMIT $1`,[limit])).rows;}
 async classify(id:string,scorer:SourceScorer,signal:AbortSignal){
  z.string().uuid().parse(id);
  const evaluate=async(slot:AbortSignal)=>{
   const token=randomUUID();let claimed=false;
   try{
    signal.throwIfAborted();slot.throwIfAborted();
    const source=(await this.pool.query(`SELECT s.*,p.revision,p.settings FROM ai_source_messages s JOIN ai_monitor_settings p ON p.id=1 AND p.epoch=s.monitor_epoch WHERE s.id=$1 AND s.state='pending' AND p.mode='active'`,[id])).rows[0];
    if(!source||!runtimeAllows(this.scope,source.account_id,source.author_id))return{classified:false};
    if(!(await this.pool.query('SELECT 1 FROM ai_search_sources s JOIN integrations i ON i.id=s.account_id WHERE s.account_id=$1 AND s.chat_id=$2 AND s.platform=$3 AND i.enabled AND i.auth_error IS NULL',[source.account_id,source.chat_id,source.platform])).rowCount)return{classified:false};
    if((await this.pool.query(`SELECT 1 FROM ai_remote_identities i JOIN ai_contacts c ON c.id=i.contact_id WHERE i.platform=$1 AND i.remote_user_id=$2 AND i.namespace IN ('global',$3) AND c.opted_out_at IS NOT NULL`,[source.platform,source.author_id,'account:'+source.account_id])).rowCount){
     await this.pool.query("UPDATE ai_source_messages SET state='ignored',original_text=NULL,reason='contact_opted_out',scoring_token=NULL,lease_until=NULL,classified_at=now() WHERE id=$1 AND state='pending'",[id]);return{classified:false};
    }
    const effective=await readChatCriteria(this.pool,source.platform,source.chat_id,monitorSettingsSchema.parse(source.settings)),settings=effective.settings;if(!settings.instructions)return{classified:false};
    const lower=source.original_text.toLocaleLowerCase(),keywordReason=settings.excludeTerms.some(t=>lower.includes(t.toLocaleLowerCase()))?'excluded_term':effective.includeGroups.some(group=>!group.some(t=>lower.includes(t.toLocaleLowerCase())))?'no_included_term':null;
    if(keywordReason){await this.pool.query("UPDATE ai_source_messages s SET state='ignored',original_text=NULL,reason=$2,classified_at=now() FROM ai_monitor_settings p WHERE s.id=$1 AND s.state='pending' AND p.id=1 AND p.mode='active' AND p.revision=$3 AND p.epoch=s.monitor_epoch",[id,keywordReason,source.revision]);return{classified:false};}
    const owned=await this.pool.query(`UPDATE ai_source_messages SET scoring_token=$2,lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1 AND state='pending' AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND (retry_after IS NULL OR retry_after<=clock_timestamp()) RETURNING id`,[id,token]);
    if(!owned.rowCount)return{classified:false};claimed=true;
    const engine=(await this.pool.query('SELECT version,settings FROM ai_engine_settings ORDER BY version DESC LIMIT 1')).rows[0],fields=(engine.settings.fields??[]) as {key:string;question:string}[];
    const result=sourceAssessmentSchema.parse(await scorer.complete({model:engine.settings.model,provider:engine.settings.provider,settings,fields:fields.map(({key,question})=>({key,question})),text:source.original_text,signal:AbortSignal.any([signal,slot,AbortSignal.timeout(15000)])}));
    signal.throwIfAborted();slot.throwIfAborted();
    if(result.params.some(p=>!fields.some(f=>f.key===p.key)))throw Error('source_parameter_unknown');
    checkLeadEvidence(source.original_text,result.params);
    if(result.params.some(p=>(engine.settings.rules??[]).some((r:{field:string;op:string})=>r.field===p.key&&['gte','lte'].includes(r.op))&&typeof p.value!=='number'))throw Error('source_parameter_type');
    if(result.intent==='demand'&&!result.demandQuote.trim()||result.demandQuote&&!source.original_text.includes(result.demandQuote))throw Error('source_demand_unverified');
    const c=await this.pool.connect();
    try{
     await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
     const policy=(await c.query('SELECT * FROM ai_monitor_settings WHERE id=1 FOR SHARE')).rows[0];
     const current=(await c.query('SELECT * FROM ai_source_messages WHERE id=$1 FOR UPDATE',[id])).rows[0];
     const selected=(await c.query('SELECT 1 FROM ai_search_sources s JOIN integrations i ON i.id=s.account_id WHERE s.account_id=$1 AND s.chat_id=$2 AND s.platform=$3 AND i.enabled AND i.auth_error IS NULL FOR SHARE OF s,i',[source.account_id,source.chat_id,source.platform])).rowCount;
     if(current.state!=='pending'||current.scoring_token!==token||policy.mode!=='active'||policy.epoch!==source.monitor_epoch||policy.revision!==source.revision||!selected){
      await c.query('UPDATE ai_source_messages SET scoring_token=NULL,lease_until=NULL WHERE id=$1 AND scoring_token=$2',[id,token]);await c.query('COMMIT');return{classified:false,reason:'source_policy_changed'};
     }
     const candidate=['demand','ambiguous'].includes(result.intent);
     let leadId:string|undefined;
     if(candidate){
      const key='lead:v1:'+hash([source.platform,source.account_id,source.chat_id,source.message_id]);
      const fingerprint=hash([source.platform,source.account_id,source.chat_id,source.author_id,source.message_id,new Date(source.occurred_at).toISOString(),null,source.original_text]);
      const created=await c.query(`INSERT INTO ai_leads(source_key,source_fingerprint,platform,account_id,chat_id,author_id,message_id,occurred_at,original_text,source_kind,params,confidence,source_message_id,classification)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'monitor',$10,$11,$12,$13) ON CONFLICT(source_key) DO UPDATE SET source_key=ai_leads.source_key WHERE ai_leads.source_fingerprint=excluded.source_fingerprint AND (ai_leads.source_message_id IS NULL OR ai_leads.source_message_id=excluded.source_message_id) RETURNING id`,[key,fingerprint,source.platform,source.account_id,source.chat_id,source.author_id,source.message_id,source.occurred_at,source.original_text,JSON.stringify(result.params),result.confidence,id,JSON.stringify({...result,params:undefined,monitorRevision:policy.revision,criteriaFingerprint:effective.fingerprint,engineSettingsVersion:engine.version})]);
      if(!created.rowCount)throw Error('source_lead_conflict');leadId=created.rows[0].id;
     }
     await c.query(`UPDATE ai_source_messages SET state=$2,original_text=NULL,reason=$3,scoring_token=NULL,lease_until=NULL,classified_at=now(),monitor_revision=$4 WHERE id=$1`,[id,candidate?'classified':'ignored',result.intent,policy.revision]);
     await c.query('COMMIT');return{classified:true,leadId,autoEligible:result.intent==='demand'&&result.confidence>=settings.confidenceThreshold&&settings.autoContact};
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
   }catch(error){
    if(claimed)await this.pool.query("UPDATE ai_source_messages SET scoring_token=NULL,lease_until=NULL,retry_after=clock_timestamp()+interval '30 seconds',reason='classification_deferred' WHERE id=$1 AND state='pending' AND scoring_token=$2",[id,token]);
    throw error;
   }
  };
  return scorer.runExclusive?scorer.runExclusive(evaluate):evaluate(signal);
 }
}
