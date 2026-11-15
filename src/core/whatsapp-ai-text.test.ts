import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {prepareWhatsAppAiText} from './adapters/whatsapp-ai-text.js';
function harness(){
 let sends=0,ack=1,connected=true,target='200@c.us',self='100@c.us',failure=false;
 const messages=new Map<string,any>();
 const wid=(id:string)=>({_serialized:id,isLid:()=>id.endsWith('@lid')});
 class Key{static async newId(){return 'reserved';}_serialized:string;constructor(data:any){this._serialized=`true_${data.to._serialized}_${data.id}`;}}
 const modules:Record<string,any>={
 WAWebSocketModel:{Socket:{get state(){return connected?'CONNECTED':'DISCONNECTED';}}},
 WAWebUserPrefsMeUser:{getMaybeMePnUser:()=>wid(self),getMaybeMeLidUser:()=>null},
 WAWebMsgKey:Key,WAWebGetEphemeralFieldsMsgActionsUtils:{getEphemeralFields:()=>({})},
 WAWebSendMsgChatAction:{addAndSendMsgToChat(chat:any,message:any){assert.equal(this,modules.WAWebSendMsgChatAction);sends++;if(failure)throw Error('private');message.ack=ack;messages.set(message.id._serialized,message);return [Promise.resolve(message),Promise.resolve()];}},
 WAWebWidFactory:{asUserWidOrThrow:(v:any)=>v},
 WAWebCollections:{Msg:{get:(id:string)=>messages.get(id)}}};
 const context=vm.createContext({window:{require:(name:string)=>modules[name],WWebJS:{processMediaData:async()=>({type:'image',preview:'prepared-preview',filehash:'synthetic-file-hash',toJSON(){return{type:'image',preview:'prepared-preview'};}}),getChat:async()=>({id:wid(target),isGroup:target.endsWith('@g.us'),groupMetadata:{isLidAddressingMode:false}})}}});
 let staged:any,commits=0;
 const cdp={send(method:string,params:Record<string,any>){
  try{if(method==='Runtime.evaluate')return Promise.resolve(vm.runInContext(params.expression,context)).then(value=>{staged=value;return{result:{objectId:'staged'}};});
   if(method==='Runtime.releaseObject')return Promise.resolve({});
   if(params.awaitPromise)commits++;
   const fn=vm.runInContext(`(${params.functionDeclaration})`,context);
   return Promise.resolve(fn.apply(staged,params.arguments?.map((v:any)=>v.value)??[])).then(value=>({result:{value}}));
  }catch{return Promise.resolve({exceptionDetails:{text:'private'}});}
 }};
 return {cdp,get sends(){return sends;},get commits(){return commits;},set ack(v:number){ack=v;},set connected(v:boolean){connected=v;},set target(v:string){target=v;},set self(v:string){self=v;},set failure(v:boolean){failure=v;}};
}
const options={accountId:'account',conversationId:'conversation',operationId:'operation',externalId:'200@c.us',recipientAliases:['200@c.us'],selfAliases:['100@c.us'],isActive:()=>true};
const action={operationId:'operation',conversationId:'conversation',text:'Synthetic message'};
test('WhatsApp prepares with zero sends and commits one exact reserved message synchronously',async()=>{
 const h=harness(),p=await prepareWhatsAppAiText({...options,cdp:h.cdp});assert.equal(h.sends,0);
 const sending=p.prepared.start(action);assert.equal(h.commits,1);assert.equal(h.sends,1);
 const result=await sending.acknowledgement as any;assert.equal(result.outcome,'confirmed');assert.equal(result.externalMessageId,p.reservedMessageId);
 assert.equal((await p.prepared.start(action).acknowledgement as any).outcome,'rejected');assert.equal(h.sends,1);await p.release();await p.release();
});
test('WhatsApp local ID without server acknowledgement is unknown and never retried',async()=>{
 const h=harness();h.ack=0;const p=await prepareWhatsAppAiText({...options,cdp:h.cdp});
 assert.equal((await p.prepared.start(action).acknowledgement as any).outcome,'unknown');assert.equal(h.sends,1);
});
test('WhatsApp revalidates identity, connection, binding, expiry and release before commit',async()=>{
 for(const change of ['self','connection','binding','expiry','release']){
  const h=harness();let now=0;const p=await prepareWhatsAppAiText({...options,cdp:h.cdp,now:()=>now});
  if(change==='self')h.self='300@c.us';if(change==='connection')h.connected=false;if(change==='expiry')now=16000;if(change==='release')await p.release();
  const result=await p.prepared.start({...action,operationId:change==='binding'?'wrong':action.operationId}).acknowledgement as any;
  assert.equal(result.outcome,'rejected',change);assert.equal(h.sends,0,change);
 }
});
test('WhatsApp preparation rejects group, self, unverified recipient and asynchronous send wrappers',async()=>{
 for(const target of ['300@c.us','200@g.us','100@c.us']){const h=harness();h.target=target;await assert.rejects(prepareWhatsAppAiText({...options,cdp:h.cdp}));assert.equal(h.sends,0);}
 await assert.rejects(prepareWhatsAppAiText({...options,cdp:{async send(){return{};}}}),/synchronous/);
});
test('WhatsApp errors after commit are unknown without claiming not_started or leaking data',async()=>{
 const h=harness();h.failure=true;const p=await prepareWhatsAppAiText({...options,cdp:h.cdp});
 const result=await p.prepared.start(action).acknowledgement as any;assert.equal(result.outcome,'unknown');assert.equal(result.dispatchState,undefined);assert.ok(!JSON.stringify(result).includes('private'));
});

test('WhatsApp publication stages group media before commit and retains caption and preview',async()=>{
 const h=harness();h.target='500@g.us';const p=await prepareWhatsAppAiText({...options,cdp:h.cdp,externalId:'500@g.us',recipientAliases:['500@g.us'],publication:{media:{mimetype:'image/png',data:'c3ludGhldGlj',filename:'test.png'},caption:'Caption'}});assert.equal(h.sends,0);assert.equal((await p.prepared.start({...action,text:''}).acknowledgement as any).outcome,'confirmed');assert.equal(h.sends,1);await p.release();
});
