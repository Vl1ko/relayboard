import {Router,type RequestHandler,type ErrorRequestHandler} from 'express';
import {z,ZodError} from 'zod';
import type {Pool} from 'pg';
import {UMax} from '@ounezz/umax';
import {AiManagerStore,AiStateError} from '../core/ai-manager.js';
import {AiOrchestrator} from '../core/ai-orchestrator.js';
import {decryptCredentials} from '../core/crypto.js';
import {prepareMaxAiText,type ConnectedMaxTextSocket} from '../core/adapters/max-ai-text.js';
import type {AiProvider} from '../core/ai-engine.js';

/** Explicit local test only: synthetic input, preview, then user-requested live send to ONE chat. */
export function createLocalMaxTestRouter(options:{pool:Pool;authorize:RequestHandler;enabled:boolean;chatId:string;provider?:AiProvider}) {
 const router=Router(),store=new AiManagerStore(options.pool),orchestrator=new AiOrchestrator(options.pool);
 let busy=false;
 router.use(options.authorize);
 router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
 router.get('/status',async(_req,res)=>res.json({enabled:options.enabled,chatTitle:'Тестовая',chatId:options.enabled?options.chatId:null,modelReady:!!options.provider}));
 router.use((_req,res,next)=>{if(!options.enabled)return res.status(404).json({error:'Локальная проверка выключена'});next();});
 const input=z.object({accountId:z.string().uuid(),requestId:z.string().uuid(),text:z.string().trim().min(1).max(2000)}).strict();
 router.post('/preview',async(req,res)=>{
  const data=input.parse(req.body);if(!options.provider)return res.status(503).json({error:'GigaChat не подключён'});
  if(busy)return res.status(409).json({error:'Дождитесь завершения текущей проверки'});
  busy=true;
  try{
   const account=(await options.pool.query("SELECT id FROM integrations WHERE id=$1 AND platform='max' AND enabled AND auth_error IS NULL",[data.accountId])).rows[0];
   if(!account)return res.status(400).json({error:'Выбранный аккаунт MAX недоступен'});
   let conversation=(await options.pool.query('SELECT v.*,c.opted_out_at FROM ai_conversations v JOIN ai_contacts c ON c.id=v.contact_id WHERE v.account_id=$1 AND v.external_id=$2',[data.accountId,options.chatId])).rows[0];
   if(!conversation){const contact=await store.createContact('Локальная проверка MAX — вымышленные данные');conversation=await store.createConversation({contactId:contact.id,accountId:data.accountId,externalId:options.chatId});conversation=await store.setMode(conversation.id,'auto');}
   if(conversation.opted_out_at || ['closed','refused'].includes(conversation.business_status))return res.status(409).json({code:'test_closed',error:'Тестовый диалог закрыт или получен отказ. Автоматическое продолжение запрещено.'});
   if(conversation.automation_mode!=='auto')return res.status(409).json({code:'test_paused',canResume:true,error:'Тестовый диалог на паузе. Нажмите «Продолжить тест», затем подготовьте ответ заново. В MAX ничего не отправлено.'});
   const event=await orchestrator.ingest({version:1,platform:'max',accountId:data.accountId,conversationId:options.chatId,messageId:'local-synthetic:'+data.requestId,occurredAt:new Date().toISOString(),direction:'inbound',origin:'customer',text:data.text,synthetic:true});
   if(event.event.text!==data.text)return res.status(409).json({error:'Этот номер проверки уже использован с другим текстом'});
   const result=await orchestrator.process(conversation.id,event.event.event_key,options.provider);
   const action='action'in result?result.action:null;
   res.json({conversationId:conversation.id,accountId:data.accountId,chatId:options.chatId,syntheticInput:true,action:action?{id:action.id,text:action.text,state:action.state}:null,decision:result.decision.disposition,reason:result.decision.reason});
  }finally{busy=false;}
 });
 router.post('/resume',async(req,res)=>{
  const data=z.object({accountId:z.string().uuid()}).strict().parse(req.body);
  if(busy)return res.status(409).json({error:'Дождитесь завершения текущей проверки'});
  const conversation=(await options.pool.query(`SELECT c.id FROM ai_conversations c JOIN integrations i ON i.id=c.account_id WHERE c.account_id=$1 AND c.external_id=$2 AND i.platform='max' AND i.enabled AND i.auth_error IS NULL`,[data.accountId,options.chatId])).rows[0];
  if(!conversation)return res.status(404).json({error:'Тестовый диалог выбранного аккаунта не найден'});
  await store.setMode(conversation.id,'auto');
  res.json({resumed:true});
 });
 router.post('/send',async(req,res)=>{
  const data=z.object({accountId:z.string().uuid(),actionId:z.string().uuid()}).strict().parse(req.body);
  const action=(await options.pool.query(`SELECT a.id,a.kind,a.state,c.external_id,i.credential_ciphertext FROM ai_outbox a JOIN ai_conversations c ON c.id=a.conversation_id JOIN integrations i ON i.id=c.account_id WHERE a.id=$1 AND c.account_id=$2 AND c.external_id=$3 AND i.platform='max' AND i.enabled AND i.auth_error IS NULL AND a.logical_key LIKE 'ai-reply:%'`,[data.actionId,data.accountId,options.chatId])).rows[0];
  if(!action)return res.status(400).json({error:'Ответ не принадлежит выбранному аккаунту и тестовому чату'});
  if(action.state!=='pending')return res.status(409).json({code:'action_not_pending',error:action.state==='cancelled'?'Предпросмотр устарел или отменён. Подготовьте новый ответ. Это сообщение не отправлялось.':'Ответ уже обработан. Повторная отправка запрещена; проверьте чат.',state:action.state});
  if(busy)return res.status(409).json({error:'Дождитесь завершения текущей проверки'});
  busy=true;let client:UMax|undefined;let connecting=true;
  try{
   client=new UMax(decryptCredentials(action.credential_ciphertext).token);
   (client.chats as unknown as {subscribe_all:()=>void}).subscribe_all=()=>{};
   await client.connect();
   connecting=false;
   const chat=client.chats.list.find(c=>c.type==='CHAT'&&String(c.id)===options.chatId&&c.title==='Тестовая');
   if(!chat)return res.status(409).json({error:'Чат «Тестовая» недоступен выбранному аккаунту'});
   const socket=(client as unknown as {ws:ConnectedMaxTextSocket}).ws;
   await store.dispatch(action.id,prepareMaxAiText({socket,accountId:data.accountId,chatId:options.chatId,allowedChatId:options.chatId}));
   const receipt=(await options.pool.query('SELECT state,external_message_id,outcome_code FROM ai_outbox WHERE id=$1',[action.id])).rows[0];
   res.json({accountId:data.accountId,chatId:options.chatId,...receipt});
  }catch(error){
   if(connecting)return res.status(503).json({code:'max_connection_failed',error:'Не удалось подключиться к MAX. Отправка не начиналась. Проверьте сессию и соединение.'});
   throw error;
  }finally{try{client?.close();}finally{busy=false;}}
 });
 router.use(((error,_req,res,_next)=>{
  if(error instanceof ZodError)return res.status(400).json({error:'Проверьте выбранный аккаунт и текст'});
  if(error instanceof AiStateError)return res.status(409).json({code:error.code,error:error.code==='automation_forbidden'?'Диалог остановлен. Проверьте его режим в разделе «Диалоги». Сообщение не отправлено.':'Состояние диалога изменилось. Подготовьте новый ответ.'});
  res.status(409).json({error:'Проверка остановлена. Проверьте настройки ИИ, режим диалога и подключение MAX. Повторная отправка неизвестного результата запрещена.'});
 })as ErrorRequestHandler);
 return router;
}
