import { Router, type RequestHandler } from "express";
import multer from "multer";
import { z, ZodError } from "zod";
import type { Pool } from "pg";
import { ContactImportService } from "../core/contact-import.js";
import { ContactImportError, IMPORT_LIMITS, parseContactFile, columnMappingSchema } from "../core/contact-file.js";

const messages: Record<string, string> = {
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

export function createContactImportRouter(options: { pool: Pool; authorize: RequestHandler; enabled: boolean; ownerScope: string }) {
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
    response.json(await service.confirm(options.ownerScope, z.string().uuid().parse(request.params.id)));
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
