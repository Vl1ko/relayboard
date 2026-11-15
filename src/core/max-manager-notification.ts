import {singleLine} from './handoff-context.js';
import type {Pool} from 'pg';
import {UMax} from '@ounezz/umax';
import {decryptCredentials} from './crypto.js';
import {ConversationWorkflow} from './conversation-workflow.js';
import {prepareMaxAiText,type ConnectedMaxTextSocket} from './adapters/max-ai-text.js';
export function formatManagerNotification(text:string){
 const n=JSON.parse(text),titles:Record<string,string>={qualified:'Заявка прошла квалификацию',human_requested:'Клиент просит подключить менеджера',insufficient_data:'Требуется помощь менеджера: недостаточно данных',reply_limit:'Достигнут лимит ответов: требуется менеджер'};
 let labels:Record<string,unknown>={};try{const value=JSON.parse(n.source?.fieldLabelsJson??'{}');if(value&&typeof value==='object'&&!Array.isArray(value))labels=value;}catch{}
 const lines=[titles[n.reason]??'Требуется менеджер','Клиент: '+singleLine(n.contact?.name||'Без имени'),...(n.contact?.phone?['Телефон: '+singleLine(n.contact.phone)]:[]),'Аккаунт: '+singleLine(n.channel?.accountName||'Не указан'),'Канал: '+(n.channel?.platform==='whatsapp'?'WhatsApp':'MAX')];
 if(n.source?.cardLink)lines.push('Открыть заявку: '+singleLine(n.source.cardLink,1000));else lines.push('Личный диалог: '+singleLine(n.channel?.externalId));
 if(n.source?.chatTitle)lines.push('Чат-источник: '+singleLine(n.source.chatTitle));if(n.source?.readerAccount)lines.push('Источник прочитан: '+singleLine(n.source.readerAccount));
 lines.push('Резюме: '+singleLine(n.summary,700));
 for(const [key,value]of Object.entries(n.parameters??{})){
  const label=typeof labels[key]==='string'?labels[key]:key,line=singleLine(label,120)+': '+singleLine(value,500);
  if(lines.join('\n').length+line.length+1>3850){lines.push('Остальные параметры доступны в карточке.');break;}lines.push(line);
 }
 if(n.source?.sourceLink){const line='Сообщение-источник: '+singleLine(n.source.sourceLink,1000);if(lines.join('\n').length+line.length+1<=4000)lines.push(line);}
 return lines.join('\n');
}
export async function dispatchMaxManagerNotification(pool:Pool,id:string,reuse?:{accountId:string;socket:ConnectedMaxTextSocket},resolveSocket?:(accountId:string)=>Promise<ConnectedMaxTextSocket>){
 const workflow=new ConversationWorkflow(pool),notification=(await pool.query("SELECT * FROM ai_handoff_notifications WHERE id=$1",[id])).rows[0];if(!notification)throw Error('manager_notification_required');
 const target=notification.target_account_id?{accountId:notification.target_account_id,externalId:notification.target_external_id}:await workflow.managerTarget();if(!target)return{pending:true};
 if(target.externalId===notification.channel_snapshot.externalId&&target.accountId===notification.channel_snapshot.accountId)throw Error('manager_target_is_customer');
 let client:UMax|undefined;let socket:ConnectedMaxTextSocket;
 try{
  if(reuse&&reuse.accountId===target.accountId)socket=reuse.socket;
  else if(resolveSocket)socket=await resolveSocket(target.accountId);
  else{const account=(await pool.query("SELECT credential_ciphertext FROM integrations WHERE id=$1 AND platform='max' AND enabled AND auth_error IS NULL",[target.accountId])).rows[0];if(!account)throw Error('manager_account_unavailable');client=new UMax(decryptCredentials(account.credential_ciphertext).token);(client.chats as unknown as{subscribe_all:()=>void}).subscribe_all=()=>{};await client.connect();socket=(client as unknown as{ws:ConnectedMaxTextSocket}).ws;}
  if(!/^-?\d+$/.test(target.externalId)||!Number.isSafeInteger(Number(target.externalId)))throw Error('manager_target_invalid');
  const metadata=await socket.send(48,{chatIds:[Number(target.externalId)]})as any;
  if(!(metadata?.chats??[]).some((c:any)=>c.type==='CHAT'&&String(c.id)===target.externalId))throw Error('manager_group_unverified');
  const prepared=prepareMaxAiText({socket,accountId:target.accountId,chatId:target.externalId,allowedChatId:target.externalId});
  await workflow.dispatchNotification(id,{target,start:a=>prepared.start({...a,text:formatManagerNotification(a.text),conversationId:notification.conversation_id})});
  return(await pool.query('SELECT state FROM ai_handoff_notifications WHERE id=$1',[id])).rows[0];
 }finally{client?.close();}
}
