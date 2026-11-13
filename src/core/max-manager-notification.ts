import type {Pool} from 'pg';
import {UMax} from '@ounezz/umax';
import {decryptCredentials} from './crypto.js';
import {ConversationWorkflow} from './conversation-workflow.js';
import {prepareMaxAiText,type ConnectedMaxTextSocket} from './adapters/max-ai-text.js';
export function formatManagerNotification(text:string){const n=JSON.parse(text);return ['Заявка прошла квалификацию','Клиент: '+(n.contact?.name||n.contact?.id||'—'),'Личный диалог MAX: '+n.channel.externalId,...Object.entries(n.parameters??{}).map(([k,v])=>k+': '+String(v))].join('\n').slice(0,4000);}
export async function dispatchMaxManagerNotification(pool:Pool,id:string,reuse?:{accountId:string;socket:ConnectedMaxTextSocket}){
 const workflow=new ConversationWorkflow(pool),notification=(await pool.query("SELECT * FROM ai_handoff_notifications WHERE id=$1 AND reason='qualified'",[id])).rows[0];if(!notification)throw Error('qualified_notification_required');
 const target=notification.target_account_id?{accountId:notification.target_account_id,externalId:notification.target_external_id}:await workflow.managerTarget();if(!target)return{pending:true};
 if(target.externalId===notification.channel_snapshot.externalId&&target.accountId===notification.channel_snapshot.accountId)throw Error('manager_target_is_customer');
 let client:UMax|undefined;let socket:ConnectedMaxTextSocket;
 try{
  if(reuse&&reuse.accountId===target.accountId)socket=reuse.socket;
  else{const account=(await pool.query("SELECT credential_ciphertext FROM integrations WHERE id=$1 AND platform='max' AND enabled AND auth_error IS NULL",[target.accountId])).rows[0];if(!account)throw Error('manager_account_unavailable');client=new UMax(decryptCredentials(account.credential_ciphertext).token);(client.chats as unknown as{subscribe_all:()=>void}).subscribe_all=()=>{};await client.connect();socket=(client as unknown as{ws:ConnectedMaxTextSocket}).ws;}
  if(!/^-?\d+$/.test(target.externalId)||!Number.isSafeInteger(Number(target.externalId)))throw Error('manager_target_invalid');
  const metadata=await socket.send(48,{chatIds:[Number(target.externalId)]})as any;
  if(!(metadata?.chats??[]).some((c:any)=>c.type==='CHAT'&&String(c.id)===target.externalId))throw Error('manager_group_unverified');
  const prepared=prepareMaxAiText({socket,accountId:target.accountId,chatId:target.externalId,allowedChatId:target.externalId});
  await workflow.dispatchNotification(id,{target,start:a=>prepared.start({...a,text:formatManagerNotification(a.text),conversationId:notification.conversation_id})});
  return(await pool.query('SELECT state FROM ai_handoff_notifications WHERE id=$1',[id])).rows[0];
 }finally{client?.close();}
}
