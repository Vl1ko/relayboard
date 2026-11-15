import {startSourceHeartbeat} from '../core/source-runtime-health.js';
import { sentMessageId } from "../core/whatsapp-receipt.js";
import express, { type RequestHandler } from "express";
import { createRequire } from "node:module";
import { join } from "node:path";
import QRCode from "qrcode";
import pkg from "whatsapp-web.js";
import { config } from "../core/config.js";

const { Client, LocalAuth, MessageMedia } = pkg;
const nodeRequire = createRequire(import.meta.url);
const { LoadUtils: loadWhatsAppUtils } = nodeRequire("whatsapp-web.js/src/util/Injected/Utils.js") as {
  LoadUtils: () => void;
};
import { pool } from "../core/db.js";
import {withExecutionSlot} from '../core/execution-slot.js';
import {WhatsAppSessions} from '../core/whatsapp-sessions.js';
import {AiManagerStore} from '../core/ai-manager.js';
import {WhatsAppAiReceipts} from '../core/whatsapp-ai-receipts.js';
import {WhatsAppPrivatePoller,type WhatsAppPrivateHistory} from '../core/whatsapp-private-poller.js';
import {prepareWhatsAppAiText} from '../core/adapters/whatsapp-ai-text.js';
import {runtimeAllowsConversation} from '../core/runtime-scope.js';
import {z} from 'zod';
import {resolveWhatsAppContactRoute} from '../core/whatsapp-contact-route.js';
import {resolveWhatsAppSourceRoute,type WhatsAppSourceProof} from '../core/whatsapp-source-route.js';
import {WhatsAppSourcePoller,type WhatsAppGroupHistory} from '../core/whatsapp-source-poller.js';
function createSession(sessionKey: string, accountId:string, ownerSignal:AbortSignal) {
const sessionPath = sessionKey === "legacy" ? config.WHATSAPP_SESSION_PATH : join(config.WHATSAPP_SESSION_PATH, sessionKey);
const app = express();
app.use(express.json({ limit: "1mb" }));

type BridgeState = "starting" | "qr" | "authenticated" | "ready" | "disconnected" | "auth_failure";

let state: BridgeState = "starting";
let qrDataUrl: string | null = null;
let authenticationConfirmed = false;
let lastError: string | null = null;
let readyProbe: Promise<boolean> | null = null;
let readyProbeTimer: NodeJS.Timeout | null = null;
let activeSends = 0;
let activeSendStartedAt = 0;
let generation = 0;
let lastHealthyAt = Date.now();
let recoveryAttempts = 0;
let recovering = false;
let closing = false;
const scope={testOnly:config.AI_TEST_ONLY,accountIds:config.AI_TEST_ACCOUNT_IDS,authorIds:config.AI_TEST_AUTHOR_IDS};
const receipts=new WhatsAppAiReceipts(pool);
const privatePoller=new WhatsAppPrivatePoller(pool,readPrivateHistory,ownerSignal,scope);
const groupPoller=new WhatsAppSourcePoller(pool,readGroupHistory,ownerSignal,scope);
let pinnedSelf:string|null=null;
async function selfAliases(){
 const page=client.pupPage;if(!page)throw Error('wa_session_not_ready');
 const ids=await page.evaluate(`(()=>{const p=window.require('WAWebUserPrefsMeUser');return [p.getMaybeMePnUser()?._serialized,p.getMaybeMeLidUser()?._serialized].filter(Boolean);})()`) as string[];
 if(!Array.isArray(ids)||!ids.length||ids.some(id=>!/^[1-9][0-9]{0,30}@(c\.us|lid)$/.test(id)))throw Error('wa_self_unverified');
 const row=(await pool.query("UPDATE integrations SET whatsapp_self_id=coalesce(whatsapp_self_id,$2),whatsapp_self_aliases=$4::jsonb WHERE id=$1 AND platform='whatsapp' AND enabled AND (whatsapp_self_id IS NULL OR whatsapp_self_id=ANY($3::text[])) RETURNING whatsapp_self_id",[accountId,ids[0],ids,JSON.stringify(ids)])).rows[0];
 if(!row)throw Error('wa_account_identity_changed');pinnedSelf=row.whatsapp_self_id;return ids;
}
async function recipientAliases(recipient:string){
 if(!/^[1-9][0-9]{0,30}@(c\.us|lid)$/.test(recipient))throw Error('wa_private_target_unverified');
 const result=await client.getContactLidAndPhone([recipient]);
 const match=result.find(v=>v.pn===recipient||v.lid===recipient);
 if(!match){if(recipient.endsWith('@lid'))return[recipient];throw Error('wa_private_target_unverified');}
 return [...new Set([match.pn,match.lid].filter((v):v is string=>!!v))];
}
async function readPrivateHistory(requestAccount:string,recipient:string,externalId:string):Promise<WhatsAppPrivateHistory>{
 if(requestAccount!==accountId||!(await probeClientReady()))throw Error('wa_session_not_ready');
 const aliases=await recipientAliases(recipient),self=await selfAliases();
 if(!aliases.includes(externalId)||self.some(id=>aliases.includes(id)))throw Error('wa_private_target_unverified');
 const chat=await client.getChatById(externalId);
 if(chat.isGroup||!aliases.includes(chat.id._serialized))throw Error('wa_private_target_unverified');
 const messages=await chat.fetchMessages({limit:500});
 return{targetId:chat.id._serialized,recipientAliases:aliases,selfAliases:self,exhausted:messages.length<500,messages:messages.map(m=>({id:m.id._serialized,from:m.from,to:m.to,fromMe:m.fromMe,timestamp:m.timestamp,body:m.body,ack:m.ack,type:String(m.type)}))};
}

async function readGroupHistory(requestAccount:string,chatId:string):Promise<WhatsAppGroupHistory>{
 if(requestAccount!==accountId||!(await probeClientReady()))throw Error('wa_session_not_ready');
 const self=await selfAliases(),chat=await client.getChatById(chatId);
 if(!chat.isGroup||chat.id._serialized!==chatId||!chatId.endsWith('@g.us'))throw Error('wa_source_unverified');
 const messages=await chat.fetchMessages({limit:500});
 return{chatId,isGroup:chat.isGroup,selfAliases:self,exhausted:messages.length<500,messages:messages.map(m=>({id:m.id._serialized,chatId:m.fromMe?m.to:m.from,authorId:m.author??'',fromMe:m.fromMe,timestamp:m.timestamp,text:m.body,type:String(m.type)}))};
}
async function phoneProof(phone:string){
 if(!(await probeClientReady()))throw Error('wa_session_not_ready');
 const number=await client.getNumberId(phone.slice(1)),expected=phone.slice(1)+'@c.us';if(!number||number._serialized!==expected)throw Error('wa_phone_unverified');
 const aliases=await recipientAliases(expected),self=await selfAliases(),chat=await client.getChatById(expected);
 if(chat.isGroup||!aliases.includes(chat.id._serialized))throw Error('wa_private_target_unverified');
 return{phone,pn:expected,aliases,selfAliases:self,privateId:chat.id._serialized};
}
async function sourceProof(lead:{chat_id:string;message_id:string}):Promise<WhatsAppSourceProof>{
 if(!(await probeClientReady()))throw Error('wa_session_not_ready');
 const chat=await client.getChatById(lead.chat_id),message=await client.getMessageById(lead.message_id);
 if(!chat.isGroup||chat.id._serialized!==lead.chat_id||!message||message.id._serialized!==lead.message_id||message.from!==lead.chat_id||message.fromMe||!message.author||typeof message.body!=='string'||!message.body.trim())throw Error('wa_source_unverified');
 const aliases=await recipientAliases(message.author),self=await selfAliases();
 return{messageId:message.id._serialized,authorId:message.author,chatId:message.from,text:message.body,occurredAt:new Date(message.timestamp*1000).toISOString(),pn:aliases.find(a=>a.endsWith('@c.us')),aliases,selfAliases:self};
}
async function privateProof(source:WhatsAppSourceProof){
 if(source.pn){const proof=await phoneProof('+'+source.pn.split('@')[0]);return{...proof,recipientId:proof.aliases.includes(source.authorId)?source.authorId:source.pn};}
 if(!(await probeClientReady()))throw Error('wa_session_not_ready');
 const aliases=await recipientAliases(source.authorId),self=await selfAliases(),chat=await client.getChatById(source.authorId);
 if(chat.isGroup||!aliases.includes(chat.id._serialized))throw Error('wa_private_target_unverified');
 return{privateId:chat.id._serialized,recipientId:source.authorId,pn:aliases.find(a=>a.endsWith('@c.us')),aliases,selfAliases:self};
}

const puppeteer: Record<string, unknown> = {
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
};
if (config.WHATSAPP_CHROMIUM_PATH) puppeteer.executablePath = config.WHATSAPP_CHROMIUM_PATH;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: sessionPath, clientId: "relayboard" }),
  puppeteer,
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}


