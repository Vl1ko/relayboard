import assert from 'node:assert/strict';
import test from 'node:test';
import type {Pool} from 'pg';
import {MaxConnections,type MaxConnection,type MaxConnectionFactory} from './max-connections.js';
import {encryptCredentials} from './crypto.js';
function fixture(){
 const rows=new Map<string,{credential_ciphertext:string;max_self_id?:number}>(Array.from({length:6},(_,i)=>['account-'+i,{credential_ciphertext:encryptCredentials({token:'synthetic-'+i})}]));
 const pool={async query(sql:string,args:Array<string|number>){const row=rows.get(String(args[0]));if(row&&sql.startsWith('UPDATE'))row.max_self_id=Number(args[2]);return {rowCount:row?1:0,rows:row?[row]:[]};}} as unknown as Pool;
 const stop=new AbortController(),made:MaxConnection[]=[];let closed=0;
 const factory:MaxConnectionFactory=async(token,signal)=>{
  await Promise.resolve();signal.throwIfAborted();
  const connection:MaxConnection={selfId:101+(Number(token.split('-').at(-1))||0),socket:{connected:true,async send(){return {}; }},groups:[{id:'-1',title:'Test',participantsCount:2}],close(){if(this.socket.connected){Object.assign(this.socket,{connected:false});closed++;}}};made.push(connection);return connection;
 };
 const manager=new MaxConnections(pool,stop.signal,factory);
 return {manager,stop,rows,made,closed:()=>closed};
}
test('group discovery and concurrent sends share one account connection',async()=>{
 const f=fixture();try{
  const connections=await Promise.all(Array.from({length:20},()=>f.manager.get('account-0')));
  assert.equal(f.made.length,1);assert.ok(connections.every(c=>c===connections[0]));
  assert.equal(connections[0].groups[0].title,'Test');assert.equal(f.closed(),0);
 }finally{f.stop.abort();}
 assert.equal(f.closed(),1);
});
test('five accounts remain isolated; sixth waits for explicit capacity rather than evicting an active socket',async()=>{
 const f=fixture();try{
  const connections=await Promise.all(Array.from({length:5},(_,i)=>f.manager.get('account-'+i)));
  assert.equal(new Set(connections).size,5);await assert.rejects(f.manager.get('account-5'),/capacity/);
  f.manager.drop('account-2');await f.manager.get('account-5');assert.equal(f.closed(),1);assert.equal(f.made.length,6);
 }finally{f.stop.abort();}
});
test('credential rotation, disabled accounts and disconnect replace only the affected connection',async()=>{
 const f=fixture();try{
  const first=await f.manager.get('account-0'),other=await f.manager.get('account-1');
  f.rows.set('account-0',{credential_ciphertext:encryptCredentials({token:'synthetic-new'})});
  await f.manager.refresh();const newer=await f.manager.get('account-0');assert.notEqual(first,newer);assert.equal(first.socket.connected,false);assert.equal(other.socket.connected,true);
  Object.assign(newer.socket,{connected:false});
  const reconnected=await Promise.all(Array.from({length:10},()=>f.manager.get('account-0')));
  assert.ok(reconnected.every(c=>c===reconnected[0]));assert.equal(f.made.length,4);
  f.rows.delete('account-0');await f.manager.refresh();await assert.rejects(f.manager.get('account-0'),/unavailable/);assert.equal(other.socket.connected,true);
 }finally{f.stop.abort();}
});
test('ownership abort during login prevents publishing a late connection',async()=>{
 const stop=new AbortController();let release!:()=>void,closed=0;
 const gate=new Promise<void>(r=>release=r);
 const pool={async query(){return{rowCount:1,rows:[{credential_ciphertext:encryptCredentials({token:'synthetic'})}]};}} as unknown as Pool;
 const manager=new MaxConnections(pool,stop.signal,async()=>{await gate;return{selfId:1,groups:[],socket:{connected:true,async send(){return{};}},close(){closed++;}};});
 const pending=manager.get('account');await Promise.resolve();stop.abort();release();await assert.rejects(pending,/cancelled/);assert.equal(closed,1);await assert.rejects(manager.get('account'),/abort/i);
});

test('a rotated token cannot silently substitute a different MAX account identity',async()=>{
 const f=fixture();try{
  await f.manager.get('account-0');
  f.rows.set('account-0',{credential_ciphertext:encryptCredentials({token:'synthetic-4'}),max_self_id:101});
  await assert.rejects(f.manager.get('account-0'),/identity_changed/);
  assert.equal(f.made.at(-1)?.socket.connected,false);
 }finally{f.stop.abort();}
});
