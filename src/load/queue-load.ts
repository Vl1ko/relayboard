import { randomUUID } from "node:crypto";
import { encryptCredentials } from "../core/crypto.js";
import { pool } from "../core/db.js";
import { publishingQueue } from "../core/queue.js";

const destinationsPerCycle = Number(process.env.LOAD_DESTINATIONS || 75);
const cycles = Number(process.env.LOAD_CYCLES || 20);
const expected = destinationsPerCycle * cycles;
const marker = `queue-load-${randomUUID()}`;
let integrationId = "";
const postIds: string[] = [];
const startedAt = Date.now();

try {
  const integration = await pool.query(
    "INSERT INTO integrations (platform,name,credential_ciphertext) VALUES ('telegram',$1,$2) RETURNING id",
    [marker, encryptCredentials({})],
  );
  integrationId = integration.rows[0].id;
  const destinationIds: string[] = [];
  for (let index = 0; index < destinationsPerCycle; index += 1) {
    const destination = await pool.query(
      "INSERT INTO destinations (integration_id,external_id,title) VALUES ($1,$2,$3) RETURNING id",
      [integrationId, `${marker}-${index}`, `Нагрузочная группа ${index + 1}`],
    );
    destinationIds.push(destination.rows[0].id);
  }
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const post = await pool.query(
      `INSERT INTO posts (text,mode,status,interval_seconds,max_attempts,retry_delay_seconds)
       VALUES ($1,'now','scheduled',1,1,1) RETURNING id`,
      [`${marker} цикл ${cycle + 1}`],
    );
    const postId = post.rows[0].id as string;
    postIds.push(postId);
    await pool.query("INSERT INTO post_destinations (post_id,destination_id) SELECT $1,unnest($2::uuid[])", [postId,destinationIds]);
    await publishingQueue.add("fanout", { postId }, { jobId: `${marker}-${cycle}` });
  }

  const deadline = Date.now() + 120_000;
  let sent = 0;
  let failed = 0;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT count(*) FILTER (WHERE status='sent')::int AS sent,
              count(*) FILTER (WHERE status IN ('failed','unknown'))::int AS failed
       FROM deliveries WHERE post_id=ANY($1::uuid[])`,
      [postIds],
    );
    sent = result.rows[0].sent;
    failed = result.rows[0].failed;
    if (sent + failed >= expected) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const totals = await pool.query(
    "SELECT count(*)::int AS total,count(DISTINCT id)::int AS unique_ids,count(*) FILTER (WHERE status='sent')::int AS sent FROM deliveries WHERE post_id=ANY($1::uuid[])",
    [postIds],
  );
  const elapsedMs = Date.now() - startedAt;
  const summary = totals.rows[0];
  if (summary.total !== expected || summary.unique_ids !== expected || summary.sent !== expected) {
    throw new Error(`queue integrity failed: ${JSON.stringify(summary)} expected=${expected}`);
  }
  console.log(JSON.stringify({ cycles, destinationsPerCycle, deliveries: expected, elapsedMs, deliveriesPerSecond: Number((expected / (elapsedMs / 1000)).toFixed(1)), lost: 0, duplicates: 0, failed: 0 }));
} finally {
  if (postIds.length) await pool.query("DELETE FROM posts WHERE id=ANY($1::uuid[])", [postIds]).catch(() => undefined);
  if (integrationId) await pool.query("DELETE FROM integrations WHERE id=$1", [integrationId]).catch(() => undefined);
  await publishingQueue.obliterate({ force: true }).catch(() => undefined);
  await publishingQueue.close();
  await pool.end();
}
