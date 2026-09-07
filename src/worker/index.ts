import { Worker, type Job } from "bullmq";
import { createAdapter } from "../core/adapters/index.js";
import { config } from "../core/config.js";
import { classifyDeliveryError, deliveryErrorMessage } from "../core/delivery-policy.js";
import { decryptCredentials } from "../core/crypto.js";
import { pool } from "../core/db.js";
import { publishingQueue, redisConnection, type DeliveryJob, type DispatchJob, type FanoutJob } from "../core/queue.js";

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Delivery timeout after ${milliseconds}ms; outcome unknown`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function scheduleDispatch(postId: string, occurrenceKey: string, delay: number) {
  await publishingQueue.add("dispatch", { postId, occurrenceKey }, {
    jobId: `dispatch-${postId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    delay: Math.max(0, delay * config.QUEUE_DELAY_SCALE),
    removeOnComplete: 2000,
    removeOnFail: 2000,
  });
}

async function reconcilePostStatus(postId: string) {
  await pool.query(
    `UPDATE posts p SET status='completed', updated_at=now()
     WHERE p.id=$1 AND p.mode <> 'recurring' AND p.status='active'
       AND NOT EXISTS (
         SELECT 1 FROM deliveries d
         WHERE d.post_id=p.id AND d.status IN ('queued','sending','paused')
       )`,
    [postId],
  );
}

async function fanout(job: Job<FanoutJob>) {
  const postResult = await pool.query("SELECT id, mode, status, scheduler_enabled FROM posts WHERE id = $1", [job.data.postId]);
  const post = postResult.rows[0];
  if (!post || post.status === "stopped" || post.status === "paused" || (post.mode === "recurring" && !post.scheduler_enabled)) {
    return { skipped: true };
  }

  const occurrenceKey = job.id || `${job.data.postId}-${job.timestamp}`;
  const destinations = await pool.query(
    `SELECT d.id
     FROM post_destinations pd
     JOIN destinations d ON d.id = pd.destination_id
     JOIN integrations i ON i.id = d.integration_id
     WHERE pd.post_id = $1 AND d.enabled AND i.enabled
     ORDER BY i.platform, d.title`,
    [job.data.postId],
  );

  let created = 0;
  for (const destination of destinations.rows) {
    const result = await pool.query(
      `INSERT INTO deliveries (post_id, destination_id, occurrence_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (post_id, destination_id, occurrence_key) DO NOTHING RETURNING id`,
      [job.data.postId, destination.id, occurrenceKey],
    );
    created += result.rowCount || 0;
  }
  await pool.query("UPDATE posts SET status = 'active', updated_at = now() WHERE id = $1 AND status <> 'stopped'", [job.data.postId]);
  if (created > 0) await scheduleDispatch(job.data.postId, occurrenceKey, 0);
  return { deliveries: created, occurrenceKey };
}

