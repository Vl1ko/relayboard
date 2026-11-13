import {
  SearchSourcesStore,
  SearchSourceError,
} from "../core/search-sources.js";
import { Router, type RequestHandler, type ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import { z, ZodError } from "zod";
import { LeadIntakeStore, LeadIntakeError } from "../core/lead-intake.js";
export function createLeadRouter(options: {
  pool: Pool;
  authorize: RequestHandler;
  enabled: boolean;
}) {
  const router = Router(),
    store = new LeadIntakeStore(options.pool);
  router.use(options.authorize);
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!options.enabled)
      return res
        .status(503)
        .json({ error: "Источники заявок пока не включены" });
    next();
  });
  router.get("/sources", async (_req, res) => {
    res.json(await new SearchSourcesStore(options.pool).get());
  });
  router.put("/sources", async (req, res) => {
    res.json(await new SearchSourcesStore(options.pool).save(req.body));
  });
  router.get("/", async (req, res) => {
    const q = z
      .object({
        status: z.enum(["pending", "approved", "rejected"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .parse(req.query);
    res.json(await store.list(q));
  });
  router.post("/", async (req, res) => {
    res.json(await store.ingest(req.body));
  });
  router.post("/:id/review", async (req, res) => {
    res.json(await store.review({ ...req.body, leadId: req.params.id }));
  });
  router.use(((e, _req, res, _next) => {
    if (e instanceof SearchSourceError)
      return res
        .status(409)
        .json({
          error:
            e.code === "sources_changed"
              ? "Список изменился. Обновите его"
              : "Чат недоступен в подключённых аккаунтах",
        });
    if (e instanceof ZodError)
      return res.status(400).json({
        error: "Проверьте исходное сообщение, параметры и поля проверки",
      });
    if (e instanceof LeadIntakeError)
      return res.status(e.status).json({
        code: e.code,
        error: (
          {
            ungrounded_parameter:
              "Параметр должен подтверждаться точной цитатой исходного текста",
            source_content_conflict:
              "Сообщение с таким идентификатором уже сохранено с другим содержимым",
            operation_payload_conflict:
              "Операция уже применена с другим содержимым",
            lead_changed: "Заявка изменилась. Обновите список",
            lead_already_reviewed: "Заявка уже проверена",
            lead_not_found: "Источник не найден",
            contact_not_found: "Контакт не найден",
            contact_excluded: "Контакт отказался от сообщений",
            request_identity_conflict:
              "Идентификатор заявки связан с другим контактом",
            invalid_review:
              "Выберите контакт/заявку, параметры или причину отклонения",
          } as Record<string, string>
        )[e.code],
      });
    if (["42P01", "42703"].includes(e?.code))
      return res
        .status(503)
        .json({ error: "Требуется миграция источников заявок" });
    console.error("Lead review failed");
    res.status(500).json({ error: "Не удалось выполнить проверку заявки" });
  }) as ErrorRequestHandler);
  return router;
}
