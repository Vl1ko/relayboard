import type {Pool} from 'pg';
import {z} from 'zod';
const schema=z.object({
 platform:z.enum(['max','whatsapp']),namespace:z.string().min(1).max(200).default('global'),
 remoteUserId:z.string().min(1).max(512).refine(v=>!!v.trim()),accountId:z.string().uuid(),
 verifiedPhone:z.string().regex(/^\+[1-9][0-9]{6,14}$/).optional(),
 verificationKind:z.enum(['source_author','max_contact','whatsapp_contact']),
 displayName:z.string().max(255).default(''),preferredContactId:z.string().uuid().optional(),
}).superRefine((v,c)=>{
 if(v.platform==='max'&&v.namespace!=='global')c.addIssue({code:'custom',message:'MAX identity namespace must be global'});
 if((v.platform==='max'&&v.verificationKind==='whatsapp_contact')||(v.platform==='whatsapp'&&v.verificationKind==='max_contact'))c.addIssue({code:'custom',message:'Contact proof platform mismatch'});
 if(v.verifiedPhone&&v.verificationKind==='source_author')c.addIssue({code:'custom',message:'Verified phone needs a contact proof'});
});
/** Only the authenticated transport supplies these identities. Names never select a contact. */
export async function bindRemoteIdentity(pool:Pool,input:z.input<typeof schema>){
 const d=schema.parse(input),c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  const locks=['identity:'+JSON.stringify([d.platform,d.namespace,d.remoteUserId]),...(d.verifiedPhone?['phone:'+d.verifiedPhone]:[])].sort();
  for(const lock of locks)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
  const identity=(await c.query('SELECT * FROM ai_remote_identities WHERE platform=$1 AND namespace=$2 AND remote_user_id=$3',[d.platform,d.namespace,d.remoteUserId])).rows[0];
  const byPhone=d.verifiedPhone?(await c.query('SELECT id FROM ai_contacts WHERE phone_e164=$1',[d.verifiedPhone])).rows[0]:undefined;
  const candidates=[identity?.contact_id,byPhone?.id,d.preferredContactId].filter(Boolean) as string[];
  if(new Set(candidates).size>1)throw Error('verified_identity_conflict');
  let contact=candidates.length?(await c.query('SELECT * FROM ai_contacts WHERE id=$1 FOR UPDATE',[candidates[0]])).rows[0]:undefined;
  if(candidates.length&&!contact)throw Error('contact_missing');
  if(contact?.phone_e164&&d.verifiedPhone&&contact.phone_e164!==d.verifiedPhone)throw Error('verified_phone_changed');
  if(d.platform==='max'&&contact){
   if((await c.query("SELECT 1 FROM ai_remote_identities WHERE platform='max' AND namespace='global' AND contact_id=$1 AND remote_user_id<>$2",[contact.id,d.remoteUserId])).rowCount)throw Error('verified_identity_conflict');
  }
  if(!(await c.query('SELECT 1 FROM integrations WHERE id=$1 AND platform::text=$2 AND enabled AND auth_error IS NULL FOR SHARE',[d.accountId,d.platform])).rowCount)throw Error('identity_account_unavailable');
  let created=false;
  if(!contact){
   const inserted=await c.query('INSERT INTO ai_contacts(display_name,phone_e164) VALUES($1,$2) ON CONFLICT(phone_e164) DO NOTHING RETURNING *',[d.displayName,d.verifiedPhone??null]);
   contact=inserted.rows[0];created=!!contact;
   if(!contact)contact=(await c.query('SELECT * FROM ai_contacts WHERE phone_e164=$1 FOR UPDATE',[d.verifiedPhone])).rows[0];
   if(!contact)throw Error('identity_contact_conflict');
   if(d.platform==='max'&&(await c.query("SELECT 1 FROM ai_remote_identities WHERE platform='max' AND contact_id=$1 AND remote_user_id<>$2",[contact.id,d.remoteUserId])).rowCount)throw Error('verified_identity_conflict');
  }
  if(d.verifiedPhone&&!contact.phone_e164)await c.query('UPDATE ai_contacts SET phone_e164=$2 WHERE id=$1',[contact.id,d.verifiedPhone]);
  await c.query(`INSERT INTO ai_remote_identities(platform,namespace,remote_user_id,contact_id,verified_phone,verification_kind,verified_account_id,phone_verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)
   ON CONFLICT(platform,namespace,remote_user_id) DO UPDATE SET verified_phone=coalesce(excluded.verified_phone,ai_remote_identities.verified_phone),verification_kind=CASE WHEN ai_remote_identities.verified_phone IS NOT NULL AND excluded.verified_phone IS NULL THEN ai_remote_identities.verification_kind ELSE excluded.verification_kind END,verified_account_id=excluded.verified_account_id,verified_at=now(),phone_verified_at=CASE WHEN excluded.verified_phone IS NULL THEN ai_remote_identities.phone_verified_at ELSE now() END`,[d.platform,d.namespace,d.remoteUserId,contact.id,d.verifiedPhone??null,d.verificationKind,d.accountId]);
  await c.query('COMMIT');return{contactId:contact.id as string,created,optedOut:!!contact.opted_out_at};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
