import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
const opaque = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => v.trim().length > 0);
export const leadParamsSchema = z
  .array(
    z
      .object({
        key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        value: z.union([
          z.string().trim().min(1).max(500),
          z.number().finite(),
        ]),
        evidenceQuote: z.string().min(1).max(1000),
      })
      .strict(),
  )
  .max(30)
  .refine((v) => new Set(v.map((p) => p.key)).size === v.length);
export const leadSourceSchema = z
  .object({
    platform: z.enum(["max", "whatsapp", "telegram"]),
    accountId: z.string().uuid(),
    chatId: opaque,
    authorId: opaque,
    messageId: opaque,
    occurredAt: z.string().datetime({ offset: true }),
    link: z
      .string()
      .url()
      .max(2048)
      .refine((v) => ["https:", "http:"].includes(new URL(v).protocol))
      .optional(),
    text: z
      .string()
      .min(1)
      .max(8000)
      .refine((v) => v.trim().length > 0),
    sourceKind: z.enum(["manual", "fixture", "monitor"]),
    params: leadParamsSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();
export const leadReviewSchema = z
  .object({
    leadId: z.string().uuid(),
    operationId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    action: z.enum(["edit", "approve", "reject"]),
    params: leadParamsSchema.optional(),
    contactId: z.string().uuid().optional(),
    requestId: z.string().uuid().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export class LeadIntakeError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
function hash(v: unknown) {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}
export function checkLeadEvidence(text: string, params: z.infer<typeof leadParamsSchema>) {
  for (const p of params) {
    if (!text.includes(p.evidenceQuote))
      throw new LeadIntakeError("ungrounded_parameter", 400);
    const at = text.indexOf(p.evidenceQuote);
    const numericContext = text.slice(
      Math.max(0, at - 1),
      at + p.evidenceQuote.length + 1,
    );
    const literal = String(p.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp("(^|[^0-9.,+-])" + literal + "($|[^0-9.,])");
    if (
      typeof p.value === "number"
        ? !(pattern.test(p.evidenceQuote) && pattern.test(numericContext))
        : !p.evidenceQuote
            .toLocaleLowerCase()
            .includes(String(p.value).toLocaleLowerCase())
    )
      throw new LeadIntakeError("ungrounded_parameter", 400);
  }
}
export class LeadIntakeStore {
  constructor(private pool: Pool) {}
  async ingest(input: z.input<typeof leadSourceSchema>) {
    const source = leadSourceSchema.parse(input);
    checkLeadEvidence(source.text, source.params);
    const sourceKey =
      "lead:v1:" +
      hash([
        source.platform,
        source.accountId,
        source.chatId,
        source.messageId,
      ]);
    const sourceFingerprint = hash([
      source.platform,
      source.accountId,
      source.chatId,
      source.authorId,
      source.messageId,
      new Date(source.occurredAt).toISOString(),
      source.link ?? null,
      source.text,
    ]);
    const result = await this.pool.query(
      `INSERT INTO ai_leads(source_key,source_fingerprint,platform,account_id,chat_id,author_id,message_id,occurred_at,source_link,original_text,source_kind,params,confidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(source_key) DO NOTHING RETURNING *`,
      [
        sourceKey,
        sourceFingerprint,
        source.platform,
        source.accountId,
        source.chatId,
        source.authorId,
        source.messageId,
        source.occurredAt,
        source.link ?? null,
        source.text,
        source.sourceKind,
        JSON.stringify(source.params),
        source.confidence,
      ],
    );
    const lead =
      result.rows[0] ??
      (
        await this.pool.query("SELECT * FROM ai_leads WHERE source_key=$1", [
          sourceKey,
        ])
      ).rows[0];
    if (lead.source_fingerprint !== sourceFingerprint)
      throw new LeadIntakeError("source_content_conflict");
    return { lead, replayed: !result.rowCount };
  }
  async list(
    input: {
      status?: "pending" | "approved" | "rejected";
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const q = z
      .object({
        status: z.enum(["pending", "approved", "rejected"]).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).max(1000000).default(0),
      })
      .parse(input);
    const rows = await this.pool.query(
      "SELECT * FROM ai_leads WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3",
      [q.status ?? null, q.limit, q.offset],
    );
    const count = (
      await this.pool.query(
        "SELECT count(*)::int n FROM ai_leads WHERE ($1::text IS NULL OR status=$1)",
        [q.status ?? null],
      )
    ).rows[0].n;
    return { leads: rows.rows, total: count };
  }
  async review(input: z.input<typeof leadReviewSchema>) {
    const q = leadReviewSchema.parse(input),
      fingerprint = hash(q);
    if (
      (q.action === "edit" && !q.params) ||
      (q.action === "approve" && (!q.contactId || !q.requestId)) ||
      (q.action === "reject" && !q.reason)
    )
      throw new LeadIntakeError("invalid_review", 400);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='5s'");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        q.operationId,
      ]);
      const prior = (
        await c.query("SELECT * FROM ai_lead_operations WHERE id=$1", [
          q.operationId,
        ])
      ).rows[0];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new LeadIntakeError("operation_payload_conflict");
        await c.query("COMMIT");
        return { lead: prior.result, replayed: true };
      }
      const lead = (
        await c.query("SELECT * FROM ai_leads WHERE id=$1 FOR UPDATE", [
          q.leadId,
        ])
      ).rows[0];
      if (!lead) throw new LeadIntakeError("lead_not_found", 404);
      if (lead.status !== "pending")
        throw new LeadIntakeError("lead_already_reviewed");
      if (lead.revision !== q.expectedRevision)
        throw new LeadIntakeError("lead_changed");
      const params = q.params ?? lead.params;
      checkLeadEvidence(lead.original_text, params);
      if(q.action==='approve'&&lead.source_message_id)throw new LeadIntakeError('verified_source_route_required');
      if (q.action === "approve") {
        const contact = (
          await c.query(
            "SELECT id,opted_out_at FROM ai_contacts WHERE id=$1 FOR UPDATE",
            [q.contactId],
          )
        ).rows[0];
        if (!contact) throw new LeadIntakeError("contact_not_found", 404);
        if (contact.opted_out_at) throw new LeadIntakeError("contact_excluded");
        await c.query(
          "INSERT INTO ai_requests(id,contact_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
          [q.requestId, q.contactId],
        );
        const request = (
          await c.query("SELECT contact_id FROM ai_requests WHERE id=$1", [
            q.requestId,
          ])
        ).rows[0];
        if (request.contact_id !== q.contactId)
          throw new LeadIntakeError("request_identity_conflict");
      }
      const status =
        q.action === "approve"
          ? "approved"
          : q.action === "reject"
            ? "rejected"
            : "pending";
      const updated = (
        await c.query(
          `UPDATE ai_leads SET params=$2,status=$3,revision=revision+1,contact_id=$4,request_id=$5,review_reason=$6,reviewed_at=CASE WHEN $3<>'pending' THEN now() ELSE NULL END WHERE id=$1 RETURNING *`,
          [
            lead.id,
            JSON.stringify(params),
            status,
            q.action === "approve" ? q.contactId : null,
            q.action === "approve" ? q.requestId : null,
            q.reason ?? null,
          ],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO ai_lead_operations(id,fingerprint,lead_id,result) VALUES($1,$2,$3,$4)",
        [q.operationId, fingerprint, lead.id, JSON.stringify(updated)],
      );
      await c.query("COMMIT");
      return { lead: updated, replayed: false };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}
/** A real search implementation must supply original scoped records; it is not implemented by manual ingestion. */
export type LeadSourceAdapter = {
  kind: "external-search";
  read(cursor: string | null): Promise<{
    items: Omit<z.input<typeof leadSourceSchema>, "sourceKind">[];
    nextCursor: string | null;
  }>;
};
