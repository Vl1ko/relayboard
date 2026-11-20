import type {Pool} from 'pg';
import {z} from 'zod';
import {AiManagerStore} from './ai-manager.js';
import {bindRemoteIdentity} from './remote-identities.js';
import {runtimeAllows,type RuntimeScope} from './runtime-scope.js';
export type WhatsAppPhoneProof={phone:string;pn:string;aliases:string[];selfAliases:string[];privateId:string};
const jid=/^[1-9][0-9]{0,30}@(c\.us|lid)$/;
/** The owning browser attests the phone and private JID. This creates no request/send. */
export async function resolveWhatsAppContactRoute(pool:Pool,scope:RuntimeScope,input:{accountId:string;contactId:string},lookup:(phone:string)=>Promise<WhatsAppPhoneProof>){
 const d=z.object({accountId:z.string().uuid(),contactId:z.string().uuid()}).parse(input);
 if(scope.testOnly&&!scope.accountIds.includes(d.accountId))throw Error('outside_runtime_scope');
 const contact=(await pool.query('SELECT * FROM ai_contacts WHERE id=$1',[d.contactId])).rows[0];if(!contact?.phone_e164)throw Error('contact_phone_required');
 const proof=await lookup(contact.phone_e164),expected=contact.phone_e164.slice(1)+'@c.us';
 if(proof.phone!==contact.phone_e164||proof.pn!==expected||!proof.aliases.includes(expected)||!proof.aliases.includes(proof.privateId)||!proof.selfAliases.length||proof.aliases.length>8||proof.aliases.some(id=>!jid.test(id))||proof.selfAliases.some(id=>!jid.test(id)||proof.aliases.includes(id)))throw Error('wa_phone_unverified');
 if(!runtimeAllows(scope,d.accountId,proof.pn))throw Error('outside_runtime_scope');
 const prior=(await pool.query('SELECT contact_id FROM ai_conversations WHERE account_id=$1 AND external_id=$2',[d.accountId,proof.privateId])).rows[0];if(prior&&prior.contact_id!==contact.id)throw Error('verified_identity_conflict');
 for(const alias of proof.aliases)await bindRemoteIdentity(pool,{platform:'whatsapp',namespace:alias.endsWith('@lid')?'account:'+d.accountId:'global',remoteUserId:alias,accountId:d.accountId,preferredContactId:contact.id,verifiedPhone:proof.phone,verificationKind:'whatsapp_contact'});
 const v=await new AiManagerStore(pool).createConversation({accountId:d.accountId,contactId:contact.id,externalId:proof.privateId});
 const route=await pool.query(`INSERT INTO ai_verified_routes(conversation_id,account_id,platform,external_id,recipient_id,contact_id,verified_phone) VALUES($1,$2,'whatsapp',$3,$4,$5,$6)
  ON CONFLICT(conversation_id) DO UPDATE SET verified_phone=excluded.verified_phone,verified_at=now()
  WHERE ai_verified_routes.account_id=excluded.account_id AND ai_verified_routes.recipient_id=excluded.recipient_id AND ai_verified_routes.contact_id=excluded.contact_id AND ai_verified_routes.external_id=excluded.external_id RETURNING conversation_id`,[v.id,d.accountId,proof.privateId,proof.pn,contact.id,proof.phone]);if(!route.rowCount)throw Error('verified_route_conflict');
 return{conversationId:v.id,contactId:contact.id,accountId:d.accountId,platform:'whatsapp',externalId:proof.privateId,recipientId:proof.pn,excluded:!!contact.opted_out_at};
}
