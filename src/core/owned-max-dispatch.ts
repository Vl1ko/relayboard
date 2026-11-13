import type {Pool} from 'pg';
import {AiManagerStore} from './ai-manager.js';
import type {MaxConnections} from './max-connections.js';
import {assertMaxAuthorDialog} from './max-author-route.js';
import {prepareMaxAiText} from './adapters/max-ai-text.js';

/** The process that owns the socket performs the durable dispatch gate itself. */
export async function dispatchOwnedMax(pool:Pool,connections:MaxConnections,actionId:string,signal:AbortSignal){
 signal.throwIfAborted();
 const target=(await pool.query(`SELECT a.id,v.id AS conversation_id,v.account_id,v.external_id,v.active_phase_id FROM ai_outbox a JOIN ai_conversations v ON v.id=a.conversation_id WHERE a.id=$1 AND v.platform='max'`,[actionId])).rows[0];
 if(!target)throw Error('max_action_missing');
 const source=(await pool.query(`SELECT s.recipient_id AS author_id,s.external_chat_id FROM ai_request_sources s JOIN ai_request_phases p ON p.request_id=s.request_id WHERE p.id=$1 AND s.conversation_id=$2 ORDER BY s.created_at DESC LIMIT 1`,[target.active_phase_id,target.conversation_id])).rows[0];
 if(!source)throw Error('max_private_route_missing');
 const connection=await connections.get(target.account_id);
 const metadata=await connection.socket.send(48,{chatIds:[Number(target.external_id)]}) as {chats?:Array<{id:unknown;type:unknown;participants:unknown}>};
 const chat=metadata.chats?.find(c=>String(c.id)===target.external_id);
 if(!chat)throw Error('max_private_target_unverified');
 assertMaxAuthorDialog(chat,connection.selfId,source.author_id,source.external_chat_id);
 const prepared=prepareMaxAiText({socket:connection.socket,accountId:target.account_id,chatId:target.external_id,allowedChatId:target.external_id});
 await new AiManagerStore(pool).dispatch(actionId,{target:prepared.target,start:action=>signal.aborted
  ?{acknowledgement:Promise.resolve({operationId:action.operationId,outcome:'rejected',dispatchState:'not_started',code:'owner_stopped',retryCondition:'never'})}
  :prepared.start(action)});
 return (await pool.query('SELECT state,external_message_id,outcome_code FROM ai_outbox WHERE id=$1',[actionId])).rows[0];
}

/** Called before accepting RPCs, while the process holds worker:max-sessions. */
export async function recoverOwnedMax(pool:Pool){
 const messages=new AiManagerStore(pool);
 for(const action of (await pool.query("SELECT a.id,a.attempt_token FROM ai_outbox a JOIN ai_conversations v ON v.id=a.conversation_id WHERE v.platform='max' AND a.state='dispatching' AND a.attempt_token IS NOT NULL")).rows){
  await messages.markInterrupted(action.id,action.attempt_token);
 }
 const {ConversationWorkflow}=await import('./conversation-workflow.js');const workflow=new ConversationWorkflow(pool);
 for(const n of (await pool.query("SELECT id,attempt_token FROM ai_handoff_notifications WHERE state='dispatching' AND attempt_token IS NOT NULL")).rows){
  await workflow.notificationOutcome({id:n.id,attemptToken:n.attempt_token,outcome:'unknown',code:'max_owner_interrupted'});
 }
 await pool.query("UPDATE max_send_receipts SET status='unknown',updated_at=now() WHERE status='sending'");
}
