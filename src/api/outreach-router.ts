import { Router, type RequestHandler, type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import type { Pool } from "pg";
import { OutreachService, OutreachError } from "../core/outreach.js";
export function createOutreachRouter(options: {
  pool: Pool;
  authorize: RequestHandler;
  enabled: boolean;
}) {
  const router = Router(),
    service = new OutreachService(options.pool);
  router.use(options.authorize);
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!options.enabled)
      return res
        .status(503)
        .json({ error: "Настройки первого обращения пока не включены" });
    next();
  });
  router.get("/settings", async (_req, res) => {
    res.json(await service.settings());
  });
  router.put("/settings", async (req, res) => {
    res.json(await service.save(req.body));
  });
  router.get("/requests", async (_req, res) => {
    res.json(await service.requests());
  });
  router.post("/requests", async (req, res) => {
    res.json(await service.createRequest(req.body));
  });
  router.post("/preview", async (req, res) => {
    res.json(await service.preview(req.body));
  });
  const messages: Record<string, string> = {
    settings_changed: "Настройки изменились. Загрузите их заново",
    template_required: "Заполните шаблон первого сообщения",
    request_not_found: "Заявка не найдена",
    request_identity_conflict:
      "Этот идентификатор заявки уже связан с другим контактом",
  };
  router.use(((error, _req, res, _next) => {
    if (error instanceof ZodError)
      return res
        .status(400)
        .json({ error: "Проверьте шаблон, интервал, аккаунты и заявки" });
    if (error instanceof OutreachError)
      return res
        .status(error.status)
        .json({ code: error.code, error: messages[error.code] });
    if (error?.code === "23503")
      return res.status(404).json({ error: "Контакт не найден" });
    if (["42P01", "42703"].includes(error?.code))
      return res.status(503).json({ error: "Требуется миграция ИИ-менеджера" });
    console.error("Outreach configuration failed");
    res.status(500).json({ error: "Не удалось выполнить операцию" });
  }) as ErrorRequestHandler);
  return router;
}
