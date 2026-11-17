import {applyAiManagerMigration} from './ai-manager-migration.js';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import pg from "pg";
import { AiManagerStore } from "./ai-manager.js";
import {
  ConversationWorkflow,
  assertWorkflowTransition,
  followupRuleSchema,
  nextFollowupWindow,
  workflowActionGate,
  type FollowupRule,
} from "./conversation-workflow.js";
const rule: FollowupRule = {
  scenario: "no_reply",
  enabled: true,
  timezone: "Europe/Moscow",
  weekdays: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 18 * 60,
  steps: [
    { delaySeconds: 60, text: "Synthetic followup" },
    { delaySeconds: 120, text: "Synthetic second" },
  ],
  maxSends: 2,
};
test("work window is explicit and end-exclusive, weekends advance without a guessed timezone", () => {
  assert.equal(
    nextFollowupWindow(new Date("2026-11-13T15:00:00Z"), rule).toISOString(),
    "2026-11-16T06:00:00.000Z",
  );
  assert.equal(
    nextFollowupWindow(new Date("2026-11-13T06:00:20Z"), rule).toISOString(),
    "2026-11-13T06:00:20.000Z",
  );
  assert.throws(() =>
    followupRuleSchema.parse({ ...rule, timezone: "invalid/zone" }),
  );
  assert.throws(() =>
    followupRuleSchema.parse({ ...rule, startMinute: 1100, endMinute: 500 }),
  );
  assert.throws(() => followupRuleSchema.parse({ ...rule, maxSends: 1 }));
});
test("nine statuses have explicit transitions and qualified never trusts a caller boolean by default", () => {
  for (const status of [
    "ai_dialog",
    "unqualified",
    "insufficient_data",
    "manager_required",
    "manager_working",
    "refused",
    "closed",
  ] as const)
    assert.doesNotThrow(() => assertWorkflowTransition("new", status));
  assert.throws(() => assertWorkflowTransition("new", "qualified"), {
    code: "qualification_proof_required",
  });
  assert.doesNotThrow(() => assertWorkflowTransition("new", "qualified", true));
  assert.throws(() => assertWorkflowTransition("closed", "ai_dialog"), {
    code: "invalid_status_transition",
  });
});
const url = process.env.WORKFLOW_TEST_DATABASE_URL,
  skip = !url;
