import {completionTemplate,DEFAULT_GREETING} from './conversation-templates.js';
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { channelMessageKey, channelMessageSchema, channelSendOutcomeSchema, messageDisposition, type ChannelSendOutcome } from "./channel-contracts.js";

import { workflowActionGate } from "./conversation-workflow.js";
import { outreachGuard } from "./outreach-guards.js";

const uuid = z.string().uuid();
const opaque = z.string().min(1).max(512).refine(v => v.trim().length > 0);
const epoch = z.string().regex(/^(0|[1-9][0-9]*)$/);
const enqueueSchema = z.object({
  conversationId: uuid, expectedEpoch: epoch, logicalKey: opaque,
  kind: z.enum(["first_message", "reply", "follow_up"]),
  text: z.string().min(1).refine(v => v.trim().length > 0),
});

type ContactGuard = { opted_out_at: Date | null };
type ConversationGuard = { id:string; contact_id: string; platform: string; account_id: string; automation_mode: string; business_status: string; automation_epoch: string };
type ActionGuard = { id: string; text: string; kind: string; automation_epoch: string; cancellation_requested: boolean };

export type PreparedChannelSend = {
  target: { accountId: string; externalConversationId: string; platform: "max" | "whatsapp" };
  /** Must synchronously initiate an already-prepared request. No await/connect/queue/retry here. */
  start(action: { operationId: string; text: string; conversationId: string }): { acknowledgement: Promise<unknown> };
};

export const QUALIFICATION_NOTICE_TEXT = 'Спасибо, параметры заявки сохранены.';
export class AiStateError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** No live clients, configuration, background timers or network are imported here. */
export class AiManagerStore {
  constructor(private readonly pool: Pool) {}

