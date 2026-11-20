import { Router, type RequestHandler } from "express";
import multer from "multer";
import { z, ZodError } from "zod";
import type { Pool } from "pg";
import { ContactImportService } from "../core/contact-import.js";
import { ContactImportError, IMPORT_LIMITS, parseContactFile, columnMappingSchema } from "../core/contact-file.js";

const messages: Record<string, string> = {
  outreach_disabled: "Автоматическое обращение недоступно: включите рабочий процесс ИИ",
  outreach_settings_changed: "Настройки первого обращения изменились. Обновите страницу и повторите подтверждение",
  outreach_settings_required: "Сохраните текст первого сообщения и выберите подключённый аккаунт для каждого выбранного канала",
  outreach_qualification_required: "Включите квалификацию ИИ перед запуском обращения",
  file_size_limit: "Размер файла должен быть от 1 байта до 5 МиБ",
  unsupported_file_type: "Выберите файл CSV или XLSX",
  invalid_csv: "Не удалось прочитать CSV: проверьте разделитель и кавычки",
  csv_requires_utf8: "Сохраните CSV в кодировке UTF-8",
  invalid_xlsx: "Не удалось прочитать XLSX",
  empty_file: "В файле нет заголовка и данных",
  invalid_column_mapping: "Столбец телефона обязателен, выбранные столбцы должны различаться",
  sheet_not_found: "Выбранный лист не найден",
  row_or_cell_limit: "Превышен предел: 10 000 строк или 100 000 ячеек",
  column_limit: "Поддерживается не более 100 столбцов",
  invalid_sheet_count: "Допустимо от 1 до 20 непустых листов",
  xlsx_dimensions_limit: "Размеры листа XLSX превышают ограничения импорта",
  xlsx_expansion_limit: "Распакованный XLSX превышает безопасный размер",
  unsafe_xlsx: "Архив XLSX содержит неподдерживаемые пути или шифрование",
  unsafe_xml: "XML с объявлениями DTD/ENTITY не поддерживается",
  unsupported_xlsx_content: "Вложения и макросы внутри XLSX не поддерживаются",
  import_session_not_found: "Предпросмотр не найден. Загрузите файл заново",
  import_session_expired: "Срок предпросмотра истёк. Подготовьте его заново",
  import_session_limit: "Слишком много предпросмотров. Повторите после истечения их срока",
  import_payload_budget: "Временные данные импорта превысили лимит. Уменьшите файл или повторите позже",
};

