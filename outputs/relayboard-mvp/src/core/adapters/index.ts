import type { MessengerAdapter } from "./types.js";
import { MaxAdapter } from "./max.js";
import { TelegramAdapter } from "./telegram.js";
import { VkAdapter } from "./vk.js";
import { WhatsAppAdapter } from "./whatsapp.js";

export function createAdapter(platform: string, credentials: Record<string, string>): MessengerAdapter {
  switch (platform) {
    case "telegram":
      return new TelegramAdapter();
    case "max":
      if (!credentials.token) throw new Error("Для MAX не указан токен личной web-сессии");
      return new MaxAdapter(credentials.token);
    case "vk":
      if (!credentials.token) throw new Error("Для VK не указан пользовательский access token");
      return new VkAdapter(credentials.token, credentials.apiVersion);
    case "whatsapp":
      return new WhatsAppAdapter();
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
