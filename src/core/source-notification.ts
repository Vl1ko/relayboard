import type {Pool} from 'pg';
import {prepareMaxAiText,type ConnectedMaxTextSocket} from './adapters/max-ai-text.js';
import {runtimeAllows,type RuntimeScope} from './runtime-scope.js';

/** A committed dispatching state is never retried after an uncertain send. */
export async function dispatchSourceNotification(pool:Pool,id:string,scope:RuntimeScope,resolve:(accountId:string)=>Promise<ConnectedMaxTextSocket>){
 const row=(await pool.query(`SELECT n.*,l.account_id,l.author_id,l.platform,l.chat_id,l.original_text,l.source_link
  FROM ai_source_notifications n JOIN ai_leads l ON l.id=n.lead_id JOIN ai_source_messages s ON s.id=l.source_message_id JOIN ai_monitor_settings m ON m.id=1 AND m.epoch=s.monitor_epoch AND m.mode='active' JOIN ai_search_sources selected ON selected.account_id=l.account_id AND selected.platform=l.platform AND selected.chat_id=l.chat_id WHERE n.id=$1 AND NOT coalesce((SELECT (settings->>'qualificationEnabled')::boolean FROM ai_engine_settings ORDER BY version DESC LIMIT 1),false)`,[id])).rows[0];
 if(!row||row.state!=='pending'||!runtimeAllows(scope,row.account_id,row.author_id))return {initiated:false};
 const target=row.target_account_id?{accountId:row.target_account_id,externalId:row.target_external_id}:(await pool.query('SELECT account_id AS "accountId",external_id AS "externalId" FROM ai_manager_target WHERE id=1')).rows[0];
 if(!target||!/^\-?\d+$/.test(target.externalId)||!Number.isSafeInteger(Number(target.externalId)))return {initiated:false};
 const account=(await pool.query("SELECT id FROM integrations WHERE id=$1 AND platform='max' AND enabled AND auth_error IS NULL",[target.accountId])).rows[0];
 if(!account)return {initiated:false};
 const socket=await resolve(target.accountId);
 if(!socket.connected)return {initiated:false};
 const metadata=await socket.send(48,{chatIds:[Number(target.externalId)]}) as {chats?:{id:number;type:string}[]};
 if(!metadata.chats?.some(c=>c.type==='CHAT'&&String(c.id)===target.externalId))return {initiated:false};
 // A source chat must never become its own notification destination.
 if(row.platform==='max'&&row.chat_id===target.externalId)return {initiated:false};
 const prepared=prepareMaxAiText({socket,accountId:target.accountId,chatId:target.externalId,allowedChatId:target.externalId});
 const claim=await pool.query(`UPDATE ai_source_notifications SET state='dispatching',target_account_id=$2,target_external_id=$3,updated_at=now()
  WHERE id=$1 AND state='pending' AND (target_account_id IS NULL OR (target_account_id=$2 AND target_external_id=$3)) RETURNING id`,[id,target.accountId,target.externalId]);
 if(!claim.rowCount)return {initiated:false};
 const text=['Новая подходящая заявка',`Источник: ${row.platform==='max'?'MAX':'WhatsApp'}, чат ${row.chat_id}`,`Автор: ${row.author_id}`,row.source_link?`Ссылка: ${row.source_link}`:'', '',row.original_text].filter((v:string)=>v!==undefined&&v!==null).join('\n');
 let outcome:any;
 try {outcome=await prepared.start({operationId:id,conversationId:id,text}).acknowledgement;} catch {outcome={outcome:'unknown',code:'send_exception'};}
 const state=outcome?.operationId===id&&outcome.outcome==='confirmed'&&outcome.externalMessageId?'confirmed':outcome?.operationId===id&&outcome.outcome==='rejected'?'rejected':'unknown';
 await pool.query('UPDATE ai_source_notifications SET state=$2,external_message_id=$3,outcome_code=$4,updated_at=now() WHERE id=$1 AND state=\'dispatching\'',[id,state,state==='confirmed'?outcome.externalMessageId:null,String(outcome?.code??'invalid_ack').slice(0,256)]);
 return {initiated:true,state};
}
