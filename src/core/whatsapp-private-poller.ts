import type {Pool} from 'pg';
import {AiManagerStore} from './ai-manager.js';
import {WhatsAppAiReceipts} from './whatsapp-ai-receipts.js';
import {runtimeAllows,type RuntimeScope} from './runtime-scope.js';
export type WhatsAppHistoryMessage={id:string;from:string;to:string;fromMe:boolean;timestamp:number;body:string;ack:number;type:string};
export type WhatsAppPrivateHistory={targetId:string;recipientAliases:string[];selfAliases:string[];messages:WhatsAppHistoryMessage[];exhausted:boolean};
export type WhatsAppPrivateReader=(accountId:string,recipientId:string,externalId:string)=>Promise<WhatsAppPrivateHistory>;
/** Bounded history catch-up, not just callbacks received since process startup. */
export class WhatsAppPrivatePoller{
 private running=new Map<string,Promise<{complete:boolean;reason?:string}>>();
 constructor(private pool:Pool,private readHistory:WhatsAppPrivateReader,private signal:AbortSignal,private scope:RuntimeScope,private now=Date.now){}
 poll(id:string){const current=this.running.get(id);if(current)return current;const work=this.read(id);this.running.set(id,work);void work.finally(()=>{if(this.running.get(id)===work)this.running.delete(id);}).catch(()=>{});return work;}
 private async checkpoint(id:string,phase:string,time:number,error:string|null){
  const changed=await this.pool.query(`INSERT INTO ai_whatsapp_private_cursors(conversation_id,phase_id,through_time,last_error)
   SELECT id,$2,$3,$4 FROM ai_conversations WHERE id=$1 AND active_phase_id=$2
   ON CONFLICT(conversation_id) DO UPDATE SET phase_id=excluded.phase_id,through_time=CASE WHEN ai_whatsapp_private_cursors.phase_id=excluded.phase_id THEN greatest(ai_whatsapp_private_cursors.through_time,excluded.through_time) ELSE excluded.through_time END,last_error=excluded.last_error,updated_at=now() RETURNING conversation_id`,[id,phase,time,error]);
  if(!changed.rowCount)throw Error('request_phase_changed');
 }
 private async read(id:string){
  this.signal.throwIfAborted();
  const v=(await this.pool.query(`SELECT v.*,p.started_at,c.through_time,c.phase_id AS cursor_phase,s.recipient_id,s.author_id,s.reader_account_id
   FROM ai_conversations v JOIN ai_request_phases p ON p.id=v.active_phase_id
   LEFT JOIN ai_whatsapp_private_cursors c ON c.conversation_id=v.id
   JOIN LATERAL(SELECT recipient_id,author_id,reader_account_id FROM ai_request_sources WHERE request_id=p.request_id AND conversation_id=v.id ORDER BY created_at DESC LIMIT 1)s ON true
   WHERE v.id=$1 AND v.platform='whatsapp'`,[id])).rows[0];
  if(!v||!runtimeAllows(this.scope,v.account_id,v.recipient_id)||!runtimeAllows(this.scope,v.reader_account_id,v.author_id))return{complete:false,reason:'outside_runtime_scope'};
  if(['closed','refused'].includes(v.business_status))return{complete:false,reason:'request_inactive'};
  const phaseSince=Math.max(0,Math.floor(new Date(v.started_at).getTime()/1000)*1000-1),cursor=v.cursor_phase===v.active_phase_id?Number(v.through_time):phaseSince;
  const since=Math.max(phaseSince,cursor-2000),until=this.now();
  if(until<cursor)throw Error('wa_clock_moved_backwards');
  try{
   const history=await this.readHistory(v.account_id,v.recipient_id,v.external_id);
   if(!history.recipientAliases.includes(v.recipient_id)||!history.recipientAliases.includes(v.external_id)||!history.recipientAliases.includes(history.targetId)||!history.selfAliases.length||history.selfAliases.some(a=>history.recipientAliases.includes(a)))throw Error('wa_private_target_unverified');
   if(history.messages.length>5000)throw Error('wa_history_backfill_limit');
   const unique=new Map<string,WhatsAppHistoryMessage>();let oldest=Infinity;
   for(const m of history.messages){
    if(!m.id||!Number.isSafeInteger(m.timestamp)||m.timestamp<0||typeof m.body!=='string'||Buffer.byteLength(m.body)>65536||typeof m.fromMe!=='boolean')throw Error('wa_history_invalid');
    const time=m.timestamp*1000;oldest=Math.min(oldest,time);
    if(time>since&&time<=until)unique.set(m.id,m);
   }
   if(!history.exhausted&&oldest>since)throw Error('wa_history_backfill_limit');
   const store=new AiManagerStore(this.pool),receipts=new WhatsAppAiReceipts(this.pool);
   // A late ack may concern an already ingested echo older than the inbox cursor.
   // Examine retained protocol IDs independently of the new-message window.
   const pendingIds=new Set((await this.pool.query(`SELECT i.reserved_message_id FROM ai_whatsapp_send_intents i JOIN ai_outbox a ON a.id=i.action_id
    WHERE i.account_id=$1 AND i.conversation_id=$2 AND a.state IN ('dispatching','unknown')`,[v.account_id,id])).rows.map(r=>r.reserved_message_id));
   for(const m of history.messages)if(m.fromMe&&pendingIds.has(m.id)){
    if(!history.recipientAliases.includes(m.to)||!history.selfAliases.includes(m.from))throw Error('wa_history_sender_unverified');
    await receipts.observe({accountId:v.account_id,messageId:m.id,targetId:m.to,selfId:m.from,ack:m.ack,text:m.body});
   }
   const ordered=[...unique.values()];
   // Provider timestamps have second precision. Ingest remote activity before own
   // activity at the same second, so a genuine manual reply wins that batch.
   ordered.sort((a,b)=>a.timestamp-b.timestamp||Number(a.fromMe)-Number(b.fromMe)||a.id.localeCompare(b.id));
   for(const m of ordered){
    this.signal.throwIfAborted();
    if(m.type==='notification_template'||m.type==='e2e_notification'||m.type==='gp2')continue;
    let origin:'customer'|'human'|'service'|'unresolved';
    if(m.fromMe){
     if(!history.recipientAliases.includes(m.to)||!history.selfAliases.includes(m.from))throw Error('wa_history_sender_unverified');
     origin=await receipts.origin(v.account_id,v.id,m.id);
    }else{
     if(!history.recipientAliases.includes(m.from)||!history.selfAliases.includes(m.to))throw Error('wa_history_sender_unverified');origin='customer';
    }
    await store.ingest({version:1,platform:'whatsapp',accountId:v.account_id,conversationId:v.external_id,messageId:m.id,occurredAt:new Date(m.timestamp*1000).toISOString(),direction:m.fromMe?'outbound':'inbound',origin,text:m.body},v.active_phase_id);
   }
   await this.checkpoint(id,v.active_phase_id,until,null);return{complete:true};
  }catch(error){
   const code=error instanceof Error&&/^wa_[a-z_]+$/.test(error.message)?error.message:'wa_poll_deferred';
   await this.checkpoint(id,v.active_phase_id,cursor,code).catch(()=>{});throw error;
  }
 }
}
