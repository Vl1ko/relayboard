import type {Pool} from 'pg';
import type {MaxConnections} from './max-connections.js';
import {maxSourceAuthor} from './max-author-route.js';
import {SourceMonitor} from './source-monitor.js';
import type {RuntimeScope} from './runtime-scope.js';
/** One owner reads chosen groups and persists a cursor only after durable capture. */
export class MaxSourcePoller{
 private running=new Map<string,Promise<{complete:boolean;reason?:string}>>();
 constructor(private pool:Pool,private connections:MaxConnections,private signal:AbortSignal,private scope:RuntimeScope,private now=Date.now){}
 poll(accountId:string,chatId:string){
  const key=accountId+':'+chatId,current=this.running.get(key);if(current)return current;
  const work=this.read(accountId,chatId);this.running.set(key,work);void work.finally(()=>{if(this.running.get(key)===work)this.running.delete(key);}).catch(()=>{});return work;
 }
 private async checkpoint(accountId:string,chatId:string,epoch:string,time:number,error:string|null){
  const changed=await this.pool.query(`INSERT INTO ai_source_cursors(platform,account_id,chat_id,monitor_epoch,through_time,last_error,last_completed_at)
   SELECT 'max',$1,$2,$3,$4,$5,CASE WHEN $5::text IS NULL THEN clock_timestamp() ELSE NULL END FROM ai_monitor_settings m JOIN ai_search_sources s ON s.platform='max' AND s.chat_id=$2 AND s.account_id=$1 WHERE m.id=1 AND m.epoch=$3 AND m.mode<>'stopped'
   ON CONFLICT(platform,chat_id) DO UPDATE SET account_id=excluded.account_id,monitor_epoch=excluded.monitor_epoch,through_time=CASE WHEN ai_source_cursors.monitor_epoch=excluded.monitor_epoch THEN greatest(ai_source_cursors.through_time,excluded.through_time) ELSE excluded.through_time END,last_error=excluded.last_error,last_completed_at=coalesce(excluded.last_completed_at,ai_source_cursors.last_completed_at),updated_at=now() RETURNING chat_id`,[accountId,chatId,epoch,time,error]);
  if(!changed.rowCount)throw Error('max_source_policy_changed');
 }
 private async read(accountId:string,chatId:string){
  this.signal.throwIfAborted();
  if(this.scope.testOnly&&!this.scope.accountIds.includes(accountId))return{complete:false,reason:'outside_runtime_scope'};
  const source=(await this.pool.query(`SELECT m.epoch,m.started_at,c.monitor_epoch,c.through_time FROM ai_monitor_settings m JOIN ai_search_sources s ON s.account_id=$1 AND s.chat_id=$2 AND s.platform='max' LEFT JOIN ai_source_cursors c ON c.platform=s.platform AND c.chat_id=s.chat_id WHERE m.id=1 AND m.mode<>'stopped'`,[accountId,chatId])).rows[0];
  if(!source)return{complete:false,reason:'source_inactive'};
  if(!/^-?\d+$/.test(chatId)||!Number.isSafeInteger(Number(chatId)))throw Error('max_source_unverified');
  const since=source.monitor_epoch===source.epoch?Number(source.through_time):Math.max(0,new Date(source.started_at).getTime()-1),until=this.now();
  if(until<since)throw Error('max_source_clock_moved_backwards');
  try{
   const connection=await this.connections.get(accountId),metadata=await connection.socket.send(48,{chatIds:[Number(chatId)]}) as any;
   if(!metadata?.chats?.some((c:any)=>String(c.id)===chatId&&c.type==='CHAT'))throw Error('max_source_unverified');
   let from=until,complete=false;const items=new Map<string,any>();
   for(let page=0;page<50;page++){
    this.signal.throwIfAborted();
    const result=await connection.socket.send(49,{chatId:Number(chatId),from,backward:100,forward:0,getMessages:true},10000) as any;
    if(!Array.isArray(result?.messages))throw Error('max_source_history_invalid');
    let oldest=from;
    for(const m of result.messages){if(!m||!String(m.id??'').trim()||!Number.isFinite(Number(m.time))||Number(m.time)<0)throw Error('max_source_history_invalid');const time=Number(m.time);oldest=Math.min(oldest,time);if(time>since&&time<=until)items.set(String(m.id),m);}
    if(result.messages.length<100||oldest<=since){complete=true;break;}
    if(oldest>=from)throw Error('max_source_page_stalled');from=oldest;
   }
   if(!complete)throw Error('max_source_backfill_limit');
   const monitor=new SourceMonitor(this.pool,this.scope);
   for(const message of [...items.values()].sort((a,b)=>Number(a.time)-Number(b.time)||String(a.id).localeCompare(String(b.id),undefined,{numeric:true}))){
    this.signal.throwIfAborted();const author=maxSourceAuthor(message,connection.selfId);if(!author)continue;
    await monitor.capture({platform:'max',accountId,chatId,...author,selfAuthorIds:[String(connection.selfId)]});
   }
   await this.checkpoint(accountId,chatId,source.epoch,until,null);return{complete:true};
  }catch(error){const code=error instanceof Error&&/^max_source_[a-z_]+$/.test(error.message)?error.message:'max_source_poll_deferred';await this.checkpoint(accountId,chatId,source.epoch,since,code).catch(()=>{});throw error;}
 }
}
