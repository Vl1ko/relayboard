import {latestRequestCustomerSequence} from './customer-sequence.js';
import {automaticFollowupGate,type AutomaticFollowupProof} from './followup-guards.js';
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { channelSendOutcomeSchema } from "./channel-contracts.js";

export const workflowStatuses = [
  "new",
  "ai_dialog",
  "qualified",
  "unqualified",
  "insufficient_data",
  "manager_required",
  "manager_working",
  "refused",
  "closed",
] as const;
export type WorkflowStatus = (typeof workflowStatuses)[number];
export const followupScenarios = [
  "no_reply",
  "not_booked",
  "not_completed",
  "requested_later",
] as const;
const uuid = z.string().uuid();
const epoch = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(20);
const text = z.string().trim().min(1).max(4000);
const key = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => v.trim().length > 0);
const timezone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  });
export const followupRuleSchema = z
  .object({
    scenario: z.enum(followupScenarios),
    enabled: z.boolean(),
    label:z.string().trim().min(1).max(120).optional(),
    channel:z.enum(['current','max','whatsapp']).optional(),
    acknowledgementMessage:z.string().trim().min(1).max(2000).optional(),
    timezone,
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((v) => new Set(v).size === v.length),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    steps: z
      .array(
        z.object({ delaySeconds: z.number().int().min(1).max(31536000), text }),
      )
      .min(1)
      .max(20),
    maxSends: z.number().int().min(1).max(20),
  })
  .refine((v) => v.startMinute < v.endMinute && v.steps.length <= v.maxSends);
