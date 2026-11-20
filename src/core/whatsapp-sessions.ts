export interface WhatsAppSession {close():Promise<void>}
export interface WhatsAppSessionAccount {id:string;session_key:string}
/** Called only while holding the process-wide WhatsApp session ownership slot. */
export class WhatsAppSessions<T extends WhatsAppSession>{
 private sessions=new Map<string,T>();
 private stopped=false;
 private queue:Promise<unknown>=Promise.resolve();
 constructor(private list:()=>Promise<WhatsAppSessionAccount[]>,private create:(account:WhatsAppSessionAccount)=>T,private limit=5){}
 private exclusive<R>(work:()=>Promise<R>):Promise<R>{const result=this.queue.then(work);this.queue=result.catch(()=>{});return result;}
 private async reconcile(){
  const accounts=await this.list();
  if(this.stopped)throw Error('whatsapp_owner_stopped');
  const keys=new Set(accounts.map(a=>a.session_key));
  for(const [key,session] of this.sessions)if(!keys.has(key)){await session.close();this.sessions.delete(key);}
  return accounts;
 }
 get(key:string){return this.exclusive(async()=>{
  if(this.stopped)throw Error('whatsapp_owner_stopped');
  const accounts=await this.reconcile(),account=accounts.find(a=>a.session_key===key);
  if(!account)throw Error('whatsapp_account_disabled_or_missing');
  const current=this.sessions.get(key);if(current)return current;
  if(this.sessions.size>=this.limit)throw Error('whatsapp_account_capacity');
  const session=this.create(account);this.sessions.set(key,session);return session;
 });}
 restore(){return this.exclusive(async()=>{
  if(this.stopped)return;
  const accounts=await this.reconcile();
  for(const account of accounts){if(this.sessions.size>=this.limit)break;if(!this.sessions.has(account.session_key))this.sessions.set(account.session_key,this.create(account));}
 });}
 refresh(){return this.exclusive(async()=>{if(!this.stopped)await this.reconcile();});}
 close(){this.stopped=true;return this.exclusive(async()=>{await Promise.all([...this.sessions.values()].map(s=>s.close()));this.sessions.clear();});}
}
