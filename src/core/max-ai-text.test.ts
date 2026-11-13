import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareMaxAiText} from './adapters/max-ai-text.js';
const target={accountId:'test',chatId:'-123',allowedChatId:'-123'};
const action={operationId:'op',text:'test',conversationId:'conversation'};
test('MAX AI text starts synchronously in exact allowlisted chat and returns actual receipt',async()=>{
 let started=false;
 const p=prepareMaxAiText({...target,socket:{connected:true,send(op,body){assert.equal(op,64);assert.equal(body.chatId,-123);started=true;return Promise.resolve({message:{id:'receipt'}});}}});
 const sent=p.start(action);assert.equal(started,true);assert.equal((await sent.acknowledgement as any).externalMessageId,'receipt');
 assert.throws(()=>prepareMaxAiText({...target,chatId:'-124',socket:{connected:true,send(){throw Error();}}}),/forbidden/);
});
test('MAX AI text never sends when disconnected; ambiguous outcomes are never retried',async()=>{
 let calls=0;const socket={connected:false,send(){calls++;return Promise.reject(Error('private detail'));}};
 const p=prepareMaxAiText({...target,socket});assert.equal((await p.start(action).acknowledgement as any).outcome,'rejected');assert.equal(calls,0);
 socket.connected=true;const result=await p.start(action).acknowledgement as any;assert.equal(result.outcome,'unknown');assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('private detail'));
});

test('independent prepared sends share one CID clock even in the same millisecond',async t=>{
 t.mock.method(Date,'now',()=>1000);const ids:number[]=[];
 const socket={connected:true,send(_op:number,body:Record<string,unknown>){ids.push((body.message as {cid:number}).cid);return Promise.resolve({message:{id:String(ids.length)}});}};
 await Promise.all(Array.from({length:20},()=>prepareMaxAiText({...target,socket}).start(action).acknowledgement));
 assert.equal(new Set(ids).size,20);assert.ok(ids.every((id,i)=>i===0||id>ids[i-1]));
});
