import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import pg from "pg";
import { LeadIntakeStore, leadSourceSchema } from "./lead-intake.js";
import { createLeadRouter } from "../api/lead-router.js";
const url = process.env.LEAD_TEST_DATABASE_URL,
  skip = !url;
let pool: pg.Pool, store: LeadIntakeStore, schema: string;
const source = () => ({
  platform: "max" as const,
  accountId: randomUUID(),
  chatId: "chat",
  authorId: "author",
  messageId: "message",
  occurredAt: "2026-11-13T09:00:00+03:00",
  text: "Требуется 12 тонн щебня. Бюджет не назван.",
  sourceKind: "fixture" as const,
  params: [{ key: "volume", value: 12, evidenceQuote: "12 тонн" }],
  confidence: 1,
});
before(async () => {
  if (!url) return;
  if (new URL(url).pathname != "/relayboard_lead_test")
    throw new Error("Dedicated relayboard_lead_test required");
  schema = "leads_" + randomUUID().replaceAll("-", "");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("CREATE SCHEMA " + schema);
  await c.end();
  pool = new pg.Pool({
    connectionString: url,
    options: "-c search_path=" + schema + ",public",
  });
  for (const name of [
    "schema.sql",
    "ai-manager.sql",
    "ai-manager-import.sql",
    "ai-manager-outreach.sql",
    "ai-manager-leads.sql",
  ])
    await pool.query(
      await readFile(
        new URL("../../database/" + name, import.meta.url),
        "utf8",
      ),
    );
  store = new LeadIntakeStore(pool);
});
beforeEach(async () => {
  if (pool)
    await pool.query("TRUNCATE ai_leads,ai_contacts,integrations CASCADE");
});
after(async () => {
  if (pool) {
    await pool.query("DROP SCHEMA " + schema + " CASCADE");
    await pool.end();
  }
});
async function contact() {
  return (
    await pool.query(
      "INSERT INTO ai_contacts(display_name) VALUES('Synthetic') RETURNING id",
    )
  ).rows[0].id;
}
async function counts() {
  return (
    await pool.query(
      "SELECT (SELECT count(*)::int FROM ai_requests) requests,(SELECT count(*)::int FROM ai_outbox) sends,(SELECT count(*)::int FROM ai_lead_operations) operations",
    )
  ).rows[0];
}

