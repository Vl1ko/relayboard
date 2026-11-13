import type {Pool} from 'pg';
import {z} from 'zod';
import {AiManagerStore} from './ai-manager.js';
import type {MaxConnections} from './max-connections.js';
import {resolveMaxPhone,openVerifiedMaxPrivate} from './max-private-route.js';
import {bindRemoteIdentity} from './remote-identities.js';
import {runtimeAllows,type RuntimeScope} from './runtime-scope.js';

/** Resolves a chosen imported contact. No message, request or auto mode is created. */
export async function resolveMaxContactRoute(pool:Pool,connections:MaxConnections,scope:RuntimeScope,input:{contactId:string;accountId:string}){
 const data=z.object({contactId:z.string().uuid(),accountId:z.string().uuid()}).parse(input);
 if(scope.testOnly&&!scope.accountIds.includes(data.accountId))throw Error('outside_runtime_scope');
 const contact=(await pool.query('SELECT * FROM ai_contacts WHERE id=$1',[data.contactId])).rows[0];
 if(!contact?.phone_e164)throw Error('contact_phone_required');
 const connection=await connections.get(data.accountId),profile=await resolveMaxPhone(connection,contact.phone_e164);
 if(!runtimeAllows(scope,data.accountId,profile.authorId))throw Error('outside_runtime_scope');
 const dialog=await openVerifiedMaxPrivate(connection,profile.authorId,'import-source');
 const previous=(await pool.query('SELECT contact_id FROM ai_conversations WHERE account_id=$1 AND external_id=$2',[data.accountId,dialog])).rows[0];
 if(previous&&previous.contact_id!==contact.id)throw Error('verified_identity_conflict');
 const identity=await bindRemoteIdentity(pool,{platform:'max',remoteUserId:profile.authorId,accountId:data.accountId,preferredContactId:contact.id,verifiedPhone:profile.phone,verificationKind:'max_contact',displayName:profile.name});
 const conversation=await new AiManagerStore(pool).createConversation({contactId:identity.contactId,accountId:data.accountId,externalId:dialog});
 const route=await pool.query(`INSERT INTO ai_verified_routes(conversation_id,account_id,platform,external_id,recipient_id,contact_id,verified_phone) VALUES($1,$2,'max',$3,$4,$5,$6)
  ON CONFLICT(conversation_id) DO UPDATE SET verified_phone=excluded.verified_phone,verified_at=now()
  WHERE ai_verified_routes.account_id=excluded.account_id AND ai_verified_routes.recipient_id=excluded.recipient_id AND ai_verified_routes.contact_id=excluded.contact_id AND ai_verified_routes.external_id=excluded.external_id RETURNING conversation_id`,[conversation.id,data.accountId,dialog,profile.authorId,identity.contactId,profile.phone]);
 if(!route.rowCount)throw Error('verified_route_conflict');
 return{conversationId:conversation.id,contactId:identity.contactId,accountId:data.accountId,platform:'max',externalId:dialog,recipientId:profile.authorId,excluded:identity.optedOut};
}
