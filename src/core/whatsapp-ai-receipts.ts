import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
const jid=/^[1-9][0-9]{0,30}@(c\.us|lid)$/;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
/** Inputs come from the owning, identity-verified browser, never an HTTP receipt payload. */
export class WhatsAppAiReceipts{
 constructor(private pool:Pool){}
 async reserve(input:{actionId:string;accountId:string;conversationId:string;messageId:string;targetId:string;recipientAliases:string[];selfAliases:string[]}){
  if(!jid.test(input.targetId)||!input.recipientAliases.includes(input.targetId)||input.recipientAliases.length>8||input.recipientAliases.some(id=>!jid.test(id))||!input.selfAliases.length||input.selfAliases.length>8||input.selfAliases.some(id=>!jid.test(id))||input.selfAliases.includes(input.targetId)||!input.messageId.trim()||input.messageId.length>512)throw Error('wa_intent_unverified');
  const result=await this.pool.query(`INSERT INTO ai_whatsapp_send_intents(action_id,account_id,conversation_id,reserved_message_id,target_id,recipient_aliases,self_aliases)
   SELECT a.id,v.account_id,v.id,$4,$5,$6,$7 FROM ai_outbox a JOIN ai_conversations v ON v.id=a.conversation_id
   WHERE a.id=$1 AND v.account_id=$2 AND v.id=$3 AND v.platform='whatsapp' AND a.state='pending' AND v.external_id=ANY($8::text[])
   ON CONFLICT(account_id,reserved_message_id) DO NOTHING RETURNING id`,[input.actionId,input.accountId,input.conversationId,input.messageId,input.targetId,JSON.stringify([...new Set(input.recipientAliases)]),JSON.stringify([...new Set(input.selfAliases)]),input.recipientAliases]);
  if(!result.rowCount)throw Error('wa_intent_binding_changed');return result.rows[0].id as string;
 }
 /** Persist an exact server acknowledgement even if it precedes the outbox COMMIT. */
 async observe(input:{accountId:string;messageId:string;targetId:string;selfId:string;ack:number;text:string}){
  if(!Number.isInteger(input.ack)||input.ack<1||input.ack>4)return false;
  const updated=await this.pool.query(`UPDATE ai_whatsapp_send_intents SET server_ack=greatest(coalesce(server_ack,0),$5),observed_body_hash=$6,ack_verified_at=clock_timestamp()
   WHERE account_id=$1 AND reserved_message_id=$2 AND target_id=$3 AND self_aliases ? $4
    AND (observed_body_hash IS NULL OR observed_body_hash=$6) RETURNING action_id`,[input.accountId,input.messageId,input.targetId,input.selfId,input.ack,hash(input.text)]);
  if(!updated.rowCount)return false;
  await this.reconcile(updated.rows[0].action_id);return true;
 }
 async reconcile(actionId:string){
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'");
   const found=(await client.query('SELECT contact_id,conversation_id FROM ai_outbox WHERE id=$1',[actionId])).rows[0];if(!found){await client.query('COMMIT');return false;}
   await client.query('SELECT id FROM ai_contacts WHERE id=$1 FOR UPDATE',[found.contact_id]);
   await client.query('SELECT id FROM ai_conversations WHERE id=$1 FOR UPDATE',[found.conversation_id]);
   const action=(await client.query('SELECT * FROM ai_outbox WHERE id=$1 FOR UPDATE',[actionId])).rows[0];
   if(!['dispatching','unknown'].includes(action.state)||!action.attempt_token||!action.dispatch_started_at){await client.query('COMMIT');return false;}
   const proofs=(await client.query(`SELECT i.* FROM ai_whatsapp_send_intents i JOIN ai_conversations v ON v.id=i.conversation_id
    WHERE i.action_id=$1 AND i.server_ack>=1 AND i.observed_body_hash=$2 AND v.id=$3 AND v.account_id=i.account_id FOR UPDATE OF i`,[actionId,hash(action.text),found.conversation_id])).rows;
   // More than one accepted reserved ID is a protocol violation, not permission to pick one.
   if(proofs.length!==1){await client.query('COMMIT');return false;}
   await client.query("UPDATE ai_outbox SET state='confirmed',external_message_id=$2,outcome_code='wa_server_ack_reconciled',updated_at=now() WHERE id=$1",[actionId,proofs[0].reserved_message_id]);
   await client.query(`INSERT INTO ai_outreach_clocks(account_id,last_started_at) SELECT account_id,clock_timestamp() FROM ai_conversations WHERE id=$1
    AND EXISTS(SELECT 1 FROM ai_outreach_items WHERE action_id=$2) ON CONFLICT(account_id) DO UPDATE SET last_started_at=greatest(ai_outreach_clocks.last_started_at,excluded.last_started_at)`,[found.conversation_id,actionId]);
   await client.query('COMMIT');return true;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async origin(accountId:string,conversationId:string,messageId:string):Promise<'service'|'human'|'unresolved'>{
  const intent=(await this.pool.query(`SELECT a.state,a.attempt_token FROM ai_whatsapp_send_intents i JOIN ai_outbox a ON a.id=i.action_id
   WHERE i.account_id=$1 AND i.conversation_id=$2 AND i.reserved_message_id=$3`,[accountId,conversationId,messageId])).rows[0];
  if(intent)return intent.attempt_token&&['dispatching','unknown','confirmed'].includes(intent.state)?'service':'unresolved';
  const confirmed=(await this.pool.query("SELECT 1 FROM ai_outbox WHERE conversation_id=$1 AND state='confirmed' AND external_message_id=$2",[conversationId,messageId])).rowCount;
  return confirmed?'service':'human';
 }
}
