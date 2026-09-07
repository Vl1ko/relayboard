import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ADMIN_API_KEY: z.string().min(12),
  APP_ENCRYPTION_KEY: z.string().min(16),
  WHATSAPP_BRIDGE_URL: z.string().url().default("http://localhost:3010"),
  WHATSAPP_BRIDGE_SECRET: z.string().min(12),
  WHATSAPP_SESSION_PATH: z.string().default("./data/whatsapp-session"),
  WHATSAPP_CHROMIUM_PATH: z.string().optional(),
  TELEGRAM_BRIDGE_URL: z.string().url().default("http://localhost:3020"),
  TELEGRAM_BRIDGE_SECRET: z.string().min(12),
  TELEGRAM_SESSION_PATH: z.string().default("./data/telegram-session.json"),
  TELEGRAM_API_ID: z.preprocess(
    (value) => value === "" || value === undefined ? undefined : value,
    z.coerce.number().int().positive().optional(),
  ),
  TELEGRAM_API_HASH: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().min(32).optional(),
  ),
});

export const config = schema.parse(process.env);
