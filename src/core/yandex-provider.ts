import type{AiProvider}from'./ai-engine.js';
/** Fixed official endpoint; credentials stay server-side. No retries or free-text sends. */
export function createYandexProvider(options:{apiKey:string;folderId:string;fetch?:typeof fetch}):AiProvider{
 const request=options.fetch??fetch;
 return {kind:'yandex',async complete({system,data,signal}){
  if(data.settings.provider!=='yandex'||!data.settings.model||!options.apiKey||!options.folderId)throw Error('yandex_not_configured');
  const response=await request('https://ai.api.cloud.yandex.net/foundationModels/v1/completion',{method:'POST',signal,headers:{'content-type':'application/json','Authorization':'Api-Key '+options.apiKey,'x-folder-id':options.folderId},body:JSON.stringify({modelUri:data.settings.model,completionOptions:{stream:false,temperature:0,maxTokens:'2000'},messages:[{role:'system',text:system+' Return only JSON with keys replyDraft,extracted,replyKind,askFields,knowledgeKeys,proposedStatus,handoffReason. replyKind: ask_fields|knowledge|handoff|none; proposedStatus: ai_dialog|qualified|unqualified|insufficient_data|manager_required; handoffReason: unknown_question|requested_human|insufficient_data|null. extracted: [{field,value,evidenceMessageId,evidenceQuote}].'},{role:'user',text:JSON.stringify(data)}]})});
  if(!response.ok)throw Error('yandex_request_failed');
  const text=await response.text();if(text.length>131072)throw Error('yandex_response_too_large');
  const body=JSON.parse(text),answer=body?.result?.alternatives?.[0]?.message?.text;
  if(typeof answer!=='string'||answer.length>32768)throw Error('yandex_invalid_response');return JSON.parse(answer);
 }};
}
