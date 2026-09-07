import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { z, ZodError } from "zod";
import { config } from "../core/config.js";
import { isMaxTransportError, listMaxGroups } from "../core/adapters/max.js";
import { decryptCredentials, encryptCredentials } from "../core/crypto.js";
import { pool } from "../core/db.js";
import { publishingQueue, schedulerKey } from "../core/queue.js";
import { destinationInput, integrationInput, postInput } from "./schemas.js";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const uploadRoot = resolve(config.UPLOAD_DIR);
mkdirSync(uploadRoot, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadRoot,
    filename: (_request, file, done) => done(null, `${randomUUID()}${extname(file.originalname).slice(0, 16).toLowerCase()}`),
  }),
  limits: { files: 10, fileSize: config.MAX_UPLOAD_BYTES },
});

const SESSION_COOKIE = "relayboard_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function sameSecret(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(request: express.Request, name: string) {
  const header = request.header("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function setSessionCookie(response: express.Response, token: string, maxAge = SESSION_TTL_MS) {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.SESSION_COOKIE_SECURE,
    maxAge,
    path: "/",
  });
}

app.post("/api/auth/login", async (request, response) => {
  const parsed = z.object({ username: z.string().trim(), password: z.string() }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "Введите логин и пароль" });
  const key = request.ip || "unknown";
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (current && current.resetAt > now && current.count >= 5) {
    return response.status(429).json({ error: "Слишком много попыток. Повторите через несколько минут" });
  }
  const expectedPassword = config.ADMIN_PASSWORD || config.ADMIN_API_KEY;
  const valid = sameSecret(parsed.data.username, config.ADMIN_USERNAME) && sameSecret(parsed.data.password, expectedPassword);
  if (!valid) {
    loginAttempts.set(key, current && current.resetAt > now ? { ...current, count: current.count + 1 } : { count: 1, resetAt: now + 5 * 60 * 1000 });
    return response.status(401).json({ error: "Неверный логин или пароль" });
  }
  loginAttempts.delete(key);
  await pool.query("DELETE FROM admin_sessions WHERE expires_at <= now()");
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO admin_sessions (token_hash, expires_at) VALUES ($1, $2)",
    [hashToken(token), new Date(now + SESSION_TTL_MS)],
  );
  setSessionCookie(response, token);
  response.json({ authenticated: true, username: config.ADMIN_USERNAME });
});

const requireAdmin: RequestHandler = async (request, response, next) => {
  try {
    if (request.header("x-admin-key") === config.ADMIN_API_KEY) return next();
    const token = cookieValue(request, SESSION_COOKIE);
    if (!token) return response.status(401).json({ error: "Требуется вход" });
    const session = await pool.query(
      `UPDATE admin_sessions SET last_seen_at = now()
       WHERE token_hash = $1 AND expires_at > now() RETURNING id`,
      [hashToken(token)],
    );
    if (!session.rowCount) return response.status(401).json({ error: "Сессия истекла. Войдите снова" });
    next();
  } catch (error) {
    next(error);
  }
};

app.get("/api/health", async (_request, response) => {
  const result = await pool.query("SELECT now() AS database_time");
  response.json({ ok: true, databaseTime: result.rows[0].database_time, version: "1.0.0" });
});
app.use("/api", requireAdmin);

app.get("/api/auth/session", (_request, response) => response.json({ authenticated: true, username: config.ADMIN_USERNAME }));
app.post("/api/auth/logout", async (request, response) => {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [hashToken(token)]);
  setSessionCookie(response, "", 0);
  response.json({ authenticated: false });
});

