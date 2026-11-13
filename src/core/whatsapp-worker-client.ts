import type {Pool} from 'pg';
import {config} from './config.js';
import {DeliveryError} from './delivery-policy.js';
/** The browser owner, not the RPC caller, performs the final gate and commit. */
export async function whatsappWorkerRequest(pool:Pool,accountId:string,path:string){
 const account=(await pool.query("SELECT session_key FROM integrations WHERE id=$1 AND platform='whatsapp' AND enabled",[accountId])).rows[0];
 if(!account)throw new DeliveryError('Аккаунт WhatsApp выключен','waiting');
 try{
  const response=await fetch(new URL(path,config.WHATSAPP_BRIDGE_URL),{method:'POST',redirect:'error',headers:{authorization:'Bearer '+config.WHATSAPP_BRIDGE_SECRET,'x-account-session':account.session_key},signal:AbortSignal.timeout(config.SEND_TIMEOUT_MS)});
  if(!response.ok)throw new DeliveryError('WhatsApp отложил действие; проверьте сохранённый результат',response.status===409?'waiting':'ambiguous');
  return await response.json();
 }catch(error){if(error instanceof DeliveryError)throw error;throw new DeliveryError('Ответ владельца WhatsApp не получен; проверьте сохранённый результат','ambiguous');}
}

export function dispatchWhatsAppAction(pool:Pool,id:string,accountId:string){return whatsappWorkerRequest(pool,accountId,`/ai/actions/${id}/dispatch`);}
