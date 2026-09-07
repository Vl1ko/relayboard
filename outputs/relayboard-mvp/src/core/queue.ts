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
export const publishingQueue = new Queue("publishing", { connection: redisConnection });

export type FanoutJob = { postId: string };
export type DeliveryJob = { deliveryId: string };
