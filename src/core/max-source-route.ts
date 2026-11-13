import type {Pool} from 'pg';
import {z} from 'zod';
import {AiManagerStore} from './ai-manager.js';
import type {MaxConnections} from './max-connections.js';
import {maxSourceAuthor} from './max-author-route.js';
import {resolveMaxAuthor,openVerifiedMaxPrivate} from './max-private-route.js';
import {bindRemoteIdentity} from './remote-identities.js';
import {runtimeAllows,type RuntimeScope} from './runtime-scope.js';

/** Re-read a selected source on the authenticated reader; never route by model/user text. */
export async function resolveMaxSourceRoute(pool:Pool,connections:MaxConnections,scope:RuntimeScope,input:{leadId:string;accountId?:string}){
 const d=z.object({leadId:z.string().uuid(),accountId:z.string().uuid().optional()}).parse(input);
 const lead=(await pool.query("SELECT * FROM ai_leads WHERE id=$1 AND platform='max' AND status<>'rejected'",[d.leadId])).rows[0];
 if(!lead)throw Error('max_source_unavailable');
 if(scope.testOnly&&!scope.accountIds.includes(lead.account_id))throw Error('outside_runtime_scope');
 if(!(await pool.query("SELECT 1 FROM ai_search_sources WHERE account_id=$1 AND chat_id=$2 AND platform='max'",[lead.account_id,lead.chat_id])).rowCount)throw Error('max_source_not_selected');
 const reader=await connections.get(lead.account_id);
 if(!/^-?\d+$/.test(lead.chat_id)||!Number.isSafeInteger(Number(lead.chat_id)))throw Error('max_source_unverified');
 const metadata=await reader.socket.send(48,{chatIds:[Number(lead.chat_id)]}) as any;
 if(!metadata?.chats?.some((c:any)=>String(c.id)===lead.chat_id&&c.type==='CHAT'))throw Error('max_source_unverified');
 const history=await reader.socket.send(49,{chatId:Number(lead.chat_id),from:new Date(lead.occurred_at).getTime()+1,backward:100,forward:2,getMessages:true},10000) as any;
 const message=history?.messages?.find((m:any)=>String(m.id)===lead.message_id),source=message?maxSourceAuthor(message,reader.selfId):null;
 if(!source||source.authorId!==lead.author_id||source.text!==lead.original_text)throw Error('max_source_changed');
 if(!runtimeAllows(scope,lead.account_id,source.authorId))throw Error('outside_runtime_scope');
 if(!scope.testOnly&&(await pool.query("SELECT 1 FROM integrations WHERE platform='max' AND max_self_id=$1",[source.authorId])).rowCount)throw Error('max_source_is_owned_account');
 const settings=(await pool.query('SELECT revision,platforms,account_ids FROM ai_outreach_settings WHERE id=1')).rows[0];
 const allowed=(await pool.query("SELECT id FROM integrations WHERE platform='max' AND enabled AND auth_error IS NULL AND id=ANY($1::uuid[])",[settings.account_ids])).rows.map(r=>r.id);
 const candidates=(d.accountId?[d.accountId]:settings.account_ids).filter((id:string)=>allowed.includes(id));
 if(!settings.platforms.includes('max')||!candidates.length)throw Error('max_sender_not_allowed');
 let profile:{authorId:string;phone?:string;name:string}={authorId:source.authorId,name:''};
 try{profile=await resolveMaxAuthor(reader,source.authorId);}catch{/* Private participant proof below remains mandatory; a hidden phone is not guessed. */}
 let lastError:unknown=Error('max_private_route_unavailable');
 for(const accountId of candidates){
  if(!runtimeAllows(scope,accountId,source.authorId))continue;
  try{
   const sender=await connections.get(accountId),dialog=await openVerifiedMaxPrivate(sender,source.authorId,lead.chat_id);
   const existing=(await pool.query('SELECT contact_id FROM ai_conversations WHERE account_id=$1 AND external_id=$2',[accountId,dialog])).rows[0];
   if(existing&&lead.contact_id&&existing.contact_id!==lead.contact_id)throw Error('verified_identity_conflict');
   const identity=await bindRemoteIdentity(pool,{platform:'max',remoteUserId:source.authorId,accountId:lead.account_id,verifiedPhone:profile.phone,verificationKind:profile.phone?'max_contact':'source_author',displayName:profile.name||'MAX '+source.authorId,preferredContactId:existing?.contact_id??lead.contact_id??undefined});
   if(lead.contact_id&&lead.contact_id!==identity.contactId)throw Error('verified_identity_conflict');
   const conversation=await new AiManagerStore(pool).createConversation({contactId:identity.contactId,accountId,externalId:dialog});
   const saved=await pool.query(`INSERT INTO ai_verified_routes(conversation_id,account_id,platform,external_id,recipient_id,contact_id,verified_phone) VALUES($1,$2,'max',$3,$4,$5,$6)
    ON CONFLICT(conversation_id) DO UPDATE SET verified_phone=coalesce(excluded.verified_phone,ai_verified_routes.verified_phone),verified_at=now()
    WHERE ai_verified_routes.account_id=excluded.account_id AND ai_verified_routes.recipient_id=excluded.recipient_id AND ai_verified_routes.contact_id=excluded.contact_id AND ai_verified_routes.external_id=excluded.external_id RETURNING conversation_id`,[conversation.id,accountId,dialog,source.authorId,identity.contactId,profile.phone??null]);
   if(!saved.rowCount)throw Error('verified_route_conflict');
   return{leadId:lead.id,revision:lead.revision,requestId:lead.request_id,contactId:identity.contactId,conversationId:conversation.id,accountId,platform:'max' as const,dialogId:dialog,recipientId:source.authorId,sourceAccountId:lead.account_id,sourcePlatform:'max' as const,sourceChatId:lead.chat_id,...source,excluded:identity.optedOut};
  }catch(error){
   if(error instanceof Error&&/identity_conflict|phone_changed|route_conflict/.test(error.message))throw error;
   lastError=error;
  }
 }
 throw lastError;
}
