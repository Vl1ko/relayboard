import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { aiSettingsSchema } from "./ai-engine.js";

const sourceSchema = z.object({
  conversationId: z.string().uuid(), accountId: z.string().uuid(),
  platform: z.enum(["max", "whatsapp"]),
  chatId: z.string().min(1).max(512), messageId: z.string().min(1).max(512),
  authorId: z.string().min(1).max(512),
});

/** Only a transport-verified source author may reach this boundary. Never pass model output. */
export async function bindSourceRequest(pool: Pool, input: z.input<typeof sourceSchema>) {
  const s = sourceSchema.parse(input), c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL lock_timeout='5s'");
    const target = (await c.query("SELECT contact_id FROM ai_conversations WHERE id=$1", [s.conversationId])).rows[0];
    if (!target) throw Error("conversation_missing");
    const contact = (await c.query("SELECT * FROM ai_contacts WHERE id=$1 FOR UPDATE", [target.contact_id])).rows[0];
    const v = (await c.query("SELECT * FROM ai_conversations WHERE id=$1 FOR UPDATE", [s.conversationId])).rows[0];
    if (v.account_id !== s.accountId || v.platform !== s.platform) throw Error("source_account_mismatch");
    const key = [s.accountId, s.platform, s.chatId, s.messageId];
    const existing = (await c.query(`SELECT * FROM ai_request_sources WHERE account_id=$1 AND platform=$2 AND external_chat_id=$3 AND external_message_id=$4`, key)).rows[0];
    if (existing) {
      if (existing.conversation_id !== v.id || existing.author_id !== s.authorId) throw Error("source_identity_conflict");
      await c.query("COMMIT");
      return { requestId: existing.request_id as string, created: false, duplicate: true };
    }
    // v12 local MAX stored source identity in the inbox message ID. Preserve
    // that dedup history even when the source ledger did not yet exist.
    const legacy = (await c.query(`SELECT p.request_id FROM ai_inbox i JOIN ai_request_phases p ON p.id=i.request_phase_id WHERE i.conversation_id=$1 AND i.external_message_id=$2`, [v.id, 'group-source:'+s.chatId+':'+s.messageId])).rows[0];
    if (legacy) {
      await c.query(`INSERT INTO ai_request_sources(account_id,platform,external_chat_id,external_message_id,author_id,request_id,conversation_id) VALUES($1,$2,$3,$4,$5,$6,$7)`, [...key, s.authorId, legacy.request_id, v.id]);
      await c.query("COMMIT");
      return { requestId: legacy.request_id as string, created: false, duplicate: true };
    }
    if (contact.opted_out_at) throw Error("contact_opted_out");
    if ((await c.query("SELECT 1 FROM ai_conversations WHERE contact_id=$1 AND manager_hold", [contact.id])).rowCount) throw Error("manager_hold");
    if ((await c.query("SELECT 1 FROM ai_outbox WHERE contact_id=$1 AND state IN ('dispatching','unknown')", [contact.id])).rowCount) throw Error("uncertain_send");
    if (v.business_status === 'refused') throw Error("qualification_forbidden");
    const active = (await c.query("SELECT p.*,r.lifecycle FROM ai_request_phases p JOIN ai_requests r ON r.id=p.request_id WHERE p.id=$1", [v.active_phase_id])).rows[0];
    let requestId: string;
    let created = false;
    if (active?.lifecycle === "open" && !active.closed_at) {
      requestId = active.request_id;
    } else {
      // Legacy conversations without phases can join a single open contact request.
      // Several legacy requests are intentionally not silently merged.
      const open = (await c.query(`SELECT r.id FROM ai_requests r WHERE r.contact_id=$1 AND r.lifecycle='open' AND EXISTS(SELECT 1 FROM ai_request_phases p WHERE p.request_id=r.id AND p.closed_at IS NULL) ORDER BY r.created_at,r.id`, [contact.id])).rows;
      if (open.length > 1) throw Error("multiple_open_requests_require_review");
      const settings = (await c.query("SELECT version,settings FROM ai_engine_settings ORDER BY version DESC LIMIT 1 FOR SHARE")).rows[0];
      if (!aiSettingsSchema.parse(settings.settings).qualificationEnabled) throw Error("qualification_disabled");
      requestId = open[0]?.id ?? randomUUID();
      created = !open.length;
      if (created) await c.query("INSERT INTO ai_requests(id,contact_id) VALUES($1,$2)", [requestId, contact.id]);
      const first = (await c.query("SELECT coalesce(max(ingest_sequence),0)::bigint+1 AS n FROM ai_inbox WHERE conversation_id=$1", [v.id])).rows[0].n;
      const phase = (await c.query(`INSERT INTO ai_request_phases(request_id,conversation_id,first_ingest_sequence,settings_version) VALUES($1,$2,$3,$4) RETURNING id`, [requestId, v.id, first, settings.version])).rows[0];
      await c.query("UPDATE ai_outbox SET state='cancelled',cancellation_requested=true,updated_at=now() WHERE conversation_id=$1 AND state='pending'", [v.id]);
      await c.query("UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason='new_request',updated_at=now() WHERE conversation_id=$1 AND state IN ('pending','enqueued')", [v.id]);
      await c.query("UPDATE ai_engine_state SET fields='{}',reply_count=0,settings_version=$2 WHERE conversation_id=$1", [v.id, settings.version]);
      await c.query("UPDATE ai_conversations SET active_phase_id=$2,automation_epoch=automation_epoch+1,business_status='ai_dialog',automation_mode='auto',manager_hold=false WHERE id=$1", [v.id, phase.id]);
    }
    await c.query(`INSERT INTO ai_request_sources(account_id,platform,external_chat_id,external_message_id,author_id,request_id,conversation_id) VALUES($1,$2,$3,$4,$5,$6,$7)`, [...key, s.authorId, requestId, v.id]);
    await c.query("COMMIT");
    return { requestId, created, duplicate: false };
  } catch (error) { await c.query("ROLLBACK"); throw error; }
  finally { c.release(); }
}
