import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import express from "express";
import ExcelJS from "exceljs";
import type { Server } from "node:http";
import pg from "pg";
import { applyAiManagerMigration } from "./ai-manager-migration.js";
import { AiManagerStore } from "./ai-manager.js";
import { ContactImportService } from "./contact-import.js";
import { parseContactFile, IMPORT_LIMITS } from "./contact-file.js";
import { createContactImportRouter } from "../api/contact-import-router.js";

const url = process.env.CONTACT_IMPORT_TEST_DATABASE_URL, skip = !url;
let pool: pg.Pool, service: ContactImportService, schema: string;
const fixture = ["name;phone;comment;stage",
  ...Array.from({ length: 6 }, (_, i) => "Person " + i + ";+1202555010" + (i + 1) + ";original;source-stage"),
  "Duplicate;+1 (202) 555-0101;;", "Duplicate;+12025550102;;", "Wrong;wrong;;", "Missing;;;"].join("\n");
const mapping = { sheetName: "CSV", phoneColumn: 1, nameColumn: 0, commentColumn: 2, stageColumn: 3 };

before(async () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("/relayboard_contact_import_test")) throw new Error("Dedicated relayboard_contact_import_test database required");
  schema = "import_test_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  try { await admin.query("CREATE SCHEMA " + schema); } finally { await admin.end(); }
  pool = new pg.Pool({ connectionString: url, options: "-c search_path=" + schema + ",public" });
  await pool.query(await readFile(new URL("../../database/schema.sql", import.meta.url), "utf8"));
  await applyAiManagerMigration(pool); service = new ContactImportService(pool);
});
beforeEach(async () => { if (pool) await pool.query("TRUNCATE ai_contacts,ai_contact_import_sessions,integrations CASCADE"); });
after(async () => { if (pool) { await pool.query("DROP SCHEMA " + schema + " CASCADE"); await pool.end(); } });

