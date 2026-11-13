import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createLocalMaxTestRouter} from './local-max-test-router.js';
const account='00000000-0000-4000-8000-000000000001',action='00000000-0000-4000-8000-000000000002';
async function serve(enabled:boolean,run:(base:string)=>Promise<void>){const app=express();app.use(express.json());app.use(createLocalMaxTestRouter({enabled,chatId:'-123',pool:{query(){throw Error('Must not access DB or connect to MAX');}}as any,authorize:(_req,_res,next)=>next()}));const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));try{await run('http://127.0.0.1:'+(server.address()as any).port);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}}
async function post(base:string,path:string,body:unknown){return fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
test('disabled local route cannot send',async()=>serve(false,async base=>{assert.equal((await post(base,'/send',{accountId:account,actionId:action})).status,404);}));
test('old group previews and forged action IDs cannot reach send transport',async()=>serve(true,async base=>{const r=await post(base,'/send',{accountId:account,actionId:action});assert.equal(r.status,409);assert.match((await r.json()as any).error,/связи ответа с автором/);}));
test('client cannot forge recipient, source author or source text',async()=>serve(true,async base=>{
 for(const body of [{accountId:account,requestId:action,text:'old synthetic preview'},{accountId:account,requestId:action,sourceId:action,authorId:'202'},{accountId:account,requestId:action,sourceId:action,recipientId:'202'}])assert.equal((await post(base,'/preview',body)).status,400);
 assert.equal((await post(base,'/preview',{accountId:account,requestId:action,sourceId:action})).status,409);
}));