export type FollowupRule = z.infer<typeof followupRuleSchema>;
export class WorkflowError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
  ) {
    super(code);
  }
}
const transitions: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  new: [
    "ai_dialog",
    "qualified",
    "unqualified",
    "insufficient_data",
    "manager_required",
    "manager_working",
    "refused",
    "closed",
  ],
  ai_dialog: [
    "qualified",
    "unqualified",
    "insufficient_data",
    "manager_required",
    "manager_working",
    "refused",
    "closed",
  ],
  qualified: [
    "manager_required",
    "manager_working",
    "closed",
    "refused",
    "ai_dialog",
  ],
  unqualified: ["closed", "manager_working", "ai_dialog", "refused"],
  insufficient_data: [
    "ai_dialog",
    "qualified",
    "unqualified",
    "manager_required",
    "manager_working",
    "closed",
    "refused",
  ],
  manager_required: ["manager_working", "ai_dialog", "closed", "refused"],
  manager_working: [
    "ai_dialog",
    "qualified",
    "unqualified",
    "insufficient_data",
    "closed",
    "refused",
  ],
  refused: ["closed"],
  closed: [],
};
export function assertWorkflowTransition(
  from: WorkflowStatus,
  to: WorkflowStatus,
  qualifiedProof = false,
) {
  if (to === "qualified" && !qualifiedProof)
    throw new WorkflowError("qualification_proof_required");
  if (from !== to && !transitions[from].includes(to))
    throw new WorkflowError("invalid_status_transition");
}
function date(value: unknown) {
  const d = z.coerce.date().parse(value);
  if (!Number.isFinite(d.getTime()))
    throw new WorkflowError("invalid_date", 400);
  return d;
}
function windowFormatter(rule: FollowupRule) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: rule.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}
function localWindow(
  now: Date,
  rule: FollowupRule,
  formatter = windowFormatter(rule),
) {
  const parts = formatter.formatToParts(now);
  const get = (name: string) => parts.find((p) => p.type === name)?.value ?? "";
  const day =
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) +
    1;
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  return (
    rule.weekdays.includes(day) &&
    minute >= rule.startMinute &&
    minute < rule.endMinute
  );
}
/** UTC minute walk avoids assuming a fixed offset across DST. Windows are same-day, end-exclusive. */
export function nextFollowupWindow(value: Date, raw: FollowupRule) {
  const rule = followupRuleSchema.parse(raw);
  const initial = date(value),
    formatter = windowFormatter(rule);
  if (localWindow(initial, rule, formatter)) return initial;
  let candidate = new Date(Math.ceil(initial.getTime() / 60000) * 60000);
  for (
    let i = 0;
    i <= 8 * 24 * 60;
    i++, candidate = new Date(candidate.getTime() + 60000)
  )
    if (localWindow(candidate, rule, formatter)) return candidate;
  throw new WorkflowError("working_window_not_found");
}
export class ConversationWorkflow {
  constructor(
    private readonly pool: Pool,
    private readonly options: {
      verifyQualification?: (
        client: PoolClient,
        conversationId: string,
        proof: unknown,
      ) => Promise<boolean>;
    } = {},
  ) {}
  private async tx<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='30s'");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private async lock(client: PoolClient, id: string) {
    const found = (
      await client.query(
        "SELECT contact_id FROM ai_conversations WHERE id=$1",
        [uuid.parse(id)],
      )
    ).rows[0];
    if (!found) throw new WorkflowError("conversation_not_found", 404);
    const contact = (
      await client.query("SELECT * FROM ai_contacts WHERE id=$1 FOR UPDATE", [
        found.contact_id,
      ])
    ).rows[0];
    const conversations = (
      await client.query(
        "SELECT * FROM ai_conversations WHERE contact_id=$1 ORDER BY id FOR UPDATE",
        [contact.id],
      )
    ).rows;
    const conversation = conversations.find((r) => r.id === id);
    if (!conversation) throw new WorkflowError("conversation_not_found", 404);
    return { contact, conversations, conversation };
  }
  private async invalidate(
    client: PoolClient,
    conversations: any[],
    mode: "auto" | "manual" | "paused",
    reason: string,
    status?: WorkflowStatus,
  ) {
    const ids = conversations.map((c) => c.id);
    await client.query(
      `UPDATE ai_conversations SET automation_epoch=automation_epoch+1,automation_mode=$2,business_status=coalesce($3,business_status) WHERE id=ANY($1::uuid[])`,
      [ids, mode, status ?? null],
    );
    await client.query(
      `UPDATE ai_outbox SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END,cancellation_requested=true,updated_at=now() WHERE conversation_id=ANY($1::uuid[]) AND state IN ('pending','dispatching')`,
      [ids],
    );
    await client.query(
      `UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason=$2,updated_at=now() WHERE conversation_id=ANY($1::uuid[]) AND state IN ('pending','enqueued')`,
      [ids, reason],
    );
  }
  private async history(
    client: PoolClient,
    conversation: any,
    status: WorkflowStatus,
    reason: string,
  ) {
    if (conversation.business_status === status) return;
    await client.query(
      "INSERT INTO ai_workflow_status_history(conversation_id,from_status,to_status,reason) VALUES($1,$2,$3,$4)",
      [conversation.id, conversation.business_status, status, reason],
    );
    await client.query(
      "UPDATE ai_conversations SET business_status=$2 WHERE id=$1",
      [conversation.id, status],
    );
  }
  async control(input: {
    conversationId: string;
    action: "takeover" | "stop" | "resume";
  }) {
    z.enum(["takeover", "stop", "resume"]).parse(input.action);
    return this.tx(async (client) => {
      const c = await this.lock(client, input.conversationId);
      if (input.action === "resume") {
        if (
          c.contact.opted_out_at || ['closed','refused'].includes(c.conversation.business_status) ||
          c.conversations.some(v=>v.manager_hold||v.business_status==='refused')
        )
          throw new WorkflowError("automation_forbidden");
        // A repeated explicit resume must not invalidate already resumed work.
        const changed = c.conversations.filter(
          (v) => v.automation_mode !== 'auto'&&!['closed','refused'].includes(v.business_status),
        );
        if (changed.length) {
          await this.invalidate(client, changed, "auto", "explicit_resume");
          for (const v of changed)
            if (
              ["manager_working", "manager_required"].includes(
                v.business_status,
              )
            )
              await this.history(client, v, "ai_dialog", "explicit_resume");
        }
      } else {
        await this.invalidate(
          client,
          c.conversations,
          input.action === "takeover" ? "manual" : "paused",
          input.action,
        );
        if (input.action === "takeover")
          for (const v of c.conversations)
            if (!["closed", "refused"].includes(v.business_status))
              await this.history(
                client,
                v,
                "manager_working",
                "explicit_takeover",
              );
      }
      return (
        await client.query(
          "SELECT * FROM ai_conversations WHERE contact_id=$1 ORDER BY id",
          [c.contact.id],
        )
      ).rows;
    });
  }
  async optOut(input: { contactId: string; reason: string }) {
    uuid.parse(input.contactId);
    text.parse(input.reason);
    return this.tx(async (client) => {
      const contact = (
        await client.query("SELECT * FROM ai_contacts WHERE id=$1 FOR UPDATE", [
          input.contactId,
        ])
      ).rows[0];
      if (!contact) throw new WorkflowError("contact_not_found", 404);
      const convs = (
        await client.query(
          "SELECT * FROM ai_conversations WHERE contact_id=$1 ORDER BY id FOR UPDATE",
          [contact.id],
        )
      ).rows;
      await client.query(
        "UPDATE ai_contacts SET opted_out_at=coalesce(opted_out_at,now()),opt_out_reason=coalesce(opt_out_reason,$2) WHERE id=$1",
        [contact.id, input.reason],
      );
      await this.invalidate(client, convs, "paused", "opt_out");
      for (const c of convs)
        await this.history(client, c, "refused", input.reason);
      return { optedOut: true };
    });
  }
  async setStatus(input: {
    conversationId: string;
    status: WorkflowStatus;
    reason: string;
    proof?: unknown;
    expectedEpoch?: string;
  }) {
    z.enum(workflowStatuses).parse(input.status);
    text.parse(input.reason);
    if (input.expectedEpoch !== undefined) epoch.parse(input.expectedEpoch);
    return this.tx(async (client) => {
      const c = await this.lock(client, input.conversationId);
      if (
        input.expectedEpoch !== undefined &&
        c.conversation.automation_epoch !== input.expectedEpoch
      )
        throw new WorkflowError("stale_generation");
      if (input.status === "refused") {
        await client.query(
          "UPDATE ai_contacts SET opted_out_at=coalesce(opted_out_at,now()),opt_out_reason=coalesce(opt_out_reason,$2) WHERE id=$1",
          [c.contact.id, input.reason],
        );
        await this.invalidate(client, c.conversations, "paused", "opt_out");
        for (const v of c.conversations)
          await this.history(client, v, "refused", input.reason);
        return (
          await client.query("SELECT * FROM ai_conversations WHERE id=$1", [
            input.conversationId,
          ])
        ).rows[0];
      }
      const proof =
        input.status === "qualified" &&
        (await this.options.verifyQualification?.(
          client,
          input.conversationId,
          input.proof,
        ));
      assertWorkflowTransition(
        c.conversation.business_status,
        input.status,
        Boolean(proof),
      );
      if(c.conversation.manager_hold&&!["manager_working","closed","refused","qualified"].includes(input.status))throw new WorkflowError("manager_hold");
      if (c.contact.opted_out_at && input.status !== "closed")
        throw new WorkflowError("automation_forbidden");
      if (c.conversation.business_status !== input.status) {
        // Every status mutation invalidates stale decisions/jobs; only explicit resume can enable auto.
        await this.invalidate(
          client,
          c.conversations,
          "paused",
          "status_changed",
        );
        await this.history(client, c.conversation, input.status, input.reason);
      }
      if(input.status==='closed')await client.query('UPDATE ai_conversations SET manager_hold=false WHERE id=$1',[input.conversationId]);
      return (
        await client.query("SELECT * FROM ai_conversations WHERE id=$1", [
          input.conversationId,
        ])
      ).rows[0];
    });
  }
  async saveManagerTarget(input: { accountId: string; externalId: string }) {
    uuid.parse(input.accountId);
    key.parse(input.externalId);
    return this.tx(async (client) => {
      const account = (
        await client.query(
          "SELECT id FROM integrations WHERE id=$1 AND platform='max' FOR SHARE",
          [input.accountId],
        )
      ).rows[0];
      if (!account) throw new WorkflowError("manager_account_not_max", 400);
      return (
        await client.query(
          "INSERT INTO ai_manager_target(id,account_id,external_id) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,external_id=excluded.external_id RETURNING *",
          [input.accountId, input.externalId],
        )
      ).rows[0];
    });
  }
  async managerTarget() {
    return (
      (
        await this.pool.query(
          'SELECT account_id AS "accountId",external_id AS "externalId" FROM ai_manager_target WHERE id=1',
        )
      ).rows[0] ?? null
    );
  }
  async handoff(input: {
    conversationId: string;
    key: string;
    reason:
      | "qualified"
      | "human_requested"
      | "insufficient_data"
      | "reply_limit";
    summary: string;
    parameters?: Record<string, string>;
    source?: Record<string, string>;
    proof?: unknown;
    expectedEpoch?: string;
    resultStatus?: "unqualified" | "insufficient_data";
  }) {
    const data = z
      .object({
        conversationId: uuid,
        expectedEpoch: epoch.optional(),
        resultStatus: z.enum(["unqualified", "insufficient_data"]).optional(),
        key,
        reason: z.enum([
          "qualified",
          "human_requested",
          "insufficient_data",
          "reply_limit",
        ]),
        summary: text,
        parameters: z
          .record(z.string().max(128), z.string().max(2000))
          .default({}),
        source: z.record(z.string().max(128), z.string().max(4000)).optional(),
      })
      .parse(input);
    if (
      Object.keys(data.parameters).length > 50 ||
      Object.keys(data.source ?? {}).length > 20
    )
      throw new WorkflowError("handoff_snapshot_too_large", 400);
    const canonical = (value: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          data.reason,
          data.summary,
          canonical(data.parameters),
          data.source ? canonical(data.source) : null,
          data.resultStatus ?? null,
        ]),
      )
      .digest("hex");
    return this.tx(async (client) => {
      const c = await this.lock(client, data.conversationId);
      const old = (
        await client.query(
          "SELECT * FROM ai_handoff_notifications WHERE conversation_id=$1 AND logical_key=$2",
          [data.conversationId, data.key],
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new WorkflowError("idempotency_payload_conflict");
        return old;
      }
      if (
        data.expectedEpoch !== undefined &&
        data.expectedEpoch !== c.conversation.automation_epoch
      )
        throw new WorkflowError("stale_generation");
      if (
        data.reason === "qualified" &&
        !(await this.options.verifyQualification?.(
          client,
          data.conversationId,
          input.proof,
        ))
      )
        throw new WorkflowError("qualification_proof_required");
      if(data.key.startsWith('ai-handoff:')){
        const proof=(await client.query("SELECT i.ingest_sequence FROM ai_engine_decisions d JOIN ai_inbox i ON i.event_key=d.event_key WHERE d.id::text=$1 AND d.conversation_id=$2 AND d.disposition='handoff' AND d.automation_epoch=$3",[data.key.slice(11),data.conversationId,c.conversation.automation_epoch])).rows[0];
        if(!proof||BigInt(await latestRequestCustomerSequence(client,data.conversationId))>BigInt(proof.ingest_sequence))throw new WorkflowError('superseded_customer_event');
      }
      await this.invalidate(client, c.conversations, "paused", "handoff");
      if (!["closed", "refused"].includes(c.conversation.business_status))
        await this.history(
          client,
          c.conversation,
          data.reason === "qualified"
            ? "qualified"
            : (data.resultStatus ?? "manager_required"),
          "handoff:" + data.reason,
        );
      if(data.reason==='qualified')await client.query('UPDATE ai_conversations SET manager_hold=true WHERE id=$1',[data.conversationId]);
      const target = (
        await client.query("SELECT * FROM ai_manager_target WHERE id=1")
      ).rows[0];
      return (
        await client.query(
          `INSERT INTO ai_handoff_notifications(conversation_id,logical_key,fingerprint,reason,summary,parameters,source,contact_snapshot,channel_snapshot,target_account_id,target_external_id,state,outcome_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            data.conversationId,
            data.key,
            fingerprint,
            data.reason,
            data.summary,
            data.parameters,
            data.source ?? null,
            {
              id: c.contact.id,
              name: c.contact.display_name,
              phone: c.contact.phone_e164 ?? null,
            },
            {
              platform: c.conversation.platform,
              accountId: c.conversation.account_id,
              externalId: c.conversation.external_id,
            },
            target?.account_id ?? null,
            target?.external_id ?? null,
            data.resultStatus==='unqualified'&&data.reason==='insufficient_data'?'rejected':'pending',
            data.resultStatus==='unqualified'&&data.reason==='insufficient_data'?'qualification_not_passed':null,
          ],
        )
      ).rows[0];
    });
  }
  /** Internal sender boundary only. Missing target/auth keeps an honest pending record. */
  async claimNotification(id: string) {
    uuid.parse(id);
    return this.tx(async (client) => {
      const found = (
        await client.query(
          "SELECT conversation_id FROM ai_handoff_notifications WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!found) throw new WorkflowError("notification_not_found", 404);
      await this.lock(client, found.conversation_id);
      let n = (
        await client.query(
          "SELECT * FROM ai_handoff_notifications WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (n.state !== "pending") return null;
      if(n.request_phase_id&&!(await client.query(`SELECT 1 FROM ai_request_phases p JOIN ai_requests r ON r.id=p.request_id JOIN ai_conversations v ON v.active_phase_id=p.id JOIN ai_contacts c ON c.id=v.contact_id WHERE p.id=$1 AND p.closed_at IS NULL AND r.lifecycle='open' AND c.opted_out_at IS NULL`,[n.request_phase_id])).rowCount){
        await client.query("UPDATE ai_handoff_notifications SET state='rejected',outcome_code='request_phase_closed',updated_at=now() WHERE id=$1",[id]);return null;
      }

      if (!n.target_account_id) {
        const configured = (
          await client.query(
            "SELECT account_id,external_id FROM ai_manager_target WHERE id=1",
          )
        ).rows[0];
        if (configured)
          n = (
            await client.query(
              "UPDATE ai_handoff_notifications SET target_account_id=$2,target_external_id=$3,updated_at=now() WHERE id=$1 RETURNING *",
              [id, configured.account_id, configured.external_id],
            )
          ).rows[0];
      }

      const target = n.target_account_id
        ? (
            await client.query(
              "SELECT id FROM integrations WHERE id=$1 AND platform='max' AND enabled AND auth_error IS NULL FOR SHARE",
              [n.target_account_id],
            )
          ).rows[0]
        : null;
      if (!target || !n.target_external_id) return null;
      const token = randomUUID();
      return (
        await client.query(
          "UPDATE ai_handoff_notifications SET state='dispatching',attempt_token=$2,updated_at=now() WHERE id=$1 RETURNING *",
          [id, token],
        )
      ).rows[0];
    });
  }
  /** Prepared notification transport: sync initiation under notification/account locks,
   * acknowledgement outside the transaction; uncertainty never becomes a retry. */
  async dispatchNotification(
    id: string,
    prepared: {
      target: { accountId: string; externalId: string };
      start: (data: { operationId: string; text: string }) => {
        acknowledgement: Promise<unknown>;
      };
    },
  ) {
    uuid.parse(id);
    uuid.parse(prepared?.target?.accountId);
    key.parse(prepared?.target?.externalId);
    if (
      typeof prepared?.start !== "function" ||
      prepared.start.constructor.name === "AsyncFunction"
    )
      throw new WorkflowError("sender_must_be_prepared");
    let original = (
      await this.pool.query(
        "SELECT target_account_id,target_external_id FROM ai_handoff_notifications WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!original) throw new WorkflowError("notification_not_found", 404);
    if (!original.target_account_id) {
      const configured = await this.managerTarget();
      if (configured)
        original = {
          target_account_id: configured.accountId,
          target_external_id: configured.externalId,
        };
    }

    if (
      prepared.target.accountId !== original.target_account_id ||
      prepared.target.externalId !== original.target_external_id
    )
      throw new WorkflowError("prepared_target_mismatch");
    const claim = await this.claimNotification(id);
    if (!claim) return { initiated: false };
    let response: Promise<unknown> | undefined;
    try{
    await this.tx(async (client) => {
      await this.lock(client, claim.conversation_id);
      const current = (
        await client.query(
          "SELECT * FROM ai_handoff_notifications WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (
        current.state !== "dispatching" ||
        current.attempt_token !== claim.attempt_token
      )
        return;
      if (
        current.target_account_id !== prepared.target.accountId ||
        current.target_external_id !== prepared.target.externalId ||
        !(await notificationDispatchGate(client, id, claim.attempt_token))
      ) {
        await client.query(
          "UPDATE ai_handoff_notifications SET state='pending',attempt_token=NULL,updated_at=now() WHERE id=$1",
          [id],
        );
        return;
      }
      const body = JSON.stringify({
        reason: current.reason,
        contact: current.contact_snapshot,
        channel: current.channel_snapshot,
        summary: current.summary,
        parameters: current.parameters,
        source: current.source,
      });
      try {
        const started = prepared.start({ operationId: id, text: body });
        if (!started || !("acknowledgement" in started))
          throw new Error("Invalid notification transport");
        response = Promise.resolve(started.acknowledgement).catch(() => null);
      } catch {
        response = Promise.resolve(null);
      }
    });
    }catch(error){if(!response)throw error;}
    if (!response) return { initiated: false };
    const parsed = channelSendOutcomeSchema.safeParse(await response);
    const outcome =
      parsed.success && parsed.data.operationId === id ? parsed.data : null;
    await this.notificationOutcome({
      id,
      attemptToken: claim.attempt_token,
      outcome: outcome?.outcome ?? "unknown",
      externalMessageId:
        outcome?.outcome === "confirmed"
          ? outcome.externalMessageId
          : undefined,
      code: outcome?.code ?? "invalid_or_missing_acknowledgement",
    });
    return { initiated: true };
  }
  async notificationOutcome(input: {
    id: string;
    attemptToken: string;
    outcome: "confirmed" | "unknown" | "rejected";
    externalMessageId?: string;
    code?: string;
  }) {
    const data = z
      .object({
        id: uuid,
        attemptToken: uuid,
        outcome: z.enum(["confirmed", "unknown", "rejected"]),
        externalMessageId: key.optional(),
        code: z.string().max(256).optional(),
      })
      .parse(input);
    if (data.outcome === "confirmed" && !data.externalMessageId)
      throw new WorkflowError("confirmation_id_required", 400);
    return this.tx(async (client) => {
      const found = (
        await client.query(
          "SELECT conversation_id FROM ai_handoff_notifications WHERE id=$1",
          [data.id],
        )
      ).rows[0];
      if (!found) throw new WorkflowError("notification_not_found", 404);
      await this.lock(client, found.conversation_id);
      const n = (
        await client.query(
          "SELECT * FROM ai_handoff_notifications WHERE id=$1 FOR UPDATE",
          [data.id],
        )
      ).rows[0];
      if (
        n.attempt_token !== data.attemptToken ||
        !["dispatching", "unknown"].includes(n.state)
      )
        return n;
      const state =
        n.state === "unknown" && data.outcome === "rejected"
          ? "unknown"
          : data.outcome;
      return (
        await client.query(
          "UPDATE ai_handoff_notifications SET state=$2,external_message_id=$3,outcome_code=$4,updated_at=now() WHERE id=$1 RETURNING *",
          [
            data.id,
            state,
            state === "confirmed" ? data.externalMessageId : null,
            data.code ?? null,
          ],
        )
      ).rows[0];
    });
  }
  async saveFollowupRule(input:FollowupRule){
    const r=followupRuleSchema.parse(input),labels={no_reply:'Ответ клиента',not_booked:'Этап 1',not_completed:'Этап 2',requested_later:'Связаться позже'};
    return this.tx(async client=>{
      const row=(await client.query(`INSERT INTO ai_followup_rules(scenario,enabled,timezone,weekdays,start_minute,end_minute,steps,max_sends,label,channel,acknowledgement_message,automatic_enabled_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $2 THEN clock_timestamp() END)
       ON CONFLICT(scenario) DO UPDATE SET enabled=excluded.enabled,timezone=excluded.timezone,weekdays=excluded.weekdays,start_minute=excluded.start_minute,end_minute=excluded.end_minute,steps=excluded.steps,max_sends=excluded.max_sends,label=excluded.label,channel=excluded.channel,acknowledgement_message=excluded.acknowledgement_message,
        automatic_enabled_at=CASE WHEN NOT excluded.enabled THEN NULL WHEN NOT ai_followup_rules.enabled THEN clock_timestamp() ELSE ai_followup_rules.automatic_enabled_at END,revision=ai_followup_rules.revision+1,updated_at=now() RETURNING *`,[r.scenario,r.enabled,r.timezone,r.weekdays,r.startMinute,r.endMinute,JSON.stringify(r.steps),r.maxSends,r.label??labels[r.scenario],r.channel??'current',r.acknowledgementMessage??'Хорошо, свяжемся позже.'])).rows[0];
      if(!r.enabled)await client.query("UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason='rule_disabled',updated_at=now() WHERE scenario=$1 AND state IN ('pending','enqueued')",[r.scenario]);
      return row;
    });
  }
  async followupRules() {
    return (
      await this.pool.query("SELECT * FROM ai_followup_rules ORDER BY scenario")
    ).rows;
  }
  async scheduleFollowup(input: {
    conversationId: string;
    scenario: FollowupRule["scenario"];
    key: string;
    anchorAt: string;
    proof?:AutomaticFollowupProof;
  }) {
    uuid.parse(input.conversationId);
    key.parse(input.key);
    z.enum(followupScenarios).parse(input.scenario);
    const anchor = date(input.anchorAt);
    return this.tx(async (client) => {
      const c = await this.lock(client, input.conversationId);
      if(input.proof){
        const p=input.proof;
        if(c.conversation.automation_epoch!==p.expectedEpoch||c.conversation.active_phase_id!==p.expectedPhaseId)throw new WorkflowError('stale_followup_trigger');
        const phase=(await client.query('SELECT request_id FROM ai_request_phases WHERE id=$1',[p.expectedPhaseId])).rows[0];if(!phase)throw new WorkflowError('stale_followup_trigger');
        const pinned=(await client.query('SELECT conversation_id,request_phase_id FROM ai_automatic_followup_triggers WHERE logical_key=$1',[input.key])).rows[0];
        if(pinned)return(await client.query('SELECT * FROM ai_followup_jobs WHERE conversation_id=$1 AND logical_key=$2 ORDER BY step',[pinned.conversation_id,input.key])).rows;
        await client.query('INSERT INTO ai_request_business_state(request_id) VALUES($1) ON CONFLICT DO NOTHING',[phase.request_id]);
        const simulated={conversation_id:c.conversation.id,request_phase_id:p.expectedPhaseId,scenario:input.scenario,trigger_action_id:p.actionId,business_event_id:p.eventId??null,business_revision:p.businessRevision,trigger_customer_sequence:p.customerSequence};
        if(await automaticFollowupGate(client,simulated)!=='ready')throw new WorkflowError('stale_followup_trigger');
      }
      const prior = (
        await client.query(
          "SELECT * FROM ai_followup_jobs WHERE conversation_id=$1 AND logical_key=$2 ORDER BY step",
          [input.conversationId, input.key],
        )
      ).rows;
      if (prior.length) {
        if (prior[0].scenario !== input.scenario)
          throw new WorkflowError("idempotency_payload_conflict");
        return prior;
      }
      if (
        c.contact.opted_out_at ||
        c.conversation.automation_mode !== "auto" ||
        ["closed","refused","manager_required","manager_working"].includes(c.conversation.business_status) ||
        c.conversations.some(v=>v.business_status!=="closed" &&
          (["refused","manager_required","manager_working"].includes(v.business_status) || v.automation_mode==="manual" || v.manager_hold))
      )
        throw new WorkflowError("automation_forbidden");
      const stored = (
        await client.query(
          "SELECT * FROM ai_followup_rules WHERE scenario=$1",
          [input.scenario],
        )
      ).rows[0];
      if (!stored?.enabled) throw new WorkflowError("followup_rule_disabled");
      const rule = followupRuleSchema.parse({
        scenario: stored.scenario,
        enabled: stored.enabled,label:stored.label,channel:stored.channel,acknowledgementMessage:stored.acknowledgement_message,
        timezone: stored.timezone,
        weekdays: stored.weekdays,
        startMinute: stored.start_minute,
        endMinute: stored.end_minute,
        steps: stored.steps,
        maxSends: stored.max_sends,
      });
      if(input.proof){
        const origin=(await client.query('SELECT conversation_id FROM ai_outbox WHERE id=$1',[input.proof.actionId])).rows[0];
        if((rule.channel??'current')==='current'&&origin?.conversation_id!==c.conversation.id||(rule.channel??'current')!=='current'&&rule.channel!==c.conversation.platform)throw new WorkflowError('followup_channel_changed');
        const phase=(await client.query('SELECT request_id FROM ai_request_phases WHERE id=$1',[input.proof.expectedPhaseId])).rows[0];
        await client.query('INSERT INTO ai_automatic_followup_triggers(logical_key,request_id,conversation_id,request_phase_id,scenario,trigger_action_id,business_event_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[input.key,phase.request_id,c.conversation.id,input.proof.expectedPhaseId,input.scenario,input.proof.actionId,input.proof.eventId??null]);
      }
      let due = anchor;
      const jobs = [];
      for (let step = 0; step < rule.steps.length; step++) {
        due = nextFollowupWindow(
          new Date(Math.max(due.getTime() + rule.steps[step].delaySeconds * 1000,step===0&&input.proof?.notBefore?date(input.proof.notBefore).getTime():0)),
          rule,
        );
        jobs.push(
          (
            await client.query(
              `INSERT INTO ai_followup_jobs(conversation_id,logical_key,scenario,step,text,due_at,automation_epoch,rule_snapshot,trigger_action_id,business_event_id,business_revision,trigger_customer_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
              [
                input.conversationId,
                input.key,
                input.scenario,
                step,
                rule.steps[step].text,
                due,
                c.conversation.automation_epoch,
                rule,input.proof?.actionId??null,input.proof?.eventId??null,input.proof?.businessRevision??null,input.proof?.customerSequence??null,
              ],
            )
          ).rows[0],
        );
      }
      return jobs;
    });
  }
  /** Cancellation reconciliation catches legacy ingest/setMode epoch changes too. */
  async reconcileFollowups() {
    return (
      await this.pool.query(
        `UPDATE ai_followup_jobs j SET state='cancelled',cancellation_reason='conversation_guard_changed',updated_at=now() FROM ai_conversations v,ai_contacts c WHERE j.conversation_id=v.id AND v.contact_id=c.id AND j.state IN ('pending','enqueued') AND (j.automation_epoch<>v.automation_epoch OR v.automation_mode<>'auto' OR v.business_status IN ('closed','refused','manager_required','manager_working') OR c.opted_out_at IS NOT NULL)`,
      )
    ).rowCount;
  }
  async dueFollowups(now = new Date()) {
    await this.reconcileFollowups();
    return (
      await this.pool.query(
        `SELECT j.* FROM ai_followup_jobs j JOIN ai_followup_rules r ON r.scenario=j.scenario WHERE j.state='pending' AND j.due_at<=$1 AND r.enabled ORDER BY j.due_at,j.id LIMIT 100`,
        [date(now)],
      )
    ).rows;
  }
  async materializeFollowup(id: string, now = new Date()) {
    uuid.parse(id);
    const at = date(now);
    return this.tx(async (client) => {
      const found = (
        await client.query(
          "SELECT conversation_id FROM ai_followup_jobs WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!found) throw new WorkflowError("followup_not_found", 404);
      const c = await this.lock(client, found.conversation_id);
      const j = (
        await client.query(
          "SELECT * FROM ai_followup_jobs WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (j.state !== "pending") return j;
      if(await automaticFollowupGate(client,j)!=='ready')return(await client.query("UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason='automatic_trigger_changed',updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];
      if (
        c.contact.opted_out_at ||
        c.conversation.automation_mode !== "auto" ||
        c.conversation.automation_epoch !== j.automation_epoch ||
        ["closed","refused","manager_required","manager_working"].includes(c.conversation.business_status) ||
        c.conversations.some(v=>v.business_status!=="closed" &&
          (["refused","manager_required","manager_working"].includes(v.business_status) || v.automation_mode==="manual" || v.manager_hold))
      ) {
        return (
          await client.query(
            "UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason='conversation_guard_changed',updated_at=now() WHERE id=$1 RETURNING *",
            [id],
          )
        ).rows[0];
      }
      const active = (
        await client.query(
          "SELECT enabled FROM ai_followup_rules WHERE scenario=$1",
          [j.scenario],
        )
      ).rows[0];
      if (!active?.enabled || j.due_at > at) return j;
      const rule = followupRuleSchema.parse(j.rule_snapshot);
      if (!localWindow(at, rule)) {
        await client.query(
          "UPDATE ai_followup_jobs SET due_at=$2 WHERE id=$1",
          [id, nextFollowupWindow(at, rule)],
        );
        return { ...j, waiting: true };
      }
      if (j.step > 0) {
        const previous = (
          await client.query(
            `SELECT o.state,o.dispatch_started_at FROM ai_followup_jobs p LEFT JOIN ai_outbox o ON o.id=p.outbox_id WHERE p.conversation_id=$1 AND p.logical_key=$2 AND p.step=$3`,
            [j.conversation_id, j.logical_key, j.step - 1],
          )
        ).rows[0];
        if (
          previous?.state !== "confirmed" ||
          !previous.dispatch_started_at ||
          new Date(previous.dispatch_started_at).getTime() +
            rule.steps[j.step].delaySeconds * 1000 >
            at.getTime()
        )
          return { ...j, waiting: true };
      }
      const logical = "followup:" + j.id;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(["follow_up", j.text]))
        .digest("hex");
      const outbox = (
        await client.query(
          `INSERT INTO ai_outbox(contact_id,conversation_id,logical_key,kind,text,fingerprint,automation_epoch) VALUES($1,$2,$3,'follow_up',$4,$5,$6) ON CONFLICT(contact_id,kind,logical_key) DO UPDATE SET logical_key=ai_outbox.logical_key RETURNING id`,
          [
            c.contact.id,
            j.conversation_id,
            logical,
            j.text,
            fingerprint,
            j.automation_epoch,
          ],
        )
      ).rows[0];
      return (
        await client.query(
          "UPDATE ai_followup_jobs SET state='enqueued',outbox_id=$2,updated_at=now() WHERE id=$1 RETURNING *",
          [id, outbox.id],
        )
      ).rows[0];
    });
  }
  async cancelFollowups(input: {
    conversationId: string;
    reason:
      | "customer_reply"
      | "booking"
      | "order_completed"
      | "requested_stop"
      | "closed";
  }) {
    z.enum([
      "customer_reply",
      "booking",
      "order_completed",
      "requested_stop",
      "closed",
    ]).parse(input.reason);
    return this.tx(async (client) => {
      const c = await this.lock(client, input.conversationId);
      await this.invalidate(client, c.conversations, "paused", input.reason);
      return { cancelled: true };
    });
  }
  async detail(conversationId: string) {
    uuid.parse(conversationId);
    const conversation = (
      await this.pool.query("SELECT * FROM ai_conversations WHERE id=$1", [
        conversationId,
      ])
    ).rows[0];
    if (!conversation) throw new WorkflowError("conversation_not_found", 404);
    const [contact, history, notifications, followups, statusHistory] =
      await Promise.all([
        this.pool.query("SELECT * FROM ai_contacts WHERE id=$1", [
          conversation.contact_id,
        ]),
        this.pool.query(
          "SELECT * FROM (SELECT * FROM ai_inbox WHERE conversation_id=$1 ORDER BY occurred_at DESC,event_key DESC LIMIT 500) recent ORDER BY occurred_at,event_key",
          [conversationId],
        ),
        this.pool.query(
          "SELECT * FROM ai_handoff_notifications WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
          [conversationId],
        ),
        this.pool.query(
          "SELECT * FROM ai_followup_jobs WHERE conversation_id=$1 ORDER BY due_at DESC,id DESC LIMIT 100",
          [conversationId],
        ),
        this.pool.query(
          "SELECT * FROM ai_workflow_status_history WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
          [conversationId],
        ),
      ]);
    return {
      conversation,
      contact: contact.rows[0],
      history: history.rows,
      notifications: notifications.rows,
      followups: followups.rows,
      statusHistory: statusHistory.rows,
    };
  }
}

/** Called inside the final outbox transaction after contact/conversation/action locks.
 * Rule SHARE lock linearizes a disable against synchronous transport start. */
export async function workflowActionGate(
  client: PoolClient,
  actionId: string,
  now = new Date(),
): Promise<"ready" | "wait" | "cancel"> {
  const job = (
    await client.query("SELECT * FROM ai_followup_jobs WHERE outbox_id=$1", [
      actionId,
    ])
  ).rows[0];
  if (!job) return "ready";
  if (job.state !== "enqueued") return "cancel";
  if(await automaticFollowupGate(client,job)!=='ready')return 'cancel';
  const stored = (
    await client.query(
      "SELECT * FROM ai_followup_rules WHERE scenario=$1 FOR SHARE",
      [job.scenario],
    )
  ).rows[0];
  if (
    !stored?.enabled ||
    job.step >= stored.max_sends ||
    job.step >= stored.steps.length
  )
    return "cancel";
  // Re-read after the rule lock: disable/re-enable may have cancelled the job
  // while this transaction was waiting for that lock.
  if((await client.query('SELECT state FROM ai_followup_jobs WHERE id=$1',[job.id])).rows[0]?.state!=='enqueued')return 'cancel';
  const rule = followupRuleSchema.parse({
    scenario: stored.scenario,
    enabled: stored.enabled,
    timezone: stored.timezone,
    weekdays: stored.weekdays,
    startMinute: stored.start_minute,
    endMinute: stored.end_minute,
    steps: stored.steps,
    maxSends: stored.max_sends,
  });
  if (date(now) < job.due_at || !localWindow(date(now), rule)) return "wait";
  if (job.step > 0) {
    const previous = (
      await client.query(
        `SELECT o.state,o.dispatch_started_at FROM ai_followup_jobs p LEFT JOIN ai_outbox o ON o.id=p.outbox_id WHERE p.conversation_id=$1 AND p.logical_key=$2 AND p.step=$3`,
        [job.conversation_id, job.logical_key, job.step - 1],
      )
    ).rows[0];
    const old = followupRuleSchema.parse(job.rule_snapshot);
    const delay = Math.max(
      old.steps[job.step].delaySeconds,
      rule.steps[job.step].delaySeconds,
    );
    if (previous?.state !== "confirmed") return "cancel";
    if (
      !previous.dispatch_started_at ||
      new Date(previous.dispatch_started_at).getTime() + delay * 1000 >
        date(now).getTime()
    )
      return "wait";
  }
  return "ready";
}

/** Internal final notification gate: caller must already hold contact + notification locks. */
export async function notificationDispatchGate(
  client: PoolClient,
  id: string,
  attemptToken: string,
) {
  const n = (
    await client.query("SELECT * FROM ai_handoff_notifications WHERE id=$1", [
      uuid.parse(id),
    ])
  ).rows[0];
  if (
    !n ||
    n.state !== "dispatching" ||
    n.attempt_token !== uuid.parse(attemptToken) ||
    !n.target_account_id ||
    !n.target_external_id
  )
    return false;
  if(n.request_phase_id&&!(await client.query(`SELECT 1 FROM ai_request_phases p JOIN ai_requests r ON r.id=p.request_id JOIN ai_conversations v ON v.active_phase_id=p.id JOIN ai_contacts c ON c.id=v.contact_id WHERE p.id=$1 AND p.closed_at IS NULL AND r.lifecycle='open' AND c.opted_out_at IS NULL`,[n.request_phase_id])).rowCount)return false;
  return Boolean(
    (
      await client.query(
        "SELECT id FROM integrations WHERE id=$1 AND platform='max' AND enabled AND auth_error IS NULL FOR SHARE",
        [n.target_account_id],
      )
    ).rowCount,
  );
}
