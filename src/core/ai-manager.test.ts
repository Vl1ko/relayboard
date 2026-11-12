import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import pg from "pg";
import { AiManagerStore, AiStateError, type PreparedChannelSend } from "./ai-manager.js";
import { applyAiManagerMigration } from "./ai-manager-migration.js";

const url = process.env.AI_MANAGER_TEST_DATABASE_URL;
const skip = !url;
let pool: pg.Pool;
let store: AiManagerStore;
let schema: string;

before(async () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("/relayboard_ai_manager_test")) throw new Error("Dedicated relayboard_ai_manager_test database required");
  schema = "ai_test_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  try { await admin.query("CREATE SCHEMA " + schema); } finally { await admin.end(); }
  pool = new pg.Pool({ connectionString: url, options: "-c search_path=" + schema + ",public" });
  await pool.query(await readFile(new URL("../../database/schema.sql", import.meta.url), "utf8"));
  assert.deepEqual(await applyAiManagerMigration(pool), { version: 2, applied: true });
  store = new AiManagerStore(pool);
});
beforeEach(async () => { if (pool) await pool.query("TRUNCATE ai_contacts,integrations CASCADE"); });
after(async () => {
  if (!pool) return;
  await pool.query("DROP SCHEMA " + schema + " CASCADE"); await pool.end();
});

const code = (expected: string) => (error: unknown) => error instanceof AiStateError && error.code === expected;
async function fixture(platform = "max", contactId?: string) {
  const account = (await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES ($1,'synthetic','not-a-real-secret') RETURNING id", [platform])).rows[0].id;
  const contact = contactId ? { id: contactId } : await store.createContact("synthetic");
  const conversation = await store.createConversation({ contactId: contact.id, accountId: account, externalId: "same-dialog" });
  const active = await store.setMode(conversation.id, "auto");
  return { account, contact: contact.id, conversation: conversation.id, epoch: active.automation_epoch as string, platform };
}
function event(f: Awaited<ReturnType<typeof fixture>>, origin = "customer", messageId = "message") {
  return { version: 1, platform: f.platform, accountId: f.account, conversationId: "same-dialog", messageId,
    occurredAt: "2026-11-12T10:00:00Z", direction: origin === "customer" ? "inbound" : "outbound", origin, text: "synthetic" };
}
async function enqueue(f: Awaited<ReturnType<typeof fixture>>, key = "request-1", kind: "first_message" | "reply" | "follow_up" = "first_message") {
  return (await store.enqueue({ conversationId: f.conversation, expectedEpoch: f.epoch, logicalKey: key, kind, text: "synthetic reply" })).action;
}
async function action(id: string) { return (await pool.query("SELECT * FROM ai_outbox WHERE id=$1", [id])).rows[0]; }
type SyntheticStart = (input: { operationId: string; text: string; conversationId: string }) => Promise<unknown>;
async function preparedFor(id: string, start: SyntheticStart): Promise<PreparedChannelSend> {
  const row = (await pool.query("SELECT c.account_id,c.external_id,c.platform FROM ai_outbox a JOIN ai_conversations c ON c.id=a.conversation_id WHERE a.id=$1", [id])).rows[0];
  return { target: { accountId: row.account_id, externalConversationId: row.external_id, platform: row.platform },
    start: input => ({ acknowledgement: start(input) }) };
}
async function dispatch(id: string, start: SyntheticStart) { return store.dispatch(id, await preparedFor(id, start)); }
function confirmation(input: { operationId: string }) {
  return Promise.resolve({ operationId: input.operationId, outcome: "confirmed", code: "sent", externalMessageId: "external", retryCondition: "never" });
}

test("migration repeats without changing existing data or deleting legacy tables", { skip }, async () => {
  const old = await fixture();
  assert.deepEqual(await applyAiManagerMigration(pool), { version: 2, applied: false });
  assert.equal((await pool.query("SELECT name FROM integrations WHERE id=$1", [old.account])).rows[0].name, "synthetic");
  assert.ok((await pool.query("SELECT to_regclass('posts') AS name")).rows[0].name);
});

test("five concurrent copies persist one inbox event and apply one generation change", { skip }, async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 5 }, () => store.ingest(event(f))));
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_inbox")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT automation_epoch FROM ai_conversations WHERE id=$1", [f.conversation])).rows[0].automation_epoch, String(Number(f.epoch) + 1));
  const replay = await store.ingest({ ...event(f), text: "changed replay" });
  assert.equal(replay.event.text, "synthetic");
});

