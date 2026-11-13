import {Router,type RequestHandler,type ErrorRequestHandler} from 'express';
import {z,ZodError} from 'zod';
import type {Pool} from 'pg';
import {AiEngineStore,AiEngineError,aiSettingsSchema} from '../core/ai-engine.js';
export function createAiEngineRouter(options:{pool:Pool;authorize:RequestHandler;enabled:boolean}){
 const router=Router(),service=new AiEngineStore(options.pool);
 router.use(options.authorize);router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');if(!options.enabled)return res.status(503).json({error:'Модуль ИИ не включён'});next();});
 router.get('/settings',async(_req,res)=>{res.json(await service.settings());});
 router.put('/settings',async(req,res)=>{const data=z.object({expectedVersion:z.number().int().positive(),settings:aiSettingsSchema}).parse(req.body);res.json(await service.saveSettings(data));});
 router.use(((error,_req,res,_next)=>{
  if(error instanceof ZodError)return res.status(400).json({error:'Проверьте поля настроек ИИ: ключи должны быть уникальными, правила — ссылаться на заданные поля'});
  if(error instanceof AiEngineError)return res.status(409).json({code:error.code,error:error.code==='settings_changed'?'Настройки изменились. Загрузите актуальную версию':'Операция ИИ отклонена'});
  if(['42P01','42703'].includes(error?.code))return res.status(503).json({error:'Требуется миграция ИИ-менеджера'});
  console.error('AI settings request failed');res.status(500).json({error:'Не удалось сохранить настройки ИИ'});
 }) as ErrorRequestHandler);return router;
}
