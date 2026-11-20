import type {Pool,PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {monitorSettingsSchema,monitorCriteriaFingerprint,type MonitorSettings} from './source-monitor-settings.js';
export const chatCriteriaSchema=z.object({platform:z.enum(['max','whatsapp']),chatId:z.string().min(1).max(512),expectedRevision:z.number().int().nonnegative(),mode:z.enum(['inherit','extend','replace']),settings:monitorSettingsSchema}).strict().refine(v=>v.mode!=='replace'||!!v.settings.instructions,{message:'Describe the chat criteria',path:['settings','instructions']});
/** Extension adds mandatory intent conditions; include groups are ANDed, each group is ORed. */
export function effectiveChatCriteria(global:MonitorSettings,chat?:{mode:string;settings:unknown}){
 if(!chat||chat.mode==='inherit')return{settings:global,includeGroups:global.includeTerms.length?[global.includeTerms]:[]};
 const local=monitorSettingsSchema.parse(chat.settings);
 if(chat.mode==='replace')return{settings:local,includeGroups:local.includeTerms.length?[local.includeTerms]:[]};
 return{settings:{...global,instructions:[global.instructions,local.instructions&&'Дополнительные обязательные условия этого чата (все должны выполняться):\n'+local.instructions].filter(Boolean).join('\n\n'),excludeTerms:[...new Set([...global.excludeTerms,...local.excludeTerms])],includeTerms:[...new Set([...global.includeTerms,...local.includeTerms])],confidenceThreshold:Math.max(global.confidenceThreshold,local.confidenceThreshold),autoContact:global.autoContact&&local.autoContact},includeGroups:[global.includeTerms,local.includeTerms].filter(g=>g.length)};
}
export async function readChatCriteria(db:Pool|PoolClient,platform:string,chatId:string,global:MonitorSettings,lock=false){
 const row=(await db.query('SELECT * FROM ai_chat_criteria WHERE platform=$1 AND chat_id=$2'+(lock?' FOR SHARE':''),[platform,chatId])).rows[0];
 const effective=effectiveChatCriteria(global,row);
 const fingerprint=effective.includeGroups.length>1?createHash('sha256').update(JSON.stringify([monitorCriteriaFingerprint(effective.settings),effective.includeGroups])).digest('hex'):monitorCriteriaFingerprint(effective.settings);
 return{...effective,fingerprint,revision:row?.revision??0};
}
export class ChatCriteriaStore{
 constructor(private pool:Pool){}
 async get(platform:string,chatId:string){
  z.enum(['max','whatsapp']).parse(platform);z.string().min(1).max(512).parse(chatId);
  const global=monitorSettingsSchema.parse((await this.pool.query('SELECT settings FROM ai_monitor_settings WHERE id=1')).rows[0].settings);
  const row=(await this.pool.query('SELECT * FROM ai_chat_criteria WHERE platform=$1 AND chat_id=$2',[platform,chatId])).rows[0];
  return{revision:row?.revision??0,mode:row?.mode??'inherit',settings:row?.settings??{instructions:'',includeTerms:[],excludeTerms:[],confidenceThreshold:global.confidenceThreshold,autoContact:true},global,effective:effectiveChatCriteria(global,row).settings};
 }
 async save(input:z.input<typeof chatCriteriaSchema>){const d=chatCriteriaSchema.parse(input),c=await this.pool.connect();try{await c.query('BEGIN');
  // Common policy lock fences classification commits and activation while a chat changes.
  await c.query('SELECT id FROM ai_monitor_settings WHERE id=1 FOR UPDATE');
  if(!(await c.query('SELECT 1 FROM ai_search_sources WHERE platform=$1 AND chat_id=$2',[d.platform,d.chatId])).rowCount)throw Error('chat_not_selected');
  const current=(await c.query('SELECT revision FROM ai_chat_criteria WHERE platform=$1 AND chat_id=$2 FOR UPDATE',[d.platform,d.chatId])).rows[0];
  if((current?.revision??0)!==d.expectedRevision)throw Error('chat_criteria_changed');
  const global=monitorSettingsSchema.parse((await c.query('SELECT settings FROM ai_monitor_settings WHERE id=1')).rows[0].settings);
  effectiveChatCriteria(global,d);
  await c.query(`INSERT INTO ai_chat_criteria(platform,chat_id,mode,settings,revision) VALUES($1,$2,$3,$4,1)
   ON CONFLICT(platform,chat_id) DO UPDATE SET mode=excluded.mode,settings=excluded.settings,revision=ai_chat_criteria.revision+1,updated_at=now()`,[d.platform,d.chatId,d.mode,JSON.stringify(d.settings)]);
  await c.query('UPDATE ai_monitor_settings SET revision=revision+1,updated_at=now() WHERE id=1');await c.query('COMMIT');return this.get(d.platform,d.chatId);
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
}
