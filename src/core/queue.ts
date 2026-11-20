import { Queue } from "bullmq";
import { config } from "./config.js";

const redisUrl = new URL(config.REDIS_URL);
export const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {}),
};
export const publishingQueue = new Queue(config.QUEUE_NAME, {
  connection: redisConnection,
  // Durable business history/receipts live in PostgreSQL; Redis retains bounded job diagnostics.
  defaultJobOptions: {
    removeOnComplete: { age: 86400, count: 2000 },
    removeOnFail: { age: 7 * 86400, count: 2000 },
  },
});

export type FanoutJob = { postId: string };
export type DeliveryJob = { deliveryId: string };
export type DispatchJob = { postId: string; occurrenceKey: string };

export const schedulerKey = (postId: string) => `post:${postId}`;