  private async tx<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      const result = await body(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  // Every mutation uses the same order: contact -> conversation -> action.
  private async lockConversation(client: PoolClient, id: string) {
    const found = await client.query("SELECT contact_id FROM ai_conversations WHERE id=$1", [uuid.parse(id)]);
    if (!found.rowCount) throw new AiStateError("conversation_not_found");
    const contact = (await client.query("SELECT * FROM ai_contacts WHERE id=$1 FOR UPDATE", [found.rows[0].contact_id])).rows[0];
    const conversation = (await client.query("SELECT * FROM ai_conversations WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!conversation || conversation.contact_id !== contact?.id) throw new AiStateError("conversation_changed");
    return { contact, conversation };
  }

  private async invalidate(client: PoolClient, conversationId: string, mode: "auto" | "manual" | "paused", status?: string) {
    await client.query(`UPDATE ai_conversations SET automation_epoch=automation_epoch+1,
      automation_mode=$2,business_status=coalesce($3,business_status) WHERE id=$1`, [conversationId, mode, status ?? null]);
    await client.query(`UPDATE ai_outbox SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END,
      cancellation_requested=true,updated_at=now() WHERE conversation_id=$1 AND state IN ('pending','dispatching')`, [conversationId]);
    await client.query("UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason='conversation_guard_changed',updated_at=now() WHERE conversation_id=$1 AND state IN ('pending','enqueued')",[conversationId]);
  }

  async createContact(displayName = "") {
    z.string().max(256).parse(displayName);
    return (await this.pool.query("INSERT INTO ai_contacts(display_name) VALUES ($1) RETURNING *", [displayName])).rows[0];
  }

  /** Linking a conversation requires an explicitly chosen contact, never fuzzy identity merging. */
  async createConversation(input: { contactId: string; accountId: string; externalId: string }) {
    uuid.parse(input.contactId); uuid.parse(input.accountId); opaque.parse(input.externalId);
    return this.tx(async client => {
      if (!(await client.query("SELECT id FROM ai_contacts WHERE id=$1 FOR UPDATE", [input.contactId])).rowCount) throw new AiStateError("contact_not_found");
      const account = (await client.query("SELECT platform FROM integrations WHERE id=$1 FOR SHARE", [input.accountId])).rows[0];
      if (!account || !["max", "whatsapp"].includes(account.platform)) throw new AiStateError("account_not_supported");
      await client.query(`INSERT INTO ai_conversations(contact_id,account_id,external_id,platform)
        VALUES ($1,$2,$3,$4) ON CONFLICT (account_id,external_id) DO NOTHING`, [input.contactId, input.accountId, input.externalId, account.platform]);
      const row = (await client.query("SELECT * FROM ai_conversations WHERE account_id=$1 AND external_id=$2", [input.accountId, input.externalId])).rows[0];
      if (row.contact_id !== input.contactId) throw new AiStateError("identity_link_conflict");
      return row;
    });
  }

  async ingest(input: unknown) {
    const event = channelMessageSchema.parse(input);
    uuid.parse(event.accountId);
    return this.tx(async client => {
      const found = (await client.query("SELECT id FROM ai_conversations WHERE account_id=$1 AND external_id=$2", [event.accountId, event.conversationId])).rows[0];
      if (!found) throw new AiStateError("conversation_not_found");
      const { conversation } = await this.lockConversation(client, found.id);
      const account = (await client.query("SELECT platform FROM integrations WHERE id=$1", [event.accountId])).rows[0];
      if (account?.platform !== event.platform) throw new AiStateError("account_platform_mismatch");
      const inserted = await client.query(`INSERT INTO ai_inbox
        (event_key,conversation_id,external_message_id,occurred_at,direction,origin,disposition,text)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (event_key) DO NOTHING RETURNING *`,
      [channelMessageKey(event), conversation.id, event.messageId, event.occurredAt, event.direction, event.origin, messageDisposition(event), event.text]);
      if (!inserted.rowCount) {
        const row = (await client.query("SELECT * FROM ai_inbox WHERE event_key=$1", [channelMessageKey(event)])).rows[0];
        return { duplicate: true, event: row };
      }
      const refusal=event.origin==='customer' && /^(?:пожалуйста[,\s]*)?(?:(?:больше\s+)?не\s+(?:пишите|звоните|связывайтесь)(?:\s+(?:мне|со\s+мной|сюда|больше))*|отпишите\s+меня|удалите\s+(?:мой\s+)?(?:номер|контакт)|стоп|stop|unsubscribe)[.!?\s]*$/iu.test(event.text.trim());
      if(refusal){
        await client.query("UPDATE ai_contacts SET opted_out_at=coalesce(opted_out_at,now()),opt_out_reason=coalesce(opt_out_reason,'explicit_customer_refusal') WHERE id=$1",[conversation.contact_id]);
        const linked=await client.query('SELECT id FROM ai_conversations WHERE contact_id=$1 ORDER BY id FOR UPDATE',[conversation.contact_id]);
        for(const row of linked.rows)await this.invalidate(client,row.id,'paused','refused');
      }
      else if (event.origin === "human" || event.origin === "unresolved") {
        const linked=await client.query("SELECT id FROM ai_conversations WHERE contact_id=$1 ORDER BY id FOR UPDATE",[conversation.contact_id]);
        for(const row of linked.rows)await this.invalidate(client,row.id,event.origin==='human'?'manual':'paused',event.origin==='human'?'manager_working':undefined);
      }
      else if (event.origin === "customer") await this.invalidate(client, conversation.id, conversation.automation_mode);
      return { duplicate: false, event: inserted.rows[0] };
    });
  }

  async setMode(conversationId: string, mode: "auto" | "manual" | "paused") {
    z.enum(["auto", "manual", "paused"]).parse(mode);
    return this.tx(async client => {
      const { contact, conversation } = await this.lockConversation(client, conversationId);
      if(mode==='auto'&&(await client.query('SELECT 1 FROM ai_conversations WHERE contact_id=$1 AND manager_hold',[contact.id])).rowCount)throw new AiStateError('manager_hold');
      if (mode === "auto" && (contact.opted_out_at || ["closed", "refused"].includes(conversation.business_status))) throw new AiStateError("automation_forbidden");
      if (conversation.automation_mode === mode) return conversation;
      // Manual/paused may be repeated; they must never silently resume automation.
      const status = mode === "manual" ? "manager_working"
        : mode === "auto" && conversation.business_status === "manager_working" ? "ai_dialog" : undefined;
      await this.invalidate(client, conversationId, mode, status);
      return (await client.query("SELECT * FROM ai_conversations WHERE id=$1", [conversationId])).rows[0];
    });
  }

  async optOut(contactId: string, reason: string) {
    uuid.parse(contactId); opaque.parse(reason);
    return this.tx(async client => {
      const contact = (await client.query("SELECT * FROM ai_contacts WHERE id=$1 FOR UPDATE", [contactId])).rows[0];
      if (!contact) throw new AiStateError("contact_not_found");
      if (!contact.opted_out_at) await client.query("UPDATE ai_contacts SET opted_out_at=now(),opt_out_reason=$2 WHERE id=$1", [contactId, reason]);
      const conversations = await client.query("SELECT id FROM ai_conversations WHERE contact_id=$1 ORDER BY id FOR UPDATE", [contactId]);
      for (const row of conversations.rows) await this.invalidate(client, row.id, "paused", "refused");
    });
  }

  async enqueue(input: z.input<typeof enqueueSchema>) {
    const data = enqueueSchema.parse(input);
    return this.tx(async client => {
      const { contact, conversation } = await this.lockConversation(client, data.conversationId);
      const fingerprint = createHash("sha256").update(JSON.stringify([data.kind, data.text])).digest("hex");
      const existing = (await client.query("SELECT * FROM ai_outbox WHERE contact_id=$1 AND kind=$2 AND logical_key=$3", [contact.id, data.kind, data.logicalKey])).rows[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new AiStateError("idempotency_payload_conflict");
        return { created: false, action: existing };
      }
      if (contact.opted_out_at || conversation.automation_mode !== "auto" || ["closed", "refused"].includes(conversation.business_status)) throw new AiStateError("automation_forbidden");
      if (conversation.automation_epoch !== data.expectedEpoch) throw new AiStateError("stale_generation");
      const action = (await client.query(`INSERT INTO ai_outbox
        (contact_id,conversation_id,logical_key,kind,text,fingerprint,automation_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [contact.id, conversation.id, data.logicalKey, data.kind, data.text, fingerprint, data.expectedEpoch])).rows[0];
      if(data.kind==='reply' && conversation.business_status==='new')await client.query("UPDATE ai_conversations SET business_status='ai_dialog' WHERE id=$1",[conversation.id]);
      return { created: true, action };
    });
  }

  /** One factual completion receipt, bound to an accepted decision and its completed handoff. */
  async enqueueQualificationNotice(decisionId:string){
    uuid.parse(decisionId);
    return this.tx(async client=>{
      const decision=(await client.query("SELECT * FROM ai_engine_decisions WHERE id=$1 AND disposition='handoff' AND business_status IN ('qualified','unqualified')",[decisionId])).rows[0];
      if(!decision)throw new AiStateError('qualification_notice_proof_required');
      const {contact,conversation}=await this.lockConversation(client,decision.conversation_id);
      const logicalKey='qualification-notice:'+decisionId;
      const old=(await client.query("SELECT * FROM ai_outbox WHERE kind='qualification_notice' AND logical_key=$1",[logicalKey])).rows[0];if(old)return old;
      const handoff=(await client.query('SELECT 1 FROM ai_handoff_notifications WHERE conversation_id=$1 AND logical_key=$2',[conversation.id,'ai-handoff:'+decisionId])).rowCount;
      if(!handoff||contact.opted_out_at||conversation.automation_mode!=='paused'||conversation.business_status!==decision.business_status||BigInt(conversation.automation_epoch)!==BigInt(decision.automation_epoch)+1n)throw new AiStateError('qualification_notice_forbidden');
      const savedSettings=(await client.query('SELECT settings FROM ai_engine_settings WHERE version=$1',[decision.settings_version])).rows[0].settings;
      const prior=(await client.query('SELECT 1 FROM ai_outbox WHERE conversation_id=$1 AND dispatch_started_at IS NOT NULL LIMIT 1',[conversation.id])).rowCount;
      const noticeText=(prior?'':(savedSettings.greetingMessage??DEFAULT_GREETING)+'\n\n')+completionTemplate(savedSettings,decision.business_status);
      const fingerprint=createHash('sha256').update(JSON.stringify(['qualification_notice',noticeText])).digest('hex');
      return(await client.query(`INSERT INTO ai_outbox(contact_id,conversation_id,logical_key,kind,text,fingerprint,automation_epoch) VALUES($1,$2,$3,'qualification_notice',$4,$5,$6) RETURNING *`,[contact.id,conversation.id,logicalKey,noticeText,fingerprint,conversation.automation_epoch])).rows[0];
    });
  }

  private async actionContext(client: PoolClient, actionId: string) {
    const found = (await client.query("SELECT conversation_id FROM ai_outbox WHERE id=$1", [uuid.parse(actionId)])).rows[0];
    if (!found) throw new AiStateError("action_not_found");
    const context = await this.lockConversation(client, found.conversation_id);
    const action = (await client.query("SELECT * FROM ai_outbox WHERE id=$1 FOR UPDATE", [actionId])).rows[0];
    return { ...context, action };
  }

  private async gate(client: PoolClient, contact: ContactGuard, conversation: ConversationGuard, action: ActionGuard, reserve = false) {
    // Account lock is shared: disabling auth/account waits until the send initiation boundary.
    const account = (await client.query("SELECT enabled,auth_error FROM integrations WHERE id=$1 FOR SHARE", [conversation.account_id])).rows[0];
    if (contact.opted_out_at || (action.kind === "qualification_notice" ? conversation.automation_mode !== "paused" || !["qualified","unqualified"].includes(conversation.business_status) : action.kind === "manual_reply" ? conversation.automation_mode !== "manual" : conversation.automation_mode !== "auto") || ["closed", "refused"].includes(conversation.business_status)
      || conversation.automation_epoch !== action.automation_epoch || action.cancellation_requested) return "cancel";
    if(!['manual_reply','qualification_notice'].includes(action.kind)&&(await client.query('SELECT 1 FROM ai_conversations WHERE contact_id=$1 AND manager_hold',[conversation.contact_id])).rowCount)return 'cancel';
    if (!account) return "cancel";
    if (!account.enabled || account.auth_error) return "wait";
    if(action.kind==='qualification_notice'){
      const proof=await client.query(`SELECT 1 FROM ai_outbox a JOIN ai_engine_decisions d ON a.logical_key='qualification-notice:'||d.id::text AND a.conversation_id=d.conversation_id JOIN ai_engine_settings k ON k.version=d.settings_version JOIN ai_handoff_notifications n ON n.conversation_id=d.conversation_id AND n.logical_key='ai-handoff:'||d.id::text WHERE a.id=$1 AND d.disposition='handoff' AND d.business_status=$2 AND d.business_status IN ('qualified','unqualified') AND d.automation_epoch+1=$3 AND a.text IN (CASE WHEN d.business_status='qualified' THEN coalesce(k.settings->>'qualifiedMessage',$4) ELSE coalesce(k.settings->>'unqualifiedMessage',$5) END,coalesce(k.settings->>'greetingMessage',$6)||E'\\n\\n'||CASE WHEN d.business_status='qualified' THEN coalesce(k.settings->>'qualifiedMessage',$4) ELSE coalesce(k.settings->>'unqualifiedMessage',$5) END)`,[action.id,conversation.business_status,conversation.automation_epoch,completionTemplate({},'qualified'),completionTemplate({},'unqualified'),DEFAULT_GREETING]);
      if(!proof.rowCount)return 'cancel';
      if((await client.query("SELECT 1 FROM ai_outbox WHERE conversation_id=$1 AND id<>$2 AND state IN ('unknown','dispatching')",[conversation.id,action.id])).rowCount)return 'wait';
    }
    const workflow = await workflowActionGate(client, action.id);
    if(workflow!=="ready")return workflow;
    return outreachGuard(client, action, conversation, reserve);
  }

  /** Prepared transport is injected; no live adapter is installed/wired in this increment.
   * Persist dispatching first, then re-lock and synchronously initiate before releasing cancellation locks.
   * Never await the external response while holding the contact/conversation transaction.
   */
  async dispatch(actionId: string, prepared: PreparedChannelSend) {
    // Reject the obvious unsafe form before invoking it; concrete adapters must also prove
    // there is no deferred work/retry hidden inside a non-async wrapper.
    if (!prepared || typeof prepared.start !== "function" || prepared.start.constructor.name === "AsyncFunction") {
      throw new AiStateError("sender_must_be_prepared");
    }
    const target = z.object({ accountId: uuid, externalConversationId: opaque, platform: z.enum(["max", "whatsapp"]) }).parse(prepared.target);
    const attempt = randomUUID();
    const claimed = await this.tx(async client => {
      const { contact, conversation, action } = await this.actionContext(client, actionId);
      if (action.state !== "pending") return false;
      if (target.accountId !== conversation.account_id || target.externalConversationId !== conversation.external_id || target.platform !== conversation.platform) {
        throw new AiStateError("prepared_target_mismatch");
      }
      const gate = await this.gate(client, contact, conversation, action);
      if (gate !== "ready") {
        if (gate === "cancel") await client.query("UPDATE ai_outbox SET state='cancelled',updated_at=now() WHERE id=$1", [actionId]);
        return false;
      }
      await client.query("UPDATE ai_outbox SET state='dispatching',attempt_token=$2,updated_at=now() WHERE id=$1", [actionId, attempt]);
      return true;
    });
    if (!claimed) return { initiated: false };
    let response: Promise<unknown> | undefined;
    try {
      await this.tx(async client => {
        const { contact, conversation, action } = await this.actionContext(client, actionId);
        if (action.state !== "dispatching" || action.attempt_token !== attempt) return;
        const gate = await this.gate(client, contact, conversation, action, true);
        if (gate !== "ready") {
          await client.query("UPDATE ai_outbox SET state=$2,attempt_token=NULL,updated_at=now() WHERE id=$1",
            [actionId, gate === "cancel" ? "cancelled" : "pending"]);
          return;
        }
        await client.query("UPDATE ai_outbox SET dispatch_started_at=now() WHERE id=$1", [actionId]);
        // Attach a rejection handler immediately; a thrown/invalid outcome remains unknown.
        try {
          const started = prepared.start({ operationId: actionId, text: action.text, conversationId: conversation.id });
          if (!started || !("acknowledgement" in started)) throw new Error("Invalid prepared transport");
          response = Promise.resolve(started.acknowledgement).catch(() => null);
        }
        catch { response = Promise.resolve(null); }
        await client.query("UPDATE ai_outbox SET dispatch_started_at=clock_timestamp() WHERE id=$1",[action.id]);
        // Record after synchronous initiation; this timestamp conservatively bounds the next start.
        await client.query(`UPDATE ai_outreach_clocks SET last_started_at=clock_timestamp() WHERE account_id=$1
          AND EXISTS(SELECT 1 FROM ai_outreach_items WHERE action_id=$2)`, [conversation.account_id,action.id]);
      });
    } catch (error) {
      // If send might have started, leave the durable dispatching state for reconciliation.
      throw error;
    }
    if (!response) return { initiated: false };
    const parsed = channelSendOutcomeSchema.safeParse(await response);
    const outcome: ChannelSendOutcome = parsed.success && parsed.data.operationId === actionId ? parsed.data
      : { operationId: actionId, outcome: "unknown", code: "invalid_or_missing_acknowledgement", retryCondition: "reconcile_or_manual_review" };
    await this.tx(async client => {
      const { action } = await this.actionContext(client, actionId);
      if (action.attempt_token !== attempt || !["dispatching", "unknown"].includes(action.state)) return;
      // Recovery/earlier uncertainty cannot be cleared by a later pre-dispatch rejection.
      const state = action.state === "unknown" && outcome.outcome === "rejected" ? "unknown" : outcome.outcome;
      await client.query(`UPDATE ai_outbox SET state=$2,outcome_code=$3,external_message_id=$4,updated_at=now() WHERE id=$1`,
        [actionId, state, outcome.code, outcome.outcome === "confirmed" ? outcome.externalMessageId : null]);
    });
    return { initiated: true };
  }

  /** Mark a named interrupted attempt unknown; never globally reset/requeue active workers. */
  async markInterrupted(actionId: string, attemptToken: string) {
    uuid.parse(attemptToken);
    return this.tx(async client => {
      await this.actionContext(client, actionId);
      return (await client.query(`UPDATE ai_outbox SET state='unknown',outcome_code='worker_interrupted',updated_at=now()
        WHERE id=$1 AND attempt_token=$2 AND state='dispatching' RETURNING id`, [actionId, attemptToken])).rowCount === 1;
    });
  }
}