export function createContactImportRouter(options: { pool: Pool; authorize: RequestHandler; enabled: boolean; ownerScope: string; outreachEnabled?: boolean; testOnly?: boolean }) {
  const router = Router();
  const service = new ContactImportService(options.pool);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_LIMITS.bytes, files: 1, fields: 0, parts: 2 } });
  // This router authenticates itself, even when mounted ahead of the legacy /api middleware.
  router.use(options.authorize);
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (!options.enabled) return response.status(503).json({ code: "contact_import_disabled", error: "Импорт контактов пока не включён" });
    next();
  });
  // Restrict concurrent in-memory parsing before Multer allocates the upload buffer.
  let busy = false;
  const parseSlot: RequestHandler = (_request, response, next) => {
    if (busy) return response.status(429).json({ code: "import_busy", error: "Другой файл уже обрабатывается. Повторите позже" });
    busy = true;
    let released = false;
    const release = () => { if (!released) { released = true; busy = false; } };
    response.locals.importRelease = release;
    response.once("close", () => { if (!response.locals.importParsing) release(); });
    next();
  };
  router.get("/contacts", async (request, response) => {
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(request.query.limit);
    const offset = z.coerce.number().int().min(0).max(1000000).default(0).parse(request.query.offset);
    response.json(await service.list(limit, offset));
  });
  router.get('/import-outreach',async(_request,response)=>{
    const batches=(await options.pool.query(`SELECT b.id,b.state,b.created_at,count(j.*)::int AS total,
     count(*) FILTER(WHERE a.state='confirmed')::int AS sent,
     count(*) FILTER(WHERE a.state='unknown')::int AS review,
     count(*) FILTER(WHERE j.state='not_found')::int AS not_found,
     count(*) FILTER(WHERE j.state='skipped' OR i.skipped_reason IS NOT NULL OR a.state IN ('cancelled','rejected'))::int AS skipped
     FROM ai_import_outreach_batches b JOIN ai_contact_import_sessions s ON s.id=b.id
     LEFT JOIN ai_import_outreach_jobs j ON j.batch_id=b.id LEFT JOIN ai_outreach_items i ON i.run_id=j.id
     LEFT JOIN ai_outbox a ON a.id=i.action_id WHERE s.owner_scope=$1 GROUP BY b.id ORDER BY b.created_at DESC LIMIT 20`,[options.ownerScope])).rows;
    response.json({enabled:!!options.outreachEnabled,testOnly:options.testOnly??true,batches});
  });
  router.get('/import-outreach/:id',async(request,response)=>{
    const id=z.string().uuid().parse(request.params.id),offset=z.coerce.number().int().min(0).max(10000).default(0).parse(request.query.offset);
    const rows=(await options.pool.query(`SELECT c.display_name AS name,c.phone_e164 AS phone,j.state,j.reason,
      v.platform,a.state AS delivery_state,i.skipped_reason,r.state AS run_state
      FROM ai_import_outreach_jobs j JOIN ai_import_outreach_batches b ON b.id=j.batch_id
      JOIN ai_contact_import_sessions s ON s.id=b.id JOIN ai_contacts c ON c.id=j.contact_id
      LEFT JOIN ai_conversations v ON v.id=j.conversation_id LEFT JOIN ai_outreach_items i ON i.run_id=j.id
      LEFT JOIN ai_outreach_runs r ON r.id=j.id LEFT JOIN ai_outbox a ON a.id=i.action_id
      WHERE b.id=$1 AND s.owner_scope=$2 ORDER BY j.id LIMIT 50 OFFSET $3`,[id,options.ownerScope,offset])).rows;
    response.json(rows);
  });
  router.post('/import-outreach/:id/control',async(request,response)=>{
    const id=z.string().uuid().parse(request.params.id),{state}=z.object({state:z.enum(['active','paused','stopped'])}).parse(request.body);
    const c=await options.pool.connect();try{await c.query('BEGIN');
      const updated=await c.query(`UPDATE ai_import_outreach_batches b SET state=$3 FROM ai_contact_import_sessions s
        WHERE b.id=$1 AND s.id=b.id AND s.owner_scope=$2 AND b.state<>'stopped' RETURNING b.id`,[id,options.ownerScope,state]);
      if(!updated.rowCount)throw new ContactImportError('import_session_not_found',404);
      await c.query(`UPDATE ai_outreach_runs r SET state=$2 FROM ai_import_outreach_jobs j WHERE j.batch_id=$1 AND r.id=j.id AND r.state IN ('active','paused')`,[id,state]);
      await c.query('COMMIT');response.json({state});
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  });
  router.post("/contact-imports/inspect", parseSlot, upload.single("file"), async (request, response) => {
    if (response.destroyed) { response.locals.importRelease(); return; }
    response.locals.importParsing = true;
    try {
      if (!request.file) throw new ContactImportError("empty_file");
      const file = await parseContactFile(request.file.buffer, request.file.originalname);
      response.json(await service.inspect(options.ownerScope, file));
    } finally { response.locals.importParsing = false; response.locals.importRelease(); }
  });
  router.post("/contact-imports/preview", async (request, response) => {
    const input = columnMappingSchema.extend({ inspectionId: z.string().uuid() }).parse(request.body);
    response.json(await service.preview(options.ownerScope, input.inspectionId, input));
  });
  router.post("/contact-imports/:id/confirm", async (request, response) => {
    const input=z.object({startOutreach:z.boolean().default(false),revision:z.number().int().nonnegative().optional()}).parse(request.body??{});
    if(input.startOutreach&&!options.outreachEnabled)throw new ContactImportError('outreach_disabled',409);
    response.json(await service.confirm(options.ownerScope, z.string().uuid().parse(request.params.id),input));
  });
  router.use(((error: unknown, _request, response, _next) => {
    if (error instanceof ZodError) return response.status(400).json({ code: "invalid_import_options", error: "Проверьте лист, столбцы и код страны" });
    if (error instanceof multer.MulterError) return response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ code: error.code, error: "Загрузите один файл CSV/XLSX размером до 5 МиБ" });
    if (error instanceof ContactImportError) return response.status(error.status).json({ code: error.code, error: messages[error.code] || "Не удалось подготовить импорт" });
    if (error && typeof error === "object" && "code" in error && ["42P01", "42703"].includes(String(error.code))) {
      return response.status(503).json({ code: "contact_import_schema_missing", error: "Схема импорта ещё не установлена. Требуется миграция ИИ-менеджера" });
    }
    // Do not log request bodies/rows, filenames or SQL error details containing PII.
    console.error("Contact import failed");
    response.status(500).json({ code: "contact_import_failed", error: "Импорт не завершён. Повторите подтверждение того же предпросмотра" });
  }) as import("express").ErrorRequestHandler);
  return router;
}

export function startContactImportCleanup(pool: Pool, enabled: boolean) {
  let running: Promise<void> | undefined;
  const service = new ContactImportService(pool);
  const tick = () => {
    if (!enabled || running) return;
    running = service.purgeExpired().catch(() => console.error("Contact import expiry cleanup failed")).finally(() => { running = undefined; });
  };
  const timer = enabled ? setInterval(tick, 60000) : undefined;
  timer?.unref();
  return async () => { if (timer) clearInterval(timer); await running; };
}
