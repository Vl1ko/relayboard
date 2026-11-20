import test from 'node:test';
import assert from 'node:assert/strict';
import {WhatsAppSessions} from './whatsapp-sessions.js';
test('WhatsApp restores five enabled accounts and never evicts one for a sixth',async()=>{
 const accounts=Array.from({length:6},(_,i)=>({id:String(i),session_key:String(i)}));const created:string[]=[],closed:string[]=[];
 const sessions=new WhatsAppSessions(async()=>accounts,a=>{created.push(a.id);return{async close(){closed.push(a.id);}};});
 await sessions.restore();assert.deepEqual(created,['0','1','2','3','4']);await assert.rejects(sessions.get('5'),/capacity/);assert.equal(closed.length,0);
 accounts.splice(0,1);await sessions.refresh();assert.deepEqual(closed,['0']);await sessions.get('5');assert.equal(created.length,6);
 await assert.rejects(sessions.get('0'),/disabled_or_missing/);await sessions.close();assert.equal(closed.length,6);
});
test('WhatsApp concurrent access shares a session, disabled accounts close, stopped owner cannot launch',async()=>{
 let accounts=[{id:'a',session_key:'key'}],creates=0,closes=0;
 const sessions=new WhatsAppSessions(async()=>accounts,()=>{creates++;return{async close(){closes++;}};});
 const results=await Promise.all(Array.from({length:20},()=>sessions.get('key')));assert.equal(creates,1);assert.ok(results.every(s=>s===results[0]));
 accounts=[];await sessions.refresh();assert.equal(closes,1);await sessions.close();accounts=[{id:'a',session_key:'key'}];await assert.rejects(sessions.get('key'),/stopped/);assert.equal(creates,1);
});
