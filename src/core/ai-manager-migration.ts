import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

export async function applyAiManagerMigration(pool: Pool) {
  const sql = await readFile(new URL("../../database/ai-manager.sql", import.meta.url), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(12677002)");
    // Fail atomically if the required base account schema has not been applied.
    await client.query("SELECT id,platform,enabled,auth_error FROM integrations LIMIT 0");
    await client.query(`CREATE TABLE IF NOT EXISTS ai_schema_migrations (
      version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const existing = await client.query("SELECT checksum FROM ai_schema_migrations WHERE version=1");
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum) throw new Error("AI migration checksum mismatch");
    } else {
      await client.query(sql);
      await client.query("INSERT INTO ai_schema_migrations(version,checksum) VALUES (1,$1)", [checksum]);
    }
    await client.query("COMMIT");
    return { version: 1, applied: !existing.rowCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
