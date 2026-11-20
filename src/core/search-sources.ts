import type { Pool } from "pg";
import { z } from "zod";
export const searchSourcesSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    sources: z
      .array(
        z
          .object({
            accountId: z.string().uuid(),
            chatId: z.string().min(1).max(512),
            platform: z.enum(["max", "whatsapp"]),
          })
          .strict(),
      ),
  })
  .superRefine((v, c) => {
    if (
      new Set(v.sources.map((s) => JSON.stringify([s.platform, s.chatId])))
        .size !== v.sources.length
    )
      c.addIssue({ code: "custom", message: "Duplicate source" });
  });
export class SearchSourceError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
const choicesSql = `SELECT DISTINCT i.id AS "accountId",d.external_id AS "chatId",i.platform::text AS platform,i.name AS "accountName",d.title FROM destinations d JOIN integrations i ON i.id=d.integration_id WHERE i.enabled AND i.platform::text IN ('max','whatsapp') AND d.kind IN ('group','channel') ORDER BY i.name,d.title`;
export class SearchSourcesStore {
  constructor(private pool: Pool) {}
  async get() {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const revision = (
        await c.query(
          "SELECT revision FROM ai_search_source_settings WHERE id=1",
        )
      ).rows[0].revision;
      const sources = (
        await c.query(
          'SELECT account_id AS "accountId",chat_id AS "chatId",platform FROM ai_search_sources ORDER BY account_id,chat_id',
        )
      ).rows;
      const choices = (await c.query(choicesSql)).rows;
      await c.query("COMMIT");
      return { revision, sources, choices, monitoringActive: false };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async save(input: z.input<typeof searchSourcesSchema>) {
    const data = searchSourcesSchema.parse(input),
      c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const version = (
        await c.query(
          "SELECT revision FROM ai_search_source_settings WHERE id=1 FOR UPDATE",
        )
      ).rows[0].revision;
      if (version !== data.revision)
        throw new SearchSourceError("sources_changed");
      for (const s of data.sources) {
        const found = await c.query(
          "SELECT 1 FROM destinations d JOIN integrations i ON i.id=d.integration_id WHERE i.id=$1 AND d.external_id=$2 AND i.platform::text=$3 AND i.enabled",
          [s.accountId, s.chatId, s.platform],
        );
        if (!found.rowCount)
          throw new SearchSourceError("source_not_available");
      }
      await c.query("DELETE FROM ai_search_sources");
      for (const s of data.sources)
        await c.query(
          "INSERT INTO ai_search_sources(account_id,chat_id,platform)VALUES($1,$2,$3)",
          [s.accountId, s.chatId, s.platform],
        );
      await c.query(
        "UPDATE ai_search_source_settings SET revision=revision+1 WHERE id=1",
      );
      await c.query("COMMIT");
      return {
        revision: version + 1,
        sources: data.sources,
        monitoringActive: false,
      };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}
