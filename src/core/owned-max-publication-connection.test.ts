import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {MaxConnections} from './max-connections.js';
import {DeliveryError} from './delivery-policy.js';
import {dispatchOwnedMaxPublication} from './owned-max-publication.js';
import {WsError} from '@ounezz/umax';
import {setTimeout as delay} from 'node:timers/promises';

test('connection failure before send remains safely waiting',async()=>{
 let queries=0;
 const pool={async query(){queries++;return queries===1?{rows:[{status:'sending',account_id:'account',external_id:'-123'}]}:{rows:[]};}} as unknown as Pool;
 const connections={async get(){throw Error('max_connection_timeout_or_cancelled');}} as unknown as MaxConnections;
 await assert.rejects(dispatchOwnedMaxPublication(pool,connections,'delivery',new AbortController().signal,60000),(error:unknown)=>error instanceof DeliveryError&&error.kind==='waiting');
 assert.equal(queries,2);
});

test('only explicit server denials clear provisional receipts; account throttling preserves waiting work',async()=>{
 for(const mode of ['denied','rate','disconnect','sent']){
  const queries:string[]=[];
  let sends=0;
  const pool={async query(sql:string){
   queries.push(sql);
   if(sql.startsWith('SELECT d.id'))return{rows:[{status:'sending',post_id:'post',account_id:'account-'+mode,external_id:'-123'}]};
   if(sql.startsWith('INSERT INTO max_send_receipts'))return{rows:[{delivery_id:'delivery'}],rowCount:1};
   if(sql.startsWith('SELECT text FROM posts'))return{rows:[{text:'synthetic'}]};
   return{rows:[]};
  },async connect(){return{release(){},async query(sql:string){
   if(sql.startsWith('SELECT status,media_expired_at'))return{rows:[{status:'active'}]};
   if(sql.startsWith('SELECT status FROM deliveries'))return{rows:[{status:'sending'}]};
   if(sql.startsWith('SELECT i.enabled'))return{rows:[{enabled:true,destination_enabled:true,external_id:'-123'}]};
   return{rows:[]};
  }};}} as unknown as Pool;
  const connections={async get(){return{socket:{connected:true,async send(){
   sends++;
   if(mode==='sent')return{message:{id:'confirmed'}};
   throw mode==='disconnect'?Error('WebSocket disconnected'):new WsError('Rejected',64,{error:mode==='rate'?'too.many.requests':'chat.denied'});
  }}};}} as unknown as MaxConnections;
  const run=()=>dispatchOwnedMaxPublication(pool,connections,'delivery',new AbortController().signal,60000);
  if(mode==='sent')assert.deepEqual(await run(),{externalMessageId:'confirmed'});
  else await assert.rejects(run(),e=>e instanceof DeliveryError&&e.kind===(mode==='denied'?'permanent':mode==='rate'?'waiting':'ambiguous'));
  assert.equal(queries.some(q=>q.startsWith('DELETE FROM max_send_receipts')),mode==='denied'||mode==='rate');
  assert.equal(queries.some(q=>q.startsWith('UPDATE max_send_receipts')),mode==='disconnect'||mode==='sent');
  // A second post on the same account must not bypass pacing/cooldown.
  if(mode==='rate')await assert.rejects(run(),e=>e instanceof DeliveryError&&e.kind==='waiting');
  else{
   const stop=new AbortController();let settled=false;
   const second=dispatchOwnedMaxPublication(pool,connections,'another-delivery',stop.signal,60000);
   second.finally(()=>{settled=true;}).catch(()=>{});
   try{await delay(20);assert.equal(settled,false);assert.equal(sends,1);}
   finally{stop.abort();await assert.rejects(second);}
  }
  assert.equal(sends,1);
 }
});
