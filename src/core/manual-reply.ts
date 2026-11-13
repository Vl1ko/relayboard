import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
const manualInput = z
  .object({
    conversationId: z.string().uuid(),
    operationId: z.string().uuid(),
    text: z
      .string()
      .min(1)
      .max(4000)
      .refine((v) => v.trim().length > 0),
  })
  .strict();
export class ManualReplyError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
  ) {
    super(code);
  }
}
/** Creates a manual intent only. The separately gated worker owns any transport invocation. */
export class ManualReplyStore {
  constructor(private readonly pool: Pool) {}
  async create(input: z.input<typeof manualInput>) {
    const data = manualInput.parse(input),
      logicalKey = "manual:" + data.operationId;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([data.conversationId, data.text]))
      .digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='30s'");
      const found = (
        await client.query(
          "SELECT contact_id FROM ai_conversations WHERE id=$1",
          [data.conversationId],
        )
      ).rows[0];
      if (!found) throw new ManualReplyError("conversation_not_found", 404);
      const contact = (
        await client.query("SELECT * FROM ai_contacts WHERE id=$1 FOR UPDATE", [
          found.contact_id,
        ])
      ).rows[0];
      if (!contact) throw new ManualReplyError("contact_not_found", 404);
      const conversations = (
        await client.query(
          "SELECT * FROM ai_conversations WHERE contact_id=$1 ORDER BY id FOR UPDATE",
          [contact.id],
        )
      ).rows;
      const conversation = conversations.find(
        (v) => v.id === data.conversationId,
      );
      if (!conversation) throw new ManualReplyError("conversation_changed");
      const existing = (
        await client.query(
          "SELECT * FROM ai_outbox WHERE kind='manual_reply' AND logical_key=$1",
          [logicalKey],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.contact_id !== contact.id ||
          existing.conversation_id !== data.conversationId ||
          existing.fingerprint !== fingerprint
        )
          throw new ManualReplyError("idempotency_payload_conflict");
        await client.query("COMMIT");
        return { created: false, action: existing };
      }
      if (
        contact.opted_out_at ||
        conversations.some((v) =>
          ["closed", "refused"].includes(v.business_status),
        )
      )
        throw new ManualReplyError("manual_reply_forbidden");
      const changed = conversations.filter(
        (v) =>
          v.automation_mode !== "manual" ||
          v.business_status !== "manager_working",
      );
      const ids = conversations.map((v) => v.id);
      if (changed.length) {
        await client.query(
          "UPDATE ai_conversations SET automation_mode='manual',business_status='manager_working',automation_epoch=automation_epoch+1 WHERE id=ANY($1::uuid[])",
          [changed.map((v) => v.id)],
        );
        for (const c of changed)
          if (c.business_status !== "manager_working")
            await client.query(
              "INSERT INTO ai_workflow_status_history(conversation_id,from_status,to_status,reason) VALUES($1,$2,'manager_working','explicit_manual_reply')",
              [c.id, c.business_status],
            );
      }
      await client.query(
        `UPDATE ai_outbox SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END,cancellation_requested=true,updated_at=now()
    WHERE conversation_id=ANY($1::uuid[]) AND kind<>'manual_reply' AND state IN ('pending','dispatching')`,
        [ids],
      );
      await client.query(
        "UPDATE ai_followup_jobs SET state='cancelled',cancellation_reason='manual_reply',updated_at=now() WHERE conversation_id=ANY($1::uuid[]) AND state IN ('pending','enqueued')",
        [ids],
      );
      const epoch = (
        await client.query(
          "SELECT automation_epoch FROM ai_conversations WHERE id=$1",
          [conversation.id],
        )
      ).rows[0].automation_epoch;
      const action = (
        await client.query(
          `INSERT INTO ai_outbox(contact_id,conversation_id,logical_key,kind,text,fingerprint,automation_epoch)
    VALUES($1,$2,$3,'manual_reply',$4,$5,$6) RETURNING *`,
          [
            contact.id,
            conversation.id,
            logicalKey,
            data.text,
            fingerprint,
            epoch,
          ],
        )
      ).rows[0];
      await client.query("COMMIT");
      return { created: true, action };
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        error.constraint === "ai_outbox_manual_operation_idx"
      )
        throw new ManualReplyError("idempotency_payload_conflict");
      throw error;
    } finally {
      client.release();
    }
  }
}