test("source schema rejects executable links, invalid confidence and duplicate parameter keys", () => {
  const s = source();
  for (const data of [
    { ...s, link: "javascript:alert(1)" },
    { ...s, confidence: 2 },
    { ...s, params: [s.params[0], s.params[0]] },
    { ...s, chatId: "   " },
  ])
    assert.equal(leadSourceSchema.safeParse(data).success, false);
  assert.equal(
    leadSourceSchema.safeParse({ ...s, link: "https://example.test/message" })
      .success,
    true,
  );
});
test(
  "five concurrent ingests preserve one original source; high confidence never approves or sends",
  { skip },
  async () => {
    const s = source(),
      r = await Promise.all(Array.from({ length: 5 }, () => store.ingest(s)));
    assert.equal(new Set(r.map((x) => x.lead.id)).size, 1);
    assert.equal(r.filter((x) => !x.replayed).length, 1);
    assert.equal(r[0].lead.status, "pending");
    assert.equal(r[0].lead.original_text, s.text);
    assert.deepEqual(await counts(), { requests: 0, sends: 0, operations: 0 });
  },
);
test(
  "same message identity with changed content conflicts and never overwrites original",
  { skip },
  async () => {
    const s = source(),
      r = await store.ingest(s);
    await assert.rejects(store.ingest({ ...s, text: s.text + " Changed" }), {
      code: "source_content_conflict",
    });
    const again = await store.ingest({ ...s, confidence: 0.2 });
    assert.equal(again.lead.id, r.lead.id);
    assert.equal(again.lead.confidence, 1);
    assert.equal(again.lead.original_text, s.text);
  },
);
test(
  "event dedup isolates platform/account/chat and preserves opaque identifiers",
  { skip },
  async () => {
    const s = source();
    for (const change of [
      {},
      { platform: "whatsapp" as const },
      { accountId: randomUUID() },
      { chatId: "other" },
      { messageId: "message " },
    ])
      await store.ingest({ ...s, ...change });
    assert.equal((await store.list()).total, 5);
  },
);
test(
  "parameters require original evidence and cannot invent price or change numeric sign",
  { skip },
  async () => {
    const s = source();
    for (const params of [
      [{ key: "price", value: 500, evidenceQuote: "12 тонн" }],
      [{ key: "volume", value: 12, evidenceQuote: "not in original" }],
    ])
      await assert.rejects(store.ingest({ ...s, params }), {
        code: "ungrounded_parameter",
      });
    await assert.rejects(
      store.ingest({ ...s, text: "Нужно -12 тонн", params: s.params }),
      { code: "ungrounded_parameter" },
    );
  },
);
test(
  "concurrent approval retries persist one request, one operation and a stable receipt",
  { skip },
  async () => {
    const lead = (await store.ingest(source())).lead,
      c = await contact(),
      q = {
        leadId: lead.id,
        operationId: randomUUID(),
        expectedRevision: 0,
        action: "approve" as const,
        contactId: c,
        requestId: randomUUID(),
      };
    const r = await Promise.all(
      Array.from({ length: 5 }, () => store.review(q)),
    );
    assert.equal(r.filter((x) => !x.replayed).length, 1);
    assert.equal(r[0].lead.status, "approved");
    assert.deepEqual(await counts(), { requests: 1, sends: 0, operations: 1 });
    await assert.rejects(store.review({ ...q, reason: "changed payload" }), {
      code: "operation_payload_conflict",
    });
  },
);
test(
  "two source records can bind the same explicit request without duplicate first approach intent",
  { skip },
  async () => {
    const s = source(),
      a = (await store.ingest(s)).lead,
      b = (await store.ingest({ ...s, messageId: "second" })).lead,
      c = await contact(),
      requestId = randomUUID();
    for (const lead of [a, b])
      await store.review({
        leadId: lead.id,
        operationId: randomUUID(),
        expectedRevision: 0,
        action: "approve",
        contactId: c,
        requestId,
      });
    assert.deepEqual(await counts(), { requests: 1, sends: 0, operations: 2 });
  },
);
test(
  "approval rejects opt-out and cannot rebind request to a different contact",
  { skip },
  async () => {
    const a = (await store.ingest(source())).lead,
      c = await contact(),
      other = await contact(),
      requestId = randomUUID();
    await pool.query("INSERT INTO ai_requests(id,contact_id) VALUES($1,$2)", [
      requestId,
      c,
    ]);
    await assert.rejects(
      store.review({
        leadId: a.id,
        operationId: randomUUID(),
        expectedRevision: 0,
        action: "approve",
        contactId: other,
        requestId,
      }),
      { code: "request_identity_conflict" },
    );
    await pool.query("UPDATE ai_contacts SET opted_out_at=now() WHERE id=$1", [
      c,
    ]);
    await assert.rejects(
      store.review({
        leadId: a.id,
        operationId: randomUUID(),
        expectedRevision: 0,
        action: "approve",
        contactId: c,
        requestId: randomUUID(),
      }),
      { code: "contact_excluded" },
    );
    assert.equal((await store.list()).leads[0].status, "pending");
    assert.equal((await counts()).operations, 0);
  },
);
test(
  "concurrent edits use revision check and preserve immutable source text",
  { skip },
  async () => {
    const s = source(),
      lead = (await store.ingest(s)).lead;
    const edit = (key: string) =>
      store.review({
        leadId: lead.id,
        operationId: randomUUID(),
        expectedRevision: 0,
        action: "edit",
        params: [{ key, value: 12, evidenceQuote: "12 тонн" }],
      });
    const r = await Promise.allSettled([
      edit("volume"),
      edit("requested_volume"),
    ]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal((await store.list()).leads[0].revision, 1);
    assert.equal((await store.list()).leads[0].original_text, s.text);
  },
);
test(
  "rejection survives restart and re-ingestion without reviving candidate",
  { skip },
  async () => {
    const s = source(),
      lead = (await store.ingest(s)).lead,
      q = {
        leadId: lead.id,
        operationId: randomUUID(),
        expectedRevision: 0,
        action: "reject" as const,
        reason: "Not a request",
      };
    await store.review(q);
    assert.equal((await new LeadIntakeStore(pool).review(q)).replayed, true);
    assert.equal((await store.ingest(s)).lead.status, "rejected");
    await assert.rejects(
      store.review({ ...q, operationId: randomUUID(), expectedRevision: 1 }),
      { code: "lead_already_reviewed" },
    );
    assert.equal((await counts()).requests, 0);
  },
);
test(
  "receipt failure rolls back approval and request, permitting safe retry",
  { skip },
  async () => {
    const lead = (await store.ingest(source())).lead,
      c = await contact(),
      q = {
        leadId: lead.id,
        operationId: randomUUID(),
        expectedRevision: 0,
        action: "approve" as const,
        contactId: c,
        requestId: randomUUID(),
      };
    await pool.query(
      "CREATE FUNCTION fail_lead_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic failure';END$$;CREATE TRIGGER fail_lead_receipt BEFORE INSERT ON ai_lead_operations FOR EACH ROW EXECUTE FUNCTION fail_lead_receipt()",
    );
    try {
      await assert.rejects(store.review(q), /synthetic failure/);
    } finally {
      await pool.query(
        "DROP TRIGGER fail_lead_receipt ON ai_lead_operations;DROP FUNCTION fail_lead_receipt()",
      );
    }
    assert.deepEqual(await counts(), { requests: 0, sends: 0, operations: 0 });
    assert.equal((await store.list()).leads[0].status, "pending");
    assert.equal((await store.review(q)).lead.status, "approved");
  },
);
test(
  "HTTP requires admin, honors disabled flag, validates input and supports source review",
  { skip },
  async () => {
    const app = express();
    app.use(express.json());
    const auth: import("express").RequestHandler = (req, res, next) =>
      req.header("x-synthetic") === "yes" ? next() : res.sendStatus(401);
    app.use("/on", createLeadRouter({ pool, authorize: auth, enabled: true }));
    app.use(
      "/off",
      createLeadRouter({ pool, authorize: auth, enabled: false }),
    );
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const a = server.address();
      assert.ok(a && typeof a !== "string");
      const base = "http://127.0.0.1:" + a.port,
        headers = { "x-synthetic": "yes", "content-type": "application/json" };
      assert.equal((await fetch(base + "/on")).status, 401);
      assert.equal((await fetch(base + "/off", { headers })).status, 503);
      assert.equal(
        (await fetch(base + "/on", { headers, method: "POST", body: "{}" }))
          .status,
        400,
      );
      const ingested = await fetch(base + "/on", {
        headers,
        method: "POST",
        body: JSON.stringify(source()),
      });
      assert.equal(ingested.status, 200);
      const r = await ingested.json();
      assert.equal(ingested.headers.get("cache-control"), "no-store");
      const review = await fetch(base + "/on/" + r.lead.id + "/review", {
        headers,
        method: "POST",
        body: JSON.stringify({
          operationId: randomUUID(),
          expectedRevision: 0,
          action: "reject",
          reason: "Not relevant",
          leadId: randomUUID(),
        }),
      });
      assert.equal(review.status, 200);
      const list = await fetch(base + "/on?status=rejected", { headers });
      assert.equal((await list.json()).total, 1);
      assert.equal(
        (await fetch(base + "/on?limit=5000", { headers })).status,
        400,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
