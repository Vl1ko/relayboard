import { lstat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Pool } from "pg";

const eligible = `p.status IN ('completed','stopped') AND p.mode <> 'recurring'
  AND p.media_expired_at IS NULL AND p.finished_at <= now()-make_interval(days => $1::int)
  AND EXISTS (SELECT 1 FROM attachments a WHERE a.post_id=p.id AND a.expired_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.post_id=p.id
    AND d.status IN ('queued','sending','paused','unknown'))
  AND NOT EXISTS (SELECT 1 FROM whatsapp_send_receipts r JOIN deliveries d ON d.id=r.delivery_id
    WHERE d.post_id=p.id AND r.status IN ('sending','unknown'))
  AND NOT EXISTS (SELECT 1 FROM max_send_receipts r JOIN deliveries d ON d.id=r.delivery_id
    WHERE d.post_id=p.id AND r.status IN ('sending','unknown'))`;

function validateDays(days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Invalid attachment retention days");
}

/** Read-only preview: no lifecycle transitions and no filesystem writes. */
export async function previewAttachmentRetention(pool: Pool, days: number) {
  validateDays(days);
  const result = await pool.query(`SELECT count(DISTINCT p.id)::int AS posts,
    count(a.id)::int AS files, coalesce(sum(a.size_bytes),0)::text AS bytes
    FROM posts p JOIN attachments a ON a.post_id=p.id AND a.expired_at IS NULL
    WHERE ${eligible}`, [days]);
  const pending = await pool.query("SELECT count(*)::int AS files FROM attachment_cleanup_jobs");
  return { ...result.rows[0], pendingFiles: pending.rows[0].files, retentionDays: days };
}

/** Expiry and durable unlink jobs commit together. Metadata/history remain intact. */
export async function expirePostAttachments(pool: Pool, days: number, batchSize = 50) {
  validateDays(days);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const posts = await client.query(`SELECT p.id FROM posts p WHERE ${eligible}
      ORDER BY p.finished_at, p.id LIMIT $2 FOR UPDATE OF p SKIP LOCKED`, [days, batchSize]);
    if (!posts.rowCount) { await client.query("COMMIT"); return 0; }
    const ids = posts.rows.map(row => row.id);
    await client.query("UPDATE posts SET media_expired_at=now() WHERE id=ANY($1::uuid[])", [ids]);
    const files = await client.query(`UPDATE attachments SET expired_at=now()
      WHERE post_id=ANY($1::uuid[]) AND expired_at IS NULL`, [ids]);
    await client.query("COMMIT");
    return files.rowCount || 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

/** Uploads never attached to a publication are temporary drafts, not permanent media. */
export async function expireUnattachedUploads(pool:Pool,hours=24,batchSize=100){
 if(!Number.isInteger(hours)||hours<1||hours>87600||!Number.isInteger(batchSize)||batchSize<1||batchSize>1000)throw Error('Invalid unattached upload policy');
 return(await pool.query(`WITH candidates AS(SELECT id FROM attachments WHERE post_id IS NULL AND expired_at IS NULL AND created_at<=now()-make_interval(hours=>$1::int) ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
 UPDATE attachments a SET expired_at=now() FROM candidates c WHERE a.id=c.id AND a.post_id IS NULL AND a.expired_at IS NULL RETURNING a.id`,[hours,batchSize])).rowCount||0;
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Uploads are flat: never traverse outside the configured root or follow symlinks. */
export async function unlinkStoredAttachment(uploadRoot: string, storedPath: string) {
  const path = resolve(storedPath);
  if (dirname(path) !== resolve(uploadRoot)) throw new Error("Attachment path is outside upload root");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Attachment is not a regular file");
    await unlink(path);
  } catch (error) { if (!isMissing(error)) throw error; }
}

/** A crash after unlink but before COMMIT is safe: ENOENT completes the retry. */
export async function drainAttachmentCleanup(pool: Pool, uploadRoot: string, batchSize = 100,
  removeFile = unlinkStoredAttachment) {
  let deleted = 0;
  for (let index = 0; index < batchSize; index += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(`SELECT storage_path FROM attachment_cleanup_jobs
        WHERE next_attempt_at <= now() ORDER BY next_attempt_at, storage_path
        LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!result.rowCount) { await client.query("COMMIT"); break; }
      const path = result.rows[0].storage_path as string;
      try {
        const references = await client.query(
          "SELECT 1 FROM attachments WHERE storage_path=$1 AND expired_at IS NULL LIMIT 1", [path]);
        if (references.rowCount) throw new Error("Attachment still has a live reference");
        await removeFile(uploadRoot, path);
        await client.query("DELETE FROM attachment_cleanup_jobs WHERE storage_path=$1", [path]);
        deleted += 1;
      } catch (error) {
        await client.query(`UPDATE attachment_cleanup_jobs SET attempts=attempts+1,
          last_error=$2, next_attempt_at=now()+make_interval(secs => LEAST(3600,60*(attempts+1)))
          WHERE storage_path=$1`, [path, String(error instanceof Error ? error.message : error).slice(0, 1000)]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  return deleted;
}

/** One non-overlapping pass per process; row locks also support multiple API replicas. */
export function startAttachmentMaintenance(pool: Pool, uploadRoot: string, days: number, intervalMs: number, unattachedHours=24) {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return;
    running = (async () => {
      const expired = await expirePostAttachments(pool, days);
      const drafts = await expireUnattachedUploads(pool,unattachedHours);
      const deleted = await drainAttachmentCleanup(pool, uploadRoot);
      if (expired || deleted || drafts) console.log("Attachment maintenance", { expired, drafts, deleted });
    })().catch(error => console.error("Attachment maintenance failed", error instanceof Error ? error.message : error))
      .finally(() => { running = undefined; });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return async () => { clearInterval(timer); await running; };
}