let pool: pg.Pool, service: ConversationWorkflow, schema: string;
before(async () => {
  if (!url) return;
  if (new URL(url).pathname != "/relayboard_workflow_test")
    throw new Error("Dedicated relayboard_workflow_test required");
  schema = "workflow_" + randomUUID().replaceAll("-", "");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("CREATE SCHEMA " + schema);
  await c.end();
  pool = new pg.Pool({
    connectionString: url,
    options: "-c search_path=" + schema + ",public",
  });
  await pool.query(await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));
  await applyAiManagerMigration(pool);
  service = new ConversationWorkflow(pool);
});
beforeEach(async () => {
  if (pool)
    await pool.query(
      "TRUNCATE ai_contacts,integrations,ai_followup_rules,ai_manager_target CASCADE",
    );
});
after(async () => {
  if (pool) {
    await pool.query("DROP SCHEMA " + schema + " CASCADE");
    await pool.end();
  }
});
async function fixture() {
  const contact = (
    await pool.query(
      "INSERT INTO ai_contacts(display_name,phone_e164) VALUES('Synthetic','+12025550101') RETURNING id",
    )
  ).rows[0].id;
  const accounts = [];
  const conversations = [];
  for (const platform of ["max", "whatsapp"]) {
    const account = (
      await pool.query(
        "INSERT INTO integrations(platform,name,credential_ciphertext) VALUES($1,'synthetic','fake') RETURNING id",
        [platform],
      )
    ).rows[0].id;
    accounts.push(account);
    conversations.push(
      (
        await pool.query(
          "INSERT INTO ai_conversations(contact_id,account_id,platform,external_id,automation_mode) VALUES($1,$2,$3,'synthetic','auto') RETURNING *",
          [contact, account, platform],
        )
      ).rows[0],
    );
  }
  return { contact, accounts, conversations };
}
async function enqueue(conv: any) {
  return (
    await new AiManagerStore(pool).enqueue({
      conversationId: conv.id,
      expectedEpoch: conv.automation_epoch,
      logicalKey: randomUUID(),
      kind: "reply",
      text: "Synthetic",
    })
  ).action;
}
async function allDay() {
  await service.saveFollowupRule({
    ...rule,
    timezone: "UTC",
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    startMinute: 0,
    endMinute: 1440,
  });
}
test(
  "takeover cancels both channels and followups; explicit resume never revives cancelled work",
  { skip },
  async () => {
    const f = await fixture();
    await allDay();
    const actions = await Promise.all(f.conversations.map(enqueue));
    const jobs = await service.scheduleFollowup({
      conversationId: f.conversations[0].id,
      scenario: "no_reply",
      key: "a",
      anchorAt: "2026-11-13T10:00:00Z",
    });
    await service.control({
      conversationId: f.conversations[0].id,
      action: "takeover",
    });
    assert.ok(
      (
        await pool.query("SELECT automation_mode FROM ai_conversations")
      ).rows.every((r) => r.automation_mode === "manual"),
    );
    assert.ok(
      (await pool.query("SELECT state FROM ai_outbox")).rows.every(
        (r) => r.state === "cancelled",
      ),
    );
    assert.equal(
      (
        await pool.query("SELECT state FROM ai_followup_jobs WHERE id=$1", [
          jobs[0].id,
        ])
      ).rows[0].state,
      "cancelled",
    );
    await service.control({
      conversationId: f.conversations[0].id,
      action: "resume",
    });
    const epochs = (
      await pool.query(
        "SELECT automation_epoch FROM ai_conversations ORDER BY id",
      )
    ).rows;
    await service.control({
      conversationId: f.conversations[0].id,
      action: "resume",
    });
    assert.deepEqual(
      (
        await pool.query(
          "SELECT automation_epoch FROM ai_conversations ORDER BY id",
        )
      ).rows,
      epochs,
    );
    assert.equal(actions.length, 2);
  },
);
test(
  "opt-out is contact-wide and cannot be cleared by resume or status change",
  { skip },
  async () => {
    const f = await fixture();
    await service.optOut({ contactId: f.contact, reason: "customer stop" });
    await assert.rejects(
      service.control({
        conversationId: f.conversations[1].id,
        action: "resume",
      }),
      { code: "automation_forbidden" },
    );
    await assert.rejects(
      service.setStatus({
        conversationId: f.conversations[0].id,
        status: "ai_dialog",
        reason: "retry",
      }),
    );
    assert.ok(
      (
        await pool.query("SELECT business_status FROM ai_conversations")
      ).rows.every((r) => r.business_status === "refused"),
    );
  },
);
test(
  "status mutation invalidates late work and qualified requires injected authoritative verifier",
  { skip },
  async () => {
    const f = await fixture();
    await assert.rejects(
      service.setStatus({
        conversationId: f.conversations[0].id,
        status: "qualified",
        reason: "untrusted",
        proof: { passed: true },
      }),
      { code: "qualification_proof_required" },
    );
    const verified = new ConversationWorkflow(pool, {
      verifyQualification: async (_c, id, proof) =>
        id === f.conversations[0].id && proof === "synthetic-approved-proof",
    });
    await verified.setStatus({
      conversationId: f.conversations[0].id,
      status: "qualified",
      reason: "server verified",
      proof: "synthetic-approved-proof",
    });
    assert.equal(
      (await service.detail(f.conversations[0].id)).conversation
        .business_status,
      "qualified",
    );
    assert.equal(
      (await service.detail(f.conversations[0].id)).statusHistory.length,
      1,
    );
  },
);
test(
  "handoff is idempotent, holds both channels and never calls itself notified",
  { skip },
  async () => {
    const f = await fixture();
    const input = {
      conversationId: f.conversations[0].id,
      key: "event-1",
      reason: "human_requested" as const,
      summary: "Synthetic request for manager",
      parameters: { material: "synthetic" },
      source: { messageId: "synthetic-1" },
    };
    const [a, b] = await Promise.all([
      service.handoff(input),
      service.handoff(input),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(a.state, "pending");
    assert.equal(await service.claimNotification(a.id), null);
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM ai_handoff_notifications"))
        .rows[0].n,
      1,
    );
    assert.ok(
      (
        await pool.query("SELECT automation_mode FROM ai_conversations")
      ).rows.every((r) => r.automation_mode === "paused"),
    );
    await assert.rejects(service.handoff({ ...input, summary: "Changed" }), {
      code: "idempotency_payload_conflict",
    });
  },
);
test(
  "notification attempt token protects uncertainty; late confirmed result is retained without resend",
  { skip },
  async () => {
    const f = await fixture();
    await service.saveManagerTarget({
      accountId: f.accounts[0],
      externalId: "manager-chat",
    });
    const n = await service.handoff({
      conversationId: f.conversations[0].id,
      key: "handoff",
      reason: "insufficient_data",
      summary: "Needs details",
    });
    const claim = await service.claimNotification(n.id);
    assert.equal(claim.state, "dispatching");
    await service.notificationOutcome({
      id: n.id,
      attemptToken: claim.attempt_token,
      outcome: "unknown",
    });
    assert.equal(await service.claimNotification(n.id), null);
    assert.equal(
      (
        await service.notificationOutcome({
          id: n.id,
          attemptToken: randomUUID(),
          outcome: "confirmed",
          externalMessageId: "wrong",
        })
      ).state,
      "unknown",
    );
    assert.equal(
      (
        await service.notificationOutcome({
          id: n.id,
          attemptToken: claim.attempt_token,
          outcome: "confirmed",
          externalMessageId: "confirmed",
        })
      ).state,
      "confirmed",
    );
    assert.equal(
      (
        await service.notificationOutcome({
          id: n.id,
          attemptToken: claim.attempt_token,
          outcome: "unknown",
        })
      ).state,
      "confirmed",
    );
  },
);
test(
  "each of four followup scenarios requires explicit enabled config, schedule replay creates no new jobs",
  { skip },
  async () => {
    const f = await fixture();
    await assert.rejects(
      service.scheduleFollowup({
        conversationId: f.conversations[0].id,
        scenario: "no_reply",
        key: "missing",
        anchorAt: "2026-11-13T10:00:00Z",
      }),
      { code: "followup_rule_disabled" },
    );
    for (const scenario of [
      "no_reply",
      "not_booked",
      "not_completed",
      "requested_later",
    ] as const) {
      await service.saveFollowupRule({ ...rule, scenario });
      const a = await service.scheduleFollowup({
        conversationId: f.conversations[0].id,
        scenario,
        key: scenario,
        anchorAt: "2026-11-13T10:00:00Z",
      });
      const b = await service.scheduleFollowup({
        conversationId: f.conversations[0].id,
        scenario,
        key: scenario,
        anchorAt: "2026-11-13T10:00:00Z",
      });
      assert.deepEqual(
        a.map((j) => j.id),
        b.map((j) => j.id),
      );
    }
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM ai_followup_jobs")).rows[0]
        .n,
      8,
    );
  },
);
test(
  "due work enqueues once, later steps wait for confirmed predecessor and actual start delay",
  { skip },
  async () => {
    const f = await fixture();
    await allDay();
    const jobs = await service.scheduleFollowup({
      conversationId: f.conversations[0].id,
      scenario: "no_reply",
      key: "sequence",
      anchorAt: "2026-11-13T10:00:00Z",
    });
    const now = new Date("2026-11-13T10:10:00Z");
    const [a, b] = await Promise.all([
      service.materializeFollowup(jobs[0].id, now),
      service.materializeFollowup(jobs[0].id, now),
    ]);
    assert.equal(a.outbox_id, b.outbox_id);
    assert.equal(
      (await service.materializeFollowup(jobs[1].id, now)).waiting,
      true,
    );
    await pool.query(
      "UPDATE ai_outbox SET state='confirmed',external_message_id='synthetic',dispatch_started_at=$2 WHERE id=$1",
      [a.outbox_id, new Date("2026-11-13T10:09:00Z")],
    );
    assert.equal(
      (await service.materializeFollowup(jobs[1].id, now)).waiting,
      true,
    );
    assert.equal(
      (
        await service.materializeFollowup(
          jobs[1].id,
          new Date("2026-11-13T10:11:00Z"),
        )
      ).state,
      "enqueued",
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM ai_outbox")).rows[0].n,
      2,
    );
  },
);
test(
  "legacy inbound epoch change cancels followups and explicit booking/order/stop/closed cancel all linked work",
  { skip },
  async () => {
    const f = await fixture();
    await allDay();
    const j = await service.scheduleFollowup({
      conversationId: f.conversations[0].id,
      scenario: "no_reply",
      key: "inbound",
      anchorAt: "2026-11-13T10:00:00Z",
    });
    await new AiManagerStore(pool).ingest({
      version: 1,
      platform: "max",
      accountId: f.accounts[0],
      conversationId: "synthetic",
      messageId: "reply",
      occurredAt: "2026-11-13T10:00:00Z",
      direction: "inbound",
      origin: "customer",
      text: "Synthetic reply",
    });
    await service.reconcileFollowups();
    assert.equal(
      (
        await pool.query("SELECT state FROM ai_followup_jobs WHERE id=$1", [
          j[0].id,
        ])
      ).rows[0].state,
      "cancelled",
    );
    for (const reason of [
      "booking",
      "order_completed",
      "requested_stop",
      "closed",
    ] as const) {
      await service.control({
        conversationId: f.conversations[0].id,
        action: "resume",
      });
      const scheduled = await service.scheduleFollowup({
        conversationId: f.conversations[0].id,
        scenario: "no_reply",
        key: reason,
        anchorAt: "2026-11-13T10:00:00Z",
      });
      await service.cancelFollowups({
        conversationId: f.conversations[0].id,
        reason,
      });
      assert.equal(
        (
          await pool.query("SELECT state FROM ai_followup_jobs WHERE id=$1", [
            scheduled[0].id,
          ])
        ).rows[0].state,
        "cancelled",
      );
    }
  },
);
test(
  "final followup gate rechecks disabled rule and working hours after an outbox was materialized",
  { skip },
  async () => {
    const f = await fixture();
    await allDay();
    const jobs = await service.scheduleFollowup({
      conversationId: f.conversations[0].id,
      scenario: "no_reply",
      key: "gate",
      anchorAt: "2026-11-13T10:00:00Z",
    });
    const a = await service.materializeFollowup(
      jobs[0].id,
      new Date("2026-11-13T10:10:00Z"),
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      assert.equal(
        await workflowActionGate(
          client,
          a.outbox_id,
          new Date("2026-11-13T10:10:00Z"),
        ),
        "ready",
      );
      await client.query("COMMIT");
      await service.saveFollowupRule({
        ...rule,
        timezone: "UTC",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        startMinute: 12 * 60,
        endMinute: 14 * 60,
      });
      await client.query("BEGIN");
      assert.equal(
        await workflowActionGate(
          client,
          a.outbox_id,
          new Date("2026-11-13T10:10:00Z"),
        ),
        "wait",
      );
      await client.query("COMMIT");
      await service.saveFollowupRule({ ...rule, enabled: false });
      await client.query("BEGIN");
      assert.equal(
        await workflowActionGate(
          client,
          a.outbox_id,
          new Date("2026-11-13T10:10:00Z"),
        ),
        "cancel",
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);

test(
  "stale AI handoff/status cannot pause a newer generation or opt the contact out",
  { skip },
  async () => {
    const f = await fixture();
    await new AiManagerStore(pool).ingest({
      version: 1,
      platform: "max",
      accountId: f.accounts[0],
      conversationId: "synthetic",
      messageId: "new",
      occurredAt: "2026-11-13T10:00:00Z",
      direction: "inbound",
      origin: "customer",
      text: "New synthetic message",
    });
    await assert.rejects(
      service.handoff({
        conversationId: f.conversations[0].id,
        key: "late",
        reason: "insufficient_data",
        summary: "Old result",
        expectedEpoch: "0",
      }),
      { code: "stale_generation" },
    );
    await assert.rejects(
      service.setStatus({
        conversationId: f.conversations[0].id,
        status: "refused",
        reason: "Old refusal",
        expectedEpoch: "0",
      }),
      { code: "stale_generation" },
    );
    const detail = await service.detail(f.conversations[0].id);
    assert.equal(detail.conversation.automation_mode, "auto");
    assert.equal(detail.contact.opted_out_at, null);
    assert.equal(detail.notifications.length, 0);
  },
);
test(
  "unproved negative status cannot bypass manager review",
  { skip },
  async () => {
    const f = await fixture();
    await assert.rejects(service.handoff({conversationId:f.conversations[0].id,key:'ai-unqualified',reason:'insufficient_data',summary:'Synthetic nonmatch',resultStatus:'unqualified',expectedEpoch:'0'}),/negative_review_proof_required/);
    assert.notEqual((await service.detail(f.conversations[0].id)).conversation.business_status,'unqualified');
  },
);
test(
  "prepared manager transport is bound to target, initiated once and confirmed only from its own acknowledgement",
  { skip },
  async () => {
    const f = await fixture();
    await service.saveManagerTarget({
      accountId: f.accounts[0],
      externalId: "manager",
    });
    const n = await service.handoff({
      conversationId: f.conversations[0].id,
      key: "dispatch",
      reason: "human_requested",
      summary: "Synthetic manager request",
    });
    let sends = 0;
    const prepared = {
      target: { accountId: f.accounts[0], externalId: "manager" },
      start: ({ operationId }: { operationId: string; text: string }) => {
        sends++;
        return {
          acknowledgement: Promise.resolve({
            operationId,
            outcome: "confirmed",
            code: "synthetic",
            externalMessageId: "manager-message",
            retryCondition: "never",
          }),
        };
      },
    };
    await assert.rejects(
      service.dispatchNotification(n.id, {
        ...prepared,
        target: { ...prepared.target, externalId: "wrong" },
      }),
      { code: "prepared_target_mismatch" },
    );
    await Promise.all([
      service.dispatchNotification(n.id, prepared),
      service.dispatchNotification(n.id, prepared),
    ]);
    assert.equal(sends, 1);
    assert.equal(
      (await service.detail(f.conversations[0].id)).notifications[0].state,
      "confirmed",
    );
  },
);

test(
  "handoff created before manager target configuration can bind only while still pending",
  { skip },
  async () => {
    const f = await fixture();
    const n = await service.handoff({
      conversationId: f.conversations[0].id,
      key: "unbound",
      reason: "reply_limit",
      summary: "Synthetic unbound",
    });
    assert.equal(n.target_account_id, null);
    assert.equal(await service.claimNotification(n.id), null);
    await service.saveManagerTarget({
      accountId: f.accounts[0],
      externalId: "configured-manager",
    });
    const claim = await service.claimNotification(n.id);
    assert.equal(claim.target_account_id, f.accounts[0]);
    assert.equal(claim.target_external_id, "configured-manager");
  },
);

test(
  "handoff payload identity survives JSONB property ordering on replay",
  { skip },
  async () => {
    const f = await fixture();
    const input = {
      conversationId: f.conversations[0].id,
      key: "ordered",
      reason: "human_requested" as const,
      summary: "Synthetic",
      parameters: { z: "last", a: "first" },
      source: { chat: "c", author: "a" },
    };
    const a = await service.handoff(input);
    const b = await service.handoff({
      ...input,
      parameters: { a: "first", z: "last" },
      source: { author: "a", chat: "c" },
    });
    assert.equal(a.id, b.id);
  },
);

test('manager receipt is recorded once even when the initiation transaction rolls back',{skip},async()=>{
 const f=await fixture();await service.saveManagerTarget({accountId:f.accounts[0],externalId:'-456'});
 const notice=await service.handoff({conversationId:f.conversations[0].id,key:'commit-failure',reason:'human_requested',summary:'synthetic'});
 let initiated=false,injected=false,starts=0;
 const interrupted={query:pool.query.bind(pool),connect:async()=>{
  const client=await pool.connect();return new Proxy(client,{get(target,key){
   if(key==='query')return(...args:unknown[])=>{
    if(args[0]==='COMMIT'&&initiated&&!injected){injected=true;return Promise.reject(Error('synthetic COMMIT failure'));}
    return Reflect.apply(target.query,target,args);
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
 }} as unknown as pg.Pool;
 const workflow=new ConversationWorkflow(interrupted),prepared={target:{accountId:f.accounts[0],externalId:'-456'},start:(a:{operationId:string})=>{initiated=true;starts++;return{acknowledgement:Promise.resolve({operationId:a.operationId,outcome:'confirmed',externalMessageId:'actual-test-receipt',code:'test_receipt',retryCondition:'never'})};}};
 await workflow.dispatchNotification(notice.id,prepared);await workflow.dispatchNotification(notice.id,prepared);
 assert.equal(injected,true);assert.equal(starts,1);assert.equal((await pool.query('SELECT state FROM ai_handoff_notifications WHERE id=$1',[notice.id])).rows[0].state,'confirmed');
});

test('historical closed channel does not block follow-up of a later active request',{skip},async()=>{
 const f=await fixture();await pool.query("UPDATE ai_conversations SET business_status='closed',automation_mode='paused' WHERE id=$1",[f.conversations[0].id]);await allDay();
 const jobs=await service.scheduleFollowup({conversationId:f.conversations[1].id,scenario:'no_reply',key:'later-active',anchorAt:'2026-11-13T10:00:00Z'});
 const ready=await service.materializeFollowup(jobs[0].id,new Date('2026-11-13T10:10:00Z'));assert.equal(ready.state,'enqueued');
 assert.equal((await pool.query('SELECT business_status FROM ai_conversations WHERE id=$1',[f.conversations[0].id])).rows[0].business_status,'closed');
 await assert.rejects(service.scheduleFollowup({conversationId:f.conversations[0].id,scenario:'no_reply',key:'archived',anchorAt:'2026-11-13T10:00:00Z'}));
});

test('handoff snapshots the selected sender name separately from the source reader',{skip},async()=>{
 const f=await fixture();await pool.query('UPDATE integrations SET name=$2 WHERE id=$1',[f.accounts[0],'Selected sender']);
 const input={conversationId:f.conversations[0].id,key:'sender-name',reason:'human_requested' as const,summary:'Synthetic',source:{readerAccount:'Different reader'}};
 const n=await service.handoff(input);assert.equal(n.channel_snapshot.accountName,'Selected sender');assert.equal(n.source.readerAccount,'Different reader');
 await pool.query('UPDATE integrations SET name=$2 WHERE id=$1',[f.accounts[0],'Renamed later']);const replay=await service.handoff(input);assert.equal(replay.id,n.id);assert.equal(replay.channel_snapshot.accountName,'Selected sender');
});
