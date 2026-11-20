import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

export async function loadAiManagerMigrations() {
  return Promise.all(["ai-manager.sql", "ai-manager-import.sql", "ai-manager-outreach.sql", "ai-manager-outreach-runs.sql", "ai-manager-ai-engine.sql", "ai-manager-workflows.sql", "ai-manager-leads.sql", "ai-manager-manual.sql", "ai-manager-ingest-order.sql", "ai-manager-search-sources.sql", "ai-manager-qualification-notice.sql", "ai-manager-manager-hold.sql", "ai-manager-request-phases.sql", "ai-manager-max-cursors.sql", "ai-manager-identities.sql", "ai-manager-whatsapp-intents.sql", "ai-manager-source-monitor.sql", "ai-manager-automatic-followups.sql", "ai-manager-text-retention.sql", "ai-manager-contact-priority.sql", "ai-manager-service-echo-phases.sql", "ai-manager-idle-inbox.sql", "ai-manager-settings-revision.sql", "ai-manager-import-outreach.sql", "ai-manager-chat-cards-review.sql", "ai-manager-source-notifications.sql"].map(async (name, index) => {
    const sql = await readFile(new URL("../../database/" + name, import.meta.url), "utf8");
    return { version: index + 1, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

export async function applyAiManagerMigration(pool: Pool) {
  const migrations = await loadAiManagerMigrations();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(12677002)");
    // Fail atomically if the required base account schema has not been applied.
    await client.query("SELECT id,platform,enabled FROM integrations LIMIT 0");
    await client.query(`CREATE TABLE IF NOT EXISTS ai_schema_migrations (
      version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    let applied = false;
    for (const migration of migrations) {
      const existing = await client.query("SELECT checksum FROM ai_schema_migrations WHERE version=$1", [migration.version]);
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== migration.checksum) throw new Error("AI migration checksum mismatch");
      } else {
        await client.query(migration.sql);
        await client.query("INSERT INTO ai_schema_migrations(version,checksum) VALUES ($1,$2)", [migration.version, migration.checksum]);
        applied = true;
      }
    }
    await client.query("COMMIT");
    return { version: migrations.at(-1)!.version, applied };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
