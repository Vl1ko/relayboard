import { config } from "../config.js";
import type { MessengerAdapter, OutgoingMessage, SendResult } from "./types.js";

export class WhatsAppAdapter implements MessengerAdapter {
  async send(destinationId: string, message: OutgoingMessage): Promise<SendResult> {
    const response = await fetch(`${config.WHATSAPP_BRIDGE_URL}/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.WHATSAPP_BRIDGE_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ destinationId, ...message }),
    });
    const body = await response.json() as { messageId?: string; error?: string };
    if (!response.ok) throw new Error(body.error || `WhatsApp bridge HTTP ${response.status}`);
    return { externalMessageId: body.messageId || "unknown" };
  }
}
