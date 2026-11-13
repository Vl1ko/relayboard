import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import pg from "pg";
import { applyAiManagerMigration } from "../core/ai-manager-migration.js";
import { ConversationWorkflow } from "../core/conversation-workflow.js";
import { createConversationRouter } from "./conversation-router.js";
const url = process.env.WORKSPACE_TEST_DATABASE_URL,
  skip = !url;
let pool: pg.Pool, schema: string, server: Server, base: string;
const headers = {
  "x-synthetic-admin": "yes",
  "content-type": "application/json",
};
before(async () => {
  if (!url) return;
  if (new URL(url).pathname !== "/relayboard_workspace_test")
    throw new Error("Dedicated relayboard_workspace_test required");
  schema = "workspace_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("CREATE SCHEMA " + schema);
  await admin.end();
  pool = new pg.Pool({
    connectionString: url,
    options: "-c search_path=" + schema + ",public",
  });
  await pool.query(
    await readFile(
      new URL("../../database/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  await applyAiManagerMigration(pool);
  const app = express();
  app.use(express.json());
  const authorize: import("express").RequestHandler = (req, res, next) =>
    req.header("x-synthetic-admin") === "yes" ? next() : res.sendStatus(401);
  app.use(
    "/on",
    createConversationRouter({
      pool,
      authorize,
      enabled: true,
      workflow: new ConversationWorkflow(pool),
    }),
  );
  app.use(
    "/off",
    createConversationRouter({ pool, authorize, enabled: false }),
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = "http://127.0.0.1:" + address.port;
});
beforeEach(async () => {
  if (pool) await pool.query("TRUNCATE ai_contacts,integrations CASCADE");
});
after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (pool) {
    await pool.query("DROP SCHEMA " + schema + " CASCADE");
    await pool.end();
  }
});
async function fixture() {
  const contact = (
    await pool.query(
      "INSERT INTO ai_contacts(display_name,phone_e164) VALUES('Synthetic Alice','+12025550101') RETURNING id",
    )
  ).rows[0].id;
  const other = (
    await pool.query(
      "INSERT INTO ai_contacts(display_name,phone_e164) VALUES('Synthetic Bob','+12025550102') RETURNING id",
    )
  ).rows[0].id;
  const max = (
    await pool.query(
      "INSERT INTO integrations(platform,name,credential_ciphertext,auth_error) VALUES('max','Team MAX','secret-cipher','secret-auth-detail') RETURNING id",
    )
  ).rows[0].id;
  const wa = (
    await pool.query(
      "INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('whatsapp','Team WhatsApp','another-secret') RETURNING id",
    )
  ).rows[0].id;
  const conv = (
    await pool.query(
      "INSERT INTO ai_conversations(contact_id,account_id,platform,external_id,automation_mode) VALUES($1,$2,'max','max-dialog','auto') RETURNING id",
      [contact, max],
    )
  ).rows[0].id;
  const second = (
    await pool.query(
      "INSERT INTO ai_conversations(contact_id,account_id,platform,external_id,business_status,automation_mode) VALUES($1,$2,'whatsapp','wa-dialog','manager_required','manual') RETURNING id",
      [contact, wa],
    )
  ).rows[0].id;
  const bob = (
    await pool.query(
      "INSERT INTO ai_conversations(contact_id,account_id,platform,external_id,business_status) VALUES($1,$2,'max','bob-dialog','closed') RETURNING id",
      [other, max],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO ai_inbox(event_key,conversation_id,external_message_id,occurred_at,direction,origin,disposition,text) VALUES('a',$1,'message-a','2026-11-13T10:00:00Z','inbound','customer','process_customer','literal %_ search'),('b',$2,'message-b','2026-11-13T10:01:00Z','outbound','human','takeover','human history'),('c',$3,'message-c','2026-11-13T10:02:00Z','inbound','customer','process_customer','Bob only')",
    [conv, second, bob],
  );
  return { contact, other, max, wa, conv, second, bob };
}
async function get(path: string) {
  return fetch(base + "/on" + path, { headers });
}
test(
  "workspace authorizes before access and disabled module remains inaccessible",
  { skip },
  async () => {
    assert.equal((await fetch(base + "/on/contacts")).status, 401);
    assert.equal(
      (await fetch(base + "/off/contacts", { headers })).status,
      503,
    );
  },
);
test(
  "list groups two channels into one contact and never exposes credential or auth details",
  { skip },
  async () => {
    const f = await fixture(),
      response = await get("/contacts?sort=name");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = await response.json();
    assert.equal(data.total, 2);
    assert.equal(data.contacts.length, 2);
    assert.equal(data.contacts[0].id, f.contact);
    assert.equal(data.contacts[0].conversations.length, 2);
    assert.equal(data.counters.new, 1);
    assert.equal(data.counters.closed, 1);
    assert.equal(data.counters.review, 1);
    assert.equal(data.counterRule, "contact-presence-v1");
    assert.ok(!JSON.stringify(data).includes("secret"));
  },
);
test(
  "search escapes SQL wildcards; channel and status filters must match the same conversation",
  { skip },
  async () => {
    await fixture();
    const literal = await (
      await get("/contacts?q=" + encodeURIComponent("%_"))
    ).json();
    assert.equal(literal.total, 1);
    const impossible = await (
      await get("/contacts?platform=max&mode=manual")
    ).json();
    assert.equal(impossible.total, 0);
    const matching = await (
      await get("/contacts?platform=whatsapp&status=manager_required")
    ).json();
    assert.equal(matching.total, 1);
    assert.equal((await get("/contacts?sort=sql-injection")).status, 400);
    assert.equal((await get("/contacts?limit=100000")).status, 400);
  },
);
test(
  "detail keeps histories attached to account/conversation and supports older pages",
  { skip },
  async () => {
    const f = await fixture();
    const response = await get("/contacts/" + f.contact + "?limit=1");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.messageTotal, 2);
    assert.equal(data.messages.length, 1);
    assert.equal(data.messages[0].conversationId, f.second);
    const older = await (
      await get("/contacts/" + f.contact + "?limit=1&offset=1")
    ).json();
    assert.equal(older.messages[0].conversationId, f.conv);
    const channel = await (
      await get("/contacts/" + f.contact + "?conversationId=" + f.conv)
    ).json();
    assert.equal(channel.messageTotal, 1);
    assert.equal(channel.messages[0].conversationId, f.conv);
    assert.equal(
      (await get("/contacts/" + f.contact + "?conversationId=" + f.bob)).status,
      404,
    );
    assert.ok(!JSON.stringify(data).includes("Bob only"));
    assert.equal((await get("/contacts/" + randomUUID())).status, 404);
  },
);
test(
  "takeover is contact-wide, preserves unknown outcomes and prevents browser qualification forgery",
  { skip },
  async () => {
    const f = await fixture();
    await pool.query(
      "INSERT INTO ai_outbox(contact_id,conversation_id,logical_key,kind,text,fingerprint,automation_epoch,state) VALUES($1,$2,'pending','reply','pending text','p',0,'pending'),($1,$3,'unknown','reply','unknown text','u',0,'unknown')",
      [f.contact, f.conv, f.second],
    );
    let r = await fetch(base + "/on/conversations/" + f.conv + "/mode", {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "manual" }),
    });
    assert.equal(r.status, 200);
    const rows = (
      await pool.query(
        "SELECT automation_mode FROM ai_conversations WHERE contact_id=$1",
        [f.contact],
      )
    ).rows;
    assert.ok(rows.every((r) => r.automation_mode === "manual"));
    const states = (
      await pool.query("SELECT state FROM ai_outbox ORDER BY logical_key")
    ).rows.map((r) => r.state);
    assert.deepEqual(states, ["cancelled", "unknown"]);
    r = await fetch(base + "/on/conversations/" + f.conv + "/status", {
      method: "POST",
      headers,
      body: JSON.stringify({
        status: "qualified",
        reason: "browser says so",
        proof: { verified: true },
      }),
    });
    assert.equal(r.status, 400);
    assert.equal(
      (
        await pool.query(
          "SELECT business_status FROM ai_conversations WHERE id=$1",
          [f.conv],
        )
      ).rows[0].business_status,
      "manager_working",
    );
  },
);
test(
  "opt-out persists on contact and explicit resume cannot bypass it",
  { skip },
  async () => {
    const f = await fixture();
    const r = await fetch(base + "/on/contacts/" + f.contact + "/opt-out", {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "synthetic explicit stop" }),
    });
    assert.equal(r.status, 200);
    assert.equal(
      (await (await get("/contacts/" + f.contact)).json()).contact.optedOut,
      true,
    );
    assert.equal(
      (
        await fetch(base + "/on/conversations/" + f.conv + "/mode", {
          method: "POST",
          headers,
          body: '{"mode":"auto"}',
        })
      ).status,
      409,
    );
  },
);
test(
  "manager target and followup rules are explicit settings, never delivery acknowledgements",
  { skip },
  async () => {
    const f = await fixture();
    let r = await fetch(base + "/on/settings/manager", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        accountId: f.max,
        externalId: "synthetic-manager",
      }),
    });
    assert.equal(r.status, 200);
    const rule = {
      scenario: "no_reply",
      enabled: false,
      timezone: "Europe/Moscow",
      weekdays: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 1080,
      maxSends: 1,
      steps: [{ delaySeconds: 60, text: "synthetic followup" }],
    };
    r = await fetch(base + "/on/settings/followups", {
      method: "PUT",
      headers,
      body: JSON.stringify(rule),
    });
    assert.equal(r.status, 200);
    const settings = await (await get("/settings")).json();
    assert.equal(settings.managerTarget.accountId, f.max);
    assert.equal(settings.followupRules.length, 1);
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM ai_outbox")).rows[0].n,
      0,
    );
    assert.equal(
      (
        await fetch(base + "/on/notifications/outcome", {
          method: "POST",
          headers,
          body: '{"outcome":"confirmed"}',
        })
      ).status,
      404,
    );
  },
);
