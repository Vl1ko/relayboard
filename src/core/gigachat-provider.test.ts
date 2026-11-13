import test from 'node:test';
import assert from 'node:assert/strict';
import { createGigaChatProvider } from './gigachat-provider.js';
import { aiSettingsSchema, type AiSettings } from './ai-engine.js';
const settings: AiSettings = { provider:'gigachat',model:'GigaChat',knowledge:[],fields:[],rules:[],qualificationEnabled:false,tone:'short',replyLimit:2 };
const input = () => ({system:'guard',signal:new AbortController().signal,data:{settings,messages:[],fields:{}}});
const answer = () => new Response(JSON.stringify({choices:[{message:{content:'{"replyKind":"handoff"}'},finish_reason:'stop'}]}));
test('GigaChat exchanges server-only key, caches and refreshes token at expiry', async () => {
  let now=1_800_000_000_000;const calls:{url:string;init:RequestInit}[]=[];
  const provider=createGigaChatProvider({authKey:'synthetic-key',now:()=>now,fetch:async(url,init)=>{
    calls.push({url:String(url),init:init!});
    return String(url).includes('oauth')?new Response(JSON.stringify({access_token:'synthetic-access',expires_at:now+1_800_000})):answer();
  }});
  assert.equal((await provider.complete(input()) as any).replyKind,'handoff');
  await provider.complete(input());assert.equal(calls.length,3);
  assert.equal(calls[0].url,'https://ngw.devices.sberbank.ru:9443/api/v2/oauth');
  assert.equal(calls[0].init.body,'scope=GIGACHAT_API_PERS');
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'),'Basic synthetic-key');
  assert.match(new Headers(calls[0].init.headers).get('RqUID')!,/^[a-f0-9-]{36}$/);
  assert.equal(calls[1].url,'https://api.giga.chat/v1/chat/completions');
  assert.equal(new Headers(calls[1].init.headers).get('Authorization'),'Bearer synthetic-access');
  assert.ok(!String(calls[1].init.body).includes('synthetic-key'));
  assert.equal(calls[1].init.redirect,'error');
  const payload=JSON.parse(String(calls[1].init.body));assert.equal(payload.response_format.strict,true);assert.ok(payload.response_format.schema.required.includes('handoffReason'));
  now+=1_760_000;await provider.complete(input());assert.equal(calls.length,5);
});
test('GigaChat fails closed on HTTP, oversized, truncated or malformed responses without exposing bodies', async()=>{
  for(const mode of ['http','oversize','truncated','malformed','token']){
    const p=createGigaChatProvider({authKey:'secret',fetch:async(url)=>String(url).includes('oauth')?new Response(JSON.stringify(mode==='token'?{access_token:'secret',expires_at:0}:{access_token:'access',expires_at:Date.now()+1_800_000})):mode==='http'?new Response('private-error-secret',{status:401}):mode==='oversize'?new Response('x'.repeat(131073)):mode==='truncated'?new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'length'}]})):new Response('private-error-secret')});
    await assert.rejects(p.complete(input()),{message:'gigachat_completion_failed'});
  }
});
test('GigaChat rejects mismatched provider before network and enforces single stream', async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let count=0;
  const p=createGigaChatProvider({authKey:'secret',fetch:async(url)=>{count++;await gate;return String(url).includes('oauth')?new Response(JSON.stringify({access_token:'access',expires_at:Date.now()+1_800_000})):answer();}});
  await assert.rejects(p.complete({...input(),data:{...input().data,settings:{...settings,provider:'yandex'}}}),/not_configured/);assert.equal(count,0);
  const first=p.complete(input());await assert.rejects(p.complete(input()),/single_stream_busy/);release();await first;
});
test('settings accept provider-specific models and reject cross-provider model formats',()=>{
  assert.ok(aiSettingsSchema.safeParse(settings).success);
  assert.ok(aiSettingsSchema.safeParse({...settings,provider:'yandex',model:'gpt://folder/yandexgpt/latest'}).success);
  assert.equal(aiSettingsSchema.safeParse({...settings,model:'https://attacker.example'}).success,false);
  assert.equal(aiSettingsSchema.safeParse({...settings,provider:'yandex'}).success,false);
});
