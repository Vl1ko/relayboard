import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
export const monitorSettingsSchema=z.object({
 instructions:z.string().trim().max(4000),includeTerms:z.array(z.string().trim().min(1).max(100)).max(60),excludeTerms:z.array(z.string().trim().min(1).max(100)).max(60),
 confidenceThreshold:z.number().min(0.5).max(0.99),autoContact:z.boolean(),
}).strict();
export type MonitorSettings=z.infer<typeof monitorSettingsSchema>;
export class SourceMonitorSettings{
 constructor(private pool:Pool){}
 async get(){return(await this.pool.query('SELECT * FROM ai_monitor_settings WHERE id=1')).rows[0];}
 async save(input:{expectedRevision:number;settings:MonitorSettings}){
  const d=z.object({expectedRevision:z.number().int().nonnegative(),settings:monitorSettingsSchema}).strict().parse(input);
  const result=await this.pool.query(`UPDATE ai_monitor_settings SET settings=$2::jsonb,mode=CASE WHEN mode='active' AND coalesce($2::jsonb->>'instructions','')='' AND EXISTS(SELECT 1 FROM ai_search_sources s LEFT JOIN ai_chat_criteria p ON p.platform=s.platform AND p.chat_id=s.chat_id WHERE p.mode IS NULL OR p.mode='inherit' OR coalesce(p.settings->>'instructions','')='') THEN 'paused' ELSE mode END,revision=revision+1,updated_at=now() WHERE id=1 AND revision=$1 RETURNING *`,[d.expectedRevision,JSON.stringify(d.settings)]);
  if(!result.rowCount)throw Error('monitor_settings_changed');return result.rows[0];
 }
 async control(input:{expectedRevision:number;action:'start'|'pause'|'stop'}){
  const d=z.object({expectedRevision:z.number().int().nonnegative(),action:z.enum(['start','pause','stop'])}).strict().parse(input),c=await this.pool.connect();
  try{
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
   const current=(await c.query('SELECT * FROM ai_monitor_settings WHERE id=1 FOR UPDATE')).rows[0];if(current.revision!==d.expectedRevision)throw Error('monitor_settings_changed');
   if(d.action==='start'){
    if(!monitorSettingsSchema.parse(current.settings).instructions&&(await c.query("SELECT 1 FROM ai_search_sources s LEFT JOIN ai_chat_criteria p ON p.platform=s.platform AND p.chat_id=s.chat_id WHERE p.mode IS NULL OR p.mode='inherit' OR coalesce(p.settings->>'instructions','')='' LIMIT 1")).rowCount)throw Error('monitor_instructions_required');
    const engine=(await c.query('SELECT settings FROM ai_engine_settings ORDER BY version DESC LIMIT 1')).rows[0]?.settings;
    if(engine?.provider!=='gigachat'||!/^GigaChat(?:-[A-Za-z0-9]+)*$/.test(engine?.model??''))throw Error('monitor_ai_required');
    if((await c.query("SELECT 1 FROM ai_search_sources s LEFT JOIN ai_chat_criteria p ON p.platform=s.platform AND p.chat_id=s.chat_id WHERE CASE WHEN p.mode='replace' THEN (p.settings->>'autoContact')::boolean WHEN p.mode='extend' THEN $1::boolean AND (p.settings->>'autoContact')::boolean ELSE $1::boolean END LIMIT 1",[current.settings.autoContact])).rowCount){
     if(!engine?.qualificationEnabled)throw Error('monitor_qualification_required');
     const outreach=(await c.query('SELECT account_ids FROM ai_outreach_settings WHERE id=1')).rows[0];
     if(!outreach?.account_ids?.length)throw Error('monitor_sender_required');
    }
    const sources=(await c.query('SELECT platform,chat_id FROM ai_search_sources')).rows;
    if((await c.query("SELECT 1 FROM ai_search_sources s LEFT JOIN integrations i ON i.id=s.account_id WHERE i.id IS NULL OR NOT i.enabled OR i.auth_error IS NOT NULL LIMIT 1")).rowCount)throw Error('monitor_sources_unavailable');
    if(!sources.length||sources.some(s=>!['max','whatsapp'].includes(s.platform)))throw Error('monitor_sources_required');
    if(new Set(sources.map(s=>JSON.stringify([s.platform,s.chat_id]))).size!==sources.length)throw Error('monitor_duplicate_reader');
   }
   const mode=d.action==='start'?'active':d.action==='pause'?'paused':'stopped';
   if(d.action==='pause'&&current.mode==='stopped')throw Error('monitor_not_started');
   const newEpoch=(d.action==='start'&&current.mode==='stopped')||d.action==='stop';
   const row=(await c.query(`UPDATE ai_monitor_settings SET mode=$1,revision=revision+1,epoch=epoch+CASE WHEN $2 THEN 1 ELSE 0 END,started_at=CASE WHEN $1='active' AND mode='stopped' THEN clock_timestamp() ELSE started_at END,updated_at=now() WHERE id=1 RETURNING *`,[mode,newEpoch])).rows[0];
   if(d.action==='stop')await c.query("UPDATE ai_source_messages SET state='ignored',original_text=NULL,reason='monitor_stopped',scoring_token=NULL,lease_until=NULL,classified_at=now() WHERE state='pending'");
   await c.query('COMMIT');return row;
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
}

export function monitorCriteriaFingerprint(s:MonitorSettings){return createHash('sha256').update(JSON.stringify([s.instructions,s.includeTerms,s.excludeTerms])).digest('hex');}
