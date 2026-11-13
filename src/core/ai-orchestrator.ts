import {DEFAULT_GREETING} from './conversation-templates.js';
import type {Pool} from 'pg';
import {AiManagerStore} from './ai-manager.js';
import {AiEngineStore,verifyAiQualification,type AiProvider} from './ai-engine.js';
import {ConversationWorkflow} from './conversation-workflow.js';
/** The connector must establish provenance before calling ingest; no network is installed here. */
export class AiOrchestrator {
 private messages:AiManagerStore; private engine:AiEngineStore; private workflow:ConversationWorkflow;
 constructor(private pool:Pool){this.messages=new AiManagerStore(pool);this.engine=new AiEngineStore(pool);this.workflow=new ConversationWorkflow(pool,{verifyQualification:verifyAiQualification});}
 async ingest(event:unknown){return this.messages.ingest(event);}
 async process(conversationId:string,eventKey:string,provider:AiProvider){
  const saved=(await this.pool.query('SELECT * FROM ai_engine_decisions WHERE conversation_id=$1 AND event_key=$2',[conversationId,eventKey])).rows[0];
  if(saved){
    const action=(await this.pool.query('SELECT * FROM ai_outbox WHERE conversation_id=$1 AND logical_key=$2',[conversationId,'ai-reply:'+saved.id])).rows[0];
    if(action)return {decision:saved,action};
    const notification=(await this.pool.query('SELECT * FROM ai_handoff_notifications WHERE conversation_id=$1 AND logical_key=$2',[conversationId,'ai-handoff:'+saved.id])).rows[0];
    if(notification)return {decision:saved,notification};
  }
  const decision=await this.engine.evaluate(conversationId,eventKey,provider);
  if(decision.disposition==='suppress')return {decision,action:null};
  if(decision.disposition==='reply'){
   const settings=(await this.pool.query('SELECT settings FROM ai_engine_settings WHERE version=$1',[decision.settings_version])).rows[0].settings;
   const prior=(await this.pool.query('SELECT 1 FROM ai_outbox WHERE conversation_id=$1 AND dispatch_started_at IS NOT NULL LIMIT 1',[conversationId])).rowCount;
   const rendered=prior?decision.reply:(settings.greetingMessage??DEFAULT_GREETING)+'\n\n'+decision.reply;
   const action=await this.messages.enqueue({conversationId,kind:'reply',logicalKey:'ai-reply:'+decision.id,expectedEpoch:decision.automation_epoch,text:rendered});
   return {decision,action:action.action};
  }
  const reason=decision.business_status==='qualified'?'qualified':decision.reason==='reply_limit'?'reply_limit':decision.reason==='requested_human'?'human_requested':'insufficient_data';
  const notification=await this.workflow.handoff({conversationId,key:'ai-handoff:'+decision.id,reason,summary:decision.reason,proof:decision.id,expectedEpoch:decision.automation_epoch,resultStatus:decision.business_status==='unqualified'?'unqualified':decision.business_status==='insufficient_data'?'insufficient_data':undefined,parameters:Object.fromEntries(Object.entries(decision.fields as Record<string,{value:unknown}>).map(([k,v])=>[k,String(v.value)])),source:{eventKey}});
  return {decision,notification};
 }
 async pending(limit=25){return(await this.pool.query(`SELECT v.id AS conversation_id,i.event_key FROM ai_conversations v JOIN ai_contacts c ON c.id=v.contact_id JOIN LATERAL (SELECT event_key,received_at,ingest_sequence FROM ai_inbox WHERE conversation_id=v.id AND origin='customer' ORDER BY ingest_sequence DESC LIMIT 1) i ON true LEFT JOIN ai_engine_decisions d ON d.conversation_id=v.id AND d.event_key=i.event_key LEFT JOIN ai_outbox a ON a.logical_key='ai-reply:'||d.id::text AND a.conversation_id=v.id LEFT JOIN ai_handoff_notifications n ON n.logical_key='ai-handoff:'||d.id::text AND n.conversation_id=v.id WHERE a.id IS NULL AND n.id IS NULL AND (d.id IS NULL OR d.automation_epoch=v.automation_epoch) AND v.automation_mode='auto' AND v.business_status NOT IN ('closed','refused','manager_working','manager_required') AND c.opted_out_at IS NULL ORDER BY i.ingest_sequence,v.id LIMIT $1`,[limit])).rows;}

}
/** Safe default fixture: unresolved business context is handed off, never invented. */
export const conservativeFixtureProvider:AiProvider={kind:'fixture',async complete(){return{replyDraft:'',extracted:[],replyKind:'handoff',askFields:[],knowledgeKeys:[],proposedStatus:'manager_required',handoffReason:'unknown_question'};}};
