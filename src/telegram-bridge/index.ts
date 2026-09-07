import express, { type RequestHandler } from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import QRCode from "qrcode";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { config } from "../core/config.js";

type BridgeState = "starting" | "disconnected" | "qr" | "password_required" | "ready" | "auth_failure";
type SessionFile = { apiId?: number; apiHash?: string; session: string };
type RemoteDialog = { id: string; title: string; kind: "channel" | "group" };

import { pool } from "../core/db.js";
function createSession(sessionKey: string) {
const sessionPath = sessionKey === "legacy" ? config.TELEGRAM_SESSION_PATH : `${config.TELEGRAM_SESSION_PATH}.${sessionKey}.json`;
const app = express();
app.use(express.json({ limit: "1mb" }));

let state: BridgeState = "starting";
let lastError: string | null = null;
let client: TelegramClient | null = null;
let profile: { id: string; name: string; username: string | null } | null = null;
let resolvePassword: ((password: string) => void) | null = null;
let authentication: Promise<void> | null = null;
let qrDataUrl: string | null = null;
let qrExpiresAt: number | null = null;
let dialogCache: RemoteDialog[] = [];
let dialogsLoadedAt = 0;
let dialogRefresh: Promise<RemoteDialog[]> | null = null;
const dialogCachePath = `${sessionPath}.dialogs.json`;

function configuredCredentials() {
  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH) return null;
  return { apiId: config.TELEGRAM_API_ID, apiHash: config.TELEGRAM_API_HASH };
}

const requireBridgeSecret: RequestHandler = (request, response, next) => {
  if (request.header("authorization") !== `Bearer ${config.TELEGRAM_BRIDGE_SECRET}`) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};
app.use(requireBridgeSecret);

async function setReady(nextClient: TelegramClient) {
  const me = await nextClient.getMe();
  client = nextClient;
  profile = {
    id: String(me.id),
    name: [me.firstName, me.lastName].filter(Boolean).join(" ") || "Telegram account",
    username: me.username || null,
  };
  state = "ready";
  lastError = null;
  qrDataUrl = null;
  qrExpiresAt = null;
}

async function restoreSession() {
  try {
    const savedDialogs = JSON.parse(await readFile(dialogCachePath, "utf8").catch(() => "[]")) as RemoteDialog[];
    if (Array.isArray(savedDialogs) && savedDialogs.length > 0) {
      dialogCache = savedDialogs;
      dialogsLoadedAt = Date.now();
    }
    const saved = JSON.parse(await readFile(sessionPath, "utf8")) as SessionFile;
    const credentials = configuredCredentials() || (saved.apiId && saved.apiHash ? { apiId: saved.apiId, apiHash: saved.apiHash } : null);
    if (!credentials) throw new Error("TELEGRAM_API_ID и TELEGRAM_API_HASH не настроены на сервере");
    const restored = new TelegramClient(new StringSession(saved.session), credentials.apiId, credentials.apiHash, { connectionRetries: 5 });
    await restored.connect();
    if (!(await restored.checkAuthorization())) throw new Error("Сессия Telegram истекла");
    await setReady(restored);
  } catch (error) {
    state = "disconnected";
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") lastError = error instanceof Error ? error.message : String(error);
  }
}

async function loadDialogs(forceRefresh = false) {
  if (!client) throw new Error("Telegram не подключён");
  if (!forceRefresh && dialogCache.length > 0 && Date.now() - dialogsLoadedAt < 5 * 60 * 1000) return dialogCache;
  if (dialogRefresh) return dialogRefresh;

  dialogRefresh = (async () => {
    // Without an explicit limit Teleproto paginates through every folder,
    // including Telegram's archive. A fixed limit hid older/less active groups.
    const dialogs = await client!.getDialogs({ limit: undefined });
    const result = dialogs
      .filter((dialog) => dialog.isGroup || dialog.isChannel)
      .map((dialog): RemoteDialog => ({
        id: String(dialog.id),
        title: dialog.title || String(dialog.id),
        kind: dialog.isChannel ? "channel" : "group",
      }));
    dialogCache = result;
    dialogsLoadedAt = Date.now();
    await mkdir(dirname(dialogCachePath), { recursive: true });
    await writeFile(dialogCachePath, JSON.stringify(result), { mode: 0o600 });
    return result;
  })().finally(() => {
    dialogRefresh = null;
  });
  return dialogRefresh;
}

app.get("/status", (_request, response) => {
  response.json({ status: state, profile, error: lastError, qr: qrDataUrl, qrExpiresAt, configured: Boolean(configuredCredentials()) });
});