function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: превышено время ожидания`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function markReady(source: string) {
  if (state !== "ready") console.log(`WhatsApp client is ready (${source})`);
  state = "ready";
  authenticationConfirmed = true;
  qrDataUrl = null;
  lastError = null;
  if (readyProbeTimer) {
    clearInterval(readyProbeTimer);
    readyProbeTimer = null;
  }
}

type WhatsAppGroup = { id: string; title: string; unreadCount: number };

async function readGroupsDirect(): Promise<WhatsAppGroup[]> {
  const page = (client as unknown as { pupPage?: { evaluate<T>(callback: () => T): Promise<T> } }).pupPage;
  if (!page) throw new Error("Страница WhatsApp Web ещё не создана");

  return withTimeout(
    page.evaluate(() => {
      const whatsappWindow = window as unknown as {
        require?: (moduleName: string) => {
          Chat?: { getModelsArray(): Array<Record<string, unknown>> };
        };
      };
      const chats = whatsappWindow.require?.("WAWebCollections")?.Chat?.getModelsArray?.() || [];
      return chats.flatMap((chat) => {
        const idObject = chat.id as { _serialized?: string; $1?: string } | undefined;
        const id = idObject?._serialized ?? idObject?.$1 ?? "";
        if (!id.endsWith("@g.us")) return [];
        const contact = chat.contact as { name?: string; pushname?: string } | undefined;
        const title = String(chat.name || chat.formattedTitle || contact?.name || contact?.pushname || id);
        const unreadCount = typeof chat.unreadCount === "number" ? chat.unreadCount : 0;
        return [{ id, title, unreadCount }];
      });
    }),
    20_000,
    "загрузка групп",
  );
}

async function ensureUtilityInjection() {
  const page = (client as unknown as { pupPage?: { evaluate<T>(callback: () => T): Promise<T> } }).pupPage;
  if (!page) throw new Error("Страница WhatsApp Web ещё не создана");
  const available = await page.evaluate(() => {
    const helpers = (window as unknown as { WWebJS?: Record<string, unknown> }).WWebJS;
    return typeof helpers?.getChat === "function" && typeof helpers?.sendMessage === "function";
  });
  if (available) return;

  await page.evaluate(loadWhatsAppUtils);
  const injected = await page.evaluate(() => {
    const helpers = (window as unknown as { WWebJS?: Record<string, unknown> }).WWebJS;
    return typeof helpers?.getChat === "function" && typeof helpers?.sendMessage === "function";
  });
  if (!injected) throw new Error("Не удалось подготовить функции отправки WhatsApp Web");
  console.log("WhatsApp utility functions injected by bridge recovery");
}

async function probeClientReady() {
  if (readyProbe) return readyProbe;

  readyProbe = (async () => {
    try {
      const page=client.pupPage;
      if (!page || recovering || closing) return false;
      const connected=await withTimeout(page.evaluate(()=>{
        const w=window as unknown as {require?: (name:string)=>{Socket?:{state?:string}}};
        return w.require?.("WAWebSocketModel")?.Socket?.state === "CONNECTED";
      }),4000,"проверка соединения WhatsApp");
      if (!connected) {
        if (state === "ready") state="disconnected";
        return false;
      }
      authenticationConfirmed=true;
      // WhatsApp Web 2.3000.x can authenticate without emitting `ready`, and
      // full chat serialization can fail on one malformed/internal model.
      // Reading the minimal group fields directly verifies the exact feature
      // this bridge needs without serializing every chat and message.
      await ensureUtilityInjection();
      await selfAliases();
      await readGroupsDirect();
      markReady("group collection");
      lastHealthyAt=Date.now();
      recoveryAttempts=0;
      return true;
    } catch (error) {
      if (state === "ready") state="disconnected";
      lastError = errorMessage(error);
      return false;
    }
  })().finally(() => {
    readyProbe = null;
  });
  return readyProbe;
}

function startReadyProbes() {
  if (readyProbeTimer) return;
  let attempts = 0;
  void probeClientReady();
  readyProbeTimer = setInterval(() => {
    attempts += 1;
    if (state === "ready" || attempts >= 20) {
      if (readyProbeTimer) clearInterval(readyProbeTimer);
      readyProbeTimer = null;
      return;
    }
    void probeClientReady();
  }, 3_000);
  readyProbeTimer.unref();
}

// Chromium manages stale profile locks itself. Never remove locks that may
// still belong to a surviving browser from the previous Node process.

client.on("qr", async (qr) => {
  if (authenticationConfirmed) {
    console.log("Ignoring a QR refresh after WhatsApp authentication");
    return;
  }
  qrDataUrl = await QRCode.toDataURL(qr, { width: 360, margin: 2 });
  state = "qr";
  lastError = null;
  console.log("WhatsApp QR code refreshed");
});
client.on("ready", () => markReady("ready event"));
client.on("authenticated", () => {
  authenticationConfirmed = true;
  state = "authenticated";
  qrDataUrl = null;
  lastError = null;
  console.log("WhatsApp client authenticated; checking session readiness");
  startReadyProbes();
});
client.on("change_state", (nextState) => {
  console.log("WhatsApp connection state changed", nextState);
  if (String(nextState) === "CONNECTED") void probeClientReady();
});
client.on("auth_failure", (message) => {
  state = "auth_failure";
  authenticationConfirmed = false;
  lastError = String(message);
  console.error("WhatsApp authentication failed", message);
});
client.on("disconnected", (reason) => {
  state = "disconnected";
  authenticationConfirmed = false;
  qrDataUrl = null;
  lastError = String(reason);
  console.error("WhatsApp disconnected", reason);
});

const requireBridgeSecret: RequestHandler = (request, response, next) => {
  if (request.header("authorization") !== `Bearer ${config.WHATSAPP_BRIDGE_SECRET}`) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};
app.use(requireBridgeSecret);

app.get("/status", async (_request, response) => {
  await probeClientReady();
  response.json({ status: state, qr: qrDataUrl, error: lastError, recoveryAttempts });
});

app.get("/groups", async (_request, response) => {
  if (!(await probeClientReady())) {
    return response.status(409).json({ error: "WhatsApp ещё синхронизирует сессию", status: state, details: lastError });
  }
  try {
    const chats = await readGroupsDirect();
    markReady("groups");
    response.json(chats);
  } catch (error) {
    lastError = errorMessage(error);
    response.status(503).json({ error: "Не удалось загрузить группы WhatsApp", details: lastError });
  }
});

app.post('/ai/contacts/:id/resolve',async(request,response)=>{
 if(config.AI_SEND_MODE!=='live')return response.status(409).json({error:'Live WhatsApp is disabled'});
 const contactId=z.string().uuid().parse(request.params.id);
 response.json(await resolveWhatsAppContactRoute(pool,scope,{accountId,contactId},phoneProof));
});

app.post('/ai/conversations/:id/sync',async(request,response)=>{
 const id=z.string().uuid().parse(request.params.id);
 if(config.AI_SEND_MODE!=='live'||!(await pool.query("SELECT 1 FROM ai_conversations WHERE id=$1 AND account_id=$2 AND platform='whatsapp'",[id,accountId])).rowCount)return response.status(409).json({error:'Private sync unavailable'});
 response.json(await privatePoller.poll(id));
});

app.post('/ai/actions/:id/dispatch',async(request,response)=>{
 const id=z.string().uuid().parse(request.params.id);
 if(config.AI_SEND_MODE!=='live'||!await runtimeAllowsConversation(pool,scope,(await pool.query('SELECT conversation_id FROM ai_outbox WHERE id=$1',[id])).rows[0]?.conversation_id))return response.status(409).json({error:'AI action is outside the enabled runtime scope'});
 const store=new AiManagerStore(pool),preflight=await store.preflight(id);
 if(!preflight.ready)return response.json({state:preflight.state,deferred:true});
 const v=(await pool.query("SELECT v.* FROM ai_outbox a JOIN ai_conversations v ON v.id=a.conversation_id WHERE a.id=$1 AND v.account_id=$2 AND v.platform='whatsapp'",[id,accountId])).rows[0];
 if(!v)return response.status(404).json({error:'WhatsApp action not found'});
 if(!(await privatePoller.poll(v.id)).complete)return response.status(409).json({error:'Private history awaits verification'});
 const source=(await pool.query('SELECT recipient_id FROM ai_request_sources WHERE conversation_id=$1 AND request_id=(SELECT request_id FROM ai_request_phases WHERE id=$2) ORDER BY created_at DESC LIMIT 1',[v.id,v.active_phase_id])).rows[0];
 if(!source)throw Error('wa_private_route_missing');
 const aliases=await recipientAliases(source.recipient_id),self=await selfAliases(),page=client.pupPage;
 if(!page)throw Error('wa_session_not_ready');
 const cdp=await page.createCDPSession(),sendGeneration=generation;
 let prepared:Awaited<ReturnType<typeof prepareWhatsAppAiText>>|undefined;
 try{
  prepared=await prepareWhatsAppAiText({cdp,accountId,conversationId:v.id,operationId:id,externalId:v.external_id,recipientAliases:aliases,selfAliases:self,isActive:()=>!ownerSignal.aborted&&!closing&&!recovering&&state==='ready'&&generation===sendGeneration&&!!pinnedSelf});
  await receipts.reserve({actionId:id,accountId,conversationId:v.id,messageId:prepared.reservedMessageId,targetId:prepared.actualTargetId,recipientAliases:aliases,selfAliases:prepared.selfIds});
  await store.dispatch(id,prepared.prepared);
  await receipts.reconcile(id);
  response.json((await pool.query('SELECT state,external_message_id,outcome_code FROM ai_outbox WHERE id=$1',[id])).rows[0]);
 }finally{await prepared?.release();await cdp.detach().catch(()=>{});}
});

app.post("/send", async (request, response) => {
  const { deliveryId, destinationId, text = "", attachments = [] } = request.body as {
    deliveryId?: string;
    destinationId?: string;
    text?: string;
    attachments?: Array<{ path: string; name: string; mimeType: string }>;
  };
  if (!deliveryId || !/^[0-9a-f-]{36}$/i.test(deliveryId) || !destinationId || (!text.trim() && attachments.length === 0)) {
    return response.status(400).json({ error: "Нужны destinationId и текст или файл" });
  }
  const existing=await pool.query("SELECT status,message_id,session_key,destination_id FROM whatsapp_send_receipts WHERE delivery_id=$1",[deliveryId]);
  if (existing.rowCount) {
    const receipt=existing.rows[0];
    if (receipt.session_key !== sessionKey || receipt.destination_id !== destinationId) return response.status(409).json({error:"Идентификатор отправки уже занят",kind:"ambiguous"});
    if (receipt.status === "sent") return response.json({messageId:receipt.message_id});
    return response.status(409).json({error:"Отправка уже начата; повтор заблокирован до проверки результата",kind:"ambiguous"});
  }
  if (!(await probeClientReady())) return response.status(409).json({ error: "WhatsApp ещё синхронизирует сессию", kind:"waiting" });
  if (activeSends) return response.status(409).json({error:"WhatsApp завершает предыдущую отправку",kind:"waiting"});
  activeSends+=1;
  activeSendStartedAt=Date.now();
  try {
    const claimed=await pool.query(`INSERT INTO whatsapp_send_receipts(delivery_id,session_key,destination_id,status)
      VALUES($1,$2,$3,'sending') ON CONFLICT DO NOTHING RETURNING delivery_id`,[deliveryId,sessionKey,destinationId]);
    if (!claimed.rowCount) { activeSends-=1;return response.status(409).json({error:"Отправка уже начата",kind:"ambiguous"}); }
  } catch(error) { activeSends-=1;throw error; }
  const sendGeneration=generation;
  const deadline=Date.now()+Math.max(1000,config.SEND_TIMEOUT_MS-15000);
  // Persist even a late result, after the caller has stopped waiting.
  const sending=(async()=>{
    try {
      const result=await sendMessage(destinationId);
      await pool.query("UPDATE whatsapp_send_receipts SET status='sent',message_id=$2,updated_at=now() WHERE delivery_id=$1",[deliveryId,result]);
      return result;
    } catch(error) {
      await pool.query("UPDATE whatsapp_send_receipts SET status='unknown',updated_at=now() WHERE delivery_id=$1",[deliveryId]);
      throw error;
    } finally { activeSends-=1; }
  })();
  try {
    const messageId=await withTimeout(sending,Math.max(1000,config.SEND_TIMEOUT_MS-15000),"отправка WhatsApp: результат требует проверки");
    response.json({messageId});
  } catch(error) {
    lastError=errorMessage(error);
    await pool.query("UPDATE whatsapp_send_receipts SET status='unknown',updated_at=now() WHERE delivery_id=$1 AND status='sending'",[deliveryId]);
    response.status(503).json({error:"Не удалось подтвердить отправку WhatsApp",details:lastError,kind:"ambiguous"});
  }
  async function sendMessage(destinationId: string) {
    await ensureUtilityInjection();
    const assertSending=()=>{if(closing||ownerSignal.aborted||generation!==sendGeneration||Date.now()>=deadline)throw Error('WhatsApp send interrupted; inspect durable outcome');};
    assertSending();
    if (attachments.length === 0) {
      const message = await client.sendMessage(destinationId, text, {waitUntilMsgSent:true});
      return sentMessageId(message);
    }
    if (text.length > 1000) sentMessageId(await client.sendMessage(destinationId, text, {waitUntilMsgSent:true}));
    const messageIds: string[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      if (generation !== sendGeneration || Date.now() >= deadline) throw new Error("Отправка вложений прервана; результат требует проверки");
      const attachment = attachments[index];
      const media=MessageMedia.fromFilePath(attachment.path);assertSending();
      const message = await client.sendMessage(destinationId, media, {
        waitUntilMsgSent:true,
        caption: index === 0 && text.length <= 1000 ? text : "",
        sendMediaAsDocument: !attachment.mimeType.startsWith("image/") && !attachment.mimeType.startsWith("video/"),
      });
      messageIds.push(sentMessageId(message));
    }
    return messageIds.join(",");
  }
});

function initialize() {
  const current=++generation;
  void client.initialize().catch((error) => {
    if (current !== generation || closing) return;
    state="disconnected"; lastError=errorMessage(error);
  });
}
initialize();
const watchdog=setInterval(()=>{
  if (closing || recovering) return;
  void (async()=>{
    const hungSend=activeSends > 0 && Date.now()-activeSendStartedAt >= config.SEND_TIMEOUT_MS*2;
    if (await probeClientReady() && !hungSend) return;
    if (closing || recovering || ["qr","auth_failure"].includes(state) || recoveryAttempts >= 3) return;
    if (activeSends && Date.now()-activeSendStartedAt < config.SEND_TIMEOUT_MS*2) return;
    if (!hungSend && Date.now()-lastHealthyAt < 180_000 * 2**recoveryAttempts) return;
    recovering=true; generation+=1; recoveryAttempts+=1;
    console.warn(`WhatsApp recovering connection (attempt ${recoveryAttempts}/3)`);
    try {
      await withTimeout(client.destroy().catch(()=>undefined),10_000,"закрытие WhatsApp");
      if (closing) return;
      state="starting"; authenticationConfirmed=false; qrDataUrl=null;
      lastError="Восстанавливаем подключение WhatsApp";
      lastHealthyAt=Date.now(); initialize();
    } catch(error) { lastError=errorMessage(error); }
    finally { recovering=false; }
  })().catch(error=>console.error("WhatsApp recovery failed",errorMessage(error)));
},15_000);
watchdog.unref();
return { app, accountId, sourceProof, privateProof, pollSource:(chatId:string)=>groupPoller.poll(accountId,chatId), poll:(id:string)=>privatePoller.poll(id), initialized: Promise.resolve(), close: async () => { closing=true;generation+=1;clearInterval(watchdog);if (readyProbeTimer) clearInterval(readyProbeTimer);await client.destroy().catch(() => undefined); } };
}
const stop=new AbortController();
process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
async function owned(signal:AbortSignal){
 signal.throwIfAborted();
 const heartbeat=await startSourceHeartbeat(pool,'whatsapp-reader',config.SOURCE_MONITOR_ENABLED&&config.AI_SEND_MODE==='live',signal);
 const app=express();
 app.use((request,response,next)=>{
  if(request.header('authorization')!==`Bearer ${config.WHATSAPP_BRIDGE_SECRET}`)return response.status(401).json({error:'Unauthorized'});
  if(signal.aborted)return response.status(503).json({error:'Owner stopped'});next();
 });
 app.use('/ai/leads',express.json({limit:'16kb'}));
 const sessions=new WhatsAppSessions(async()=>{
  const result=await pool.query("SELECT id,session_key FROM integrations WHERE platform='whatsapp' AND enabled ORDER BY created_at,id");
  return result.rows;
 },account=>createSession(account.session_key,account.id,signal));
 // The prior process may have died after submitting a message. Never retry it.
 await pool.query("UPDATE whatsapp_send_receipts SET status='unknown',updated_at=now() WHERE status='sending'");
 for(const action of (await pool.query("SELECT a.id,a.attempt_token FROM ai_outbox a JOIN ai_conversations v ON v.id=a.conversation_id WHERE v.platform='whatsapp' AND a.state='dispatching' AND a.attempt_token IS NOT NULL")).rows)await new AiManagerStore(pool).markInterrupted(action.id,action.attempt_token);
 signal.throwIfAborted();
 app.use(async(request,response,next)=>{
  if(request.header('authorization')!==`Bearer ${config.WHATSAPP_BRIDGE_SECRET}`)return response.status(401).json({error:'Unauthorized'});
  if(signal.aborted)return response.status(503).json({error:'Owner stopped'});
  if(request.method==='POST'&&/^\/ai\/leads\/[^/]+\/resolve$/.test(request.path)){
   try{
    if(config.AI_SEND_MODE!=='live')return response.status(409).json({error:'Live WhatsApp is disabled'});
    const leadId=z.string().uuid().parse(request.path.split('/')[3]),selectedAccount=z.string().uuid().optional().parse(request.body?.accountId);
    const scope={testOnly:config.AI_TEST_ONLY,accountIds:config.AI_TEST_ACCOUNT_IDS,authorIds:config.AI_TEST_AUTHOR_IDS};
    const getSession=async(id:string)=>{const row=(await pool.query("SELECT session_key FROM integrations WHERE id=$1 AND platform='whatsapp' AND enabled",[id])).rows[0];if(!row)throw Error('wa_account_unavailable');return sessions.get(row.session_key);};
    return response.json(await resolveWhatsAppSourceRoute(pool,{readSource:async(id,lead)=>(await getSession(id)).sourceProof(lead),resolveRecipient:async(id,source)=>(await getSession(id)).privateProof(source)},scope,{leadId,accountId:selectedAccount}));
   }catch{return response.status(503).json({error:'WhatsApp route awaits verification'});}
  }
  if(request.path==='/health')return response.json({ready:!signal.aborted,platform:'whatsapp'});
  const key=request.header('x-account-session');
  if(!key||!/^(legacy|[0-9a-f-]{36})$/.test(key))return response.status(400).json({error:'Нужен аккаунт'});
  try{const session=await sessions.get(key);if(signal.aborted)return response.status(503).json({error:'Owner stopped'});session.app(request,response,next);}
  catch(error){if(error instanceof Error&&error.message==='whatsapp_account_capacity')return response.status(409).json({error:'Доступно не более пяти одновременных аккаунтов WhatsApp'});
   if(error instanceof Error&&error.message==='whatsapp_account_disabled_or_missing')return response.status(404).json({error:'Аккаунт выключен или не найден'});next(error);}
 });
 app.use(((_error,_request,response,_next)=>response.status(503).json({error:'WhatsApp operation deferred; inspect durable outcome before retry'})) as express.ErrorRequestHandler);
 let polling:Promise<void>|undefined;
 const inboxTimer=setInterval(()=>{
  if(config.AI_SEND_MODE!=='live'||polling||signal.aborted)return;
  polling=(async()=>{
   const active=(await pool.query("SELECT v.id,v.account_id,i.session_key FROM ai_conversations v JOIN integrations i ON i.id=v.account_id WHERE v.platform='whatsapp' AND i.enabled AND v.active_phase_id IS NOT NULL ORDER BY coalesce((SELECT updated_at FROM ai_whatsapp_private_cursors WHERE conversation_id=v.id),'-infinity'::timestamptz),v.account_id,v.id LIMIT 100")).rows;
   await Promise.all([...new Set(active.map(v=>v.account_id))].map(async account=>{for(const v of active.filter(v=>v.account_id===account)){
    try{if(!await runtimeAllowsConversation(pool,{testOnly:config.AI_TEST_ONLY,accountIds:config.AI_TEST_ACCOUNT_IDS,authorIds:config.AI_TEST_AUTHOR_IDS},v.id))continue;await (await sessions.get(v.session_key)).poll(v.id);}catch{console.error('WhatsApp private sync deferred; cursor retained');}
   }}));
   for(const row of (await pool.query("SELECT DISTINCT a.id FROM ai_outbox a JOIN ai_whatsapp_send_intents i ON i.action_id=a.id WHERE a.state='unknown' AND i.server_ack>=1 LIMIT 100")).rows)await new WhatsAppAiReceipts(pool).reconcile(row.id);
  })().catch(()=>console.error('WhatsApp inbox iteration deferred')).finally(()=>{polling=undefined;});
 },5000);inboxTimer.unref();
 let groupWork:Promise<void>|undefined;
 const groupTimer=setInterval(()=>{
  if(!config.SOURCE_MONITOR_ENABLED||config.AI_SEND_MODE!=='live'||signal.aborted||groupWork)return;
  groupWork=(async()=>{
   const sources=(await pool.query("SELECT s.account_id,s.chat_id,i.session_key FROM ai_search_sources s JOIN integrations i ON i.id=s.account_id AND i.enabled JOIN ai_monitor_settings m ON m.id=1 AND m.mode<>'stopped' WHERE s.platform='whatsapp' ORDER BY s.account_id,s.chat_id LIMIT 5")).rows;
   await Promise.all([...new Set(sources.map(s=>s.account_id))].map(async account=>{for(const source of sources.filter(s=>s.account_id===account))try{await (await sessions.get(source.session_key)).pollSource(source.chat_id);}catch{if(!signal.aborted)console.error('WhatsApp source sync deferred; cursor retained');}}));
  })().catch(()=>console.error('WhatsApp group iteration deferred')).finally(()=>{groupWork=undefined;});
 },5000);groupTimer.unref();
 let refresh:Promise<void>|undefined;
 const cleanup=setInterval(()=>{if(!refresh&&!signal.aborted)refresh=sessions.refresh().catch(()=>console.error('WhatsApp session refresh deferred')).finally(()=>{refresh=undefined;});},5000);cleanup.unref();
 let server:ReturnType<typeof app.listen>|undefined;
 try{
  await sessions.restore();signal.throwIfAborted();
  server=app.listen(config.WHATSAPP_BRIDGE_PORT,config.WHATSAPP_BRIDGE_HOST,()=>console.log('WhatsApp session owner listening'));
  await new Promise<void>((resolve,reject)=>{
   server!.once('error',reject);
   const shutdown=()=>{void sessions.close();server!.close(error=>error?reject(error):resolve());};
   signal.addEventListener('abort',shutdown,{once:true});if(signal.aborted)shutdown();
  });
 }finally{clearInterval(cleanup);clearInterval(inboxTimer);clearInterval(groupTimer);server?.close();await refresh;await sessions.close();await polling;await groupWork;await heartbeat.close();}
}
async function main(){
 try{if(config.AI_SEND_MODE==='live'&&config.AI_TEST_ONLY&&(!config.AI_TEST_ACCOUNT_IDS.length||!config.AI_TEST_AUTHOR_IDS.length))throw Error('Test allowlists required');await withExecutionSlot(pool,'worker:whatsapp-sessions',owned,stop.signal);}
 catch{if(!stop.signal.aborted){console.error('WhatsApp session owner stopped');process.exitCode=1;}}
 finally{await pool.end();}
}
void main();
