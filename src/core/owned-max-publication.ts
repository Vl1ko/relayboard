import type {Pool} from 'pg';
import type {MaxConnections} from './max-connections.js';
import {prepareMaxMediaMessage,MaxPublicationRejected} from './adapters/max-photo.js';
import {DeliveryError,isAuthorizationError} from './delivery-policy.js';
import {setTimeout as delay} from 'node:timers/promises';

// One MAX owner serves all posts. Per-post intervals alone allow a burst when
// many overdue posts resume together. Gate the account across those posts.
const accountNotBefore=new Map<string,number>();
function publicationReady(accountId:string){
 if((accountNotBefore.get(accountId)??0)>Date.now())throw new DeliveryError('MAX: публикация ожидает интервала отправки аккаунта','waiting');
}
async function awaitPublicationTurn(accountId:string,signal:AbortSignal){
 const remaining=(accountNotBefore.get(accountId)??0)-Date.now();
 // Ordinary pacing fits inside the RPC budget and holds no DB locks. A longer
 // server cooldown defers the job durably instead of tying up the worker.
 if(remaining>3000)publicationReady(accountId);
 if(remaining>0)await delay(remaining,undefined,{signal});
 signal.throwIfAborted();
}

/** Publication content and destination come from the database, never the RPC body. */
export async function dispatchOwnedMaxPublication(pool:Pool,connections:MaxConnections,deliveryId:string,signal:AbortSignal,timeoutMs:number){
 signal.throwIfAborted();
 const row=(await pool.query(`SELECT d.id,d.status,d.post_id,dst.external_id,i.id AS account_id FROM deliveries d JOIN destinations dst ON dst.id=d.destination_id JOIN integrations i ON i.id=dst.integration_id WHERE d.id=$1 AND i.platform='max' AND i.enabled AND i.auth_error IS NULL`,[deliveryId])).rows[0];
 if(!row)throw new DeliveryError('Публикация MAX недоступна','waiting');
 if(!/^-?\d+$/.test(row.external_id)||!Number.isSafeInteger(Number(row.external_id)))throw new DeliveryError('Неверный адрес MAX','permanent');
 const old=(await pool.query('SELECT * FROM max_send_receipts WHERE delivery_id=$1',[deliveryId])).rows[0];
 if(old){
  if(old.account_id!==row.account_id||old.destination_id!==row.external_id)throw new DeliveryError('Адрес начатой отправки изменён','ambiguous');
  if(old.status==='sent')return {externalMessageId:old.message_id};
  throw new DeliveryError('Результат предыдущей отправки MAX требует проверки','ambiguous');
 }
 if(row.status!=='sending')throw new DeliveryError('Публикация не захвачена worker','waiting');
 await awaitPublicationTurn(row.account_id,signal);
 let connection:Awaited<ReturnType<MaxConnections['get']>>;
 try{connection=await connections.get(row.account_id);}catch(error){throw new DeliveryError(isAuthorizationError(error)?'MAX: требуется повторный вход':'MAX временно недоступен; отправка ожидает подключения',isAuthorizationError(error)?'auth_required':'waiting');}
 const claimed=await pool.query("INSERT INTO max_send_receipts(delivery_id,account_id,destination_id,status) VALUES($1,$2,$3,'sending') ON CONFLICT DO NOTHING RETURNING delivery_id",[deliveryId,row.account_id,row.external_id]);
 if(!claimed.rowCount)throw new DeliveryError('Отправка MAX уже началась','ambiguous');
 let started=false;
 try{
  const post=(await pool.query('SELECT text FROM posts WHERE id=$1',[row.post_id])).rows[0];
  const attachments=(await pool.query('SELECT storage_path AS path,original_name AS name,mime_type AS "mimeType",size_bytes::int AS "sizeBytes" FROM attachments WHERE post_id=$1 AND expired_at IS NULL ORDER BY created_at,id',[row.post_id])).rows;
  const prepared=await prepareMaxMediaMessage(connection.socket,Number(row.external_id),{text:post.text,attachments},timeoutMs,()=>{signal.throwIfAborted();started=true;});
  const client=await pool.connect();let ack:Promise<{externalMessageId:string}>;
  try{
   await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'");
   const current=(await client.query('SELECT status,media_expired_at FROM posts WHERE id=$1 FOR UPDATE',[row.post_id])).rows[0];
   if(!current||current.media_expired_at||['stopped','paused','completed'].includes(current.status))throw new DeliveryError('Публикация остановлена до отправки','waiting');
   const delivery=(await client.query('SELECT status FROM deliveries WHERE id=$1 FOR UPDATE',[deliveryId])).rows[0];
   if(delivery?.status!=='sending'||signal.aborted||!connection.socket.connected)throw new DeliveryError('Владелец MAX остановлен до отправки','waiting');
   const route=(await client.query(`SELECT i.enabled,i.auth_error,dst.enabled AS destination_enabled,dst.external_id FROM destinations dst JOIN integrations i ON i.id=dst.integration_id WHERE dst.id=(SELECT destination_id FROM deliveries WHERE id=$1) AND i.id=$2 FOR SHARE OF i,dst`,[deliveryId,row.account_id])).rows[0];
   if(!route?.enabled||route.auth_error||!route.destination_enabled||route.external_id!==row.external_id)throw new DeliveryError('Маршрут MAX изменён до отправки','waiting');
   // The prepared function writes to the socket synchronously under the post lock.
   publicationReady(row.account_id);
   accountNotBefore.set(row.account_id,Date.now()+3000);
   ack=prepared();ack.catch(()=>{});
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const receipt=await ack!;
  await pool.query("UPDATE max_send_receipts SET status='sent',message_id=$2,updated_at=now() WHERE delivery_id=$1",[deliveryId,receipt.externalMessageId]);
  return receipt;
 }catch(error){
  if(error instanceof MaxPublicationRejected){
   if(error.wireCode==='too.many.requests')accountNotBefore.set(row.account_id,Date.now()+60000);
   // Only a correlated explicit denial allows clearing the provisional receipt.
   // Disconnects, timeouts and missing receipts still retain unknown status.
   await pool.query("DELETE FROM max_send_receipts WHERE delivery_id=$1 AND status='sending'",[deliveryId]);
   throw error;
  }
  if(started){await pool.query("UPDATE max_send_receipts SET status='unknown',updated_at=now() WHERE delivery_id=$1 AND status='sending'",[deliveryId]);throw new DeliveryError('Начатая отправка MAX не подтверждена','ambiguous');}
  await pool.query("DELETE FROM max_send_receipts WHERE delivery_id=$1 AND status='sending'",[deliveryId]);throw error;
 }
}
