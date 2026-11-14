import type {Pool} from 'pg';
import {SourceMonitor} from './source-monitor.js';
import type {RuntimeScope} from './runtime-scope.js';
export type WhatsAppGroupHistory={chatId:string;isGroup:boolean;selfAliases:string[];exhausted:boolean;messages:{id:string;chatId:string;authorId:string;fromMe:boolean;timestamp:number;text:string;type:string}[]};
export class WhatsAppSourcePoller{
 private running=new Map<string,Promise<{complete:boolean;reason?:string}>>();
 constructor(private pool:Pool,private reader:(accountId:string,chatId:string)=>Promise<WhatsAppGroupHistory>,private signal:AbortSignal,private scope:RuntimeScope,private now=Date.now){}
 poll(accountId:string,chatId:string){const key=accountId+':'+chatId,current=this.running.get(key);if(current)return current;const work=this.read(accountId,chatId);this.running.set(key,work);void work.finally(()=>{if(this.running.get(key)===work)this.running.delete(key);}).catch(()=>{});return work;}
 private async checkpoint(accountId:string,chatId:string,epoch:string,time:number,error:string|null){
  const saved=await this.pool.query(`INSERT INTO ai_source_cursors(platform,account_id,chat_id,monitor_epoch,through_time,last_error,last_completed_at)
   SELECT 'whatsapp',$1,$2,$3,$4,$5,CASE WHEN $5::text IS NULL THEN clock_timestamp() ELSE NULL END FROM ai_monitor_settings m JOIN ai_search_sources s ON s.platform='whatsapp' AND s.chat_id=$2 AND s.account_id=$1 WHERE m.id=1 AND m.epoch=$3 AND m.mode<>'stopped'
   ON CONFLICT(platform,chat_id) DO UPDATE SET account_id=excluded.account_id,monitor_epoch=excluded.monitor_epoch,through_time=CASE WHEN ai_source_cursors.monitor_epoch=excluded.monitor_epoch THEN greatest(ai_source_cursors.through_time,excluded.through_time) ELSE excluded.through_time END,last_error=excluded.last_error,last_completed_at=coalesce(excluded.last_completed_at,ai_source_cursors.last_completed_at),updated_at=now() RETURNING chat_id`,[accountId,chatId,epoch,time,error]);if(!saved.rowCount)throw Error('wa_source_policy_changed');
 }
 private async read(accountId:string,chatId:string){
  this.signal.throwIfAborted();if(this.scope.testOnly&&!this.scope.accountIds.includes(accountId))return{complete:false,reason:'outside_runtime_scope'};
  const source=(await this.pool.query(`SELECT m.epoch,m.started_at,c.monitor_epoch,c.through_time FROM ai_monitor_settings m JOIN ai_search_sources s ON s.account_id=$1 AND s.chat_id=$2 AND s.platform='whatsapp' LEFT JOIN ai_source_cursors c ON c.platform=s.platform AND c.chat_id=s.chat_id WHERE m.id=1 AND m.mode<>'stopped'`,[accountId,chatId])).rows[0];if(!source)return{complete:false,reason:'source_inactive'};
  const start=Math.max(0,Math.floor(new Date(source.started_at).getTime()/1000)*1000-1),cursor=source.monitor_epoch===source.epoch?Number(source.through_time):start,since=Math.max(start,cursor-2000),until=this.now();
  if(until<cursor)throw Error('wa_source_clock_moved_backwards');
  try{
   const history=await this.reader(accountId,chatId);
   if(!history.isGroup||history.chatId!==chatId||!chatId.endsWith('@g.us')||!history.selfAliases.length)throw Error('wa_source_unverified');
   if(history.messages.length>5000)throw Error('wa_source_backfill_limit');
   let oldest=Infinity;const collected=new Map<string,WhatsAppGroupHistory['messages'][number]>();
   for(const m of history.messages){
    if(!m.id||m.chatId!==chatId||!Number.isSafeInteger(m.timestamp)||m.timestamp<0||typeof m.text!=='string'||typeof m.fromMe!=='boolean')throw Error('wa_source_history_invalid');
    const time=m.timestamp*1000;oldest=Math.min(oldest,time);if(time>since&&time<=until)collected.set(m.id,m);
   }
   if(!history.exhausted&&oldest>since)throw Error('wa_source_backfill_limit');
   const monitor=new SourceMonitor(this.pool,this.scope);
   for(const m of [...collected.values()].sort((a,b)=>a.timestamp-b.timestamp||a.id.localeCompare(b.id))){
    this.signal.throwIfAborted();if(m.fromMe||history.selfAliases.includes(m.authorId)||!m.text.trim()||m.type!=='chat')continue;
    if(!/^[1-9][0-9]{0,30}@(c\.us|lid)$/.test(m.authorId))throw Error('wa_source_author_unverified');
    await monitor.capture({platform:'whatsapp',accountId,chatId,authorId:m.authorId,messageId:m.id,occurredAt:new Date(m.timestamp*1000).toISOString(),text:m.text,selfAuthorIds:history.selfAliases});
   }
   await this.checkpoint(accountId,chatId,source.epoch,until,null);return{complete:true};
  }catch(error){const code=error instanceof Error&&/^wa_source_[a-z_]+$/.test(error.message)?error.message:'wa_source_poll_deferred';await this.checkpoint(accountId,chatId,source.epoch,cursor,code).catch(()=>{});throw error;}
 }
}