function normalizeMaxToken(value: string | undefined) {
  const trimmed = value?.trim() || "";
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed.trim();
    if (parsed && typeof parsed === "object" && "token" in parsed && typeof parsed.token === "string") return parsed.token.trim();
  } catch {
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

app.get("/api/dashboard", async (_request, response) => {
  const [counts, recent] = await Promise.all([
    pool.query(`SELECT
      (SELECT count(*)::int FROM integrations WHERE enabled) AS integrations,
      (SELECT count(*)::int FROM destinations d JOIN integrations i ON i.id=d.integration_id WHERE d.enabled) AS destinations,
      (SELECT count(*)::int FROM deliveries WHERE status = 'sent') AS sent,
      (SELECT count(*)::int FROM deliveries WHERE status IN ('failed','unknown')) AS failed`),
    pool.query(`SELECT d.id, d.post_id, d.status, d.attempt_count, d.last_error, d.last_error_kind, d.sent_at, d.queued_at,
      p.text, dst.title AS destination_title, i.platform
      FROM deliveries d JOIN posts p ON p.id=d.post_id JOIN destinations dst ON dst.id=d.destination_id
      JOIN integrations i ON i.id=dst.integration_id ORDER BY d.queued_at DESC LIMIT 100`),
  ]);
  response.json({ counts: counts.rows[0], recent: recent.rows });
});

app.get("/api/integrations", async (_request, response) => {
  const result = await pool.query(`SELECT i.id, i.platform, i.name, i.enabled, i.created_at, count(d.id)::int AS destination_count
    FROM integrations i LEFT JOIN destinations d ON d.integration_id=i.id
    GROUP BY i.id ORDER BY i.created_at ASC`);
  response.json(result.rows);
});

app.post("/api/integrations", async (request, response) => {
  const input = integrationInput.parse(request.body);
  if (input.platform === "max") {
    const token = normalizeMaxToken(input.credentials.token);
    if (!token) return response.status(400).json({ error: "Нужен токен личной web-сессии MAX" });
    input.credentials.token = token;
    try { await listMaxGroups(token); }
    catch (error) { return response.status(400).json({ error: `MAX не принял токен: ${error instanceof Error ? error.message : "ошибка входа"}` }); }
  }
  const result = await pool.query(
    `INSERT INTO integrations (platform, name, credential_ciphertext) VALUES ($1,$2,$3)
     RETURNING id, platform, name, enabled, created_at`,
    [input.platform, input.name, encryptCredentials(input.credentials)],
  );
  response.status(201).json(result.rows[0]);
});

app.patch("/api/integrations/:id/toggle", async (request, response) => {
  const result = await pool.query("UPDATE integrations SET enabled=NOT enabled, updated_at=now() WHERE id=$1 RETURNING id,platform,name,enabled", [request.params.id]);
  if (!result.rowCount) return response.status(404).json({ error: "Подключение не найдено" });
  response.json(result.rows[0]);
});
app.delete("/api/integrations/:id", async (request, response) => {
  const id = z.string().uuid().safeParse(request.params.id);
  if (!id.success) return response.status(400).json({ error: "Некорректный ID подключения" });
  const result = await pool.query("DELETE FROM integrations WHERE id=$1 RETURNING id,platform,name", [id.data]);
  if (!result.rowCount) return response.status(404).json({ error: "Подключение не найдено" });
  response.json({ deleted: true, integration: result.rows[0] });
});

app.get("/api/destinations", async (_request, response) => {
  const result = await pool.query(`SELECT d.id,d.external_id,d.title,d.kind,d.enabled,d.integration_id,i.platform,i.name AS integration_name
    FROM destinations d JOIN integrations i ON i.id=d.integration_id ORDER BY i.platform,d.title`);
  response.json(result.rows);
});
app.post("/api/destinations", async (request, response) => {
  const input = destinationInput.parse(request.body);
  const result = await pool.query(`INSERT INTO destinations (integration_id,external_id,title,kind)
    SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM integrations WHERE id=$1)
    ON CONFLICT (integration_id,external_id) DO NOTHING RETURNING *`, [input.integrationId,input.externalId,input.title,input.kind]);
  if (!result.rowCount) return response.status(409).json({ error: "Беседа уже добавлена или подключение недоступно" });
  response.status(201).json(result.rows[0]);
});
app.delete("/api/destinations/:id", async (request, response) => {
  const result = await pool.query("DELETE FROM destinations WHERE id=$1 RETURNING id", [request.params.id]);
  if (!result.rowCount) return response.status(404).json({ error: "Беседа не найдена" });
  response.json({ deleted: true });
});

app.get("/api/max/groups/:integrationId", async (request, response) => {
  const id = z.string().uuid().safeParse(request.params.integrationId);
  if (!id.success) return response.status(400).json({ error: "Некорректный ID подключения" });
  const result = await pool.query("SELECT platform,credential_ciphertext FROM integrations WHERE id=$1", [id.data]);
  if (!result.rowCount) return response.status(404).json({ error: "Подключение не найдено" });
  if (result.rows[0].platform !== "max") return response.status(400).json({ error: "Это не подключение MAX" });
  const credentials = decryptCredentials(result.rows[0].credential_ciphertext);
  try { response.json(await listMaxGroups(credentials.token)); }
  catch (error) {
    if (isMaxTransportError(error)) {
      return response.status(503).json({ error: "MAX временно не отвечает. Сохранённый токен будет использован повторно — менять его не нужно" });
    }
    response.status(401).json({ error: `MAX отклонил авторизацию: ${error instanceof Error ? error.message : "авторизуйтесь снова"}` });
  }
});

app.post("/api/uploads", upload.array("files", 10), async (request, response) => {
  const files = (request.files || []) as Express.Multer.File[];
  if (!files.length) return response.status(400).json({ error: "Выберите хотя бы один файл" });
  const saved = [];
  for (const file of files) {
    const result = await pool.query(`INSERT INTO attachments (original_name,stored_name,mime_type,size_bytes,storage_path)
      VALUES ($1,$2,$3,$4,$5) RETURNING id,original_name,mime_type,size_bytes::int`,
      [file.originalname.slice(0, 255),file.filename,file.mimetype || "application/octet-stream",file.size,file.path]);
    saved.push(result.rows[0]);
  }
  response.status(201).json(saved);
});
app.get("/api/attachments/:id", async (request, response) => {
  const result = await pool.query("SELECT original_name,mime_type,storage_path FROM attachments WHERE id=$1", [request.params.id]);
  if (!result.rowCount || !existsSync(result.rows[0].storage_path)) return response.status(404).json({ error: "Файл не найден" });
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.type(result.rows[0].mime_type).download(result.rows[0].storage_path, result.rows[0].original_name);
});
app.delete("/api/attachments/:id", async (request, response) => {
  const result = await pool.query("DELETE FROM attachments WHERE id=$1 AND post_id IS NULL RETURNING storage_path", [request.params.id]);
  if (!result.rowCount) return response.status(404).json({ error: "Свободный файл не найден" });
  await unlink(result.rows[0].storage_path).catch(() => undefined);
  response.json({ deleted: true });
});

app.get("/api/posts", async (_request, response) => {
  const result = await pool.query(`SELECT p.*, count(DISTINCT pd.destination_id)::int AS destination_count,
    count(DISTINCT a.id)::int AS attachment_count,
    count(DISTINCT d.id) FILTER (WHERE d.status='sent')::int AS sent_count,
    count(DISTINCT d.id) FILTER (WHERE d.status IN ('failed','unknown'))::int AS failed_count
    FROM posts p LEFT JOIN post_destinations pd ON pd.post_id=p.id LEFT JOIN attachments a ON a.post_id=p.id
    LEFT JOIN deliveries d ON d.post_id=p.id GROUP BY p.id ORDER BY p.created_at DESC LIMIT 50`);
  response.json(result.rows);
});

async function schedulePost(post: Record<string, unknown>) {
  if (post.mode === "recurring") {
    await publishingQueue.upsertJobScheduler(schedulerKey(String(post.id)), { pattern: String(post.cron_pattern), tz: String(post.timezone) }, { name: "fanout", data: { postId: post.id } });
    return;
  }
  const delay = post.mode === "scheduled" ? Math.max(0, new Date(String(post.scheduled_at)).getTime() - Date.now()) : 0;
  await publishingQueue.add("fanout", { postId: post.id }, { jobId: `post-${post.id}`, delay, removeOnComplete: 1000, removeOnFail: 1000 });
}

async function removeOneOffJob(postId: string) {
  const job = await publishingQueue.getJob(`post-${postId}`);
  await job?.remove().catch(() => undefined);
}

app.post("/api/posts", async (request, response) => {
  const input = postInput.parse(request.body);
  const [targets, files] = await Promise.all([
    pool.query("SELECT d.id,i.platform FROM destinations d JOIN integrations i ON i.id=d.integration_id WHERE d.id=ANY($1::uuid[]) AND d.enabled AND i.enabled", [input.destinationIds]),
    input.attachmentIds.length ? pool.query("SELECT id,size_bytes FROM attachments WHERE id=ANY($1::uuid[]) AND post_id IS NULL", [input.attachmentIds]) : Promise.resolve({ rows: [], rowCount: 0 }),
  ]);
  if (targets.rowCount !== input.destinationIds.length) return response.status(400).json({ error: "Одна или несколько бесед недоступны" });
  if ((files.rowCount || 0) !== input.attachmentIds.length) return response.status(400).json({ error: "Один или несколько файлов недоступны или уже использованы" });
  if (files.rows.some((file) => Number(file.size_bytes) > config.MAX_UPLOAD_BYTES)) return response.status(413).json({ error: "Файл превышает разрешённый размер" });

  const client = await pool.connect();
  let post: Record<string, unknown> | null = null;
  try {
    await client.query("BEGIN");
    const result = await client.query(`INSERT INTO posts
      (text,mode,scheduled_at,cron_pattern,timezone,interval_seconds,max_attempts,retry_delay_seconds,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled') RETURNING *`,
      [input.text,input.mode,input.scheduledAt || null,input.cronPattern || null,input.timezone,input.intervalSeconds,input.maxAttempts,input.retryDelaySeconds]);
    const createdPost = result.rows[0] as Record<string, unknown>;
    post = createdPost;
    await client.query("INSERT INTO post_destinations (post_id,destination_id) SELECT $1,unnest($2::uuid[])", [createdPost.id,input.destinationIds]);
    if (input.attachmentIds.length) await client.query("UPDATE attachments SET post_id=$1 WHERE id=ANY($2::uuid[]) AND post_id IS NULL", [createdPost.id,input.attachmentIds]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  try {
    await schedulePost(post!);
  } catch (error) {
    const storedFiles = await pool.query("SELECT storage_path FROM attachments WHERE post_id=$1", [post!.id]);
    await pool.query("DELETE FROM posts WHERE id=$1", [post!.id]);
    await Promise.all(storedFiles.rows.map((file) => unlink(file.storage_path).catch(() => undefined)));
    throw error;
  }
  response.status(201).json(post);
});

app.post("/api/posts/:id/pause", async (request, response) => {
  const result = await pool.query("UPDATE posts SET status='paused',updated_at=now() WHERE id=$1 AND status IN ('scheduled','active') RETURNING *", [request.params.id]);
  if (!result.rowCount) return response.status(409).json({ error: "Задание нельзя поставить на паузу" });
  await pool.query("UPDATE deliveries SET status='paused' WHERE post_id=$1 AND status='queued'", [request.params.id]);
  if (result.rows[0].mode === "recurring") await publishingQueue.removeJobScheduler(schedulerKey(request.params.id));
  else await removeOneOffJob(request.params.id);
  response.json(result.rows[0]);
});
app.post("/api/posts/:id/resume", async (request, response) => {
  const result = await pool.query("UPDATE posts SET status='active',updated_at=now() WHERE id=$1 AND status='paused' RETURNING *", [request.params.id]);
  if (!result.rowCount) return response.status(409).json({ error: "Задание не находится на паузе" });
  await pool.query("UPDATE deliveries SET status='queued' WHERE post_id=$1 AND status='paused'", [request.params.id]);
  const occurrences = await pool.query("SELECT DISTINCT occurrence_key FROM deliveries WHERE post_id=$1 AND status='queued'", [request.params.id]);
  for (const item of occurrences.rows) await publishingQueue.add("dispatch", { postId: request.params.id, occurrenceKey: item.occurrence_key }, { jobId: `resume-${request.params.id}-${Date.now()}-${Math.random().toString(36).slice(2,7)}` });
  if (result.rows[0].mode === "recurring" && result.rows[0].scheduler_enabled) await schedulePost(result.rows[0]);
  if (!occurrences.rowCount && result.rows[0].mode !== "recurring") await schedulePost(result.rows[0]);
  response.json(result.rows[0]);
});
app.post("/api/posts/:id/stop", async (request, response) => {
  const result = await pool.query("UPDATE posts SET status='stopped',scheduler_enabled=false,updated_at=now() WHERE id=$1 AND status <> 'stopped' RETURNING *", [request.params.id]);
  if (!result.rowCount) return response.status(409).json({ error: "Задание уже остановлено или не найдено" });
  await pool.query("UPDATE deliveries SET status='stopped' WHERE post_id=$1 AND status IN ('queued','paused')", [request.params.id]);
  await publishingQueue.removeJobScheduler(schedulerKey(request.params.id));
  await removeOneOffJob(request.params.id);
  response.json(result.rows[0]);
});
app.delete("/api/posts/:id/schedule", async (request, response) => {
  const result = await pool.query("UPDATE posts SET scheduler_enabled=false,updated_at=now() WHERE id=$1 AND mode='recurring' RETURNING id", [request.params.id]);
  if (!result.rowCount) return response.status(404).json({ error: "Повторяющееся расписание не найдено" });
  await publishingQueue.removeJobScheduler(schedulerKey(request.params.id));
  await removeOneOffJob(request.params.id);
  response.json({ disabled: true });
});
app.delete("/api/posts/:id", async (request, response) => {
  const post = await pool.query("SELECT status FROM posts WHERE id=$1", [request.params.id]);
  if (!post.rowCount) return response.status(404).json({ error: "Задание не найдено" });
  if (!["stopped", "completed"].includes(post.rows[0].status)) return response.status(409).json({ error: "Сначала остановите задание" });
  const files = await pool.query("SELECT storage_path FROM attachments WHERE post_id=$1", [request.params.id]);
  await publishingQueue.removeJobScheduler(schedulerKey(request.params.id));
  await removeOneOffJob(request.params.id);
  await pool.query("DELETE FROM posts WHERE id=$1", [request.params.id]);
  await Promise.all(files.rows.map((file) => unlink(file.storage_path).catch(() => undefined)));
  response.json({ deleted: true });
});
app.post("/api/deliveries/:id/retry", async (request, response) => {
  const result = await pool.query(`UPDATE deliveries SET status='queued',attempt_count=0,last_error=NULL,last_error_kind=NULL
    WHERE id=$1 AND status IN ('failed','unknown') RETURNING id,post_id,occurrence_key`, [request.params.id]);
  if (!result.rowCount) return response.status(409).json({ error: "Эту отправку нельзя повторить" });
  await publishingQueue.add("dispatch", { postId: result.rows[0].post_id, occurrenceKey: result.rows[0].occurrence_key }, { jobId: `retry-${request.params.id}-${Date.now()}` });
  response.status(202).json({ queued: true });
});

// Explicit account selection prevents accidentally using another account's session.
app.use("/api/accounts/:accountId", async (request, response) => {
  const id=z.string().uuid().safeParse(request.params.accountId);
  if (!id.success) return response.status(400).json({error:"Некорректный аккаунт"});
  const result=await pool.query("SELECT platform,session_key FROM integrations WHERE id=$1",[id.data]);
  const account=result.rows[0];
  if (!account || !["telegram","whatsapp"].includes(account.platform)) return response.status(404).json({error:"Аккаунт не найден"});
  const routes: Record<string,string | undefined>=account.platform === "telegram" ? {"/status":"GET","/dialogs":"GET","/auth/qr":"POST","/auth/password":"POST"} : {"/status":"GET","/groups":"GET"};
  if (routes[request.path] !== request.method) return response.status(404).json({error:"Неизвестное действие"});
  const base=account.platform === "telegram" ? config.TELEGRAM_BRIDGE_URL : config.WHATSAPP_BRIDGE_URL;
  const secret=account.platform === "telegram" ? config.TELEGRAM_BRIDGE_SECRET : config.WHATSAPP_BRIDGE_SECRET;
  try {
    const upstream=await fetch(base+request.path,{method:request.method,headers:{authorization:`Bearer ${secret}`,"content-type":"application/json","x-account-session":account.session_key},...(request.method === "POST" ? {body:JSON.stringify(request.body)} : {})});
    response.status(upstream.status).json(await upstream.json());
  } catch { response.status(503).json({error:"Сервис аккаунта временно недоступен"}); }
});

const webRoot = fileURLToPath(new URL("../../dist-web", import.meta.url));
if (config.NODE_ENV === "production" && existsSync(webRoot)) {
  app.use(express.static(webRoot));
  app.use((request, response, next) => request.method === "GET" && !request.path.startsWith("/api/") ? response.sendFile(`${webRoot}/index.html`) : next());
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ZodError) return response.status(400).json({ error: "Проверьте данные формы", details: error.flatten() });
  if (error instanceof multer.MulterError) return response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Файл слишком большой" : "Ошибка загрузки файлов" });
  if (error && typeof error === "object" && "code" in error && error.code === "23505") return response.status(409).json({ error: "Такая запись уже существует" });
  console.error(error);
  response.status(500).json({ error: error instanceof Error ? error.message : "Внутренняя ошибка" });
};
app.use(errorHandler);

const server = app.listen(config.PORT, () => console.log(`Relayboard API listening on http://localhost:${config.PORT}`));
async function shutdown() { server.close(); await publishingQueue.close(); await pool.end(); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
