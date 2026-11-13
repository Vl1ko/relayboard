import { randomUUID } from 'node:crypto';
import type { AiProvider } from './ai-engine.js';

export type GigaChatScope = 'GIGACHAT_API_PERS' | 'GIGACHAT_API_B2B' | 'GIGACHAT_API_CORP';
const contract = ' Return only JSON with keys replyDraft,extracted,replyKind,askFields,knowledgeKeys,proposedStatus,handoffReason. replyKind: ask_fields|knowledge|handoff|none; proposedStatus: ai_dialog|qualified|unqualified|insufficient_data|manager_required; handoffReason: unknown_question|requested_human|insufficient_data|null. extracted: [{field,value,evidenceMessageId,evidenceQuote}].';
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
export function createGigaChatProvider(options: { authKey: string; scope?: GigaChatScope; fetch?: typeof fetch; now?: () => number }): AiProvider {
  const request = options.fetch ?? fetch, now = options.now ?? Date.now;
  const scope = options.scope ?? 'GIGACHAT_API_PERS';
  if (!['GIGACHAT_API_PERS','GIGACHAT_API_B2B','GIGACHAT_API_CORP'].includes(scope)) throw Error('gigachat_invalid_scope');
  let token: { value: string; expires: number } | undefined, busy = false;
  return { kind: 'gigachat', async complete({ system, data, signal }) {
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
      const response = await request('https://api.giga.chat/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal: deadline,
        headers: { Authorization: 'Bearer ' + token.value, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: data.settings.model, stream: false, temperature: 0.01, max_tokens: 2000, messages: [{ role: 'system', content: system + contract }, { role: 'user', content: JSON.stringify(data) }] }),
      });
      if (response.status === 401) token = undefined;
      const body = await boundedJson(response, 131072), answer = body?.choices?.[0]?.message?.content;
      if (body?.choices?.[0]?.finish_reason === 'length' || typeof answer !== 'string' || answer.length > 32768) throw Error('gigachat_invalid_response');
      return JSON.parse(answer);
    } catch { throw Error('gigachat_completion_failed'); }
    finally { busy = false; }
  } };
}
