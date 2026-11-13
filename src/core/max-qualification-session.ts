import type {Pool} from 'pg';
import {AiManagerStore} from './ai-manager.js';
import {AiOrchestrator} from './ai-orchestrator.js';
import type {AiProvider} from './ai-engine.js';
import {prepareMaxAiText,type ConnectedMaxTextSocket} from './adapters/max-ai-text.js';

/** One explicit local test account/private recipient. No scanning other dialogs or automatic restart. */
export class MaxQualificationSession{
 active=true;reason='running';lastError:string|null=null;
 private polling=false;private processing=false;private sending=false;
 private timer:ReturnType<typeof setInterval>|undefined;
 private seen=new Set<string>();
 private store:AiManagerStore;private orchestrator:AiOrchestrator;
 constructor(private o:{pool:Pool;provider:AiProvider;socket:ConnectedMaxTextSocket;close:()=>void;accountId:string;conversationId:string;dialogId:string;authorId:string;selfId:number;since:number;ignoreIds?:string[]}){this.seen=new Set(o.ignoreIds??[]);this.store=new AiManagerStore(o.pool);this.orchestrator=new AiOrchestrator(o.pool);}
 start(){if(this.timer)throw Error('session_already_started');this.timer=setInterval(()=>void this.poll(),1500);void this.poll();}
 async stop(reason='stopped_by_user',pause=true){if(!this.active)return;this.active=false;this.reason=reason;if(this.timer)clearInterval(this.timer);try{if(pause)await this.store.setMode(this.o.conversationId,'paused');}finally{this.o.close();}}
 async status(){const r=(await this.o.pool.query(`SELECT c.business_status,c.automation_mode,s.settings_version,s.fields,k.settings FROM ai_conversations c JOIN ai_engine_state s ON s.conversation_id=c.id JOIN ai_engine_settings k ON k.version=s.settings_version WHERE c.id=$1`,[this.o.conversationId])).rows[0];return{active:this.active,reason:this.reason,lastError:this.lastError,accountId:this.o.accountId,authorId:this.o.authorId,conversationId:this.o.conversationId,businessStatus:r?.business_status,mode:r?.automation_mode,settingsVersion:r?.settings_version,fieldLabels:Object.fromEntries((r?.settings?.fields??[]).map((f:any)=>[f.key,f.question])),fields:Object.fromEntries(Object.entries(r?.fields??{}).map(([key,value])=>[key,(value as any).value]))};}
 async poll(){
  if(!this.active||this.polling)return;this.polling=true;
  try{
   if(!this.o.socket.connected)throw Error('connection_lost');
   const response=await this.o.socket.send(49,{chatId:Number(this.o.dialogId),from:Date.now(),backward:50,forward:0,getMessages:true},10000)as any;
   const items=Array.isArray(response?.messages)?response.messages:[];
   // Raw messages have no separate chat field: the authenticated request is scoped to this one dialog.
   for(const m of items.sort((a:any,b:any)=>Number(a.time)-Number(b.time))){
    if(!this.active)break;
    const id=String(m.id??''),sender=Number(m.sender),time=Number(m.time);
    if(!id||this.seen.has(id)||!Number.isFinite(time)||time<this.o.since||typeof m.text!=='string'||(m.type!==undefined&&m.type!=='USER'))continue;
    if(sender!==this.o.selfId&&String(sender)!==this.o.authorId)continue;
    if(sender===this.o.selfId&&this.sending)continue; // Wait for the durable server receipt before classifying own echoes.
    let origin:'customer'|'service'|'human'='customer';
    if(sender===this.o.selfId){const sent=await this.o.pool.query("SELECT 1 FROM ai_outbox WHERE conversation_id=$1 AND external_message_id=$2 AND state='confirmed'",[this.o.conversationId,id]);origin=sent.rowCount?'service':'human';}
    await this.store.ingest({version:1,platform:'max',accountId:this.o.accountId,conversationId:this.o.dialogId,messageId:id,occurredAt:new Date(time).toISOString(),direction:origin==='customer'?'inbound':'outbound',origin,text:m.text.slice(0,4000)});
    this.seen.add(id);if(this.seen.size>2000)this.seen.delete(this.seen.values().next().value!);
    if(origin==='human'){await this.stop('manager_takeover',false);break;}
   }
   if(this.active)void this.process();
  }catch{if(!this.active)return;this.lastError='Соединение MAX прервано. История сохранена; автоматика остановлена.';await this.stop('connection_error').catch(()=>{});}
  finally{this.polling=false;}
 }
 async process(){
  if(!this.active||this.processing)return;this.processing=true;
  try{
   while(this.active){
    const state=(await this.o.pool.query('SELECT automation_mode,business_status FROM ai_conversations WHERE id=$1',[this.o.conversationId])).rows[0];
    if(!state||state.automation_mode!=='auto'||['closed','refused','manager_required','manager_working'].includes(state.business_status)){await this.stop(state?.business_status??'conversation_unavailable',false);break;}
    if((await this.o.pool.query("SELECT 1 FROM ai_outbox WHERE conversation_id=$1 AND state IN ('dispatching','unknown') LIMIT 1",[this.o.conversationId])).rowCount){await this.stop('uncertain_send');break;}
    const event=(await this.orchestrator.pending(1000)).find(e=>e.conversation_id===this.o.conversationId);if(!event)break;
    try{
     const result=await this.orchestrator.process(this.o.conversationId,event.event_key,this.o.provider);
     if(!this.active)break;
     const action='action'in result?result.action:null;
     if(action&&action.state==='pending'){
      this.sending=true;
      try{const prepared=prepareMaxAiText({socket:this.o.socket,accountId:this.o.accountId,chatId:this.o.dialogId,allowedChatId:this.o.dialogId});
       await this.store.dispatch(action.id,{target:prepared.target,start:a=>this.active?prepared.start(a):{acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'rejected',dispatchState:'not_started',code:'local_session_stopped',retryCondition:'never'})}});
      }finally{this.sending=false;}
     }
     if(result.decision.disposition==='handoff'){
      if(['qualified','unqualified'].includes(result.decision.business_status)){
       const notice=await this.store.enqueueQualificationNotice(result.decision.id);this.sending=true;
       try{const prepared=prepareMaxAiText({socket:this.o.socket,accountId:this.o.accountId,chatId:this.o.dialogId,allowedChatId:this.o.dialogId});await this.store.dispatch(notice.id,{target:prepared.target,start:a=>this.active?prepared.start(a):{acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'rejected',dispatchState:'not_started',code:'local_session_stopped',retryCondition:'never'})}});}finally{this.sending=false;}
      }
      if(['ungrounded_extraction','invalid_model_output','provider_failure'].includes(result.decision.reason))this.lastError='ИИ не смог подтвердить параметры по сообщению клиента. Требуется проверка менеджера или явное продолжение теста.';await this.stop(result.decision.reason,false);break;}
    }catch{
     // A newer inbound event or takeover may invalidate a model result. Re-read guards next poll.
     this.lastError='Ответ не отправлен: состояние диалога изменилось или ИИ недоступен.';break;
    }
   }
  }finally{this.processing=false;}
 }
}
