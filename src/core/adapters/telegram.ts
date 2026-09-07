import { config } from "../config.js";
import type { MessengerAdapter, OutgoingMessage, SendResult } from "./types.js";

export class TelegramAdapter implements MessengerAdapter {
  constructor(private readonly sessionKey: string) {}
  async send(destinationId: string, message: OutgoingMessage): Promise<SendResult> {
    const response = await fetch(`${config.TELEGRAM_BRIDGE_URL}/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.TELEGRAM_BRIDGE_SECRET}`,
        "content-type": "application/json",
        "x-account-session": this.sessionKey,
      },
      body: JSON.stringify({ destinationId, ...message }),
    });
    const body = await response.json() as { messageId?: string; error?: string };
    if (!response.ok) throw new Error(body.error || `Telegram bridge HTTP ${response.status}`);
    return { externalMessageId: body.messageId || "unknown" };
  }
}
