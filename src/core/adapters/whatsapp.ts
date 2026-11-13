import { config } from "../config.js";
import { DeliveryError } from "../delivery-policy.js";
import type { MessengerAdapter, OutgoingMessage, SendResult } from "./types.js";

export class WhatsAppAdapter implements MessengerAdapter {
  constructor(private readonly sessionKey: string) {}
  async send(destinationId: string, message: OutgoingMessage): Promise<SendResult> {
    // This request cannot send a message. Failure here is safe to defer.
    let ready: boolean;
    try {
      const status = await fetch(`${config.WHATSAPP_BRIDGE_URL}/status`, {
        headers: { authorization: `Bearer ${config.WHATSAPP_BRIDGE_SECRET}`, "x-account-session": this.sessionKey },
        signal: AbortSignal.timeout(8000),
      });
      const body = await status.json() as { status?: string; error?: string };
      if (["qr", "auth_failure"].includes(body.status || "")) throw new DeliveryError("WhatsApp: нужно заново подключить устройство через QR", "auth_required");
      ready = status.ok && body.status === "ready";
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw new DeliveryError("WhatsApp временно недоступен; отправка ожидает подключения", "waiting");
    }
    if (!ready) throw new DeliveryError("WhatsApp синхронизирует сессию; отправка ожидает готовности", "waiting");
    try {
    const response = await fetch(`${config.WHATSAPP_BRIDGE_URL}/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.WHATSAPP_BRIDGE_SECRET}`,
        "content-type": "application/json",
        "x-account-session": this.sessionKey,
      },
      body: JSON.stringify({ destinationId, ...message }),
      signal: AbortSignal.timeout(config.SEND_TIMEOUT_MS),
    });
    const body = await response.json() as { messageId?: string; error?: string; details?: string; kind?: string };
    if (!response.ok) throw new DeliveryError([body.error || `WhatsApp bridge HTTP ${response.status}`, body.details].filter(Boolean).join(": "),
      body.kind === "waiting" ? "waiting" : body.kind === "auth_required" ? "auth_required" : "ambiguous");
    if (typeof body.messageId !== "string" || !body.messageId.trim()) throw new DeliveryError("WhatsApp не вернул подтверждение отправки; результат требует проверки", "ambiguous");
    return { externalMessageId: body.messageId };
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw new DeliveryError("Соединение прервано после начала отправки WhatsApp; результат требует проверки", "ambiguous");
    }
  }
}
