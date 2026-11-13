import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import pg from "pg";
import express from "express";
import type { Server } from "node:http";
import { OutreachService } from "./outreach.js";
import { applyAiManagerMigration } from "./ai-manager-migration.js";
import { createOutreachRouter } from "../api/outreach-router.js";
const url = process.env.OUTREACH_TEST_DATABASE_URL,
  skip = !url;
let pool: pg.Pool, service: OutreachService, schema: string;
before(async () => {
  if (!url) return;
  if (new URL(url).pathname != "/relayboard_outreach_test")
    throw new Error("Dedicated relayboard_outreach_test required");
  schema = "outreach_" + randomUUID().replaceAll("-", "");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("CREATE SCHEMA " + schema);
  await c.end();
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
  service = new OutreachService(pool);
});
beforeEach(async () => {
  if (!pool) return;
  await pool.query("TRUNCATE ai_contacts,integrations CASCADE");
  await pool.query(
    "UPDATE ai_outreach_settings SET revision=0,template='',interval_seconds=60,account_ids='{}',platforms=ARRAY['max','whatsapp']",
  );
});
after(async () => {
  if (pool) {
    await pool.query("DROP SCHEMA " + schema + " CASCADE");
    await pool.end();
  }
});
async function fixture(platform = "max") {
  const contact = (
    await pool.query(
      "INSERT INTO ai_contacts(display_name) VALUES('Synthetic') RETURNING id",
    )
  ).rows[0].id;
  const account = (
    await pool.query(
      "INSERT INTO integrations(platform,name,credential_ciphertext) VALUES($1,'synthetic','fake') RETURNING id",
      [platform],
    )
  ).rows[0].id;
  const conv = (
    await pool.query(
      "INSERT INTO ai_conversations(contact_id,account_id,platform,external_id,automation_mode) VALUES($1,$2,$3,'synthetic-dialog','auto') RETURNING id",
      [contact, account, platform],
    )
  ).rows[0].id;
  const request = await service.createRequest({
    id: randomUUID(),
    contactId: contact,
  });
  const s = await service.save({
    ...(await service.settings()),
    template: "Synthetic text",
    accountIds: [account],
  });
  return { contact, account, conv, request, s };
}
test(
  "settings survive restart, use revision checks and admit only one concurrent editor",
  { skip },
  async () => {
    const s = await service.settings();
    const results = await Promise.allSettled([
      service.save({ ...s, template: "a" }),
      service.save({ ...s, template: "b" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const next = await new OutreachService(pool).settings();
    assert.equal(next.revision, 1);
    await assert.rejects(service.save({ ...next, intervalSeconds: 0 }));
    await assert.rejects(service.save({ ...next, platforms: ["max", "max"] }));
  },
);
test(
  "explicit request replay is stable and cannot be rebound to another contact",
  { skip },
  async () => {
    const f = await fixture();
    assert.deepEqual(
      await service.createRequest({ id: f.request.id, contactId: f.contact }),
      f.request,
    );
    const other = (
      await pool.query("INSERT INTO ai_contacts DEFAULT VALUES RETURNING id")
    ).rows[0].id;
    await assert.rejects(
      service.createRequest({ id: f.request.id, contactId: other }),
      { code: "request_identity_conflict" },
    );
    assert.equal((await service.requests()).length, 1);
  },
);
test(
  "empty template blocks preview, stale revision cannot preview new content",
  { skip },
  async () => {
    const f = await fixture();
    const s = await service.save({ ...f.s, template: "   " });
    await assert.rejects(
      service.preview({ revision: s.revision, requestIds: [f.request.id] }),
      { code: "template_required" },
    );
    await assert.rejects(
      service.preview({ revision: f.s.revision, requestIds: [f.request.id] }),
      { code: "settings_changed" },
    );
  },
);
test(
  "preview chooses explicit route and never creates a send or changes mode",
  { skip },
  async () => {
    const f = await fixture();
    const p = await service.preview({
      revision: f.s.revision,
      requestIds: [f.request.id],
    });
    assert.equal(p.eligible, 1);
    assert.equal(p.canStart, false);
    assert.equal(p.template, "Synthetic text");
    assert.equal(p.rows[0].route?.accountId, f.account);
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM ai_outbox")).rows[0].n,
      0,
    );
    assert.equal(
      (await pool.query("SELECT automation_mode FROM ai_conversations")).rows[0]
        .automation_mode,
      "auto",
    );
  },
);
test(
  "opt-out and manual conversation outside allowed accounts block cross-channel approach",
  { skip },
  async () => {
    const f = await fixture();
    await pool.query(
      "INSERT INTO ai_conversations(contact_id,account_id,platform,external_id,automation_mode) VALUES($1,$2,'whatsapp','human','manual')",
      [f.contact, randomUUID()],
    );
    let p = await service.preview({
      revision: f.s.revision,
      requestIds: [f.request.id],
    });
    assert.equal(p.rows[0].reason, "manual_or_closed");
    await pool.query("UPDATE ai_contacts SET opted_out_at=now() WHERE id=$1", [
      f.contact,
    ]);
    p = await service.preview({
      revision: f.s.revision,
      requestIds: [f.request.id],
    });
    assert.equal(p.rows[0].reason, "opted_out");
  },
);
test(
  "unknown action blocks a second first approach for the same explicit request",
  { skip },
  async () => {
    const f = await fixture();
    await pool.query(
      "INSERT INTO ai_outbox(contact_id,conversation_id,logical_key,kind,text,fingerprint,automation_epoch,state) VALUES($1,$2,$3,'first_message','old','synthetic',0,'unknown')",
      [f.contact, f.conv, "request:" + f.request.id],
    );
    const p = await service.preview({
      revision: f.s.revision,
      requestIds: [f.request.id],
    });
    assert.equal(p.rows[0].reason, "existing_unknown");
  },
);
test(
  "missing, paused, disabled and unauthorized routes are not implicitly activated",
  { skip },
  async () => {
    const f = await fixture();
    for (const update of [
      "UPDATE ai_conversations SET automation_mode='paused'",
      "UPDATE ai_conversations SET automation_mode='auto'; UPDATE integrations SET enabled=false",
      "UPDATE integrations SET enabled=true,auth_error='synthetic auth failure'",
    ]) {
      await pool.query(update);
      assert.equal(
        (
          await service.preview({
            revision: f.s.revision,
            requestIds: [f.request.id],
          })
        ).rows[0].reason,
        "no_ready_conversation",
      );
    }
    await assert.rejects(
      service.preview({ revision: f.s.revision, requestIds: [randomUUID()] }),
      { code: "request_not_found" },
    );
  },
);
test(
  "two explicit requests for one contact are distinct, but preview permits only one parallel approach",
  { skip },
  async () => {
    const f = await fixture();
    const second = await service.createRequest({
      id: randomUUID(),
      contactId: f.contact,
    });
    const p = await service.preview({
      revision: f.s.revision,
      requestIds: [f.request.id, second.id],
    });
    assert.equal(p.eligible, 1);
    assert.equal(p.rows[1].reason, "same_contact_in_preview");
  },
);
test(
  "channel priority is deterministic and empty account allowlist blocks all routes",
  { skip },
  async () => {
    const f = await fixture();
    const a = (
      await pool.query(
        "INSERT INTO integrations(platform,name,credential_ciphertext) VALUES('whatsapp','second','fake') RETURNING id",
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO ai_conversations(contact_id,account_id,platform,external_id,automation_mode) VALUES($1,$2,'whatsapp','second','auto')",
      [f.contact, a],
    );
    const s = await service.save({
      ...f.s,
      platforms: ["whatsapp", "max"],
      accountIds: [f.account, a],
    });
    assert.equal(
      (
        await service.preview({
          revision: s.revision,
          requestIds: [f.request.id],
        })
      ).rows[0].route?.accountId,
      a,
    );
    const empty = await service.save({ ...s, accountIds: [] });
    assert.equal(
      (
        await service.preview({
          revision: empty.revision,
          requestIds: [f.request.id],
        })
      ).eligible,
      0,
    );
  },
);
test(
  "HTTP requires authorization, honors disabled flag and rejects invalid input",
  { skip },
  async () => {
    const app = express();
    app.use(express.json());
    const authorize: import("express").RequestHandler = (req, res, next) =>
      req.header("x-synthetic") === "yes" ? next() : res.sendStatus(401);
    app.use("/on", createOutreachRouter({ pool, authorize, enabled: true }));
    app.use("/off", createOutreachRouter({ pool, authorize, enabled: false }));
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const a = server.address();
      assert.ok(a && typeof a !== "string");
      const base = "http://127.0.0.1:" + a.port;
      assert.equal((await fetch(base + "/on/settings")).status, 401);
      assert.equal(
        (
          await fetch(base + "/off/settings", {
            headers: { "x-synthetic": "yes" },
          })
        ).status,
        503,
      );
      const r = await fetch(base + "/on/settings", {
        headers: { "x-synthetic": "yes" },
      });
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.equal((await r.json()).revision, 0);
      assert.equal(
        (
          await fetch(base + "/on/preview", {
            method: "POST",
            headers: {
              "x-synthetic": "yes",
              "content-type": "application/json",
            },
            body: "{}",
          })
        ).status,
        400,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
