import type {Pool} from 'pg';
import {withExecutionSlot} from './execution-slot.js';
import {setTimeout as delay} from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type {AiProvider} from './ai-engine.js';

export type GigaChatScope = 'GIGACHAT_API_PERS' | 'GIGACHAT_API_B2B' | 'GIGACHAT_API_CORP';
const contract = `
Return exactly ONE JSON object, no markdown. All eight keys are required:
{"replyDraft":"","extracted":[],"replyKind":"ask_fields","askFields":["field_key"],"knowledgeKeys":[],"proposedStatus":"ai_dialog","handoffReason":null}
replyDraft must be a string (the server renders configured text).
extracted is an array of {"field":"field_key","value":"non-empty factual value or number or boolean","evidenceMessageId":"actual customer message ID","evidenceQuote":"exact non-empty quote from that customer message"}.
If the customer did not supply a field, OMIT its extraction entirely; never emit empty values, empty evidence or placeholders. Use extracted:[] when no facts are known.
askFields and knowledgeKeys are arrays of STRING KEYS, for example ["volume"], NEVER arrays of objects. Use only keys in data.settings.fields or knowledge.
replyKind is ask_fields|knowledge|handoff|none.
proposedStatus is ai_dialog|qualified|unqualified|insufficient_data|manager_required.
handoffReason is unknown_question|requested_human|insufficient_data|null (JSON null, not a string).
When asking for missing required volume, a valid result is {"replyDraft":"","extracted":[],"replyKind":"ask_fields","askFields":["volume"],"knowledgeKeys":[],"proposedStatus":"ai_dialog","handoffReason":null}.
For fields used by gte/lte rules, extracted.value MUST be a JSON number, never a quoted string.
Use the supplied knowledge and evidence; if a commercial fact is unknown, hand off rather than invent it.`;

/** Literal numeric evidence only: no rounding, unit conversion or values from business rules. */
export function numericEvidenceValues(messages:{origin:string;text:string}[]){
 const values=new Set<number>();
 for(const m of messages.filter(m=>m.origin==='customer'))for(const match of m.text.matchAll(/(?<![\p{L}\d.,+\-])[+-]?\d+(?:\.\d+)?(?![\d.,])/gu)){
  const n=Number(match[0]);if(!Number.isFinite(n)||(Number.isInteger(n)&&!Number.isSafeInteger(n)))continue;
  const literal=String(n).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(new RegExp('(^|[^0-9.,+-])'+literal+'($|[^0-9.,])').test(m.text))values.add(n);
 }
 return [...values];
}
async function boundedJson(response: Response, limit: number): Promise<any> {
  if (!response.ok) { await response.body?.cancel(); throw Error('gigachat_request_failed'); }
  const reader = response.body?.getReader();
  if (!reader) throw Error('gigachat_invalid_response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw Error('gigachat_response_too_large');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); }
}
/** Official endpoints only; normal TLS validation, no retries, credentials never in model input/logs. */
export function createGigaChatProvider(options: { pool?: Pool; authKey: string; scope?: GigaChatScope; fetch?: typeof fetch; now?: () => number }): AiProvider {
  const request = options.fetch ?? fetch, now = options.now ?? Date.now;
  const scope = options.scope ?? 'GIGACHAT_API_PERS';
  if (!['GIGACHAT_API_PERS','GIGACHAT_API_B2B','GIGACHAT_API_CORP'].includes(scope)) throw Error('gigachat_invalid_scope');
  let token: { value: string; expires: number } | undefined, busy = false;
  const provider:AiProvider = { kind: 'gigachat', async complete({ system, data, signal }) {
    if (data.settings.provider !== 'gigachat' || !/^GigaChat(?:-[A-Za-z0-9]+)*$/.test(data.settings.model ?? '') || !options.authKey.trim()) throw Error('gigachat_not_configured');
    if (busy) throw Error('gigachat_single_stream_busy');
    busy = true;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    try {
      if (!token || token.expires <= now() + 60_000) {
        const auth = await boundedJson(await request('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
          method: 'POST', redirect: 'error', signal: deadline,
          headers: { Authorization: 'Basic ' + options.authKey.trim(), RqUID: randomUUID(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ scope }).toString(),
        }), 16384);
        let expires = Number(auth.expires_at);
        if (expires < 1e12) expires *= 1000;
        if (typeof auth.access_token !== 'string' || !auth.access_token || auth.access_token.length > 12000 || !Number.isFinite(expires) || expires <= now() + 1000) throw Error('gigachat_invalid_token');
        token = { value: auth.access_token, expires };
      }
      const evidenceMessages=data.messages.filter(m=>m.origin==='customer');
      const evidenceIds=evidenceMessages.map(m=>m.messageId);
      const evidenceQuotes=[...new Set(evidenceMessages.flatMap(m=>m.text.length<=2000?[m.text]:[m.text.slice(0,2000),m.text.slice(-2000)]).filter(Boolean))];
      const numeric=data.settings.fields.every(f=>data.settings.rules.some(r=>r.field===f.key&&['gte','lte'].includes(r.op)));
      const numericValues=numericEvidenceValues(data.messages);
      const schema={type:'object',additionalProperties:false,required:['replyDraft','extracted','replyKind','askFields','knowledgeKeys','proposedStatus','handoffReason'],properties:{
        replyDraft:{type:'string'},extracted:{type:'array',items:{type:'object',additionalProperties:false,required:['field','value','evidenceMessageId','evidenceQuote'],properties:{field:{type:'string'},value:numeric?{type:'number',...(numericValues.length?{enum:numericValues}:{})}:{type:['string','number','boolean']},evidenceMessageId:{type:'string',...(evidenceIds.length?{enum:evidenceIds}:{})},evidenceQuote:{type:'string',...(evidenceQuotes.length?{enum:evidenceQuotes}:{})}}}},
        replyKind:{type:'string',enum:['ask_fields','knowledge','handoff','none']},askFields:{type:'array',items:{type:'string'}},knowledgeKeys:{type:'array',items:{type:'string'}},proposedStatus:{type:'string',enum:['ai_dialog','qualified','unqualified','insufficient_data','manager_required']},handoffReason:{type:['string','null'],enum:['unknown_question','requested_human','insufficient_data',null]}
      }};
      if(numeric&&!numericValues.length)(schema.properties.extracted as any).maxItems=0;
      const response = await request('https://api.giga.chat/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal: deadline,
        headers: { Authorization: 'Bearer ' + token.value, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: data.settings.model, response_format:{type:'json_schema',schema,strict:true},stream: false, temperature: 0.01, max_tokens: 2000, messages: [{ role: 'system', content: system + contract }, { role: 'user', content: JSON.stringify(data) }] }),
      });
      if (response.status === 401) token = undefined;
      const body = await boundedJson(response, 131072), answer = body?.choices?.[0]?.message?.content;
      if (body?.choices?.[0]?.finish_reason === 'length' || typeof answer !== 'string' || answer.length > 32768) throw Error('gigachat_invalid_response');
      return JSON.parse(answer);
    } catch { throw Error('gigachat_completion_failed'); }
    finally { busy = false; }
  } };
  if(options.pool)provider.runExclusive=work=>withExecutionSlot(options.pool!,'model:gigachat:'+options.authKey.trim(),async signal=>{
    try{return await work(signal);}
    finally{while(busy)await delay(10);} // Retain ownership until an aborted HTTP call actually settles.
  });
  return provider;
}
