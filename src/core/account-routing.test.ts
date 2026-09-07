import assert from "node:assert/strict";
import test from "node:test";
import { TelegramAdapter } from "./adapters/telegram.js";
import { WhatsAppAdapter } from "./adapters/whatsapp.js";

test("Telegram and WhatsApp route identical groups through isolated account sessions", async (t) => {
  const sessions: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    sessions.push(new Headers(init.headers).get("x-account-session") || "");
    return Response.json({ messageId: "mock-only" });
  });
  for (const Adapter of [TelegramAdapter, WhatsAppAdapter]) {
    await Promise.all(["account-a", "account-b"].map((key) =>
      new Adapter(key).send("same-group", { text: "test", attachments: [] }),
    ));
  }
  assert.deepEqual(sessions, ["account-a", "account-b", "account-a", "account-b"]);
});