app.post("/auth/qr", async (request, response) => {
  const envCredentials = configuredCredentials();
  const { apiId, apiHash } = request.body as { apiId?: number | string; apiHash?: string };
  const numericApiId = Number(apiId);
  const enteredCredentials = Number.isInteger(numericApiId) && numericApiId > 0 && apiHash?.trim()
    ? { apiId: numericApiId, apiHash: apiHash.trim() }
    : null;
  const credentials = envCredentials || enteredCredentials;
  if (!credentials) return response.status(400).json({ error: "Введите API ID и API Hash Telegram" });
  if (authentication) return response.status(409).json({ error: "Авторизация уже выполняется", status: state });

  state = "starting";
  lastError = null;
  profile = null;
  qrDataUrl = null;
  qrExpiresAt = null;
  const nextClient = new TelegramClient(new StringSession(""), credentials.apiId, credentials.apiHash, { connectionRetries: 5 });
  authentication = (async () => {
    try {
      await nextClient.connect();
      await nextClient.signInUserWithQrCode(credentials, {
        qrCode: async ({ token, expires }) => {
          const loginUrl = `tg://login?token=${token.toString("base64url")}`;
          qrDataUrl = await QRCode.toDataURL(loginUrl, { width: 360, margin: 2 });
          qrExpiresAt = expires * 1000;
          state = "qr";
        },
        password: async () => {
          state = "password_required";
          return new Promise<string>((resolve) => { resolvePassword = resolve; });
        },
        onError: async (error) => {
          lastError = error.message;
          return true;
        },
      });
      await setReady(nextClient);
      await mkdir(dirname(sessionPath), { recursive: true });
      await writeFile(
        sessionPath,
        JSON.stringify(envCredentials
          ? { session: nextClient.session.save() }
          : { apiId: credentials.apiId, apiHash: credentials.apiHash, session: nextClient.session.save() }),
        { mode: 0o600 },
      );
    } catch (error) {
      state = "auth_failure";
      lastError = error instanceof Error ? error.message : String(error);
      await nextClient.disconnect().catch(() => undefined);
    } finally {
      authentication = null;
      resolvePassword = null;
    }
  })();
  response.status(202).json({ status: state });
});

app.post("/auth/password", (request, response) => {
  const password = String(request.body?.password || "");
  if (!resolvePassword || !password) return response.status(409).json({ error: "Пароль 2FA сейчас не ожидается", status: state });
  const resolve = resolvePassword;
  resolvePassword = null;
  resolve(password);
  response.status(202).json({ status: "verifying" });
});

app.get("/dialogs", async (_request, response) => {
  if (state !== "ready" || !client) return response.status(409).json({ error: "Telegram не подключён", status: state });
  // An explicit group-list request must include newly created groups immediately.
  // Concurrent requests still share dialogRefresh to avoid duplicate API calls.
  response.json(await loadDialogs(true));
});

app.post("/send", async (request, response) => {
  if (state !== "ready" || !client) return response.status(409).json({ error: "Telegram не подключён" });
  const { destinationId, text = "", attachments = [] } = request.body as {
    destinationId?: string;
    text?: string;
    attachments?: Array<{ path: string; name: string; mimeType: string }>;
  };
  if (!destinationId || (!text.trim() && attachments.length === 0)) {
    return response.status(400).json({ error: "Нужны destinationId и текст или файл" });
  }
  if (attachments.length === 0) {
    const sent = await client.sendMessage(destinationId, { message: text });
    return response.json({ messageId: String(sent.id) });
  }
  if (text.length > 1000) await client.sendMessage(destinationId, { message: text });
  const messageIds: string[] = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const sent = await client.sendFile(destinationId, {
      file: attachment.path,
      caption: index === 0 && text.length <= 1000 ? text : "",
      forceDocument: !attachment.mimeType.startsWith("image/") && !attachment.mimeType.startsWith("video/"),
    });
    messageIds.push(String(sent.id));
  }
  response.json({ messageId: messageIds.join(",") });
});

const initialized = restoreSession();
return { app, initialized, close: async () => { await client?.disconnect().catch(() => undefined); } };
}
const app = express();
const sessions = new Map<string, ReturnType<typeof createSession>>();
app.use(async (request, response, next) => {
  if (request.header("authorization") !== `Bearer ${config.TELEGRAM_BRIDGE_SECRET}`) return response.status(401).json({error:"Unauthorized"});
  const key = request.header("x-account-session");
  if (!key || !/^(legacy|[0-9a-f-]{36})$/.test(key)) return response.status(400).json({error:"Нужен аккаунт"});
  try {
    const account = await pool.query("SELECT id FROM integrations WHERE platform=$1 AND session_key=$2", ["telegram", key]);
    if (!account.rowCount) return response.status(404).json({error:"Аккаунт не найден"});
    let session = sessions.get(key);
    if (!session) { session = createSession(key); sessions.set(key, session); }
    await session.initialized;
    session.app(request, response, next);
  } catch (error) { next(error); }
});
// Restore saved accounts before accepting deliveries after a restart.
const existing = await pool.query("SELECT session_key FROM integrations WHERE platform=$1", ["telegram"]);
for (const row of existing.rows) sessions.set(row.session_key, createSession(row.session_key));
const cleanup = setInterval(() => {
  void pool.query("SELECT session_key FROM integrations WHERE platform=$1", ["telegram"]).then(async result => {
    const keys = new Set(result.rows.map(row => row.session_key));
    for (const [key, session] of sessions) if (!keys.has(key)) { sessions.delete(key); await session.close(); }
  }).catch(error => console.error("Session cleanup failed", error.message));
}, 30000);
cleanup.unref();
const server = app.listen(3020);
async function shutdown() {
  clearInterval(cleanup);
  server.close();
  await Promise.all([...sessions.values()].map(session => session.close()));
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