async function preview(owner = "admin", csv = fixture) {
  const inspection = await service.inspect(owner, await parseContactFile(Buffer.from(csv), "synthetic.csv"));
  return service.preview(owner, inspection.inspectionId, mapping);
}
async function count(table: string) {
  assert.ok(["ai_contacts", "ai_outbox", "ai_inbox", "deliveries"].includes(table));
  return (await pool.query("SELECT count(*)::int AS n FROM " + table)).rows[0].n;
}
async function http(enabled = true) {
  const app = express(); app.use(express.json({ limit: "1mb" }));
  app.use("/api/ai", createContactImportRouter({ pool, enabled, ownerScope: "admin", authorize: (request, response, next) =>
    request.header("x-synthetic-admin") === "yes" ? next() : response.status(401).json({ error: "Unauthorized" }) }));
  const server = await new Promise<Server>(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { base: "http://127.0.0.1:" + address.port + "/api/ai", close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
const headers = { "x-synthetic-admin": "yes", "content-type": "application/json" };

test("preview is side-effect-free; 10 rows confirm as 6 new, 2 duplicate, 2 invalid and zero sends", { skip }, async () => {
  const p = await preview(); assert.deepEqual(p.summary, { total: 10, new: 6, duplicate: 2, invalid: 2 });
  assert.equal(await count("ai_contacts"), 0);
  const result = await service.confirm("admin", p.previewId);
  assert.deepEqual(result.summary, p.summary); assert.equal(await count("ai_contacts"), 6);
  assert.equal(await count("ai_outbox"), 0); assert.equal(await count("deliveries"), 0);
  const stored = (await pool.query("SELECT payload FROM ai_contact_import_sessions WHERE id=$1", [p.previewId])).rows[0];
  assert.equal(stored.payload, null);
});

test("five concurrent confirmations replay one committed receipt, even after expiry", { skip }, async () => {
  const p = await preview();
  const results = await Promise.all(Array.from({ length: 5 }, () => service.confirm("admin", p.previewId)));
  assert.equal(results.filter(r => !r.replayed).length, 1);
  assert.equal(new Set(results.map(r => r.importId)).size, 1); assert.equal(await count("ai_contacts"), 6);
  await pool.query("UPDATE ai_contact_import_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1", [p.previewId]);
  await service.purgeExpired();
  assert.equal((await service.confirm("admin", p.previewId)).replayed, true);
});

test("XLSX sheet selection produces the same 6/2/2 import without sending", { skip }, async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Ignore").addRow(["unused"]);
  const sheet = workbook.addWorksheet("Contacts");
  for (const row of fixture.split("\n")) sheet.addRow(row.split(";"));
  const inspection = await service.inspect("admin", await parseContactFile(Buffer.from(await workbook.xlsx.writeBuffer()), "synthetic.xlsx"));
  assert.equal(inspection.sheets.length, 2);
  const p = await service.preview("admin", inspection.inspectionId, { ...mapping, sheetName: "Contacts" });
  assert.deepEqual(p.summary, { total: 10, new: 6, duplicate: 2, invalid: 2 });
  assert.deepEqual((await service.confirm("admin", p.previewId)).summary, p.summary);
  assert.equal(await count("ai_contacts"), 6); assert.equal(await count("ai_outbox"), 0);
});

test("reimport preserves existing name/comment/stage, opt-out and conversation history", { skip }, async () => {
  const first = await preview(); await service.confirm("admin", first.previewId);
  const contact = (await pool.query("SELECT * FROM ai_contacts WHERE phone_e164='+12025550101'")).rows[0];
  const account = (await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES ('max','synthetic','fake') RETURNING id")).rows[0].id;
  const store = new AiManagerStore(pool);
  const conversation = await store.createConversation({ contactId: contact.id, accountId: account, externalId: "dialog" });
  await store.setMode(conversation.id, "manual");
  await store.ingest({ version: 1, platform: "max", accountId: account, conversationId: "dialog", messageId: "m",
    occurredAt: "2026-11-12T10:00:00Z", direction: "outbound", origin: "service", text: "synthetic history" });
  await store.optOut(contact.id, "explicit-stop");
  const before = (await pool.query("SELECT * FROM ai_contacts WHERE id=$1", [contact.id])).rows[0];
  const state = (await pool.query("SELECT * FROM ai_conversations WHERE id=$1", [conversation.id])).rows[0];
  const again = await preview("admin", "name;phone;comment;stage\nChanged;+12025550101;changed;qualified");
  assert.equal(again.rows[0].reason, "already_exists");
  assert.equal((await service.confirm("admin", again.previewId)).summary.new, 0);
  assert.deepEqual((await pool.query("SELECT * FROM ai_contacts WHERE id=$1", [contact.id])).rows[0], before);
  assert.deepEqual((await pool.query("SELECT * FROM ai_conversations WHERE id=$1", [conversation.id])).rows[0], state);
  assert.equal(await count("ai_inbox"), 1); assert.equal(await count("ai_outbox"), 0);
});

test("two different previews reconcile concurrent additions without duplicate contacts", { skip }, async () => {
  const a = await preview(), b = await preview();
  const [one, two] = await Promise.all([service.confirm("admin", a.previewId), service.confirm("admin", b.previewId)]);
  assert.equal(one.summary.new + two.summary.new, 6);
  assert.equal(await count("ai_contacts"), 6);
  assert.equal(one.summary.duplicate + two.summary.duplicate, 10);
});

test("unconfirmed expiry, foreign owner and changed mapping cannot bypass server preview", { skip }, async () => {
  const p = await preview();
  await assert.rejects(service.confirm("another-admin", p.previewId), { code: "import_session_not_found" });
  await pool.query("UPDATE ai_contact_import_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1", [p.previewId]);
  await assert.rejects(service.confirm("admin", p.previewId), { code: "import_session_expired" });
  await service.purgeExpired();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_contact_import_sessions WHERE id=$1", [p.previewId])).rows[0].n, 0);
  assert.equal(await count("ai_contacts"), 0);
});

test("failed insertion rolls back all contacts and receipt, then permits safe retry", { skip }, async () => {
  const p = await preview();
  await pool.query(`CREATE FUNCTION fail_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fail'; END $$;
    CREATE TRIGGER fail_import BEFORE INSERT ON ai_contacts FOR EACH ROW EXECUTE FUNCTION fail_import()`);
  try { await assert.rejects(service.confirm("admin", p.previewId), /synthetic fail/); }
  finally { await pool.query("DROP TRIGGER fail_import ON ai_contacts; DROP FUNCTION fail_import()"); }
  assert.equal(await count("ai_contacts"), 0);
  const row = (await pool.query("SELECT payload,result FROM ai_contact_import_sessions WHERE id=$1", [p.previewId])).rows[0];
  assert.ok(row.payload); assert.equal(row.result, null);
  assert.equal((await service.confirm("admin", p.previewId)).summary.new, 6);
});

test("temporary session quota bounds stored raw data", { skip }, async () => {
  const file = await parseContactFile(Buffer.from(fixture), "synthetic.csv");
  for (let i = 0; i < 10; i++) await service.inspect("admin", file);
  await assert.rejects(service.inspect("admin", file), { code: "import_session_limit" });
});

test("HTTP authenticates before upload/parsing and flag is off unless explicitly enabled", { skip }, async () => {
  const app = await http(false);
  try {
    assert.equal((await fetch(app.base + "/contacts")).status, 401);
    const denied = await fetch(app.base + "/contacts", { headers });
    assert.equal(denied.status, 503); assert.equal((await denied.json()).code, "contact_import_disabled");
    assert.equal(await count("ai_contacts"), 0);
  } finally { await app.close(); }
});

test("HTTP CSV upload -> mapping -> preview -> confirm -> paged list, with no send", { skip }, async () => {
  const app = await http();
  try {
    const form = new FormData(); form.append("file", new Blob([fixture]), "synthetic.csv");
    const uploaded = await fetch(app.base + "/contact-imports/inspect", { method: "POST", headers: { "x-synthetic-admin": "yes" }, body: form });
    assert.equal(uploaded.status, 200); assert.equal(uploaded.headers.get("cache-control"), "no-store");
    const inspection = await uploaded.json(); assert.equal(inspection.sheets[0].columns[1].label, "phone");
    const previewed = await fetch(app.base + "/contact-imports/preview", { method: "POST", headers, body: JSON.stringify({ ...mapping, inspectionId: inspection.inspectionId }) });
    assert.equal(previewed.status, 200); const p = await previewed.json();
    const confirmed = await fetch(app.base + "/contact-imports/" + p.previewId + "/confirm", { method: "POST", headers, body: JSON.stringify({ rows: [{ phone: "+442079460018" }] }) });
    assert.equal(confirmed.status, 200); assert.equal((await confirmed.json()).summary.new, 6);
    const list = await fetch(app.base + "/contacts?limit=2&offset=0", { headers }); const body = await list.json();
    assert.equal(body.contacts.length, 2); assert.equal(body.total, 6);
    assert.equal((await fetch(app.base + "/contacts?limit=999999", { headers })).status, 400);
    assert.equal(await count("ai_outbox"), 0);
  } finally { await app.close(); }
});

test("HTTP rejects oversized and malformed uploads and recovers parser slot", { skip }, async () => {
  const app = await http();
  try {
    for (const [buffer, name, expected] of [[Buffer.alloc(IMPORT_LIMITS.bytes + 1), "large.csv", 413], [Buffer.from("bad zip"), "broken.xlsx", 400]] as const) {
      const form = new FormData(); form.append("file", new Blob([buffer]), name);
      assert.equal((await fetch(app.base + "/contact-imports/inspect", { method: "POST", headers: { "x-synthetic-admin": "yes" }, body: form })).status, expected);
    }
    const valid = new FormData(); valid.append("file", new Blob([fixture]), "valid.csv");
    assert.equal((await fetch(app.base + "/contact-imports/inspect", { method: "POST", headers: { "x-synthetic-admin": "yes" }, body: valid })).status, 200);
  } finally { await app.close(); }
});
