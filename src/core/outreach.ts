import type { Pool } from "pg";
import { z } from "zod";
export const outreachSettingsSchema = z.object({
  revision: z.number().int().nonnegative(),
  template: z.string().max(4000),
  intervalSeconds: z.number().int().min(1).max(86400),
  platforms: z
    .array(z.enum(["max", "whatsapp"]))
    .min(1)
    .max(2)
    .refine((v) => new Set(v).size === v.length),
  accountIds: z
    .array(z.string().uuid())
    .max(50)
    .refine((v) => new Set(v).size === v.length),
});
export const outreachPreviewSchema = z.object({
  revision: z.number().int().nonnegative(),
  requestIds: z
    .array(z.string().uuid())
    .min(1)
    .max(100)
    .refine((v) => new Set(v).size === v.length),
});
export class OutreachError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
const settingsSelect = `SELECT revision,template,interval_seconds AS "intervalSeconds",platforms,account_ids AS "accountIds" FROM ai_outreach_settings WHERE id=1`;
export class OutreachService {
  constructor(private pool: Pool) {}
  async settings() {
    return (await this.pool.query(settingsSelect)).rows[0];
  }
  async requests() {
    return (
      await this.pool.query(
        `SELECT r.id,r.contact_id AS "contactId",c.display_name AS name,c.phone_e164 AS phone FROM ai_requests r JOIN ai_contacts c ON c.id=r.contact_id ORDER BY r.created_at DESC,r.id LIMIT 100`,
      )
    ).rows;
  }
  async createRequest(input: { id: string; contactId: string }) {
    const data = z
      .object({ id: z.string().uuid(), contactId: z.string().uuid() })
      .parse(input);
    const result = await this.pool.query(
      `INSERT INTO ai_requests(id,contact_id) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET id=ai_requests.id WHERE ai_requests.contact_id=excluded.contact_id RETURNING id,contact_id AS "contactId"`,
      [data.id, data.contactId],
    );
    if (!result.rowCount) throw new OutreachError("request_identity_conflict");
    return result.rows[0];
  }
  async save(input: z.input<typeof outreachSettingsSchema>) {
    const s = outreachSettingsSchema.parse(input);
    const updated = await this.pool.query(
      `UPDATE ai_outreach_settings SET template=$2,interval_seconds=$3,platforms=$4,account_ids=$5,revision=revision+1,updated_at=now() WHERE id=1 AND revision=$1 RETURNING revision`,
      [s.revision, s.template, s.intervalSeconds, s.platforms, s.accountIds],
    );
    if (!updated.rowCount) throw new OutreachError("settings_changed");
    // Return the exact revision saved, not a later concurrent writer's settings.
    return { ...s, revision: updated.rows[0].revision };
  }
  async preview(input: z.input<typeof outreachPreviewSchema>) {
    const data = outreachPreviewSchema.parse(input),
      client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const settings = (await client.query(settingsSelect)).rows[0];
      if (settings.revision !== data.revision)
        throw new OutreachError("settings_changed");
      if (!settings.template.trim())
        throw new OutreachError("template_required", 400);
      const found = await client.query(
        `SELECT r.id,r.contact_id,r.lifecycle,c.display_name,c.phone_e164,c.opted_out_at FROM ai_requests r JOIN ai_contacts c ON c.id=r.contact_id WHERE r.id=ANY($1::uuid[])`,
        [data.requestIds],
      );
      if (found.rowCount !== data.requestIds.length)
        throw new OutreachError("request_not_found", 404);
      const routes = (
        await client.query(
          `SELECT v.*,a.enabled,a.auth_error,p.closed_at AS phase_closed_at FROM ai_conversations v LEFT JOIN ai_request_phases p ON p.id=v.active_phase_id LEFT JOIN integrations a ON a.id=v.account_id AND a.platform::text=v.platform WHERE v.contact_id=ANY($1::uuid[])`,
          [found.rows.map((r) => r.contact_id)],
        )
      ).rows;
      const actions = (
        await client.query(
          `SELECT logical_key,state FROM ai_outbox WHERE kind='first_message' AND logical_key=ANY($1::text[])`,
          [data.requestIds.map((id) => "request:" + id)],
        )
      ).rows;
      const seenContacts = new Set<string>();
      const rows = data.requestIds.map((id) => {
        const r = found.rows.find((r) => r.id === id)!;
        const existing = actions.find((a) => a.logical_key === "request:" + id);
        const candidates = routes
          .filter(
            (v) =>
              v.contact_id === r.contact_id &&
              settings.accountIds.includes(v.account_id) &&
              settings.platforms.includes(v.platform),
          )
          .sort(
            (a, b) =>
              settings.platforms.indexOf(a.platform) -
                settings.platforms.indexOf(b.platform) ||
              settings.accountIds.indexOf(a.account_id) -
                settings.accountIds.indexOf(b.account_id) ||
              a.id.localeCompare(b.id),
          );
        // Current human takeover blocks a parallel approach; historical closed phases do not.
        const contactRoutes = routes.filter(
          (v) => v.contact_id === r.contact_id,
        );
        const route = candidates.find(
          (v) =>
            v.enabled &&
            !v.auth_error &&
            v.automation_mode === "auto" &&
            !["closed", "refused"].includes(v.business_status),
        );
        const reason = r.opted_out_at
          ? "opted_out"
          : r.lifecycle==='closed'?'request_closed'
          : contactRoutes.some(v=>v.manager_hold)?'manager_hold'
          : existing
            ? "existing_" + existing.state
            : contactRoutes.some(
                  (v) =>
                    !v.phase_closed_at && (v.automation_mode==='manual'||v.business_status==='refused'||(v.business_status==='closed'&&!v.active_phase_id)),
                )
              ? "manual_or_closed"
              : seenContacts.has(r.contact_id)
                ? "same_contact_in_preview"
                : !route
                  ? "no_ready_conversation"
                  : null;
        if (!reason) seenContacts.add(r.contact_id);
        return {
          requestId: id,
          contactId: r.contact_id,
          name: r.display_name,
          phone: r.phone_e164,
          reason,
          route: reason
            ? null
            : {
                conversationId: route.id,
                accountId: route.account_id,
                platform: route.platform,
                externalId: route.external_id,
              },
        };
      });
      // Missing/paused contacts cannot be made auto implicitly. Preview never mutates them.
      await client.query("COMMIT");
      return {
        revision: settings.revision,
        template: settings.template,
        intervalSeconds: settings.intervalSeconds,
        rows,
        eligible: rows.filter((r) => !r.reason).length,
        canStart: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
