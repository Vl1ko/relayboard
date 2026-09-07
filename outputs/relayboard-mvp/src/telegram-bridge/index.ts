import express, { type RequestHandler } from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import QRCode from "qrcode";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { config } from "../core/config.js";

type BridgeState = "starting" | "disconnected" | "qr" | "password_required" | "ready" | "auth_failure";
type SessionFile = { apiId?: number; apiHash?: string; session: string };

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
    const saved = JSON.parse(await readFile(config.TELEGRAM_SESSION_PATH, "utf8")) as SessionFile;
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
      await mkdir(dirname(config.TELEGRAM_SESSION_PATH), { recursive: true });
      await writeFile(
        config.TELEGRAM_SESSION_PATH,
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
  const dialogs = await client.getDialogs({ limit: 200 });
  response.json(dialogs
    .filter((dialog) => dialog.isGroup || dialog.isChannel)
    .map((dialog) => ({ id: String(dialog.id), title: dialog.title || String(dialog.id), kind: dialog.isChannel ? "channel" : "group" })));
});

app.post("/send", async (request, response) => {
  if (state !== "ready" || !client) return response.status(409).json({ error: "Telegram не подключён" });
  const { destinationId, text, mediaUrl } = request.body as { destinationId?: string; text?: string; mediaUrl?: string };
  if (!destinationId || !text) return response.status(400).json({ error: "destinationId и text обязательны" });
  const sent = await client.sendMessage(destinationId, mediaUrl ? { message: text, file: mediaUrl } : { message: text });
  response.json({ messageId: String(sent.id) });
});

const port = 3020;
const server = app.listen(port, () => console.log(`Telegram user bridge listening on http://localhost:${port}`));
restoreSession().catch((error) => {
  state = "auth_failure";
  lastError = error instanceof Error ? error.message : String(error);
});

async function shutdown() {
  await client?.disconnect().catch(() => undefined);
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
