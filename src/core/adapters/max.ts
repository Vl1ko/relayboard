import { UMax } from "@ounezz/umax";
import type { MessengerAdapter, OutgoingMessage, SendResult } from "./types.js";

const clients = new Map<string, Promise<UMax>>();
const MAX_CONNECT_ATTEMPTS = 4;
const MAX_RETRY_DELAYS_MS = [250, 750, 1_500];

type ErrorWithCode = Error & { code?: string };

export function isMaxTransportError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = (error as ErrorWithCode).code;
  return ["CERT_HAS_EXPIRED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code || "")
    || /certificate has expired|WebSocket (?:is not connected|disconnected)|socket hang up/i.test(error.message);
}

function wait(delay: number) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function isConnected(client: UMax) {
  return Boolean((client as unknown as { ws?: { connected?: boolean } }).ws?.connected);
}

function forgetClient(token: string, client?: UMax) {
  clients.delete(token);
  client?.close();
}

function disableBulkSubscriptions(client: UMax) {
  // UMax 1.0.8 subscribes to every chat immediately after login. Accounts
  // with a larger dialog list are disconnected by MAX before the first send.
  // Individual chats are still subscribed when chats.get(...) is called.
  const chats = client.chats as unknown as { subscribe_all?: () => void };
  chats.subscribe_all = () => undefined;
}

async function createConnectedClient(token: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt += 1) {
    const client = new UMax(token);
    disableBulkSubscriptions(client);
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      client.close();
      if (!isMaxTransportError(error) || attempt === MAX_CONNECT_ATTEMPTS - 1) throw error;
      await wait(MAX_RETRY_DELAYS_MS[attempt] ?? MAX_RETRY_DELAYS_MS.at(-1) ?? 1_500);
    }
  }
  throw lastError;
}

async function getClient(token: string): Promise<UMax> {
  const current = clients.get(token);
  if (current) {
    const client = await current;
    if (isConnected(client)) return client;
    forgetClient(token, client);
  }
  const connection = (async () => {
    const client = await createConnectedClient(token);
    client.on("disconnected", () => {
      clients.delete(token);
    });
    return client;
  })();
  clients.set(token, connection);
  connection.catch(() => clients.delete(token));
  return connection;
}

async function withConnectedClient<T>(token: string, action: (client: UMax) => Promise<T>) {
  let client = await getClient(token);
  try {
    return await action(client);
  } catch (error) {
    if (!(error instanceof Error) || !/WebSocket (?:is not connected|disconnected)/i.test(error.message)) throw error;
    forgetClient(token, client);
    client = await getClient(token);
    return action(client);
  }
}

export async function listMaxGroups(token: string) {
  // Group discovery runs in the API process, while deliveries run in the
  // worker. MAX permits one active web socket per token, so retaining an API
  // client would disconnect the delivery worker. Use a short-lived session.
  const client = await createConnectedClient(token);
  try {
    return client.chats.list
      .filter((chat) => chat.type === "CHAT")
      .map((chat) => ({
        id: String(chat.id),
        title: chat.title,
        participantsCount: chat.participants_count,
      }))
      .sort((left, right) => left.title.localeCompare(right.title, "ru"));
  } finally {
    client.close();
  }
}

export class MaxAdapter implements MessengerAdapter {
  constructor(private readonly token: string) {}

  async send(destinationId: string, message: OutgoingMessage): Promise<SendResult> {
    return withConnectedClient(this.token, async (client) => {
      const chat = await client.chats.get(Number(destinationId));
      const sent = await chat.messages.send(message.text, {
        photos: message.attachments.filter((item) => item.mimeType.startsWith("image/")).map((item) => item.path),
        videos: message.attachments.filter((item) => item.mimeType.startsWith("video/")).map((item) => item.path),
        files: message.attachments.filter((item) => !item.mimeType.startsWith("image/") && !item.mimeType.startsWith("video/")).map((item) => item.path),
      });
      return { externalMessageId: String(sent.id) };
    });
  }
}
