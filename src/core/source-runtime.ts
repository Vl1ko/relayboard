import {readChatCriteria} from './chat-criteria.js';
import {monitorSettingsSchema,monitorCriteriaFingerprint} from './source-monitor-settings.js';
import type {Pool} from 'pg';
import {SourceMonitor,type SourceScorer} from './source-monitor.js';
import {activateSource,type VerifiedSourceRoute} from './source-activation.js';
import type {RuntimeScope} from './runtime-scope.js';
/** Low-priority bounded work; private client replies run before each monitor iteration. */
export class SourceRuntime{
 private monitor:SourceMonitor;
 constructor(private pool:Pool,private scope:RuntimeScope,private scorer:SourceScorer,private route:(leadId:string,platform:string)=>Promise<VerifiedSourceRoute>,private signal:AbortSignal){this.monitor=new SourceMonitor(pool,scope);}
 async tick(){
  this.signal.throwIfAborted();
  for(const item of await this.monitor.pending(1)){
   try{await this.monitor.classify(item.id,this.scorer,this.signal);}catch{if(!this.signal.aborted)console.error('Source classification deferred; original retained');}
  }
  this.signal.throwIfAborted();
  const leads=(await this.pool.query(`SELECT l.id,l.platform,l.chat_id,l.confidence,l.classification,p.settings FROM ai_leads l JOIN ai_source_messages s ON s.id=l.source_message_id JOIN ai_monitor_settings p ON p.id=1 AND p.epoch=s.monitor_epoch WHERE p.mode='active' AND (SELECT coalesce((settings->>'qualificationEnabled')::boolean,false) FROM ai_engine_settings ORDER BY version DESC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM ai_source_notifications n WHERE n.lead_id=l.id) AND l.status='pending' AND l.revision=0 AND l.activation_error IS DISTINCT FROM 'source_requires_review' AND l.classification->>'intent'='demand' AND (l.activation_after IS NULL OR l.activation_after<=clock_timestamp()) ORDER BY l.created_at,l.id LIMIT 5`)).rows;
  for(const lead of leads){
   this.signal.throwIfAborted();
   try{const {settings,fingerprint}=await readChatCriteria(this.pool,lead.platform,lead.chat_id,monitorSettingsSchema.parse(lead.settings));if(!settings.autoContact||lead.confidence<settings.confidenceThreshold||lead.classification?.criteriaFingerprint!==fingerprint){await this.pool.query("UPDATE ai_leads SET activation_error='source_requires_review' WHERE id=$1 AND status='pending'",[lead.id]);continue;}await activateSource(this.pool,this.scope,await this.route(lead.id,lead.platform),'automatic');}
   catch(error){if(this.signal.aborted)throw error;await this.pool.query("UPDATE ai_leads SET activation_after=clock_timestamp()+interval '30 seconds',activation_error=$2 WHERE id=$1 AND status='pending'",[lead.id,error instanceof Error&&/^source_[a-z_]+$/.test(error.message)?error.message:'source_route_deferred']);}
  }
 }
}
