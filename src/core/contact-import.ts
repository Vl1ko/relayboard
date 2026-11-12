import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ContactImportError, mapContactRows, summarize, type ColumnMapping, type ContactFile, type ImportRow } from "./contact-file.js";

const uuid = z.string().uuid();
const MAX_ACTIVE_SESSIONS = 10;
const MAX_TOTAL_SESSIONS = 20;
const PAYLOAD_BUDGET = 32 * 1024 * 1024;

export class ContactImportService {
  constructor(private readonly pool: Pool) {}
  private async tx<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='30s'");
      const result = await fn(client); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async purgeExpired() {
    await this.pool.query("DELETE FROM ai_contact_import_sessions WHERE result IS NULL AND expires_at<=now()");
  }
  private async session(client: PoolClient, id: string, owner: string, kind: string, lock = false) {
    const row = (await client.query("SELECT *,expires_at>now() AS fresh FROM ai_contact_import_sessions WHERE id=$1 AND owner_scope=$2 AND kind=$3" + (lock ? " FOR UPDATE" : ""),
      [uuid.parse(id), owner, kind])).rows[0];
    if (!row) throw new ContactImportError("import_session_not_found", 404);
    if (!row.result && !row.fresh) throw new ContactImportError("import_session_expired", 410);
    return row;
  }
  private async save(client: PoolClient, owner: string, kind: string, filename: string, payload: unknown) {
    await client.query("SELECT pg_advisory_xact_lock(12677003)");
    await client.query("DELETE FROM ai_contact_import_sessions WHERE result IS NULL AND expires_at<=now()");
    const stats = (await client.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE owner_scope=$1)::int AS owned,
      coalesce(sum(octet_length(payload::text)),0)::bigint AS bytes
      FROM ai_contact_import_sessions WHERE result IS NULL`, [owner])).rows[0];
    const encoded = JSON.stringify(payload);
    if (stats.owned >= MAX_ACTIVE_SESSIONS || stats.total >= MAX_TOTAL_SESSIONS) throw new ContactImportError("import_session_limit", 429);
    const incomingBytes = (await client.query("SELECT octet_length($1::jsonb::text) AS n", [encoded])).rows[0].n;
    if (Number(stats.bytes) + incomingBytes > PAYLOAD_BUDGET) throw new ContactImportError("import_payload_budget", 413);
    return (await client.query(`INSERT INTO ai_contact_import_sessions(owner_scope,kind,filename,payload)
      VALUES ($1,$2,$3,$4::jsonb) RETURNING id,expires_at`, [owner, kind, filename, encoded])).rows[0];
  }
  async inspect(owner: string, file: ContactFile) {
    return this.tx(async client => {
      const session = await this.save(client, owner, "inspection", file.filename, file);
      return { inspectionId: session.id, filename: file.filename, sheets: file.sheets.map(sheet => ({
        name: sheet.name, columns: sheet.headers.map((label, index) => ({ index, label: label || "Столбец " + (index + 1) })),
        sampleRows: sheet.rows.slice(0, 5).map(row => row.cells),
      })) };
    });
  }
  async preview(owner: string, inspectionId: string, mapping: ColumnMapping) {
    return this.tx(async client => {
      const inspection = await this.session(client, inspectionId, owner, "inspection");
      const rows = mapContactRows(inspection.payload as ContactFile, mapping);
      const phones = [...new Set(rows.flatMap(row => row.phone ? [row.phone] : []))];
      const existing = new Set((await client.query("SELECT phone_e164 FROM ai_contacts WHERE phone_e164=ANY($1::text[])", [phones])).rows.map(row => row.phone_e164));
      for (const row of rows) if (row.outcome === "new" && existing.has(row.phone)) { row.outcome = "duplicate"; row.reason = "already_exists"; }
      const session = await this.save(client, owner, "preview", inspection.filename, rows);
      return { previewId: session.id, expiresAt: session.expires_at, summary: summarize(rows), rows };
    });
  }
  async confirm(owner: string, previewId: string) {
    return this.tx(async client => {
      const session = await this.session(client, previewId, owner, "preview", true);
      if (session.result) return { ...session.result, replayed: true };
      const rows = session.payload as ImportRow[];
      const unique = new Map<string, ImportRow>();
      for (const row of rows) if (row.phone && row.outcome !== "invalid" && !unique.has(row.phone)) unique.set(row.phone, row);
      const input = [...unique.values()].map(row => ({ phone: row.phone, name: row.name || "", comment: row.comment || "", stage: row.stage || "" }));
      const inserted = await client.query(`INSERT INTO ai_contacts(phone_e164,display_name,comment,imported_stage)
        SELECT phone,name,comment,stage FROM jsonb_to_recordset($1::jsonb) AS r(phone text,name text,comment text,stage text)
        ORDER BY phone COLLATE "C"
        ON CONFLICT (phone_e164) DO NOTHING RETURNING id`, [JSON.stringify(input)]);
      const previous = summarize(rows);
      const summary = { total: previous.total, new: inserted.rowCount || 0,
        duplicate: previous.total - previous.invalid - (inserted.rowCount || 0), invalid: previous.invalid };
      const result = { importId: session.id, summary };
      await client.query("UPDATE ai_contact_import_sessions SET result=$2::jsonb,payload=NULL WHERE id=$1", [session.id, JSON.stringify(result)]);
      return { ...result, replayed: false };
    });
  }
  async list(limit: number, offset: number) {
    z.number().int().min(1).max(100).parse(limit); z.number().int().min(0).max(1000000).parse(offset);
    const result = await this.pool.query(`SELECT id,display_name AS "displayName",phone_e164 AS phone,
      comment,imported_stage AS stage,(opted_out_at IS NOT NULL) AS "optedOut"
      FROM ai_contacts ORDER BY created_at DESC,id LIMIT $1 OFFSET $2`, [limit, offset]);
    const total = (await this.pool.query("SELECT count(*)::int AS n FROM ai_contacts")).rows[0].n;
    return { contacts: result.rows, total };
  }
}
