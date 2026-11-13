import { Router, type RequestHandler, type ErrorRequestHandler } from "express";
import { z, ZodError } from "zod";
import type { Pool } from "pg";
import { OutreachService, OutreachError } from "../core/outreach.js";
import { OutreachRunner } from "../core/outreach-runner.js";
export function createOutreachRouter(options: {
  pool: Pool;
  authorize: RequestHandler;
  enabled: boolean;
  syntheticEnabled?: boolean;
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
  const runner = new OutreachRunner(options.pool);
  router.get('/capabilities', (_req,res)=>res.json({mode:options.syntheticEnabled?'synthetic':'disabled', canStartSynthetic:!!options.syntheticEnabled}));
  router.get('/runs', async(_req,res)=>{res.json(await runner.list());});
  router.get('/runs/:id',async(req,res)=>{res.json(await runner.items(z.string().uuid().parse(req.params.id)));});
  router.post('/runs',async(req,res)=>{
    if(!options.syntheticEnabled)return res.status(503).json({error:'Тестовый запуск не включён'});
    res.json(await runner.create(req.body));
  });
  router.post('/runs/:id/control',async(req,res)=>{
    const {state}=z.object({state:z.enum(['active','paused','stopped'])}).parse(req.body);
    res.json(await runner.control(z.string().uuid().parse(req.params.id),state));
  });
  const messages: Record<string, string> = {
    run_identity_conflict:'Идентификатор запуска уже занят другим набором заявок',
    run_has_blocked_requests:'В запуске есть заблокированные заявки. Обновите предпросмотр',
    run_not_controllable:'Этот запуск уже остановлен или завершён',
    run_item_not_found:'Заявка запуска не найдена',
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
    if(error?.code === "23505")return res.status(409).json({error:"Заявка уже включена в другой запуск"});
    if (error?.code === "23503")
      return res.status(404).json({ error: "Контакт не найден" });
    if (["42P01", "42703"].includes(error?.code))
      return res.status(503).json({ error: "Требуется миграция ИИ-менеджера" });
    console.error("Outreach configuration failed");
    res.status(500).json({ error: "Не удалось выполнить операцию" });
  }) as ErrorRequestHandler);
  return router;
}