test("events isolate accounts/platforms and never create automatic identity links", { skip }, async () => {
  const a = await fixture(), b = await fixture("whatsapp");
  await Promise.all([store.ingest(event(a)), store.ingest(event(b))]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_inbox")).rows[0].n, 2);
  await assert.rejects(store.ingest({ ...event(a), platform: "whatsapp" }), code("account_platform_mismatch"));
  await assert.rejects(store.createConversation({ contactId: b.contact, accountId: a.account, externalId: "same-dialog" }), code("identity_link_conflict"));
});

test("service echo does not take over; native human stops pending actions", { skip }, async () => {
  const f = await fixture(); const out = await enqueue(f);
  await store.ingest(event(f, "service"));
  assert.equal((await action(out.id)).state, "pending");
  await store.ingest(event(f, "human", "native-human"));
  const conversation = (await pool.query("SELECT * FROM ai_conversations WHERE id=$1", [f.conversation])).rows[0];
  assert.equal(conversation.automation_mode, "manual"); assert.equal(conversation.business_status, "manager_working");
  assert.equal((await action(out.id)).state, "cancelled");
  await store.ingest(event(f, "service", "late-echo"));
  assert.equal((await pool.query("SELECT automation_mode FROM ai_conversations WHERE id=$1", [f.conversation])).rows[0].automation_mode, "manual");
});

test("unresolved provenance pauses; incoming customer invalidates stale LLM/follow-ups", { skip }, async () => {
  const f = await fixture(); const out = await enqueue(f, "follow", "follow_up");
  await store.ingest(event(f));
  assert.equal((await action(out.id)).state, "cancelled");
  await assert.rejects(enqueue(f, "stale-draft", "reply"), code("stale_generation"));
  await store.ingest(event(f, "unresolved", "uncorrelated-own"));
  assert.equal((await pool.query("SELECT automation_mode FROM ai_conversations WHERE id=$1", [f.conversation])).rows[0].automation_mode, "paused");
});

test("opt-out persists across store restart and blocks all explicitly linked channels", { skip }, async () => {
  const a = await fixture(), b = await fixture("whatsapp", a.contact);
  const first = await enqueue(a), second = await enqueue(b, "other");
  await store.optOut(a.contact, "explicit-stop");
  store = new AiManagerStore(pool);
  assert.equal((await action(first.id)).state, "cancelled"); assert.equal((await action(second.id)).state, "cancelled");
  await assert.rejects(store.setMode(b.conversation, "auto"), code("automation_forbidden"));
  const c = await fixture("max", a.contact).then(() => null, error => error);
  assert.ok(c instanceof AiStateError);
  assert.equal((await store.enqueue({ conversationId: a.conversation, expectedEpoch: a.epoch, logicalKey: "request-1", kind: "first_message", text: "synthetic reply" })).created, false);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_outbox")).rows[0].n, 2);
});

test("concurrent/cross-channel enqueue has one durable action and rejects payload-key reuse", { skip }, async () => {
  const a = await fixture(), b = await fixture("whatsapp", a.contact);
  const results = await Promise.all([enqueue(a), enqueue(a), enqueue(b), enqueue(b), enqueue(a)]);
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  await assert.rejects(store.enqueue({ conversationId: a.conversation, expectedEpoch: a.epoch, logicalKey: "request-1", kind: "first_message", text: "different content" }), code("idempotency_payload_conflict"));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_outbox")).rows[0].n, 1);
});

test("new conversations default paused and require explicit auto command", { skip }, async () => {
  const f = await fixture();
  const row = await store.createConversation({ contactId: f.contact, accountId: f.account, externalId: "new-dialog" });
  assert.equal(row.automation_mode, "paused");
  await assert.rejects(store.enqueue({ conversationId: row.id, expectedEpoch: "0", logicalKey: "new", kind: "reply", text: "hello" }), code("automation_forbidden"));
});

test("repeated resume does not invalidate newly queued work or change generation", { skip }, async () => {
  const f = await fixture(), out = await enqueue(f);
  const repeated = await store.setMode(f.conversation, "auto");
  assert.equal(repeated.automation_epoch, f.epoch);
  assert.equal((await action(out.id)).state, "pending");
  const manual = await store.setMode(f.conversation, "manual");
  assert.equal((await store.setMode(f.conversation, "manual")).automation_epoch, manual.automation_epoch);
  assert.equal((await store.setMode(f.conversation, "auto")).business_status, "ai_dialog");
});

test("five dispatch contenders invoke sender once; confirmed action is never replayed", { skip }, async () => {
  const f = await fixture(), out = await enqueue(f); let calls = 0;
  await Promise.all(Array.from({ length: 5 }, () => dispatch(out.id, input => { calls++; return confirmation(input); })));
  assert.equal(calls, 1); assert.equal((await action(out.id)).state, "confirmed");
  await dispatch(out.id, input => { calls++; return confirmation(input); }); assert.equal(calls, 1);
});

test("a prepared transport bound to another account/recipient is rejected before claim", { skip }, async () => {
  const a = await fixture(), b = await fixture("whatsapp");
  const out = await enqueue(a), wrong = await enqueue(b); let calls = 0;
  await assert.rejects(store.dispatch(out.id, await preparedFor(wrong.id, input => { calls++; return confirmation(input); })), code("prepared_target_mismatch"));
  assert.equal(calls, 0); assert.equal((await action(out.id)).state, "pending");
});

test("committed stop and stale generation prevent sender invocation", { skip }, async () => {
  const f = await fixture(), out = await enqueue(f); let calls = 0;
  await store.optOut(f.contact, "stop");
  assert.deepEqual(await dispatch(out.id, input => { calls++; return confirmation(input); }), { initiated: false });
  assert.equal(calls, 0);
});

test("account auth loss waits without destroying an unsent action", { skip }, async () => {
  const f = await fixture(), out = await enqueue(f); let calls = 0;
  await pool.query("UPDATE integrations SET auth_error='synthetic expired' WHERE id=$1", [f.account]);
  await dispatch(out.id, input => { calls++; return confirmation(input); });
  assert.equal(calls, 0); assert.equal((await action(out.id)).state, "pending");
  await pool.query("UPDATE integrations SET auth_error=NULL WHERE id=$1", [f.account]);
  await dispatch(out.id, input => { calls++; return confirmation(input); });
  assert.equal(calls, 1); assert.equal((await action(out.id)).state, "confirmed");
});

test("sender failure or an invalid acknowledgement becomes unknown without automatic replay", { skip }, async () => {
  const f = await fixture();
  for (const [key, sender] of [
    ["throw", async () => { throw new Error("lost response"); }],
    ["invalid", async () => ({ operationId: randomUUID(), outcome: "confirmed" })],
    ["unknown", async (input: { operationId: string }) => ({ ...input, outcome: "unknown", code: "timeout", retryCondition: "reconcile_or_manual_review" })],
  ] as const) {
    const out = await enqueue(f, key); let calls = 0;
    await dispatch(out.id, input => { calls++; return sender(input); });
    assert.equal((await action(out.id)).state, "unknown");
    await new AiManagerStore(pool).dispatch(out.id, await preparedFor(out.id, input => { calls++; return confirmation(input); }));
    assert.equal(calls, 1);
  }
});

test("response wait does not lock out cancellation; a late confirmation stays factual", { skip }, async () => {
  const f = await fixture(), out = await enqueue(f);
  let entered!: () => void, resolve!: (value: unknown) => void;
  const started = new Promise<void>(r => { entered = r; });
  const response = new Promise(r => { resolve = r; });
  const pending = dispatch(out.id, () => { entered(); return response; });
  await started;
  await store.optOut(f.contact, "stop-during-send");
  assert.equal((await action(out.id)).cancellation_requested, true);
  resolve(await confirmation({ operationId: out.id }));
  await pending;
  assert.equal((await action(out.id)).state, "confirmed");
  await assert.rejects(store.setMode(f.conversation, "auto"), code("automation_forbidden"));
});

test("interrupted attempts become unknown, never pending; late rejection cannot erase uncertainty", { skip }, async () => {
  const f = await fixture(), out = await enqueue(f);
  let entered!: () => void, resolve!: (value: unknown) => void;
  const started = new Promise<void>(r => { entered = r; });
  const response = new Promise(r => { resolve = r; });
  const pending = dispatch(out.id, () => { entered(); return response; }); await started;
  const current = await action(out.id);
  assert.equal(await store.markInterrupted(out.id, randomUUID()), false);
  assert.equal(await store.markInterrupted(out.id, current.attempt_token), true);
  resolve({ operationId: out.id, outcome: "rejected", code: "auth", dispatchState: "not_started", retryCondition: "refresh_auth" });
  await pending;
  assert.equal((await action(out.id)).state, "unknown");
  assert.deepEqual(await dispatch(out.id, confirmation), { initiated: false });
});

test("migration checksum mismatch is not silently accepted", { skip }, async () => {
  const before = (await pool.query("SELECT checksum FROM ai_schema_migrations WHERE version=1")).rows[0].checksum;
  await pool.query("UPDATE ai_schema_migrations SET checksum='changed' WHERE version=1");
  try { await assert.rejects(applyAiManagerMigration(pool), /checksum mismatch/); }
  finally { await pool.query("UPDATE ai_schema_migrations SET checksum=$1 WHERE version=1", [before]); }
});

test("legacy account deletion still works and preserves AI history without sending from missing account", { skip }, async () => {
  const f = await fixture(), out = await enqueue(f); await store.ingest(event(f, "service"));
  await pool.query("DELETE FROM integrations WHERE id=$1", [f.account]);
  const preserved = (await pool.query("SELECT platform,account_id FROM ai_conversations WHERE id=$1", [f.conversation])).rows[0];
  assert.equal(preserved.platform, "max"); assert.equal(preserved.account_id, f.account);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_inbox")).rows[0].n, 1);
  let calls = 0;
  await dispatch(out.id, input => { calls++; return confirmation(input); });
  assert.equal(calls, 0); assert.equal((await action(out.id)).state, "cancelled");
});

test("preparation that finishes after opt-out cannot initiate a request", { skip }, async () => {
  const f = await fixture(), out = await enqueue(f);
  let ready!: () => void;
  const barrier = new Promise<void>(r => { ready = r; });
  let calls = 0;
  const preparation = (async () => {
    await barrier; // connect, load media and construct the request OUTSIDE the final guard.
    return preparedFor(out.id, input => { calls++; return confirmation(input); });
  })();
  await store.optOut(f.contact, "stop-before-ready"); ready();
  assert.deepEqual(await store.dispatch(out.id, await preparation), { initiated: false });
  assert.equal(calls, 0);
});

test("an async start callback is rejected before it can start deferred preparation/send", { skip }, async () => {
  const f = await fixture(), out = await enqueue(f); let calls = 0;
  const unsafe = { start: async () => { await Promise.resolve(); calls++; return confirmation({ operationId: out.id }); } };
  await assert.rejects(store.dispatch(out.id, unsafe as unknown as PreparedChannelSend), code("sender_must_be_prepared"));
  assert.equal(calls, 0); assert.equal((await action(out.id)).state, "pending");
});

test("stop between durable claim and final initiation is rechecked atomically", { skip }, async () => {
  const f = await fixture(), out = await enqueue(f); let hookRan = false, calls = 0;
  const intercepted = {
    connect: async () => {
      const client = await pool.connect(); let claimed = false;
      return new Proxy(client, {
        get(target, key) {
          if (key === "query") return async (sql: string, values?: unknown[]) => {
            const result = await target.query(sql, values);
            if (sql.includes("state='dispatching',attempt_token=")) claimed = true;
            if (sql === "COMMIT" && claimed && !hookRan) {
              hookRan = true;
              assert.equal((await action(out.id)).state, "dispatching");
              await store.optOut(f.contact, "stop-between-transactions");
            }
            return result;
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
  await new AiManagerStore(intercepted).dispatch(out.id, await preparedFor(out.id, input => { calls++; return confirmation(input); }));
  assert.equal(hookRan, true); assert.equal(calls, 0);
  assert.equal((await action(out.id)).state, "cancelled");
});

test("inbox insertion and mode/action invalidation roll back together", { skip }, async () => {
  const f = await fixture(), out = await enqueue(f);
  await pool.query(`CREATE FUNCTION reject_epoch_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER reject_epoch BEFORE UPDATE ON ai_conversations FOR EACH ROW EXECUTE FUNCTION reject_epoch_update()`);
  try { await assert.rejects(store.ingest(event(f)), /synthetic failure/); }
  finally { await pool.query("DROP TRIGGER reject_epoch ON ai_conversations; DROP FUNCTION reject_epoch_update()"); }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_inbox")).rows[0].n, 0);
  assert.equal((await action(out.id)).state, "pending");
});

test("failed migration leaves no partial AI tables or history record", { skip }, async () => {
  const name = "ai_broken_" + randomUUID().replaceAll("-", "");
  await pool.query("CREATE SCHEMA " + name);
  const broken = new pg.Pool({ connectionString: url, options: "-c search_path=" + name });
  try {
    await assert.rejects(applyAiManagerMigration(broken), /integrations/);
    const tables = await broken.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=$1", [name]);
    assert.equal(tables.rows[0].n, 0);
  } finally { await broken.end(); await pool.query("DROP SCHEMA " + name + " CASCADE"); }
});
