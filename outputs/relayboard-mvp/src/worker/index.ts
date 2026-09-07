import { Worker, type Job } from "bullmq";
import { createAdapter } from "../core/adapters/index.js";
import { decryptCredentials } from "../core/crypto.js";
import { pool } from "../core/db.js";
import { publishingQueue, redisConnection, type DeliveryJob, type FanoutJob } from "../core/queue.js";

async function fanout(job: Job<FanoutJob>) {
  const occurrenceKey = job.id || `${job.data.postId}:${job.timestamp}`;
  const destinations = await pool.query(
    `SELECT d.id
     FROM post_destinations pd
     JOIN destinations d ON d.id = pd.destination_id
     JOIN integrations i ON i.id = d.integration_id
     WHERE pd.post_id = $1 AND d.enabled AND i.enabled`,
    [job.data.postId],
  );

  for (const destination of destinations.rows) {
    const result = await pool.query(
      `INSERT INTO deliveries (post_id, destination_id, occurrence_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (post_id, destination_id, occurrence_key) DO NOTHING
       RETURNING id`,
      [job.data.postId, destination.id, occurrenceKey],
    );
    const deliveryId = result.rows[0]?.id;
    if (!deliveryId) continue;
    await publishingQueue.add(
      "deliver",
      { deliveryId },
      {
        jobId: `delivery-${deliveryId}`,
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 2000,
      },
    );
  }
  await pool.query("UPDATE posts SET status = 'active', updated_at = now() WHERE id = $1", [job.data.postId]);
  return { deliveries: destinations.rowCount };
}

async function deliver(job: Job<DeliveryJob>) {
  const result = await pool.query(
    `SELECT d.id, p.text, p.media_url, dst.external_id, i.platform, i.credential_ciphertext
     FROM deliveries d
     JOIN posts p ON p.id = d.post_id
     JOIN destinations dst ON dst.id = d.destination_id
     JOIN integrations i ON i.id = dst.integration_id
     WHERE d.id = $1`,
    [job.data.deliveryId],
  );
  const row = result.rows[0];
  if (!row) return { skipped: true, reason: "Подключение или доставка удалены" };

  await pool.query(
    `UPDATE deliveries SET status = 'sending', attempt_count = attempt_count + 1 WHERE id = $1`,
    [row.id],
  );

  try {
    const adapter = createAdapter(row.platform, decryptCredentials(row.credential_ciphertext));
    const sent = await adapter.send(row.external_id, { text: row.text, mediaUrl: row.media_url });
    await pool.query(
      `UPDATE deliveries
       SET status = 'sent', external_message_id = $2, last_error = NULL, sent_at = now()
       WHERE id = $1`,
      [row.id, sent.externalMessageId],
    );
    return sent;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE deliveries SET status = 'failed', last_error = $2 WHERE id = $1`,
      [row.id, message.slice(0, 2000)],
    );
    throw error;
  }
}

const worker = new Worker(
  "publishing",
  async (job) => {
    if (job.name === "fanout") return fanout(job as Job<FanoutJob>);
    if (job.name === "deliver") return deliver(job as Job<DeliveryJob>);
    throw new Error(`Unknown job: ${job.name}`);
  },
  { connection: redisConnection, concurrency: 8 },
);

worker.on("completed", (job) => console.log(`Completed ${job.name} ${job.id}`));
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
