import type {Pool} from 'pg';
import {readFile,stat} from 'node:fs/promises';
import {DeliveryError} from './delivery-policy.js';
import {prepareWhatsAppAiText,type WhatsAppCdpSession} from './adapters/whatsapp-ai-text.js';
type Prepared=Awaited<ReturnType<typeof prepareWhatsAppAiText>>;
/** Publication IDs select canonical DB content. All uploads are staged before the final post gate. */
export async function dispatchOwnedWhatsAppPublication(pool:Pool,options:{deliveryId:string;accountId:string;sessionKey:string;cdp:WhatsAppCdpSession;selfAliases:string[];recipientAliases:(id:string)=>Promise<string[]>;isActive:()=>boolean;maxUploadBytes:number;prepare?:typeof prepareWhatsAppAiText}){
 const {deliveryId,accountId,sessionKey}=options;
 const row=(await pool.query(`SELECT d.id,d.post_id,d.status,dst.external_id,p.text,p.updated_at FROM deliveries d JOIN posts p ON p.id=d.post_id JOIN destinations dst ON dst.id=d.destination_id JOIN integrations i ON i.id=dst.integration_id WHERE d.id=$1 AND i.id=$2 AND i.platform='whatsapp' AND i.enabled AND i.auth_error IS NULL`,[deliveryId,accountId])).rows[0];
 if(!row)throw new DeliveryError('Публикация WhatsApp недоступна','waiting');
 const existing=(await pool.query('SELECT * FROM whatsapp_send_receipts WHERE delivery_id=$1',[deliveryId])).rows[0];
 if(existing){if(existing.session_key!==sessionKey||existing.destination_id!==row.external_id)throw new DeliveryError('Маршрут начатой отправки изменён','ambiguous');if(existing.status==='sent')return{externalMessageId:existing.message_id};throw new DeliveryError('Результат отправки WhatsApp требует проверки','ambiguous');}
 if(row.status!=='sending'||!options.isActive())throw new DeliveryError('Публикация WhatsApp ожидает готовности','waiting');
 const claim=await pool.query("INSERT INTO whatsapp_send_receipts(delivery_id,session_key,destination_id,status) VALUES($1,$2,$3,'sending') ON CONFLICT DO NOTHING RETURNING delivery_id",[deliveryId,sessionKey,row.external_id]);
 if(!claim.rowCount)throw new DeliveryError('Отправка WhatsApp уже начата','ambiguous');
 const prepared:Prepared[]=[],ids:string[]=[];let started=false;
 try{
  const attachments=(await pool.query('SELECT storage_path AS path,original_name AS name,mime_type AS mime,size_bytes FROM attachments WHERE post_id=$1 AND expired_at IS NULL ORDER BY created_at,id',[row.post_id])).rows;
  if(attachments.length>10)throw new DeliveryError('Слишком много вложений WhatsApp','permanent');
  const recipients=row.external_id.endsWith('@g.us')?[row.external_id]:await options.recipientAliases(row.external_id);
  const plan:{text:string;attachment?:{path:string;name:string;mime:string;size_bytes:string};publication:{media?:{mimetype:string;data:string;filename:string};caption?:string;forceDocument?:boolean}}[]=[];
  if(!attachments.length||row.text.length>1000)plan.push({text:row.text,publication:{}});
  let bytes=0;
  for(let index=0;index<attachments.length;index++){
   const a=attachments[index],info=await stat(a.path);bytes+=info.size;
   if(!info.isFile()||info.size!==Number(a.size_bytes)||info.size>options.maxUploadBytes||bytes>options.maxUploadBytes*10)throw new DeliveryError('Размер вложений WhatsApp требует проверки','permanent');
   plan.push({text:'',attachment:a,publication:{caption:index===0&&row.text.length<=1000?row.text:'',forceDocument:!a.mime.startsWith('image/')&&!a.mime.startsWith('video/')}});
  }
  if(!plan.length)throw new DeliveryError('Пустая публикация WhatsApp','permanent');
  for(let index=0;index<plan.length;index++){
   const item=plan[index];if(item.attachment){const data=await readFile(item.attachment.path);if(data.length!==Number(item.attachment.size_bytes))throw new DeliveryError('Вложение изменилось во время подготовки','waiting');item.publication.media={mimetype:item.attachment.mime,data:data.toString('base64'),filename:item.attachment.name};}
   prepared.push(await (options.prepare??prepareWhatsAppAiText)({cdp:options.cdp,accountId,conversationId:deliveryId,operationId:deliveryId+':'+index,externalId:row.external_id,recipientAliases:recipients,selfAliases:options.selfAliases,isActive:options.isActive,publication:item.publication,maxAgeMs:120000}));delete item.publication.media;
  }
  for(let index=0;index<prepared.length;index++){
   const c=await pool.connect();let acknowledgement:Promise<unknown>|undefined;
   try{
    await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
    const post=(await c.query('SELECT status,media_expired_at,text,updated_at FROM posts WHERE id=$1 FOR UPDATE',[row.post_id])).rows[0];
    if(!post||post.media_expired_at||['paused','stopped','completed'].includes(post.status)||post.text!==row.text||+post.updated_at!==+row.updated_at)throw new DeliveryError('Публикация изменена или остановлена до отправки','waiting');
    const delivery=(await c.query('SELECT status FROM deliveries WHERE id=$1 FOR UPDATE',[deliveryId])).rows[0];
    const route=(await c.query(`SELECT i.enabled,i.auth_error,i.session_key,dst.enabled AS destination_enabled,dst.external_id FROM deliveries d JOIN destinations dst ON dst.id=d.destination_id JOIN integrations i ON i.id=dst.integration_id WHERE d.id=$1 AND i.id=$2 FOR SHARE OF i,dst`,[deliveryId,accountId])).rows[0];
    if(delivery?.status!=='sending'||!route?.enabled||route.auth_error||!route.destination_enabled||route.session_key!==sessionKey||route.external_id!==row.external_id||!options.isActive())throw new DeliveryError('Маршрут WhatsApp изменён до отправки','waiting');
    // CDP writes the already-prepared command synchronously while post/delivery are locked.
    started=true;acknowledgement=prepared[index].prepared.start({operationId:deliveryId+':'+index,conversationId:deliveryId,text:plan[index].text}).acknowledgement;acknowledgement.catch(()=>{});
    await c.query('COMMIT');
   }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
   const result=await acknowledgement as {outcome?:string;externalMessageId?:string};
   if(result.outcome!=='confirmed'||result.externalMessageId!==prepared[index].reservedMessageId)throw new DeliveryError('WhatsApp не подтвердил отправку','ambiguous');
   ids.push(result.externalMessageId);
  }
  const externalMessageId=ids.join(',');await pool.query("UPDATE whatsapp_send_receipts SET status='sent',message_id=$2,updated_at=now() WHERE delivery_id=$1",[deliveryId,externalMessageId]);return{externalMessageId};
 }catch(error){
  if(started){await pool.query("UPDATE whatsapp_send_receipts SET status='unknown',updated_at=now() WHERE delivery_id=$1 AND status='sending'",[deliveryId]);throw new DeliveryError('Начатая отправка WhatsApp требует проверки','ambiguous');}
  await pool.query("DELETE FROM whatsapp_send_receipts WHERE delivery_id=$1 AND status='sending'",[deliveryId]);throw error;
 }finally{for(const p of prepared)await p.release().catch(()=>{});}
}