async function sendDelivery(deliveryId: string) {
  const result = await pool.query(
    `SELECT d.id, d.status, d.attempt_count, d.occurrence_key,
            p.id AS post_id, p.text, p.status AS post_status, p.interval_seconds, p.max_attempts, p.retry_delay_seconds,
            dst.external_id, i.platform, i.session_key, i.credential_ciphertext
     FROM deliveries d
     JOIN posts p ON p.id = d.post_id
     JOIN destinations dst ON dst.id = d.destination_id
     JOIN integrations i ON i.id = dst.integration_id
     WHERE d.id = $1`,
    [deliveryId],
  );
  const row = result.rows[0];
  if (!row) return { terminal: true, delay: 0 };
  if (row.post_status === "paused") {
    await pool.query("UPDATE deliveries SET status = 'paused' WHERE id = $1 AND status = 'queued'", [row.id]);
    return { terminal: true, delay: 0 };
  }
  if (row.post_status === "stopped") {
    await pool.query("UPDATE deliveries SET status = 'stopped' WHERE id = $1 AND status IN ('queued', 'paused')", [row.id]);
    return { terminal: true, delay: 0 };
  }
  if (row.status !== "queued") return { terminal: false, delay: 0 };

  const claimed = await pool.query(
    `UPDATE deliveries SET status = 'sending', attempt_count = attempt_count + 1
     WHERE id = $1 AND status = 'queued' RETURNING attempt_count`,
    [row.id],
  );
  if (!claimed.rowCount) return { terminal: false, delay: 0 };
  const attachments = await pool.query(
    `SELECT storage_path AS path, original_name AS name, mime_type AS "mimeType", size_bytes::int AS "sizeBytes"
     FROM attachments WHERE post_id = $1 ORDER BY created_at, id`,
    [row.post_id],
  );

  try {
    const adapter = createAdapter(row.platform, decryptCredentials(row.credential_ciphertext), row.session_key);
    const sent = await withTimeout(adapter.send(row.external_id, { text: row.text, attachments: attachments.rows }), config.SEND_TIMEOUT_MS);
    await pool.query(
      `UPDATE deliveries SET status = 'sent', external_message_id = $2, last_error = NULL,
       last_error_kind = NULL, sent_at = now() WHERE id = $1`,
      [row.id, sent.externalMessageId],
    );
    return { terminal: false, delay: Number(row.interval_seconds) * 1000 };
  } catch (error) {
    const kind = classifyDeliveryError(error);
    const attempts = Number(claimed.rows[0].attempt_count);
    const canRetry = kind === "transient" && attempts < Number(row.max_attempts);
    const status = canRetry ? "queued" : kind === "ambiguous" ? "unknown" : "failed";
    await pool.query(
      "UPDATE deliveries SET status = $2, last_error = $3, last_error_kind = $4 WHERE id = $1",
      [row.id, status, deliveryErrorMessage(error), kind],
    );
    return { terminal: false, delay: (canRetry ? Number(row.retry_delay_seconds) : Number(row.interval_seconds)) * 1000 };
  }
}

async function dispatch(job: Job<DispatchJob>) {
  const postResult = await pool.query("SELECT mode, status FROM posts WHERE id = $1", [job.data.postId]);
  const post = postResult.rows[0];
  if (!post || post.status === "paused" || post.status === "stopped") return { skipped: true };

  const next = await pool.query(
    `SELECT id FROM deliveries WHERE post_id = $1 AND occurrence_key = $2 AND status = 'queued'
     ORDER BY queued_at, id LIMIT 1`,
    [job.data.postId, job.data.occurrenceKey],
  );
  if (!next.rowCount) {
    if (post.mode !== "recurring") {
      await pool.query("UPDATE posts SET status = 'completed', updated_at = now() WHERE id = $1 AND status = 'active'", [job.data.postId]);
    }
    return { completed: true };
  }

  const outcome = await sendDelivery(next.rows[0].id);
  const remaining = await pool.query(
    "SELECT 1 FROM deliveries WHERE post_id = $1 AND occurrence_key = $2 AND status = 'queued' LIMIT 1",
    [job.data.postId, job.data.occurrenceKey],
  );
  if (remaining.rowCount && !outcome.terminal) await scheduleDispatch(job.data.postId, job.data.occurrenceKey, outcome.delay);
  else await reconcilePostStatus(job.data.postId);
  return outcome;
}

async function retryDelivery(job: Job<DeliveryJob>) {
  const outcome = await sendDelivery(job.data.deliveryId);
  const delivery = await pool.query("SELECT post_id FROM deliveries WHERE id=$1", [job.data.deliveryId]);
  if (delivery.rowCount) await reconcilePostStatus(delivery.rows[0].post_id);
  return outcome;
}

// Repair jobs left active by older workers after their final delivery.
await pool.query(
  `UPDATE posts p SET status='completed', updated_at=now()
   WHERE p.mode <> 'recurring' AND p.status='active'
     AND NOT EXISTS (
       SELECT 1 FROM deliveries d
       WHERE d.post_id=p.id AND d.status IN ('queued','sending','paused')
     )`,
);

const worker = new Worker(
  config.QUEUE_NAME,
  async (job) => {
    if (job.name === "fanout") return fanout(job as Job<FanoutJob>);
    if (job.name === "dispatch") return dispatch(job as Job<DispatchJob>);
    if (job.name === "deliver") return retryDelivery(job as Job<DeliveryJob>);
    throw new Error(`Unknown job: ${job.name}`);
  },
  { connection: redisConnection, concurrency: 1 },
);

worker.on("failed", (job, error) => console.error(`Failed ${job?.name} ${job?.id}`, error.message));
worker.on("error", (error) => console.error("Worker error", error));
console.log("Relayboard publishing worker started");

async function shutdown() {
  await worker.close();
  await publishingQueue.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
