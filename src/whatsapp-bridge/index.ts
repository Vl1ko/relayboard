import { sentMessageId } from "../core/whatsapp-receipt.js";
import express, { type RequestHandler } from "express";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
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
function createSession(sessionKey: string) {
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

const profilePath = join(sessionPath, "session-relayboard");
for (const filename of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]) {
  rmSync(join(profilePath, filename), { force: true });
}

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
    if (attachments.length === 0) {
      const message = await client.sendMessage(destinationId, text);
      return sentMessageId(message);
    }
    if (text.length > 1000) sentMessageId(await client.sendMessage(destinationId, text));
    const messageIds: string[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      if (generation !== sendGeneration || Date.now() >= deadline) throw new Error("Отправка вложений прервана; результат требует проверки");
      const attachment = attachments[index];
      const message = await client.sendMessage(destinationId, MessageMedia.fromFilePath(attachment.path), {
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
return { app, initialized: Promise.resolve(), close: async () => { closing=true;generation+=1;clearInterval(watchdog);if (readyProbeTimer) clearInterval(readyProbeTimer);await client.destroy().catch(() => undefined); } };
}
const app = express();
const sessions = new Map<string, ReturnType<typeof createSession>>();
app.use(async (request, response, next) => {
  if (request.header("authorization") !== `Bearer ${config.WHATSAPP_BRIDGE_SECRET}`) return response.status(401).json({error:"Unauthorized"});
  const key = request.header("x-account-session");
  if (!key || !/^(legacy|[0-9a-f-]{36})$/.test(key)) return response.status(400).json({error:"Нужен аккаунт"});
  try {
    const account = await pool.query("SELECT id FROM integrations WHERE platform=$1 AND session_key=$2", ["whatsapp", key]);
    if (!account.rowCount) return response.status(404).json({error:"Аккаунт не найден"});
    let session = sessions.get(key);
    if (!session) { session = createSession(key); sessions.set(key, session); }
    await session.initialized;
    session.app(request, response, next);
  } catch (error) { next(error); }
});
// Restore saved accounts before accepting deliveries after a restart.
const existing = await pool.query("SELECT session_key FROM integrations WHERE platform=$1", ["whatsapp"]);
for (const row of existing.rows) sessions.set(row.session_key, createSession(row.session_key));
const cleanup = setInterval(() => {
  void pool.query("SELECT session_key FROM integrations WHERE platform=$1", ["whatsapp"]).then(async result => {
    const keys = new Set(result.rows.map(row => row.session_key));
    for (const [key, session] of sessions) if (!keys.has(key)) { sessions.delete(key); await session.close(); }
  }).catch(error => console.error("Session cleanup failed", error.message));
}, 30000);
cleanup.unref();
const server = app.listen(3010);
async function shutdown() {
  clearInterval(cleanup);
  server.close();
  await Promise.all([...sessions.values()].map(session => session.close()));
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
