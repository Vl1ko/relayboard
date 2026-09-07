import type { MessengerAdapter, OutgoingMessage, SendResult } from "./types.js";

export class VkAdapter implements MessengerAdapter {
  constructor(
    private readonly token: string,
    private readonly apiVersion = "5.199",
  ) {}

  async send(destinationId: string, message: OutgoingMessage): Promise<SendResult> {
    const params = new URLSearchParams({
      access_token: this.token,
      v: this.apiVersion,
      peer_id: destinationId,
      random_id: String(Math.floor(Math.random() * 2_000_000_000)),
      message: message.mediaUrl ? `${message.text}\n\n${message.mediaUrl}` : message.text,
    });
    const response = await fetch("https://api.vk.com/method/messages.send", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const body = await response.json() as { response?: number; error?: { error_msg?: string } };
    if (!response.ok || body.error) throw new Error(body.error?.error_msg || `VK HTTP ${response.status}`);
    return { externalMessageId: String(body.response ?? "unknown") };
  }
}
