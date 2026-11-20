import type {Pool} from 'pg';
import {z} from 'zod';
import {runtimeAllows,type RuntimeScope} from './runtime-scope.js';
import {bindRemoteIdentity} from './remote-identities.js';
import {AiManagerStore} from './ai-manager.js';
export type WhatsAppSourceProof={messageId:string;authorId:string;chatId:string;text:string;occurredAt:string;pn?:string;aliases:string[];selfAliases:string[]};
export type WhatsAppRecipientProof={privateId:string;recipientId:string;pn?:string;aliases:string[];selfAliases:string[]};
export interface WhatsAppSourceConnections{
 readSource(accountId:string,lead:{chat_id:string;message_id:string}):Promise<WhatsAppSourceProof>;
 resolveRecipient(accountId:string,proof:WhatsAppSourceProof):Promise<WhatsAppRecipientProof>;
}
const jid=/^[1-9][0-9]{0,30}@(c\.us|lid)$/;
export async function resolveWhatsAppSourceRoute(pool:Pool,connections:WhatsAppSourceConnections,scope:RuntimeScope,input:{leadId:string;accountId?:string}){
 const d=z.object({leadId:z.string().uuid(),accountId:z.string().uuid().optional()}).parse(input),lead=(await pool.query("SELECT * FROM ai_leads WHERE id=$1 AND platform='whatsapp' AND status<>'rejected'",[d.leadId])).rows[0];if(!lead)throw Error('wa_source_unavailable');
 if(scope.testOnly&&!scope.accountIds.includes(lead.account_id))throw Error('outside_runtime_scope');
 if(!(await pool.query("SELECT 1 FROM ai_search_sources WHERE account_id=$1 AND chat_id=$2 AND platform='whatsapp'",[lead.account_id,lead.chat_id])).rowCount)throw Error('wa_source_not_selected');
 const source=await connections.readSource(lead.account_id,lead);
 if(!source.chatId.endsWith('@g.us')||!jid.test(source.authorId)||!source.selfAliases.length||source.selfAliases.some(a=>!jid.test(a))||!source.aliases.length||source.aliases.length>2||source.aliases.filter(a=>a.endsWith('@c.us')).length>1||source.aliases.filter(a=>a.endsWith('@lid')).length>1||source.aliases.some(a=>!jid.test(a))||source.chatId!==lead.chat_id||source.messageId!==lead.message_id||source.authorId!==lead.author_id||source.text!==lead.original_text||new Date(source.occurredAt).getTime()!==new Date(lead.occurred_at).getTime()||!source.aliases.includes(source.authorId)||source.selfAliases.some(a=>source.aliases.includes(a)))throw Error('wa_source_changed');
 if(!runtimeAllows(scope,lead.account_id,source.authorId))throw Error('outside_runtime_scope');
 if(!scope.testOnly&&(await pool.query("SELECT 1 FROM integrations WHERE platform='whatsapp' AND (whatsapp_self_id=ANY($1::text[]) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(whatsapp_self_aliases) a(id) WHERE a.id=ANY($1::text[])))",[source.aliases])).rowCount)throw Error('wa_source_owned_account');
 if(source.pn&&(!source.pn.endsWith('@c.us')||!source.aliases.includes(source.pn)||!/^\+[1-9][0-9]{6,14}$/.test('+'+source.pn.split('@')[0])))throw Error('wa_source_phone_unverified');
 const settings=(await pool.query('SELECT * FROM ai_outreach_settings WHERE id=1')).rows[0];if(!settings.platforms.includes('whatsapp'))throw Error('wa_sender_not_allowed');
 const allowed=(await pool.query("SELECT id FROM integrations WHERE platform='whatsapp' AND enabled AND auth_error IS NULL AND id=ANY($1::uuid[])",[settings.account_ids])).rows.map(r=>r.id);
 const candidates=(d.accountId?[d.accountId]:settings.account_ids).filter((id:string)=>allowed.includes(id));let lastError:unknown=Error('wa_private_route_unavailable');
 for(const accountId of candidates){
  if(scope.testOnly&&!scope.accountIds.includes(accountId))continue;
  try{
   const target=await connections.resolveRecipient(accountId,source);
   if(!target.aliases.includes(target.privateId)||!target.aliases.includes(target.recipientId)||!target.aliases.length||target.aliases.length>2||target.aliases.filter(a=>a.endsWith('@c.us')).length>1||target.aliases.filter(a=>a.endsWith('@lid')).length>1||target.aliases.some(a=>!jid.test(a))||!target.selfAliases.length||target.selfAliases.some(a=>target.aliases.includes(a)))throw Error('wa_private_target_unverified');
   if(source.pn?target.pn!==source.pn||!target.aliases.includes(source.pn):accountId!==lead.account_id||!target.aliases.includes(source.authorId))throw Error('wa_private_recipient_unverified');
   if(!runtimeAllows(scope,accountId,target.recipientId))throw Error('outside_runtime_scope');
   const previous=(await pool.query('SELECT contact_id FROM ai_conversations WHERE account_id=$1 AND external_id=$2',[accountId,target.privateId])).rows[0],phone=source.pn?'+'+source.pn.split('@')[0]:undefined;
   const canonical=source.pn??source.authorId;
   const identity=await bindRemoteIdentity(pool,{platform:'whatsapp',namespace:canonical.endsWith('@lid')?'account:'+lead.account_id:'global',remoteUserId:canonical,accountId:lead.account_id,verifiedPhone:phone,verificationKind:phone?'whatsapp_contact':'source_author',preferredContactId:previous?.contact_id??lead.contact_id??undefined});
   for(const [owner,aliases]of [[lead.account_id,source.aliases],[accountId,target.aliases]] as [string,string[]][])for(const alias of aliases)await bindRemoteIdentity(pool,{platform:'whatsapp',namespace:alias.endsWith('@lid')?'account:'+owner:'global',remoteUserId:alias,accountId:owner,verifiedPhone:phone,verificationKind:phone?'whatsapp_contact':'source_author',preferredContactId:identity.contactId});
   const v=await new AiManagerStore(pool).createConversation({contactId:identity.contactId,accountId,externalId:target.privateId});
   const saved=await pool.query(`INSERT INTO ai_verified_routes(conversation_id,account_id,platform,external_id,recipient_id,contact_id,verified_phone)VALUES($1,$2,'whatsapp',$3,$4,$5,$6)
    ON CONFLICT(conversation_id) DO UPDATE SET verified_phone=coalesce(excluded.verified_phone,ai_verified_routes.verified_phone),verified_at=now() WHERE ai_verified_routes.account_id=excluded.account_id AND ai_verified_routes.external_id=excluded.external_id AND ai_verified_routes.recipient_id=excluded.recipient_id AND ai_verified_routes.contact_id=excluded.contact_id RETURNING conversation_id`,[v.id,accountId,target.privateId,target.recipientId,identity.contactId,phone??null]);if(!saved.rowCount)throw Error('verified_route_conflict');
   return{leadId:lead.id,revision:lead.revision,contactId:identity.contactId,conversationId:v.id,accountId,platform:'whatsapp' as const,dialogId:target.privateId,recipientId:target.recipientId,sourceAccountId:lead.account_id,sourcePlatform:'whatsapp' as const,sourceChatId:source.chatId,messageId:source.messageId,authorId:source.authorId,text:source.text,occurredAt:source.occurredAt,excluded:identity.optedOut};
  }catch(error){if(error instanceof Error&&/identity_conflict|phone_changed|route_conflict/.test(error.message))throw error;lastError=error;}
 }
 throw lastError;
}
