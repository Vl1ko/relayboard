import express, { type RequestHandler } from "express";
import { rmSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import pkg from "whatsapp-web.js";
import { config } from "../core/config.js";

const { Client, LocalAuth, MessageMedia } = pkg;
const app = express();
app.use(express.json({ limit: "1mb" }));

let state: "starting" | "qr" | "ready" | "disconnected" | "auth_failure" = "starting";
let qrDataUrl: string | null = null;

const puppeteer: Record<string, unknown> = {
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
};
if (config.WHATSAPP_CHROMIUM_PATH) puppeteer.executablePath = config.WHATSAPP_CHROMIUM_PATH;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: config.WHATSAPP_SESSION_PATH, clientId: "relayboard" }),
  puppeteer,
});

const profilePath = join(config.WHATSAPP_SESSION_PATH, "session-relayboard");
for (const filename of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]) {
  rmSync(join(profilePath, filename), { force: true });
}

client.on("qr", async (qr) => {
  qrDataUrl = await QRCode.toDataURL(qr, { width: 360, margin: 2 });
  state = "qr";
  console.log("WhatsApp QR code refreshed");
});
client.on("ready", () => {
  state = "ready";
  qrDataUrl = null;
  console.log("WhatsApp client is ready");
});
client.on("authenticated", () => console.log("WhatsApp client authenticated"));
client.on("auth_failure", (message) => {
  state = "auth_failure";
  console.error("WhatsApp authentication failed", message);
});
client.on("disconnected", (reason) => {
  state = "disconnected";
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

app.get("/status", (_request, response) => {
  response.json({ status: state, qr: qrDataUrl });
});

app.get("/groups", async (_request, response) => {
  if (state !== "ready") return response.status(409).json({ error: "WhatsApp не подключён", status: state });
  const chats = await client.getChats();
  response.json(
    chats
      .filter((chat) => chat.isGroup)
      .map((chat) => ({ id: chat.id._serialized, title: chat.name, unreadCount: chat.unreadCount })),
  );
});

app.post("/send", async (request, response) => {
  if (state !== "ready") return response.status(409).json({ error: "WhatsApp не подключён" });
  const { destinationId, text, mediaUrl } = request.body as {
    destinationId?: string;
    text?: string;
    mediaUrl?: string;
  };
  if (!destinationId || !text) return response.status(400).json({ error: "destinationId и text обязательны" });

  const message = mediaUrl
    ? await client.sendMessage(destinationId, await MessageMedia.fromUrl(mediaUrl), { caption: text })
    : await client.sendMessage(destinationId, text);
  response.json({ messageId: message.id._serialized });
});

const port = 3010;
const server = app.listen(port, () => console.log(`WhatsApp bridge listening on http://localhost:${port}`));
client.initialize().catch((error) => {
  state = "auth_failure";
  console.error("WhatsApp initialization failed", error);
});

async function shutdown() {
  await client.destroy().catch(() => undefined);
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
