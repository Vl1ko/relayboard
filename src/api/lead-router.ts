import {ChatCriteriaStore} from '../core/chat-criteria.js';
import {sourceRuntimeReady} from '../core/source-runtime-health.js';
import {SourceMonitorSettings} from '../core/source-monitor-settings.js';
import {activateSource} from '../core/source-activation.js';
import type {VerifiedSourceRoute} from '../core/source-activation.js';
import type {RuntimeScope} from '../core/runtime-scope.js';
import {maxWorkerRequest} from '../core/max-worker-client.js';
import {whatsappWorkerRequest} from '../core/whatsapp-worker-client.js';
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
  runtimeEnabled?:boolean;
  scope?:RuntimeScope;
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
  const chatCriteria=new ChatCriteriaStore(options.pool);
  router.get('/chat-criteria',async(req,res)=>res.json(await chatCriteria.get(z.enum(['max','whatsapp']).parse(req.query.platform),z.string().min(1).max(512).parse(req.query.chatId))));
  router.put('/chat-criteria',async(req,res)=>res.json(await chatCriteria.save(req.body)));
  const monitor=new SourceMonitorSettings(options.pool);
  router.get('/monitor',async(_req,res)=>res.json({...await monitor.get(),runtimeEnabled:!!options.runtimeEnabled&&await sourceRuntimeReady(options.pool,(await options.pool.query('SELECT DISTINCT platform FROM ai_search_sources')).rows.map(r=>r.platform)),lastReadAt:(await options.pool.query('SELECT max(last_completed_at) AS at FROM ai_source_cursors')).rows[0].at,sourceErrorCount:Number((await options.pool.query('SELECT count(*) AS n FROM ai_source_cursors c JOIN ai_search_sources s ON s.platform=c.platform AND s.chat_id=c.chat_id WHERE c.last_error IS NOT NULL')).rows[0].n)}));
  router.put('/monitor',async(req,res)=>res.json(await monitor.save(req.body)));
  router.post('/monitor/control',async(req,res)=>{
    if(req.body?.action==='start'&&(!options.runtimeEnabled||!await sourceRuntimeReady(options.pool,(await options.pool.query('SELECT DISTINCT platform FROM ai_search_sources')).rows.map(r=>r.platform))))return res.status(503).json({error:'Автоматический поиск пока недоступен'});
    res.json(await monitor.control(req.body));
  });
  router.post('/:id/activate',async(req,res)=>{
    if(!options.runtimeEnabled)return res.status(503).json({error:'Автоматический поиск пока недоступен'});
    const d=z.object({expectedRevision:z.number().int().nonnegative(),accountId:z.string().uuid().optional()}).strict().parse(req.body),id=z.string().uuid().parse(req.params.id);
    const lead=(await options.pool.query('SELECT account_id,platform,status,request_id FROM ai_leads WHERE id=$1',[id])).rows[0];if(!lead)return res.status(404).json({error:'Источник не найден'});
    if(lead.status==='approved')return res.json({requestId:lead.request_id,activated:false,replayed:true});
    const route=await (lead.platform==='max'?maxWorkerRequest(`/leads/${id}/resolve`,'POST',{accountId:d.accountId}):lead.platform==='whatsapp'?whatsappWorkerRequest(options.pool,lead.account_id,`/ai/leads/${id}/resolve`,{accountId:d.accountId}):Promise.reject(Error('source_platform_unsupported'))) as VerifiedSourceRoute;
    if(route.revision!==d.expectedRevision)return res.status(409).json({error:'Заявка изменилась. Обновите список'});
    res.json(await activateSource(options.pool,options.scope??{testOnly:true,accountIds:[],authorIds:[]},route,'manual'));
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
    if(req.body?.sourceKind==='monitor')return res.status(400).json({error:'Сообщения мониторинга принимает только владелец подключения'});
    res.json(await store.ingest(req.body));
  });
  router.post("/:id/review", async (req, res) => {
    res.json(await store.review({ ...req.body, leadId: req.params.id }));
  });
  router.use(((e, _req, res, _next) => {
    if(e instanceof Error&&['chat_criteria_changed','chat_not_selected'].includes(e.message))return res.status(409).json({error:e.message==='chat_not_selected'?'Сначала сохраните чат в списке источников':'Критерии изменились. Загрузите сохранённые настройки'});
    if(e instanceof Error&&/^monitor_[a-z_]+$/.test(e.message))return res.status(409).json({code:e.message,error:({monitor_settings_changed:'Настройки изменились. Обновите страницу',monitor_instructions_required:'Опишите, какие заявки нужно искать',monitor_sources_required:'Выберите чаты MAX или WhatsApp',monitor_sources_unavailable:'Проверьте подключение выбранных аккаунтов',monitor_duplicate_reader:'Для одного чата выберите один аккаунт чтения',monitor_ai_required:'Подключите GigaChat в настройках ИИ',monitor_qualification_required:'Настройте и включите квалификацию',monitor_sender_required:'Выберите аккаунты отправителей',monitor_not_started:'Сначала запустите поиск'} as Record<string,string>)[e.message]??'Проверьте настройки поиска'});
    if(e instanceof Error&&/^(source_|wa_source_|max_source_|verified_|outside_runtime_scope)/.test(e.message))return res.status(409).json({error:'Не удалось подтвердить источник. Обновите заявку и проверьте выбранные аккаунты'});
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
            verified_source_route_required:'Подтвердите автора через проверку источника',
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
