import {DeliveryError} from '../delivery-policy.js';
import type {PreparedChannelSend} from '../ai-manager.js';
export interface WhatsAppCdpSession{
 send(method:string,params:Record<string,unknown>,options?:{timeout?:number}):Promise<any>;
}
const jid=/^[1-9][0-9]{0,30}@(c\.us|lid)$/;
const publicationJid=/^[1-9][0-9-]{0,60}@(c\.us|lid|g\.us)$/;
const stageFunction=`async function(data){
 const socket=window.require('WAWebSocketModel').Socket;
 if(socket.state!=='CONNECTED')throw Error('not_ready');
 const chat=await window.WWebJS.getChat(data.target,{getAsModel:false});
 const target=chat?.id?._serialized;
 const group=typeof chat?.isGroup==='function'?chat.isGroup():!!chat?.isGroup;
 if(!chat||group&&!data.publication||!data.recipients.includes(target))throw Error('recipient_unverified');
 const prefs=window.require('WAWebUserPrefsMeUser');
 const mePn=prefs.getMaybeMePnUser(),meLid=prefs.getMaybeMeLidUser();
 const self=[mePn?._serialized,meLid?._serialized].filter(Boolean);
 if(!self.some(id=>data.self.includes(id))||self.includes(target))throw Error('self_unverified');
 const from=group&&chat.groupMetadata?.isLidAddressingMode?meLid:chat.id.isLid()?meLid:mePn;if(!from)throw Error('self_unverified');
 const participant=group?window.require('WAWebWidFactory').asUserWidOrThrow(from):undefined;
 let media={};
 if(data.publication?.media){
  media=await window.WWebJS.processMediaData(data.publication.media,{forceDocument:data.publication.forceDocument,sendToChannel:false,sendToStatus:false});
  media={...media,...(media.toJSON?media.toJSON():{}),caption:data.publication.caption,isViewOnce:false};
  delete media.__x_id;
 }
 const id=await window.require('WAWebMsgKey').newId();
 const key=new (window.require('WAWebMsgKey'))({from,to:chat.id,id,participant,selfDir:'out'});
 const ephemeral=window.require('WAWebGetEphemeralFieldsMsgActionsUtils').getEphemeralFields(chat);
 return {chat,recipients:data.recipients,self,operation:data.operation,media:!!data.publication?.media,started:false,message:{id:key,ack:0,body:data.publication?.media?media.preview:'',from,to:chat.id,local:true,self:'out',t:Math.floor(Date.now()/1000),isNewMsg:true,type:'chat',...ephemeral,...media}};
}`;
const startFunction=`function(text,operation){
 if(this.started||operation!==this.operation)return {outcome:'rejected',code:'wa_stage_used',dispatchState:'not_started',retryCondition:'never'};
 let pair;
 try{
  const prefs=window.require('WAWebUserPrefsMeUser');
  const self=[prefs.getMaybeMePnUser()?._serialized,prefs.getMaybeMeLidUser()?._serialized].filter(Boolean);
  if(window.require('WAWebSocketModel').Socket.state!=='CONNECTED'||!this.self.some(id=>self.includes(id))||!this.recipients.includes(this.chat.id._serialized)||self.includes(this.chat.id._serialized))return {outcome:'rejected',code:'wa_session_changed',dispatchState:'not_started',retryCondition:'refresh_auth'};
  const actions=window.require('WAWebSendMsgChatAction');
  if(typeof actions.addAndSendMsgToChat!=='function')return {outcome:'rejected',code:'wa_runtime_not_ready',dispatchState:'not_started',retryCondition:'refresh_auth'};
  if(!this.media)this.message.body=text;this.message.t=Math.floor(Date.now()/1000);this.started=true;
  pair=actions.addAndSendMsgToChat(this.chat,this.message);
 }catch{return this.started?{outcome:'unknown',code:'wa_commit_failed',retryCondition:'reconcile_or_manual_review'}:{outcome:'rejected',code:'wa_commit_failed',dispatchState:'not_started',retryCondition:'refresh_auth'};}
 if(!Array.isArray(pair)||pair.length<2)return {outcome:'unknown',code:'wa_send_contract_changed',retryCondition:'reconcile_or_manual_review'};
 return Promise.all(pair).then(()=>{
  const message=window.require('WAWebCollections').Msg.get(this.message.id._serialized);
  return message?.id?._serialized===this.message.id._serialized&&Number(message.ack)>=1
   ?{outcome:'confirmed',externalMessageId:this.message.id._serialized,code:'wa_server_ack',retryCondition:'never'}
   :{outcome:'unknown',code:'wa_server_ack_pending',retryCondition:'reconcile_or_manual_review'};
 },()=>({outcome:'unknown',code:'wa_send_uncertain',retryCondition:'reconcile_or_manual_review'}));
}`;

