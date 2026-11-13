import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveMaxPhone,openVerifiedMaxPrivate,verifiedWirePhone} from './max-private-route.js';
import type {MaxConnection} from './max-connections.js';
function connection(result:unknown):MaxConnection{return{selfId:101,groups:[],close(){},openDialog:async()=> '303',socket:{connected:true,async send(op){if(op===37)return result;return{chats:[{id:303,type:'DIALOG',participants:{'101':{},'202':{}}}]};}}};}
test('phone lookup requires a unique exact verified phone, never a name containing the digits',async()=>{
 const phone='+79991234567';
 const c=connection({result:[{id:999,names:[{firstName:phone}],phone:0},{id:202,phone:79991234567}]});
 assert.equal((await resolveMaxPhone(c,phone)).authorId,'202');
 for(const result of [{result:[{id:999,phone:0,names:[{firstName:phone}]}]},{result:[{id:202,phone:79991234567},{id:203,phone:79991234567}]},{result:[{id:101,phone:79991234567}]}])await assert.rejects(resolveMaxPhone(connection(result),phone),/uniquely_verified/);
 assert.equal(verifiedWirePhone('89991234567'),undefined);assert.equal(verifiedWirePhone('7 999 1234567'),undefined);
});
test('opening a private dialog checks raw metadata rather than trusting a client fallback',async()=>{
 const c=connection({});assert.equal(await openVerifiedMaxPrivate(c,'202','-456'),'303');
 c.socket.send=async()=>({chats:[{id:303,type:'DIALOG',participants:{'101':{},'999':{}}}]});
 await assert.rejects(openVerifiedMaxPrivate(c,'202','-456'),/target_unverified/);
 await assert.rejects(openVerifiedMaxPrivate(c,'101','-456'),/route_unavailable/);
});
