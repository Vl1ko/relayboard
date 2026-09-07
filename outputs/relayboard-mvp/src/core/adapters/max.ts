import { UMax } from "@ounezz/umax";
import type { MessengerAdapter, OutgoingMessage, SendResult } from "./types.js";

const clients = new Map<string, Promise<UMax>>();

function getClient(token: string): Promise<UMax> {
  const current = clients.get(token);
  if (current) return current;
  const connection = (async () => {
    const client = new UMax(token);
    await client.connect();
    return client;
  })();
  clients.set(token, connection);
  connection.catch(() => clients.delete(token));
  return connection;
}

export async function listMaxGroups(token: string) {
  const client = await getClient(token);
  return client.chats.list
    .filter((chat) => chat.type === "CHAT")
    .map((chat) => ({
      id: String(chat.id),
      title: chat.title,
      participantsCount: chat.participants_count,
    }))
    .sort((left, right) => left.title.localeCompare(right.title, "ru"));
}

export class MaxAdapter implements MessengerAdapter {
  constructor(private readonly token: string) {}

  async send(destinationId: string, message: OutgoingMessage): Promise<SendResult> {
    const client = await getClient(this.token);
    const chat = await client.chats.get(Number(destinationId));
    const sent = await chat.messages.send(message.text, message.mediaUrl ? { photos: [message.mediaUrl] } : undefined);
    return { externalMessageId: String(sent.id) };
  }
}
