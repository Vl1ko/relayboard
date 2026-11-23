import {config} from './config.js';
import {DeliveryError} from './delivery-policy.js';
/** RPC carries durable operation IDs; the socket owner rechecks all send guards. */
export async function maxWorkerRequest(path:string,method:'GET'|'POST'='GET',body?:unknown){
 if(!config.MAX_WORKER_URL||!config.MAX_WORKER_SECRET)throw new DeliveryError('MAX worker не настроен','waiting');
 try{
  const response=await fetch(new URL(path,config.MAX_WORKER_URL),{method,redirect:'error',headers:{authorization:'Bearer '+config.MAX_WORKER_SECRET,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(config.SEND_TIMEOUT_MS)});
  if(!response.ok){
   const body=await response.json() as {kind?:string;code?:string};
   const kind=body.kind==='waiting'?'waiting':body.kind==='auth_required'?'auth_required':body.kind==='permanent'?'permanent':'ambiguous';
   const message=kind==='permanent'&&body.code==='max_chat_denied'?'MAX: нет прав отправки сообщений в этот чат':kind==='waiting'&&body.code==='max_rate_limited'?'MAX ограничил частоту отправки; публикация ожидает':'MAX worker отложил операцию; проверьте её сохранённый результат';
   throw new DeliveryError(message,kind);
  }
  return await response.json();
 }catch(error){
  if(error instanceof DeliveryError)throw error;
  throw new DeliveryError('Ответ MAX worker не получен; проверьте сохранённый результат',method==='POST'?'ambiguous':'waiting');
 }
}
