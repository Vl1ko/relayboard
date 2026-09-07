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

function sentMessageId(message: unknown) {
  const id = (message as { id?: { _serialized?: string; $1?: string } } | undefined)?.id;
  // Recent WhatsApp Web builds may complete sendMessage but omit the returned
  // model. Reaching this point still means the browser-side send resolved.
  return id?._serialized ?? id?.$1 ?? `accepted-${Date.now()}`;
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
  if (state === "ready") return true;
  if (!authenticationConfirmed) return false;
  if (readyProbe) return readyProbe;

  readyProbe = (async () => {
    try {
      // WhatsApp Web 2.3000.x can authenticate without emitting `ready`, and
      // full chat serialization can fail on one malformed/internal model.
      // Reading the minimal group fields directly verifies the exact feature
      // this bridge needs without serializing every chat and message.
      await ensureUtilityInjection();
      await readGroupsDirect();
      markReady("group collection");
      return true;
    } catch (error) {
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
  if (String(nextState) === "CONNECTED") markReady("change_state");
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
  response.json({ status: state, qr: qrDataUrl, error: lastError });
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
  if (!(await probeClientReady())) return response.status(409).json({ error: "WhatsApp ещё синхронизирует сессию" });
  const { destinationId, text = "", attachments = [] } = request.body as {
    destinationId?: string;
    text?: string;
    attachments?: Array<{ path: string; name: string; mimeType: string }>;
  };
  if (!destinationId || (!text.trim() && attachments.length === 0)) {
    return response.status(400).json({ error: "Нужны destinationId и текст или файл" });
  }
  try {
    await ensureUtilityInjection();
    if (attachments.length === 0) {
      const message = await client.sendMessage(destinationId, text);
      return response.json({ messageId: sentMessageId(message) });
    }
    if (text.length > 1000) await client.sendMessage(destinationId, text);
    const messageIds: string[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const message = await client.sendMessage(destinationId, MessageMedia.fromFilePath(attachment.path), {
        caption: index === 0 && text.length <= 1000 ? text : "",
        sendMediaAsDocument: !attachment.mimeType.startsWith("image/") && !attachment.mimeType.startsWith("video/"),
      });
      messageIds.push(sentMessageId(message));
    }
    response.json({ messageId: messageIds.join(",") });
  } catch (error) {
    lastError = errorMessage(error);
    response.status(503).json({ error: "Не удалось отправить сообщение в WhatsApp", details: lastError });
  }
});

const initialized = client.initialize().catch((error) => { state="auth_failure"; lastError=errorMessage(error); });
return { app, initialized: Promise.resolve(), close: async () => { if (readyProbeTimer) clearInterval(readyProbeTimer); await client.destroy().catch(() => undefined); } };
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
