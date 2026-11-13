import type {Pool} from 'pg';
import {AiOrchestrator} from './ai-orchestrator.js';
import {AiManagerStore,type PreparedChannelSend} from './ai-manager.js';
import {ConversationWorkflow} from './conversation-workflow.js';
import {verifyAiQualification,type AiProvider} from './ai-engine.js';
import {OutreachRunner} from './outreach-runner.js';

export type RuntimeTransport={
 allowsConversation:(id:string)=>Promise<boolean>;
 dispatchAction:(id:string,target:PreparedChannelSend['target'])=>Promise<unknown>;
 dispatchNotification:(id:string)=>Promise<unknown>;
};
/** Durable input/outbox state drives every iteration; no browser/session Map owns business state. */
export class AiExecutionRuntime{
 private orchestrator:AiOrchestrator;private messages:AiManagerStore;private workflow:ConversationWorkflow;private runner:OutreachRunner;
 constructor(private pool:Pool,private provider:AiProvider,private transport:RuntimeTransport,private signal:AbortSignal){
  this.orchestrator=new AiOrchestrator(pool);this.messages=new AiManagerStore(pool);this.workflow=new ConversationWorkflow(pool,{verifyQualification:verifyAiQualification});this.runner=new OutreachRunner(pool);
 }
 private async deliver(id:string){
  this.signal.throwIfAborted();
  const a=(await this.pool.query(`SELECT a.id,v.id AS conversation_id,v.account_id AS "accountId",v.external_id AS "externalConversationId",v.platform FROM ai_outbox a JOIN ai_conversations v ON v.id=a.conversation_id WHERE a.id=$1 AND a.state='pending'`,[id])).rows[0];
  if(a&&await this.transport.allowsConversation(a.conversation_id)){this.signal.throwIfAborted();await this.transport.dispatchAction(a.id,a);}
 }
 async tick(){
  this.signal.throwIfAborted();
  await this.messages.retryReady();
  const provider:AiProvider={...this.provider,runExclusive:work=>this.provider.runExclusive
   ?this.provider.runExclusive(slot=>work(AbortSignal.any([slot,this.signal])))
   :work(this.signal)};
  // A bounded batch can wait for the shared provider slot; each result is delivered immediately.
  await Promise.all((await this.orchestrator.pending(20)).map(async event=>{
   try{
    if(!await this.transport.allowsConversation(event.conversation_id))return;
    const result=await this.orchestrator.process(event.conversation_id,event.event_key,provider);
    if('action'in result&&result.action)await this.deliver(result.action.id);
    if('notification'in result&&result.notification){
     if(['qualified','unqualified'].includes(result.decision.business_status)){
      const notice=await this.messages.enqueueQualificationNotice(result.decision.id);await this.deliver(notice.id);
     }
     this.signal.throwIfAborted();if(result.notification.state==='pending')await this.transport.dispatchNotification(result.notification.id);
    }
   }catch{if(!this.signal.aborted)console.error('AI event deferred; durable state retained');}
  }));
  this.signal.throwIfAborted();
  // Repair a crash between durable handoff creation and client completion receipt creation.
  const incomplete=(await this.pool.query(`SELECT d.id,d.conversation_id FROM ai_engine_decisions d JOIN ai_conversations v ON v.id=d.conversation_id JOIN ai_handoff_notifications n ON n.conversation_id=d.conversation_id AND n.logical_key='ai-handoff:'||d.id::text LEFT JOIN ai_outbox a ON a.logical_key='qualification-notice:'||d.id::text AND a.conversation_id=d.conversation_id WHERE d.disposition='handoff' AND d.business_status IN ('qualified','unqualified') AND a.id IS NULL AND v.automation_mode='paused' AND v.business_status=d.business_status AND v.automation_epoch=d.automation_epoch+1 AND d.request_phase_id IS NOT DISTINCT FROM v.active_phase_id ORDER BY d.created_at LIMIT 100`)).rows;
  for(const d of incomplete){try{if(await this.transport.allowsConversation(d.conversation_id)){const notice=await this.messages.enqueueQualificationNotice(d.id);await this.deliver(notice.id);}}catch{}}
  for(const job of await this.workflow.dueFollowups()){this.signal.throwIfAborted();if(await this.transport.allowsConversation(job.conversation_id))await this.workflow.materializeFollowup(job.id);}
  await this.runner.tickWithDispatch(async(id,target)=>{
   const a=(await this.pool.query('SELECT conversation_id FROM ai_outbox WHERE id=$1',[id])).rows[0];
   this.signal.throwIfAborted();if(a&&await this.transport.allowsConversation(a.conversation_id))await this.transport.dispatchAction(id,target);
  },{allowsConversation:id=>this.transport.allowsConversation(id),stopped:()=>this.signal.aborted});
  const actions=(await this.pool.query("SELECT id FROM ai_outbox WHERE state='pending' AND kind IN ('reply','follow_up','manual_reply','qualification_notice') ORDER BY created_at,id LIMIT 100")).rows;
  for(const a of actions){try{await this.deliver(a.id);}catch{if(!this.signal.aborted)console.error('AI delivery deferred; outcome retained');}}
  await this.pool.query(`UPDATE ai_handoff_notifications n SET state='rejected',outcome_code='request_phase_closed',updated_at=now() WHERE n.state='pending' AND n.request_phase_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_request_phases p JOIN ai_requests r ON r.id=p.request_id JOIN ai_conversations v ON v.active_phase_id=p.id JOIN ai_contacts c ON c.id=v.contact_id WHERE p.id=n.request_phase_id AND p.closed_at IS NULL AND r.lifecycle='open' AND c.opted_out_at IS NULL)`);
  for(const n of (await this.pool.query("SELECT id,conversation_id FROM ai_handoff_notifications WHERE state='pending' ORDER BY created_at,id LIMIT 100")).rows){
   try{this.signal.throwIfAborted();if(await this.transport.allowsConversation(n.conversation_id))await this.transport.dispatchNotification(n.id);}catch{if(!this.signal.aborted)console.error('Manager notification deferred; outcome retained');}
  }
 }
}
