import {Router,type RequestHandler,type ErrorRequestHandler} from 'express';
import {z,ZodError}from'zod';import type{Pool}from'pg';
import{ManualReplyStore,ManualReplyError}from'../core/manual-reply.js';
import{AiManagerStore,AiStateError}from'../core/ai-manager.js';
import{channelMessageSchema}from'../core/channel-contracts.js';
export function createProtocolRouter(options:{pool:Pool;authorize:RequestHandler;enabled:boolean;syntheticEnabled:boolean}){
 const r=Router(),store=new AiManagerStore(options.pool);r.use(options.authorize);
 r.use((_q,s,n)=>{s.setHeader('Cache-Control','no-store');if(!options.enabled)return s.status(503).json({error:'Модуль диалогов выключен'});n();});
 r.post('/conversations',async(q,s)=>{const data=z.object({contactId:z.string().uuid(),accountId:z.string().uuid(),externalId:z.string().min(1).max(512)}).parse(q.body);s.json(await store.createConversation(data));});
 r.post('/conversations/:id/manual-messages',async(q,s)=>{if(!options.syntheticEnabled)return s.status(503).json({error:'Ручная тестовая отправка выключена'});s.json(await new ManualReplyStore(options.pool).create({...q.body,conversationId:q.params.id}));});
 r.post('/events',async(q,s)=>{if(!options.syntheticEnabled)return s.status(503).json({error:'Ввод синтетических событий выключен'});const event=channelMessageSchema.parse(q.body);if(event.text.length>4000)return s.status(400).json({error:'Тестовый текст ограничен 4000 символами'});s.json(await store.ingest(event));});
 r.use(((e,_q,s,_n)=>{if(e instanceof ZodError)return s.status(400).json({error:'Проверьте поля события или привязки'});if(e instanceof ManualReplyError)return s.status(e.status).json({code:e.code,error:'Ручное сообщение отклонено: '+e.code});if(e instanceof AiStateError)return s.status(409).json({code:e.code,error:'Операция диалога отклонена: '+e.code});if(['42P01','42703'].includes(e?.code))return s.status(503).json({error:'Требуется миграция ИИ-менеджера'});console.error('Protocol request failed');s.status(500).json({error:'Не удалось обработать событие'});})as ErrorRequestHandler);return r;
}
