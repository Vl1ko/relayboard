import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z, ZodError } from "zod";
import { config } from "../core/config.js";
import { listMaxGroups } from "../core/adapters/max.js";
import { decryptCredentials, encryptCredentials } from "../core/crypto.js";
import { pool } from "../core/db.js";
import { publishingQueue } from "../core/queue.js";
import { destinationInput, integrationInput, postInput } from "./schemas.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function normalizeMaxToken(value: string | undefined) {
  const trimmed = value?.trim() || "";
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed.trim();
    if (parsed && typeof parsed === "object" && "token" in parsed && typeof parsed.token === "string") return parsed.token.trim();
  } catch {
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

const requireAdmin: RequestHandler = (request, response, next) => {
  if (request.header("x-admin-key") !== config.ADMIN_API_KEY) {
    response.status(401).json({ error: "Неверный ключ администратора" });
    return;
  }
  next();
};

app.get("/api/health", async (_request, response) => {
  const result = await pool.query("SELECT now() AS database_time");
  response.json({ ok: true, databaseTime: result.rows[0].database_time });
});

app.use("/api", requireAdmin);

app.get("/api/dashboard", async (_request, response) => {
  const [counts, recent] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT count(*)::int FROM integrations WHERE enabled) AS integrations,
        (SELECT count(*)::int FROM destinations WHERE enabled) AS destinations,
        (SELECT count(*)::int FROM deliveries WHERE status = 'sent') AS sent,
        (SELECT count(*)::int FROM deliveries WHERE status = 'failed') AS failed
    `),
    pool.query(`
      SELECT d.id, d.status, d.attempt_count, d.last_error, d.sent_at, d.queued_at,
             p.text, dst.title AS destination_title, i.platform
      FROM deliveries d
      JOIN posts p ON p.id = d.post_id
      JOIN destinations dst ON dst.id = d.destination_id
      JOIN integrations i ON i.id = dst.integration_id
      ORDER BY d.queued_at DESC LIMIT 30
    `),
  ]);
  response.json({ counts: counts.rows[0], recent: recent.rows });
});

app.get("/api/integrations", async (_request, response) => {
  const result = await pool.query(`
    SELECT i.id, i.platform, i.name, i.enabled, i.created_at,
           count(d.id)::int AS destination_count
    FROM integrations i LEFT JOIN destinations d ON d.integration_id = i.id
    GROUP BY i.id ORDER BY i.created_at ASC
  `);
  response.json(result.rows);
});

app.post("/api/integrations", async (request, response) => {
  const input = integrationInput.parse(request.body);
  if (input.platform === "max") {
    const token = normalizeMaxToken(input.credentials.token);
    if (!token) return response.status(400).json({ error: "Нужен токен личной web-сессии MAX" });
    input.credentials.token = token;
    try {
      await listMaxGroups(token);
    } catch (error) {
      return response.status(400).json({ error: `MAX не принял токен: ${error instanceof Error ? error.message : "ошибка входа"}` });
    }
  }
  if (input.platform === "vk") {
    const token = input.credentials.token;
    if (!token) return response.status(400).json({ error: "Нужен пользовательский access token VK" });
    const params = new URLSearchParams({ access_token: token, v: input.credentials.apiVersion || "5.199" });
    const check = await fetch("https://api.vk.com/method/account.getProfileInfo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const body = await check.json() as { response?: { first_name?: string }; error?: { error_msg?: string } };
    if (!check.ok || body.error || !body.response) {
      return response.status(400).json({ error: body.error?.error_msg || "VK не подтвердил пользовательский токен" });
    }
  }
  const result = await pool.query(
    `INSERT INTO integrations (platform, name, credential_ciphertext)
     VALUES ($1, $2, $3)
     RETURNING id, platform, name, enabled, created_at`,
    [input.platform, input.name, encryptCredentials(input.credentials)],
  );
  response.status(201).json(result.rows[0]);
});

app.patch("/api/integrations/:id/toggle", async (request, response) => {
  const result = await pool.query(
    `UPDATE integrations SET enabled = NOT enabled, updated_at = now()
     WHERE id = $1 RETURNING id, platform, name, enabled`,
    [request.params.id],
  );
  if (!result.rowCount) return response.status(404).json({ error: "Подключение не найдено" });
  response.json(result.rows[0]);
});

app.delete("/api/integrations/:id", async (request, response) => {
  const id = z.string().uuid().safeParse(request.params.id);
  if (!id.success) return response.status(400).json({ error: "Некорректный ID подключения" });
  const result = await pool.query(
    `DELETE FROM integrations
     WHERE id = $1
     RETURNING id, platform, name`,
    [id.data],
  );
  if (!result.rowCount) return response.status(404).json({ error: "Подключение не найдено" });
  response.json({ deleted: true, integration: result.rows[0] });
});

app.get("/api/destinations", async (_request, response) => {
  const result = await pool.query(`
    SELECT d.id, d.external_id, d.title, d.kind, d.enabled, d.integration_id,
           i.platform, i.name AS integration_name
    FROM destinations d JOIN integrations i ON i.id = d.integration_id
    ORDER BY i.platform, d.title
  `);
  response.json(result.rows);
});

app.post("/api/destinations", async (request, response) => {
  const input = destinationInput.parse(request.body);
  const result = await pool.query(
    `INSERT INTO destinations (integration_id, external_id, title, kind)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (integration_id, external_id) DO NOTHING
     RETURNING *`,
    [input.integrationId, input.externalId, input.title, input.kind],
  );
  if (!result.rowCount) return response.status(409).json({ error: "Эта беседа уже добавлена" });
  response.status(201).json(result.rows[0]);
});

app.get("/api/max/groups/:integrationId", async (request, response) => {
  const id = z.string().uuid().safeParse(request.params.integrationId);
  if (!id.success) return response.status(400).json({ error: "Некорректный ID подключения" });
  const result = await pool.query(
    `SELECT platform, credential_ciphertext
     FROM integrations
     WHERE id = $1`,
    [id.data],
  );
  if (!result.rowCount) return response.status(404).json({ error: "Подключение не найдено" });
  if (result.rows[0].platform !== "max") return response.status(400).json({ error: "Это не подключение MAX" });
  const credentials = decryptCredentials(result.rows[0].credential_ciphertext);
  if (!credentials.token) return response.status(400).json({ error: "В подключении MAX отсутствует токен" });
  try {
    response.json(await listMaxGroups(credentials.token));
  } catch (error) {
    response.status(401).json({ error: `MAX не принял токен: ${error instanceof Error ? error.message : "авторизуйтесь снова"}` });
  }
});

app.get("/api/posts", async (_request, response) => {
  const result = await pool.query(`
    SELECT p.*, count(pd.destination_id)::int AS destination_count
    FROM posts p LEFT JOIN post_destinations pd ON pd.post_id = p.id
    GROUP BY p.id ORDER BY p.created_at DESC LIMIT 50
  `);
  response.json(result.rows);
});

app.post("/api/posts", async (request, response) => {
  const input = postInput.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO posts (text, media_url, mode, scheduled_at, cron_pattern, timezone)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        input.text,
        input.mediaUrl || null,
        input.mode,
        input.scheduledAt || null,
        input.cronPattern || null,
        input.timezone,
      ],
    );
    const post = result.rows[0];
    for (const destinationId of input.destinationIds) {
      await client.query(
        "INSERT INTO post_destinations (post_id, destination_id) VALUES ($1, $2)",
        [post.id, destinationId],
      );
    }
    await client.query("COMMIT");

    if (input.mode === "recurring") {
      await publishingQueue.upsertJobScheduler(
        `post:${post.id}`,
        { pattern: input.cronPattern!, tz: input.timezone },
        { name: "fanout", data: { postId: post.id } },
      );
    } else {
      const delay = input.mode === "scheduled"
        ? Math.max(0, new Date(input.scheduledAt!).getTime() - Date.now())
        : 0;
      await publishingQueue.add(
        "fanout",
        { postId: post.id },
        { jobId: `post-${post.id}`, delay, removeOnComplete: 1000, removeOnFail: 1000 },
      );
    }
    response.status(201).json(post);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/api/deliveries/:id/retry", async (request, response) => {
  const result = await pool.query(
    `UPDATE deliveries SET status = 'queued', last_error = NULL
     WHERE id = $1 RETURNING id`,
    [request.params.id],
  );
  if (!result.rowCount) return response.status(404).json({ error: "Отправка не найдена" });
  await publishingQueue.add("deliver", { deliveryId: request.params.id }, {
    jobId: `retry-${request.params.id}-${Date.now()}`,
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
  });
  response.status(202).json({ queued: true });
});

app.get("/api/whatsapp/status", async (_request, response) => {
  const upstream = await fetch(`${config.WHATSAPP_BRIDGE_URL}/status`, {
    headers: { authorization: `Bearer ${config.WHATSAPP_BRIDGE_SECRET}` },
  }).catch(() => null);
  if (!upstream) return response.status(503).json({ status: "offline" });
  response.status(upstream.status).json(await upstream.json());
});

app.get("/api/whatsapp/groups", async (_request, response) => {
  const upstream = await fetch(`${config.WHATSAPP_BRIDGE_URL}/groups`, {
    headers: { authorization: `Bearer ${config.WHATSAPP_BRIDGE_SECRET}` },
  });
  response.status(upstream.status).json(await upstream.json());
});

async function telegramProxy(path: string, init?: RequestInit) {
  return fetch(`${config.TELEGRAM_BRIDGE_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.TELEGRAM_BRIDGE_SECRET}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
}

app.get("/api/telegram/status", async (_request, response) => {
  const upstream = await telegramProxy("/status").catch(() => null);
  if (!upstream) return response.status(503).json({ status: "offline" });
  response.status(upstream.status).json(await upstream.json());
});

app.post("/api/telegram/auth/qr", async (request, response) => {
  const upstream = await telegramProxy("/auth/qr", { method: "POST", body: JSON.stringify(request.body) });
  response.status(upstream.status).json(await upstream.json());
});

app.post("/api/telegram/auth/password", async (request, response) => {
  const upstream = await telegramProxy("/auth/password", { method: "POST", body: JSON.stringify(request.body) });
  response.status(upstream.status).json(await upstream.json());
});

app.get("/api/telegram/dialogs", async (_request, response) => {
  const upstream = await telegramProxy("/dialogs");
  response.status(upstream.status).json(await upstream.json());
});

const webRoot = fileURLToPath(new URL("../../dist-web", import.meta.url));
if (config.NODE_ENV === "production" && existsSync(webRoot)) {
  app.use(express.static(webRoot));
  app.use((request, response, next) => {
    if (request.method === "GET" && !request.path.startsWith("/api/")) {
      return response.sendFile(`${webRoot}/index.html`);
    }
    next();
  });
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error(error);
  if (error instanceof ZodError) {
    response.status(400).json({ error: "Проверьте данные формы", details: error.flatten() });
    return;
  }
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    response.status(409).json({ error: "Такая запись уже существует" });
    return;
  }
  response.status(500).json({ error: error instanceof Error ? error.message : "Внутренняя ошибка" });
};
app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  console.log(`Relayboard API listening on http://localhost:${config.PORT}`);
});

async function shutdown() {
  server.close();
  await publishingQueue.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
