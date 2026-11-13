import type { PreparedChannelSend } from '../ai-manager.js';
export interface ConnectedMaxTextSocket {
  readonly connected: boolean;
  send(opcode: number, payload: Record<string, unknown>, timeout?: number): Promise<unknown>;
}
/** Text-only prepared transport for an explicitly allowlisted local test chat.
 * UMax 1.0.8 Ws.send writes synchronously before returning its acknowledgement promise.
 * No connection, upload, delayed work or retry is allowed at this boundary.
 */
export function prepareMaxAiText(options: { socket: ConnectedMaxTextSocket; accountId: string; chatId: string; allowedChatId: string; beforeStart?: (operationId:string,cid:number)=>void }): PreparedChannelSend {
  if (options.chatId !== options.allowedChatId || !/^-?\d+$/.test(options.chatId) || !Number.isSafeInteger(Number(options.chatId))) throw Error('max_test_target_forbidden');
  let lastCid = 0;
  return { target: { accountId: options.accountId, externalConversationId: options.chatId, platform:'max' }, start(action) {
    if (!options.socket.connected) return { acknowledgement: Promise.resolve({ operationId:action.operationId,outcome:'rejected',dispatchState:'not_started',code:'max_not_connected',retryCondition:'refresh_auth' }) };
    const cid = Math.max(Date.now(), lastCid + 1); lastCid = cid;
    options.beforeStart?.(action.operationId,cid);
    const acknowledgement = options.socket.send(64,{chatId:Number(options.chatId),message:{text:action.text,cid,elements:[],attaches:[]},notify:true},15000).then((result:any) => {
      const id=result?.message?.id;
      if (id === null || id === undefined || !String(id).trim()) return {operationId:action.operationId,outcome:'unknown',code:'max_missing_receipt',retryCondition:'reconcile_or_manual_review'};
      return {operationId:action.operationId,outcome:'confirmed',externalMessageId:String(id),code:'max_server_receipt',retryCondition:'never'};
    },()=>({operationId:action.operationId,outcome:'unknown',code:'max_send_uncertain',retryCondition:'reconcile_or_manual_review'}));
    return {acknowledgement};
  }};
}
