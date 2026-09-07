import type { MessengerAdapter } from "./types.js";
import { config } from "../config.js";
import { FakeAdapter } from "./fake.js";
import { MaxAdapter } from "./max.js";
import { TelegramAdapter } from "./telegram.js";
import { WhatsAppAdapter } from "./whatsapp.js";

export function createAdapter(platform: string, credentials: Record<string, string>, sessionKey = ""): MessengerAdapter {
  if (config.MESSENGER_SEND_MODE === "fake") return new FakeAdapter();
  switch (platform) {
    case "telegram":
      return new TelegramAdapter(sessionKey);
    case "max":
      if (!credentials.token) throw new Error("Для MAX не указан токен личной web-сессии");
      return new MaxAdapter(credentials.token);
    case "whatsapp":
      return new WhatsAppAdapter(sessionKey);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
