import {closeMaxClient} from './max-close.js';
import type {Pool} from 'pg';
import {isAuthorizationError} from './delivery-policy.js';
import {UMax} from '@ounezz/umax';
import {decryptCredentials} from './crypto.js';
import type {ConnectedMaxTextSocket} from './adapters/max-ai-text.js';

export type MaxConnection={socket:ConnectedMaxTextSocket;selfId:number;groups:Array<{id:string;title:string;participantsCount:number}>;openDialog?:(authorId:number)=>Promise<string>;close:()=>void};
export type MaxConnectionFactory=(token:string,signal:AbortSignal)=>Promise<MaxConnection>;
export const connectMax:MaxConnectionFactory=async(token,signal)=>{
 const client=new UMax(token);
 (client.chats as unknown as {subscribe_all:()=>void}).subscribe_all=()=>{};
 const close=()=>closeMaxClient(client as unknown as Parameters<typeof closeMaxClient>[0]);signal.addEventListener('abort',close,{once:true});
 try{
  signal.throwIfAborted();await client.connect();signal.throwIfAborted();
  const socket=(client as unknown as{ws:ConnectedMaxTextSocket}).ws;
  if(!client.account?.id||!socket.connected)throw Error('max_connection_unverified');
  return {socket,selfId:client.account.id,async openDialog(authorId){signal.throwIfAborted();const chat=await client.chats.new(authorId);signal.throwIfAborted();return String(chat.id);},groups:client.chats.list.filter(c=>c.type==='CHAT').map(c=>({id:String(c.id),title:c.title,participantsCount:c.participants_count})),close(){signal.removeEventListener('abort',close);close();}};
 }catch(error){signal.removeEventListener('abort',close);close();throw error;}
};

/** Owned by one messenger process. API discovery and sends share the same socket. */
export class MaxConnections{
 private entries=new Map<string,{cipher:string;stop:AbortController;promise:Promise<MaxConnection>;connection?:MaxConnection}>();
 constructor(private pool:Pool,private signal:AbortSignal,private factory:MaxConnectionFactory=connectMax,private limit=5){
  signal.addEventListener('abort',()=>this.close(),{once:true});
 }
 async get(accountId:string):Promise<MaxConnection>{
  this.signal.throwIfAborted();
  const account=(await this.pool.query("SELECT credential_ciphertext,max_self_id FROM integrations WHERE id=$1 AND platform='max' AND enabled AND auth_error IS NULL",[accountId])).rows[0];
  if(!account){this.drop(accountId);throw Error('max_account_unavailable');}
  const old=this.entries.get(accountId);
  if(old&&old.cipher===account.credential_ciphertext){
   const connection=await old.promise;
   if(connection.socket.connected)return connection;
   if(this.entries.get(accountId)!==old)return this.get(accountId);
   this.drop(accountId);
  }else if(old)this.drop(accountId);
  if(this.entries.size>=this.limit)throw Error('max_account_capacity');
  const stop=new AbortController();
  const entry:{cipher:string;stop:AbortController;promise:Promise<MaxConnection>;connection?:MaxConnection}={cipher:account.credential_ciphertext,stop,promise:undefined as unknown as Promise<MaxConnection>};
  this.entries.set(accountId,entry);
  entry.promise=(async()=>{
   const {token}=decryptCredentials(account.credential_ciphertext);
   if(!token)throw Error('max_token_missing');
   const connection=await this.factory(token,AbortSignal.any([this.signal,stop.signal]));
   if(this.signal.aborted||stop.signal.aborted){connection.close();throw Error('max_connection_cancelled');}
   try{
    if(account.max_self_id!=null&&String(account.max_self_id)!==String(connection.selfId))throw Error('max_account_identity_changed');
    const saved=await this.pool.query('UPDATE integrations SET max_self_id=$3 WHERE id=$1 AND credential_ciphertext=$2 AND enabled AND (max_self_id IS NULL OR max_self_id=$3) RETURNING id',[accountId,account.credential_ciphertext,connection.selfId]);
    if(!saved.rowCount||this.signal.aborted||stop.signal.aborted)throw Error('max_connection_cancelled');
   }catch(error){connection.close();throw error;}
   entry.connection=connection;return connection;
  })();
  entry.promise.catch(error=>{
   if(this.entries.get(accountId)===entry)this.drop(accountId);
   if(isAuthorizationError(error))void this.pool.query("UPDATE integrations SET auth_error='MAX: требуется повторный вход' WHERE id=$1 AND credential_ciphertext=$2",[accountId,entry.cipher]).catch(()=>{});
  });
  return entry.promise;
 }
 drop(accountId:string){
  const entry=this.entries.get(accountId);if(!entry)return;
  this.entries.delete(accountId);entry.stop.abort();
  entry.connection?.close();
 }
 async refresh(){
  for(const id of [...this.entries.keys()]){
   const account=(await this.pool.query("SELECT credential_ciphertext,max_self_id FROM integrations WHERE id=$1 AND platform='max' AND enabled AND auth_error IS NULL",[id])).rows[0];
   if(!account||account.credential_ciphertext!==this.entries.get(id)?.cipher)this.drop(id);
  }
 }
 close(){for(const id of [...this.entries.keys()])this.drop(id);}
}
