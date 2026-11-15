import type {Pool} from 'pg';
/** Fail closed if any known request channel cannot catch up before an external send. */
export async function synchronizeContactHistory(pool:Pool,actionId:string,options:{allows:(id:string)=>Promise<boolean>;sync:(channel:{id:string;account_id:string;platform:string})=>Promise<{complete?:boolean}>}){
 const channels=(await pool.query(`SELECT v.id,v.account_id,v.platform FROM ai_conversations v WHERE v.contact_id=(SELECT contact_id FROM ai_outbox WHERE id=$1) AND v.active_phase_id IS NOT NULL ORDER BY v.id`,[actionId])).rows;
 if(!channels.length)throw Error('contact_history_missing');
 for(const v of channels){if(!await options.allows(v.id))throw Error('contact_history_outside_scope');if(!(await options.sync(v)).complete)throw Error('contact_history_incomplete');}
}