/** Stage all lookup/key generation first; start writes one CDP frame synchronously. */
export async function prepareWhatsAppAiText(options:{cdp:WhatsAppCdpSession;accountId:string;conversationId:string;operationId:string;externalId:string;recipientAliases:string[];selfAliases:string[];isActive:()=>boolean;timeoutMs?:number;maxAgeMs?:number;now?:()=>number;publication?:{media?:{mimetype:string;data:string;filename:string};caption?:string;forceDocument?:boolean}}){
 if(options.cdp.send.constructor.name==='AsyncFunction'||options.isActive.constructor.name==='AsyncFunction')throw Error('wa_sender_must_be_synchronous');
 const targetPattern=options.publication?publicationJid:jid;
 const recipients=[...new Set(options.recipientAliases)],self=[...new Set(options.selfAliases)];
 if(!targetPattern.test(options.externalId)||!recipients.includes(options.externalId)||!recipients.length||recipients.length>8||recipients.some(id=>!targetPattern.test(id))||!self.length||self.length>8||self.some(id=>!jid.test(id)))throw Error('wa_private_target_unverified');
 if(!options.isActive())throw new DeliveryError('WhatsApp ожидает готовности','waiting');
 const timeout=options.timeoutMs??20000,now=options.now??(()=>performance.now());let objectId:string|undefined,released=false,started=false;
 const release=async()=>{if(released)return;released=true;if(objectId)await options.cdp.send('Runtime.releaseObject',{objectId}).catch(()=>{});};
 try{
  const staged=await options.cdp.send('Runtime.evaluate',{expression:`(${stageFunction})(${JSON.stringify({target:options.externalId,recipients,self,operation:options.operationId,publication:options.publication})})`,awaitPromise:true,returnByValue:false,silent:true},{timeout});
  objectId=staged?.result?.objectId;if(staged?.exceptionDetails||!objectId)throw Error('wa_preparation_failed');
  const metadata=await options.cdp.send('Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){return {messageId:this.message.id._serialized,target:this.chat.id._serialized,self:this.self};}',returnByValue:true},{timeout});
  const proof=metadata?.result?.value;
  if(metadata?.exceptionDetails||typeof proof?.messageId!=='string'||!proof.messageId.trim()||proof.messageId.length>512||!recipients.includes(proof.target)||!Array.isArray(proof.self)||!proof.self.some((id:string)=>self.includes(id))||!options.isActive())throw Error('wa_preparation_unverified');
  const preparedAt=now(),reservedMessageId=proof.messageId as string;
  const prepared:PreparedChannelSend={target:{accountId:options.accountId,externalConversationId:options.externalId,platform:'whatsapp'},start(action){
   if(started||released||action.operationId!==options.operationId||action.conversationId!==options.conversationId)return{acknowledgement:Promise.resolve({operationId:action.operationId,outcome:'rejected',dispatchState:'not_started',code:'wa_prepared_binding_changed',retryCondition:'never'})};
   if(!options.isActive()||now()-preparedAt>(options.maxAgeMs??15000))return{acknowledgement:Promise.resolve({operationId:action.operationId,outcome:'rejected',dispatchState:'not_started',code:'wa_preparation_expired',retryCondition:'refresh_auth'})};
   started=true;let response:Promise<any>;
   try{response=options.cdp.send('Runtime.callFunctionOn',{objectId,functionDeclaration:startFunction,arguments:[{value:action.text},{value:action.operationId}],awaitPromise:true,returnByValue:true,userGesture:true},{timeout});}
   catch{return{acknowledgement:Promise.resolve({operationId:action.operationId,outcome:'unknown',code:'wa_cdp_commit_uncertain',retryCondition:'reconcile_or_manual_review'})};}
   const acknowledgement=response.then(result=>{
    const value=result?.result?.value;
    if(result?.exceptionDetails||!value||value.outcome==='confirmed'&&value.externalMessageId!==reservedMessageId)return{operationId:action.operationId,outcome:'unknown',code:'wa_cdp_receipt_unverified',retryCondition:'reconcile_or_manual_review'};
    return{...value,operationId:action.operationId};
   },()=>({operationId:action.operationId,outcome:'unknown',code:'wa_cdp_response_uncertain',retryCondition:'reconcile_or_manual_review'}));
   return{acknowledgement};
  }};
  return{prepared,reservedMessageId,actualTargetId:proof.target as string,selfIds:proof.self as string[],release};
 }catch{await release();throw new DeliveryError('Не удалось подготовить личную отправку WhatsApp','waiting');}
}
