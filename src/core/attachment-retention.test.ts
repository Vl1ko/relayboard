import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { drainAttachmentCleanup, expirePostAttachments, previewAttachmentRetention, unlinkStoredAttachment } from "./attachment-retention.js";

const url = process.env.RETENTION_TEST_DATABASE_URL;
const enabled = Boolean(url);
let pool: pg.Pool;
let root: string;
let schema: string;
const schemaSql = await readFile(new URL("../../database/schema.sql", import.meta.url), "utf8");

before(async () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith("/attachment_retention_test")) {
    throw new Error("Use a dedicated database named attachment_retention_test");
  }
  schema = `retention_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try { await admin.query(`CREATE SCHEMA ${schema}`); } finally { await admin.end(); }
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
  root = await mkdtemp(join(tmpdir(), "relayboard-retention-"));
  // An old completed post receives a full grace period, not its old updated_at.
  await pool.query(schemaSql.split("-- Media lifetime")[0]);
  await pool.query("INSERT INTO posts(text,mode,status,updated_at) VALUES ('legacy','now','completed',now()-interval '100 days')");
  await pool.query(schemaSql);
  const grace = await pool.query("SELECT finished_at > now()-interval '1 minute' AS granted FROM posts");
  assert.equal(grace.rows[0].granted, true);
});

beforeEach(async () => {
  if (!enabled) return;
  await pool.query("TRUNCATE posts, integrations, attachment_cleanup_jobs CASCADE");
});

after(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
  await rm(root, { recursive: true, force: true });
});

async function fixture(options: { status?: string; mode?: string; age?: number; delivery?: string; receipt?: string } = {}) {
  const post = (await pool.query("INSERT INTO posts(text,mode,status) VALUES ('test',$1,$2) RETURNING id",
    [options.mode || "now", options.status || "completed"])).rows[0].id as string;
  const name = `${randomUUID()}.txt`;
  const path = join(root, name);
  await writeFile(path, "retained media");
  const attachment = (await pool.query(`INSERT INTO attachments(post_id,original_name,stored_name,mime_type,size_bytes,storage_path)
    VALUES ($1,'test.txt',$2,'text/plain',14,$3) RETURNING id`, [post, name, path])).rows[0].id as string;
  let delivery: string | undefined;
  let destination: string | undefined;
  if (options.delivery || options.receipt) {
    const integration = (await pool.query("INSERT INTO integrations(platform,name,credential_ciphertext) VALUES ('whatsapp','test','not-a-credential') RETURNING id")).rows[0].id;
    destination = (await pool.query("INSERT INTO destinations(integration_id,external_id,title) VALUES ($1,'group','test') RETURNING id", [integration])).rows[0].id;
    delivery = (await pool.query("INSERT INTO deliveries(post_id,destination_id,occurrence_key,status) VALUES ($1,$2,'occurrence',$3) RETURNING id",
      [post, destination, options.delivery || "failed"])).rows[0].id;
    if (options.receipt) await pool.query("INSERT INTO whatsapp_send_receipts(delivery_id,session_key,destination_id,status) VALUES ($1,'test','group',$2)", [delivery, options.receipt]);
  }
  await pool.query("UPDATE posts SET finished_at=now()-make_interval(days => $2::int) WHERE id=$1", [post, options.age ?? 31]);
  return { post, attachment, path, delivery, destination };
}

test("30-day expiry preserves metadata/history and queues physical deletion durably", { skip: !enabled }, async () => {
  const old = await fixture({ delivery: "sent" });
  await fixture({ age: 29 });
  assert.deepEqual(await previewAttachmentRetention(pool, 30), { posts: 1, files: 1, bytes: "14", pendingFiles: 0, retentionDays: 30 });
  assert.equal(await expirePostAttachments(pool, 30), 1);
  assert.equal(await readFile(old.path, "utf8"), "retained media");
  const metadata = await pool.query("SELECT expired_at FROM attachments WHERE id=$1", [old.attachment]);
  assert.ok(metadata.rows[0].expired_at);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM deliveries WHERE post_id=$1", [old.post])).rows[0].n, 1);
  assert.equal(await drainAttachmentCleanup(pool, root), 1);
  await assert.rejects(readFile(old.path), { code: "ENOENT" });
  assert.equal(await expirePostAttachments(pool, 30), 0);
  assert.equal(await drainAttachmentCleanup(pool, root), 0);
});

test("active/scheduled/paused, every recurring post, unresolved deliveries and receipts keep media", { skip: !enabled }, async () => {
  for (const status of ["active", "scheduled", "paused"]) await fixture({ status, age: 100 });
  for (const status of ["active", "paused", "stopped", "completed"]) await fixture({ status, mode: "recurring", age: 100 });
  for (const delivery of ["queued", "sending", "paused", "unknown"]) await fixture({ delivery, age: 100 });
  for (const receipt of ["sending", "unknown"]) await fixture({ delivery: "failed", receipt, age: 100 });
  assert.equal((await previewAttachmentRetention(pool, 30)).files, 0);
  assert.equal(await expirePostAttachments(pool, 30), 0);
});

test("completion has its own clock; a retry restarts the grace period", { skip: !enabled }, async () => {
  const item = await fixture({ delivery: "failed" });
  await pool.query("UPDATE posts SET updated_at=now() WHERE id=$1", [item.post]);
  assert.equal((await previewAttachmentRetention(pool, 30)).files, 1);
  await pool.query("UPDATE deliveries SET status='queued' WHERE id=$1", [item.delivery]);
  assert.equal(await expirePostAttachments(pool, 30), 0);
  await pool.query("UPDATE deliveries SET status='failed' WHERE id=$1", [item.delivery]);
  assert.equal((await previewAttachmentRetention(pool, 30)).files, 0);
  const fresh = await pool.query("SELECT finished_at > now()-interval '1 minute' AS fresh FROM posts WHERE id=$1", [item.post]);
  assert.equal(fresh.rows[0].fresh, true);
});

test("expired media cannot be retried, reactivated or silently reattached", { skip: !enabled }, async () => {
  const item = await fixture({ delivery: "failed" });
  await expirePostAttachments(pool, 30);
  const guard = (error: unknown) => error instanceof Error && "constraint" in error && error.constraint === "media_not_expired";
  await assert.rejects(pool.query("UPDATE deliveries SET status='queued' WHERE id=$1", [item.delivery]), guard);
  await assert.rejects(pool.query("INSERT INTO deliveries(post_id,destination_id,occurrence_key) VALUES ($1,$2,'stale-fanout')", [item.post, item.destination]), guard);
  await assert.rejects(pool.query("UPDATE posts SET status='active' WHERE id=$1", [item.post]), guard);
  await assert.rejects(pool.query("UPDATE attachments SET expired_at=NULL WHERE id=$1", [item.attachment]), guard);
});

test("a concurrent delivery claim locks its parent and is skipped by retirement", { skip: !enabled }, async () => {
  const item = await fixture({ delivery: "failed" });
  const claim = await pool.connect();
  try {
    await claim.query("BEGIN");
    await claim.query("UPDATE deliveries SET status='sending' WHERE id=$1", [item.delivery]);
    assert.equal(await expirePostAttachments(pool, 30), 0);
    await claim.query("COMMIT");
    assert.equal(await expirePostAttachments(pool, 30), 0);
  } finally { await claim.query("ROLLBACK"); claim.release(); }
});

test("a retry already waiting on retirement cannot revive expired media", { skip: !enabled }, async () => {
  const item = await fixture({ delivery: "failed" });
  const retire = await pool.connect();
  const retry = await pool.connect();
  try {
    const retirePid = (await retire.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const retryPid = (await retry.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await retire.query("BEGIN");
    await retire.query("SELECT id FROM posts WHERE id=$1 FOR UPDATE", [item.post]);
    const waiting = retry.query("UPDATE deliveries SET status='queued' WHERE id=$1", [item.delivery])
      .then(() => null, error => error);
    let blocked = false;
    for (let n = 0; n < 100; n += 1) {
      const blockers = (await retire.query("SELECT pg_blocking_pids($1) AS pids", [retryPid])).rows[0].pids as number[];
      if (blockers.includes(retirePid)) { blocked = true; break; }
      await delay(10);
    }
    assert.equal(blocked, true);
    await retire.query("UPDATE posts SET media_expired_at=now() WHERE id=$1", [item.post]);
    await retire.query("UPDATE attachments SET expired_at=now() WHERE post_id=$1", [item.post]);
    await retire.query("COMMIT");
    assert.equal((await waiting)?.constraint, "media_not_expired");
  } finally {
    await retire.query("ROLLBACK");
    retire.release();
    retry.release();
  }
});

test("two cleanup processes cannot unlink the same job concurrently", { skip: !enabled }, async () => {
  await fixture();
  await expirePostAttachments(pool, 30);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const first = drainAttachmentCleanup(pool, root, 1, async (dir, path) => {
    enter(); await resume; await unlinkStoredAttachment(dir, path);
  });
  await entered;
  try { assert.equal(await drainAttachmentCleanup(pool, root, 1), 0); }
  finally { release(); }
  assert.equal(await first, 1);
});

test("failed unlink is retained for retry; missing files after a crash are acknowledged", { skip: !enabled }, async () => {
  const item = await fixture();
  await expirePostAttachments(pool, 30);
  assert.equal(await drainAttachmentCleanup(pool, root, 1, async () => { throw new Error("simulated EACCES"); }), 0);
  const job = (await pool.query("SELECT attempts,last_error FROM attachment_cleanup_jobs")).rows[0];
  assert.equal(job.attempts, 1);
  assert.match(job.last_error, /EACCES/);
  assert.equal(await readFile(item.path, "utf8"), "retained media");
  await unlink(item.path); // Crash window: unlink succeeded but job acknowledgement did not.
  await pool.query("UPDATE attachment_cleanup_jobs SET next_attempt_at=now()");
  assert.equal(await drainAttachmentCleanup(pool, root), 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM attachment_cleanup_jobs")).rows[0].n, 0);
});

test("explicit/cascade deletion queues cleanup in the same transaction, and rollback cancels it", { skip: !enabled }, async () => {
  const item = await fixture();
  const transaction = await pool.connect();
  try {
    await transaction.query("BEGIN");
    await transaction.query("DELETE FROM posts WHERE id=$1", [item.post]);
    assert.equal((await transaction.query("SELECT count(*)::int AS n FROM attachment_cleanup_jobs")).rows[0].n, 1);
    await transaction.query("ROLLBACK");
  } finally { transaction.release(); }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM attachment_cleanup_jobs")).rows[0].n, 0);
  await pool.query("DELETE FROM posts WHERE id=$1", [item.post]);
  assert.equal(await drainAttachmentCleanup(pool, root), 1);
  await assert.rejects(readFile(item.path), { code: "ENOENT" });
});

test("explicit deletion cannot remove media during an in-flight send", { skip: !enabled }, async () => {
  const item = await fixture({ status: "stopped", delivery: "sending" });
  await assert.rejects(pool.query("DELETE FROM posts WHERE id=$1", [item.post]), error =>
    error instanceof Error && "constraint" in error && error.constraint === "post_in_flight");
  assert.equal(await readFile(item.path, "utf8"), "retained media");
});

test("cleanup refuses traversal/symlinks and never deletes a file with a live reference", { skip: !enabled }, async () => {
  const item = await fixture({ age: 1 });
  await pool.query("INSERT INTO attachment_cleanup_jobs(storage_path) VALUES ($1)", [item.path]);
  assert.equal(await drainAttachmentCleanup(pool, root, 1), 0);
  assert.equal(await readFile(item.path, "utf8"), "retained media");
  await assert.rejects(unlinkStoredAttachment(root, join(root, "..", "outside")), /outside upload root/);
  const link = join(root, `${randomUUID()}.txt`);
  await symlink(item.path, link);
  await assert.rejects(unlinkStoredAttachment(root, link), /not a regular file/);
  assert.equal(await readFile(item.path, "utf8"), "retained media");
});

test("re-running migration preserves already recorded completion dates", { skip: !enabled }, async () => {
  const item = await fixture();
  const before = (await pool.query("SELECT finished_at FROM posts WHERE id=$1", [item.post])).rows[0].finished_at;
  await pool.query(schemaSql);
  const after = (await pool.query("SELECT finished_at FROM posts WHERE id=$1", [item.post])).rows[0].finished_at;
  assert.deepEqual(after, before);
});

test('unknown MAX receipt protects media and outcome metadata even when delivery says failed',{skip:!enabled},async()=>{
 const item=await fixture({status:'stopped',delivery:'failed',age:100});
 await pool.query("INSERT INTO max_send_receipts(delivery_id,account_id,destination_id,status) VALUES($1,$2,'group','unknown')",[item.delivery,randomUUID()]);
 assert.equal((await previewAttachmentRetention(pool,30)).files,0);assert.equal(await expirePostAttachments(pool,30),0);
 await assert.rejects(pool.query('DELETE FROM posts WHERE id=$1',[item.post]),error=>error instanceof Error&&'constraint'in error&&error.constraint==='post_in_flight');
 assert.equal(await readFile(item.path,'utf8'),'retained media');
});
