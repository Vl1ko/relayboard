import {Router,type RequestHandler,type ErrorRequestHandler} from 'express';
import type {Pool} from 'pg';
import {z,ZodError} from 'zod';
import multer from 'multer';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {statfs} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ContactCardStore,CardError} from '../core/contact-card.js';
export function createContactCardRouter(options:{pool:Pool;authorize:RequestHandler;uploadRoot:string;enabled?:boolean}){
 const root=resolve(options.uploadRoot,'contact-card');mkdirSync(root,{recursive:true,mode:0o700});const store=new ContactCardStore(options.pool,root),router=Router();
 router.use(options.authorize,(_req,res,next)=>{res.setHeader('Cache-Control','no-store');if(options.enabled===false)return res.status(503).json({error:'Карточка клиента пока недоступна'});next();});
 let busy=false;const slot:RequestHandler=async(_req,res,next)=>{if(busy)return res.status(429).json({error:'Загружается другой файл. Повторите позже'});busy=true;let released=false;const release=()=>{if(!released){released=true;busy=false;}};res.locals.release=release;res.locals.writing=true;try{await options.pool.query('SELECT 1');const disk=await statfs(root);if(disk.bavail*disk.bsize<256*1024*1024)throw new CardError('file_disk_full',507);next();}catch(e){release();next(e);}};
 const upload=multer({storage:multer.diskStorage({destination:root,filename:(_req,_file,done)=>done(null,randomUUID()+'.upload')}),limits:{fileSize:20*1024*1024,files:1,fields:0,parts:1}});
 router.get('/contacts/:id/card',async(req,res)=>res.json(await store.get(z.string().uuid().parse(req.params.id))));
 router.post('/contacts/:id/notes',async(req,res)=>res.json(await store.addNote(z.string().uuid().parse(req.params.id),req.body)));
 router.put('/contacts/:id/notes/:noteId',async(req,res)=>res.json(await store.editNote(z.string().uuid().parse(req.params.id),z.string().uuid().parse(req.params.noteId),req.body)));
 router.delete('/contacts/:id/notes/:noteId',async(req,res)=>res.json(await store.deleteNote(z.string().uuid().parse(req.params.id),z.string().uuid().parse(req.params.noteId),z.number().int().nonnegative().parse(req.body.expectedRevision))));
 router.post('/contacts/:id/files/:fileId',slot,(req,res,next)=>{try{z.string().uuid().parse(req.params.id);z.string().uuid().parse(req.params.fileId);next();}catch(e){res.locals.release();next(e);}},upload.single('file'),async(req,res)=>{
  res.locals.writing=true;try{if(!req.file)throw new CardError('file_required',400);res.json(await store.addFile(z.string().uuid().parse(req.params.id),z.string().uuid().parse(req.params.fileId),req.file));}
  finally{if(req.file)await store.cleanupUpload(req.file.path);res.locals.writing=false;res.locals.release();}
 });
 router.get('/contacts/:id/files/:fileId',async(req,res)=>{const f=await store.download(z.string().uuid().parse(req.params.id),z.string().uuid().parse(req.params.fileId));res.setHeader('X-Content-Type-Options','nosniff');res.type('application/octet-stream').download(f.storage_path,f.original_name);});
 router.delete('/contacts/:id/files/:fileId',async(req,res)=>res.json(await store.deleteFile(z.string().uuid().parse(req.params.id),z.string().uuid().parse(req.params.fileId))));
 router.use(((e,_req,res,_next)=>{res.locals.release?.();if(e instanceof ZodError)return res.status(400).json({error:'Проверьте данные карточки'});if(e instanceof multer.MulterError)return res.status(413).json({error:'Загрузите один файл размером до 20 МБ'});if(e instanceof CardError)return res.status(e.status).json({error:({contact_not_found:'Клиент не найден',file_not_found:'Файл не найден',file_disk_full:'Недостаточно свободного места для загрузки файла',file_type_or_size:'Поддерживаются PDF, Word, Excel, текст и изображения до 20 МБ',file_budget_exceeded:'Лимит: 20 файлов и 100 МБ на клиента, 256 МБ суммарно',note_changed:'Заметка изменилась. Обновите карточку',note_limit:'Не более 200 заметок на клиента',card_identity_conflict:'Эта операция уже выполнена с другими данными'} as Record<string,string>)[e.code]||'Не удалось изменить карточку'});console.error('Contact card operation deferred');res.status(500).json({error:'Операция не завершена. Повторите с тем же файлом или обновите карточку'});}) as ErrorRequestHandler);
 let cleanup:Promise<void>|undefined;const timer=setInterval(()=>{if(!cleanup)cleanup=store.cleanup().catch(()=>console.error('Contact card cleanup deferred')).finally(()=>{cleanup=undefined;});},600000);timer.unref();
 return{router,close:async()=>{clearInterval(timer);await cleanup;}};
}
