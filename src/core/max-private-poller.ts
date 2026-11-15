import type {Pool} from 'pg';
import {AiManagerStore} from './ai-manager.js';
import type {MaxConnections} from './max-connections.js';
import {assertMaxAuthorDialog} from './max-author-route.js';
import {runtimeAllows,type RuntimeScope} from './runtime-scope.js';

export class MaxPrivatePoller{
 private running=new Map<string,Promise<{complete:boolean;reason?:string}>>();
 private store:AiManagerStore;
 constructor(private pool:Pool,private connections:MaxConnections,private signal:AbortSignal,private scope:RuntimeScope,private now=Date.now){this.store=new AiManagerStore(pool);}
 poll(id:string){
  const existing=this.running.get(id);if(existing)return existing;
  const work=this.read(id);this.running.set(id,work);
  void work.finally(()=>{if(this.running.get(id)===work)this.running.delete(id);}).catch(()=>{});
  return work;
 }
 private async checkpoint(id:string,phase:string,time:number,error:string|null){
  const changed=await this.pool.query(`INSERT INTO ai_max_private_cursors(conversation_id,phase_id,through_time,last_error)
   SELECT id,$2,$3,$4 FROM ai_conversations WHERE id=$1 AND active_phase_id=$2
   ON CONFLICT(conversation_id) DO UPDATE SET phase_id=excluded.phase_id,
    through_time=CASE WHEN ai_max_private_cursors.phase_id=excluded.phase_id THEN greatest(ai_max_private_cursors.through_time,excluded.through_time) ELSE excluded.through_time END,
    last_error=excluded.last_error,updated_at=now() RETURNING conversation_id`,[id,phase,time,error]);
  if(!changed.rowCount)throw Error('request_phase_changed');
 }
 private async read(id:string){
  this.signal.throwIfAborted();
  const v=(await this.pool.query(`SELECT v.*,p.started_at,(SELECT min(started_at) FROM ai_request_phases WHERE conversation_id=v.id) AS history_started_at,c.through_time,c.phase_id AS cursor_phase,s.author_id,s.external_chat_id,s.reader_account_id,s.source_author_id FROM ai_conversations v
   JOIN ai_request_phases p ON p.id=v.active_phase_id
   LEFT JOIN ai_max_private_cursors c ON c.conversation_id=v.id
   JOIN LATERAL(SELECT recipient_id AS author_id,author_id AS source_author_id,reader_account_id,external_chat_id FROM ai_request_sources WHERE request_id=p.request_id AND conversation_id=v.id ORDER BY created_at DESC LIMIT 1)s ON true WHERE v.id=$1 AND v.platform='max'`,[id])).rows[0];
  if(!v||(!runtimeAllows(this.scope,v.account_id,v.author_id)||!runtimeAllows(this.scope,v.reader_account_id,v.source_author_id)))return{complete:false,reason:'outside_runtime_scope'};
  const since=v.through_time!==null?(v.cursor_phase===v.active_phase_id?Number(v.through_time):Math.min(Number(v.through_time),Math.max(0,new Date(v.started_at).getTime()-1))):Math.max(0,new Date(v.history_started_at).getTime()-1),until=this.now();
  if(until<since)throw Error('max_clock_moved_backwards');
  try{
   const connection=await this.connections.get(v.account_id);
   const metadata=await connection.socket.send(48,{chatIds:[Number(v.external_id)]}) as any;
   const chat=metadata?.chats?.find((c:any)=>String(c.id)===v.external_id);
   if(!chat)throw Error('max_private_target_unverified');
   assertMaxAuthorDialog(chat,connection.selfId,v.author_id,v.external_chat_id);
   let from=until,complete=false;const collected=new Map<string,any>();
   for(let page=0;page<50;page++){
    this.signal.throwIfAborted();
    const response=await connection.socket.send(49,{chatId:Number(v.external_id),from,backward:100,forward:0,getMessages:true},10000) as any;
    if(!Array.isArray(response?.messages))throw Error('max_history_invalid');
    let oldest=from;
    for(const m of response.messages){
     if(!m||!Number.isFinite(Number(m.time))||Number(m.time)<0||String(m.id??'').length===0)throw Error('max_history_invalid');
     const time=Number(m.time);oldest=Math.min(oldest,time);
     if(time>since&&time<=until)collected.set(String(m.id),m);
    }
    if(response.messages.length<100||oldest<=since){complete=true;break;}
    // Keep the timestamp overlap; dedup handles an inclusive page boundary.
    // No progress at a full timestamp boundary is a gap, never permission to skip.
    if(oldest>=from)throw Error('max_history_page_stalled');
    from=oldest;
   }
   if(!complete)throw Error('max_history_backfill_limit');
   const ordered=[...collected.values()].sort((a,b)=>Number(a.time)-Number(b.time)||String(a.id).localeCompare(String(b.id),undefined,{numeric:true}));
   for(const m of ordered){
    this.signal.throwIfAborted();
    if(m.type!==undefined&&m.type!=='USER')continue;
    const sender=String(m.sender),own=sender===String(connection.selfId);
    if(!own&&sender!==v.author_id)throw Error('max_history_sender_unverified');
    if(typeof m.text!=='string'&&m.text!==undefined&&m.text!==null)throw Error('max_history_invalid');
    if(Buffer.byteLength(m.text??'')>65536)throw Error('max_history_message_too_large');
    let origin:'customer'|'human'|'service'|'unresolved'=own?'human':'customer';
    if(own){
     const known=(await this.pool.query("SELECT 1 FROM ai_outbox WHERE conversation_id=$1 AND external_message_id=$2 AND state='confirmed'",[id,String(m.id)])).rowCount;
     if(known)origin='service';
     else{
      const pending=(await this.pool.query("SELECT state FROM ai_outbox WHERE conversation_id=$1 AND state IN ('dispatching','unknown')",[id])).rows;
      if(pending.some(a=>a.state==='dispatching'))return{complete:false,reason:'receipt_pending'};
      if(pending.length)origin='unresolved';
     }
    }
    await this.store.ingest({version:1,platform:'max',accountId:v.account_id,conversationId:v.external_id,messageId:String(m.id),occurredAt:new Date(Number(m.time)).toISOString(),direction:own?'outbound':'inbound',origin,text:m.text??''},v.active_phase_id);
   }
   await this.checkpoint(id,v.active_phase_id,until,null);
   return{complete:true};
  }catch(error){
   const code=error instanceof Error&&/^max_[a-z_]+$/.test(error.message)?error.message:'max_poll_deferred';
   await this.checkpoint(id,v.active_phase_id,since,code).catch(()=>{});throw error;
  }
 }
}
