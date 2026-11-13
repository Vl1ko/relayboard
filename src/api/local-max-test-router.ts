import {bindSourceRequest} from '../core/request-lifecycle.js';
import {dispatchMaxManagerNotification} from '../core/max-manager-notification.js';
import {beginConfiguredQualification} from '../core/begin-qualification.js';
import {Router,type RequestHandler,type ErrorRequestHandler} from 'express';
import {randomUUID} from 'node:crypto';
import {z,ZodError} from 'zod';
import type {Pool} from 'pg';
import {UMax} from '@ounezz/umax';
import {MaxQualificationSession} from '../core/max-qualification-session.js';
import {AiManagerStore,AiStateError} from '../core/ai-manager.js';
import {AiOrchestrator} from '../core/ai-orchestrator.js';
import {decryptCredentials} from '../core/crypto.js';
import {prepareMaxAiText,type ConnectedMaxTextSocket} from '../core/adapters/max-ai-text.js';
import {maxSourceAuthor,assertMaxAuthorDialog} from '../core/max-author-route.js';
import type {AiProvider} from '../core/ai-engine.js';

type Source={id:string;accountId:string;messageId:string;authorId:string;text:string;occurredAt:string;expiresAt:number};
type Binding={accountId:string;sourceId:string;dialogId:string;conversationId:string};
class TestError extends Error{}
/** Local only. Group messages establish authors; AI replies are always private. No automatic sends. */
export function createLocalMaxTestRouter(options:{pool:Pool;authorize:RequestHandler;enabled:boolean;chatId:string;provider?:AiProvider}){
 const router=Router(),store=new AiManagerStore(options.pool),orchestrator=new AiOrchestrator(options.pool);
 const sources=new Map<string,Source>(),bindings=new Map<string,Binding>();let busy=false;let qualification:MaxQualificationSession|undefined;
 function prune(){for(const [id,s]of sources)if(s.expiresAt<Date.now())sources.delete(id);while(sources.size>256)sources.delete(sources.keys().next().value!);for(const [id,b]of bindings)if(!sources.has(b.sourceId))bindings.delete(id);}
 function source(id:string,accountId:string){prune();const s=sources.get(id);if(!s||s.accountId!==accountId)throw new TestError('Источник устарел или относится к другому аккаунту. Загрузите сообщения заново.');return s;}
 async function withMax<T>(accountId:string,body:(client:UMax,socket:ConnectedMaxTextSocket)=>Promise<T>,retain=false){
  const account=(await options.pool.query("SELECT credential_ciphertext FROM integrations WHERE id=$1 AND platform='max' AND enabled AND auth_error IS NULL",[accountId])).rows[0];
  if(!account)throw new TestError('Выбранный аккаунт MAX недоступен');
  let client:UMax|undefined;let retained=false;
  try{client=new UMax(decryptCredentials(account.credential_ciphertext).token);(client.chats as unknown as {subscribe_all:()=>void}).subscribe_all=()=>{};await client.connect();
   if(!client.account?.id)throw new TestError('MAX не подтвердил аккаунт');
   const group=client.chats.list.find(c=>c.type==='CHAT'&&String(c.id)===options.chatId&&c.title==='Тестовая');
   if(!group)throw new TestError('Тестовый чат недоступен выбранному аккаунту');
   const result=await body(client,(client as unknown as {ws:ConnectedMaxTextSocket}).ws);retained=retain;return result;
  }finally{if(!retained)client?.close();}
 }
 async function verifySource(client:UMax,socket:ConnectedMaxTextSocket,s:Source){
  const result=await socket.send(49,{chatId:Number(options.chatId),from:new Date(s.occurredAt).getTime(),forward:1,backward:2,getMessages:true})as any;
  const message=(result?.messages??[]).find((m:any)=>String(m.id)===s.messageId);
  const current=message?maxSourceAuthor(message,client.account!.id):null;
  if(!current||current.authorId!==s.authorId||current.text!==s.text)throw new TestError('Исходное сообщение удалено, изменилось или его автор не подтверждён. Загрузите сообщения заново.');
 }
 async function privateDialog(client:UMax,socket:ConnectedMaxTextSocket,s:Source){
  const candidate=await client.chats.new(Number(s.authorId));
  const details=await socket.send(48,{chatIds:[candidate.id]})as any;
  const chat=(details?.chats??[]).find((c:any)=>String(c.id)===String(candidate.id));
  if(!chat)throw new TestError('MAX не подтвердил личный диалог автора');
  return assertMaxAuthorDialog(chat,client.account!.id,s.authorId,options.chatId);
 }
 router.use(options.authorize);router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
 router.get('/status',async(_req,res)=>res.json({enabled:options.enabled,chatTitle:'Тестовая',replyMode:'private_author',modelReady:!!options.provider}));
 router.use((_req,res,next)=>{if(!options.enabled)return res.status(404).json({error:'Локальная проверка выключена'});next();});
 router.get('/qualification',async(_req,res)=>res.json(qualification?await qualification.status():{active:false,reason:'not_started'}));
 router.post('/qualification/stop',async(_req,res)=>{await qualification?.stop();res.json({stopped:true});});
 router.post('/qualification/notify-managers',async(req,res)=>{
  const data=z.object({accountId:z.string().uuid(),actionId:z.string().uuid()}).strict().parse(req.body);prune();const b=bindings.get(data.actionId);
  if(!b||b.accountId!==data.accountId)throw new TestError('Загрузите сообщение тестового автора заново');source(b.sourceId,data.accountId);
  if(busy||qualification?.active)return res.status(409).json({error:'Дождитесь завершения текущей операции'});busy=true;
  try{const n=(await options.pool.query("SELECT id FROM ai_handoff_notifications WHERE conversation_id=$1 AND reason='qualified' ORDER BY created_at DESC LIMIT 1",[b.conversationId])).rows[0];if(!n)throw new TestError('Квалификация ещё не завершена');res.json(await dispatchMaxManagerNotification(options.pool,n.id));}finally{busy=false;}
 });
 router.post('/qualification/acknowledge',async(req,res)=>{
  const data=z.object({accountId:z.string().uuid(),actionId:z.string().uuid()}).strict().parse(req.body);
  if(busy||qualification?.active)return res.status(409).json({error:'Дождитесь завершения квалификации'});
  prune();const b=bindings.get(data.actionId);if(!b||b.accountId!==data.accountId)throw new TestError('Сначала загрузите исходное сообщение и подготовьте предпросмотр');
  const s=source(b.sourceId,data.accountId);busy=true;
  try{
   const decision=(await options.pool.query("SELECT id FROM ai_engine_decisions WHERE conversation_id=$1 AND disposition='handoff' AND business_status IN ('qualified','unqualified') ORDER BY created_at DESC LIMIT 1",[b.conversationId])).rows[0];
   if(!decision)throw new TestError('Квалификация ещё не завершена');
   const notice=await store.enqueueQualificationNotice(decision.id);
   if(notice.state==='pending')await withMax(data.accountId,async(client,socket)=>{await verifySource(client,socket,s);const dialog=await privateDialog(client,socket,s);if(dialog!==b.dialogId)throw new TestError('Личка автора изменилась');await store.dispatch(notice.id,prepareMaxAiText({socket,accountId:data.accountId,chatId:dialog,allowedChatId:b.dialogId}));});
   res.json((await options.pool.query('SELECT state,external_message_id,outcome_code FROM ai_outbox WHERE id=$1',[notice.id])).rows[0]);
  }finally{busy=false;}
 });
 router.post('/qualification/start',async(req,res)=>{
  const data=z.object({accountId:z.string().uuid(),actionId:z.string().uuid(),useCurrentSettings:z.literal(true)}).strict().parse(req.body);
  if(!options.provider)return res.status(503).json({error:'GigaChat не подключён'});
  if(busy||qualification?.active)return res.status(409).json({error:'Квалификация уже включена или выполняется проверка'});
  prune();const b=bindings.get(data.actionId);if(!b||b.accountId!==data.accountId)return res.status(409).json({error:'Подготовьте ответ выбранному автору заново'});
  const s=source(b.sourceId,data.accountId);busy=true;
  try{
   const action=(await options.pool.query(`SELECT a.state,a.dispatch_started_at,c.automation_mode FROM ai_outbox a JOIN ai_conversations c ON c.id=a.conversation_id WHERE a.id=$1 AND c.id=$2 AND c.account_id=$3 AND c.external_id=$4`,[data.actionId,b.conversationId,data.accountId,b.dialogId])).rows[0];
   if(action?.state!=='confirmed'||!action.dispatch_started_at)return res.status(409).json({error:'Сначала отправьте первый ответ и дождитесь подтверждения MAX'});
   await withMax(data.accountId,async(client,socket)=>{await verifySource(client,socket,s);const dialog=await privateDialog(client,socket,s);if(dialog!==b.dialogId)throw new TestError('Личка автора изменилась');
    try{await beginConfiguredQualification(options.pool,b.conversationId);}catch(error){if(error instanceof Error&&error.message==='manager_hold')throw new TestError('Заявка передана менеджеру. Автоматические ответы заблокированы до её закрытия менеджером.');throw new TestError('Включите квалификацию и задайте критерии в «ИИ-квалификация». При отказе клиента или неизвестной отправке запуск запрещён.');}
    const recorded=(await options.pool.query('SELECT external_message_id FROM ai_inbox WHERE conversation_id=$1 ORDER BY ingest_sequence DESC LIMIT 2000',[b.conversationId])).rows.map(r=>String(r.external_message_id));
    const history=await socket.send(49,{chatId:Number(dialog),from:Date.now(),backward:50,forward:0,getMessages:true},10000)as any;
    const ownHistory=(history?.messages??[]).filter((m:any)=>Number(m.sender)===client.account!.id).map((m:any)=>String(m.id));
    qualification=new MaxQualificationSession({pool:options.pool,provider:options.provider!,socket,close:()=>client.close(),accountId:data.accountId,conversationId:b.conversationId,dialogId:dialog,authorId:s.authorId,selfId:client.account!.id,since:new Date(action.dispatch_started_at).getTime(),ignoreIds:[...recorded,...ownHistory],notifyManagers:id=>dispatchMaxManagerNotification(options.pool,id,{accountId:data.accountId,socket})});qualification.start();
   },true);
   res.json(await qualification!.status());
  }finally{busy=false;}
 });
 router.use((_req,res,next)=>{if(qualification?.active)return res.status(409).json({error:'Сначала остановите квалификацию, чтобы сменить аккаунт или источник'});next();});
 router.get('/sources',async(req,res)=>{
  const accountId=z.string().uuid().parse(req.query.accountId);if(busy)return res.status(409).json({error:'Дождитесь завершения проверки'});busy=true;
  try{const items=await withMax(accountId,async(client,socket)=>{
   const result=await socket.send(49,{chatId:Number(options.chatId),from:Date.now(),backward:20,forward:0,getMessages:true})as any;
   return(result?.messages??[]).map((message:any)=>maxSourceAuthor(message,client.account!.id)).filter(Boolean).slice(-20).reverse().map((m:any)=>{const s:Source={...m,id:randomUUID(),accountId,expiresAt:Date.now()+10*60_000};sources.set(s.id,s);return s;});
  });prune();res.json({items:items.map(({id,authorId,text,occurredAt}:Source)=>({id,authorId,text,occurredAt})),note:'Показаны только сообщения других участников. Ответ уйдёт автору в личку.'});}finally{busy=false;}
 });
 router.post('/preview',async(req,res)=>{
  const data=z.object({accountId:z.string().uuid(),requestId:z.string().uuid(),sourceId:z.string().uuid()}).strict().parse(req.body);
  const s=source(data.sourceId,data.accountId);if(!options.provider)return res.status(503).json({error:'GigaChat не подключён'});if(busy)return res.status(409).json({error:'Дождитесь завершения проверки'});busy=true;
  try{
   const dialogId=await withMax(data.accountId,async(client,socket)=>{await verifySource(client,socket,s);return privateDialog(client,socket,s);});
   let conversation=(await options.pool.query('SELECT v.*,c.opted_out_at FROM ai_conversations v JOIN ai_contacts c ON c.id=v.contact_id WHERE v.account_id=$1 AND v.external_id=$2',[data.accountId,dialogId])).rows[0];
   if(!conversation){const contact=await store.createContact('Тестовый автор MAX');conversation=await store.createConversation({contactId:contact.id,accountId:data.accountId,externalId:dialogId});conversation=await store.setMode(conversation.id,'auto');}
   if(!conversation.manager_hold){
    const request=await bindSourceRequest(options.pool,{conversationId:conversation.id,accountId:data.accountId,platform:'max',chatId:options.chatId,messageId:s.messageId,authorId:String(s.authorId),occurredAt:s.occurredAt});
    conversation=(await options.pool.query('SELECT v.*,c.opted_out_at FROM ai_conversations v JOIN ai_contacts c ON c.id=v.contact_id WHERE v.id=$1',[conversation.id])).rows[0];
    const phase=(await options.pool.query('SELECT p.request_id FROM ai_conversations v JOIN ai_request_phases p ON p.id=v.active_phase_id WHERE v.id=$1',[conversation.id])).rows[0];
    if(phase?.request_id!==request.requestId||conversation.business_status==='closed')return res.status(409).json({error:'Этот источник относится к прежней или уже активной заявке. Для нового обращения выберите новое сообщение после закрытия предыдущей.'});
   }
   if(conversation.opted_out_at||conversation.business_status==='refused')return res.status(409).json({error:'Получен отказ. Продолжение запрещено.'});
   if(conversation.automation_mode!=='auto'){
    const confirmed=(await options.pool.query("SELECT id,text,state FROM ai_outbox WHERE conversation_id=$1 AND state='confirmed' AND kind='reply' ORDER BY dispatch_started_at LIMIT 1",[conversation.id])).rows[0];
    if(confirmed){bindings.set(confirmed.id,{accountId:data.accountId,sourceId:s.id,dialogId,conversationId:conversation.id});return res.json({accountId:data.accountId,authorId:s.authorId,sourceId:s.id,dialogId,action:confirmed,decision:'reply',reason:'explicit_restart_required',paused:true,qualificationCompleted:['qualified','unqualified'].includes(conversation.business_status),managerHold:conversation.manager_hold});}
    return res.status(409).json({canResume:true,error:'Диалог на паузе. Нажмите «Продолжить тест».'});
   }
   const event=await orchestrator.ingest({version:1,platform:'max',accountId:data.accountId,conversationId:dialogId,messageId:'group-source:'+options.chatId+':'+s.messageId,occurredAt:s.occurredAt,direction:'inbound',origin:'customer',text:s.text,sourceChatId:options.chatId,sourceMessageId:s.messageId,sourceAuthorId:s.authorId});
   if(event.event.text!==s.text)throw new TestError('Исходный текст изменился. Нужна новая проверка.');
   const result=await orchestrator.process(conversation.id,event.event.event_key,options.provider);
   const action='action'in result?result.action:null;
   if(action)bindings.set(action.id,{accountId:data.accountId,sourceId:s.id,dialogId,conversationId:conversation.id});
   res.json({accountId:data.accountId,authorId:s.authorId,sourceId:s.id,dialogId,action:action?{id:action.id,text:action.text,state:action.state}:null,decision:result.decision.disposition,reason:result.decision.reason});
  }finally{busy=false;}
 });
 router.post('/resume',async(req,res)=>{
  const data=z.object({accountId:z.string().uuid(),sourceId:z.string().uuid()}).strict().parse(req.body);const s=source(data.sourceId,data.accountId);
  if(busy)return res.status(409).json({error:'Дождитесь завершения проверки'});busy=true;
  try{const dialogId=await withMax(data.accountId,async(c,w)=>{await verifySource(c,w,s);return privateDialog(c,w,s);});
   const c=(await options.pool.query('SELECT id FROM ai_conversations WHERE account_id=$1 AND external_id=$2',[data.accountId,dialogId])).rows[0];
   if(!c)throw new TestError('Диалог не найден');await store.setMode(c.id,'auto');res.json({resumed:true});
  }finally{busy=false;}
 });
 router.post('/send',async(req,res)=>{
  const data=z.object({accountId:z.string().uuid(),actionId:z.string().uuid()}).strict().parse(req.body);prune();const binding=bindings.get(data.actionId);
  if(!binding||binding.accountId!==data.accountId)return res.status(409).json({error:'Нет подтверждённой связи ответа с автором. Загрузите исходное сообщение и подготовьте ответ заново.'});
  const s=source(binding.sourceId,data.accountId);
  if(busy)return res.status(409).json({error:'Дождитесь завершения проверки'});busy=true;
  try{const action=(await options.pool.query(`SELECT a.id,a.state FROM ai_outbox a JOIN ai_conversations c ON c.id=a.conversation_id WHERE a.id=$1 AND c.account_id=$2 AND c.external_id=$3 AND c.id=$4 AND c.platform='max' AND a.logical_key LIKE 'ai-reply:%'`,[data.actionId,data.accountId,binding.dialogId,binding.conversationId])).rows[0];
   if(!action||action.state!=='pending')return res.status(409).json({error:'Ответ уже обработан или отменён. Повторная отправка запрещена.'});
   await withMax(data.accountId,async(client,socket)=>{await verifySource(client,socket,s);const dialogId=await privateDialog(client,socket,s);if(dialogId!==binding.dialogId)throw new TestError('Личный диалог изменился. Отправка остановлена.');
    await store.dispatch(action.id,prepareMaxAiText({socket,accountId:data.accountId,chatId:dialogId,allowedChatId:binding.dialogId}));
   });
   const receipt=(await options.pool.query('SELECT state,external_message_id,outcome_code FROM ai_outbox WHERE id=$1',[action.id])).rows[0];res.json({accountId:data.accountId,authorId:s.authorId,...receipt});
  }finally{busy=false;}
 });
 router.use(((error,_req,res,_next)=>{
  if(error instanceof ZodError)return res.status(400).json({error:'Выберите аккаунт и исходное сообщение автора'});
  if(error instanceof TestError)return res.status(409).json({error:error.message});
  if(error instanceof AiStateError)return res.status(409).json({error:'Состояние диалога изменилось. Проверьте режим или подготовьте новый ответ.'});
  res.status(409).json({error:'Проверка не завершена. Проверьте сессию MAX и доступ к личке автора. При неизвестном результате повторная отправка запрещена.'});
 })as ErrorRequestHandler);return Object.assign(router,{stopQualification:()=>qualification?.stop()});
}
