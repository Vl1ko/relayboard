import {DialogueRetention} from '../core/dialogue-retention.js';
import {BusinessEvents,businessEventSchema} from '../core/business-events.js';
import { Router, type RequestHandler, type ErrorRequestHandler } from "express";
import type { Pool, PoolClient } from "pg";
import { z, ZodError } from "zod";

const statuses = [
  "new",
  "ai_dialog",
  "qualified",
  "unqualified",
  "insufficient_data",
  "manager_required",
  "manager_working",
  "refused",
  "closed",
] as const;
const querySchema = z.object({
  q: z.string().trim().max(200).default(""),
  status: z.enum(statuses).optional(),
  mode: z.enum(["auto", "manual", "paused"]).optional(),
  platform: z.enum(["max", "whatsapp"]).optional(),
  accountId: z.string().uuid().optional(),
  sort: z.enum(["recent", "oldest", "name"]).default("recent"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
export interface WorkspaceWorkflow {
  control(input: {
    conversationId: string;
    action: "takeover" | "stop" | "resume";
  }): Promise<unknown>;
  optOut(input: { contactId: string; reason: string }): Promise<unknown>;
  setStatus(input: {
    conversationId: string;
    status: (typeof statuses)[number];
    reason: string;
  }): Promise<unknown>;
  detail?(conversationId: string): Promise<unknown>;
  managerTarget?(): Promise<unknown>;
  saveManagerTarget?(input: {
    accountId: string;
    externalId: string;
  }): Promise<unknown>;
  followupRules?(): Promise<unknown>;
  saveFollowupRule?(input: any): Promise<unknown>;
  scheduleFollowup?(input: {
    conversationId: string;
    scenario: "no_reply" | "not_booked" | "not_completed" | "requested_later";
    key: string;
    anchorAt: string;
  }): Promise<unknown>;
  cancelFollowups?(input: {
    conversationId: string;
    reason:
      | "customer_reply"
      | "booking"
      | "order_completed"
      | "requested_stop"
      | "closed";
  }): Promise<unknown>;
  handoff?(input: {
    conversationId: string;
    key: string;
    reason: "human_requested" | "insufficient_data" | "reply_limit";
    summary: string;
  }): Promise<unknown>;
}

const conversationObject = `jsonb_build_object('id',v.id,'platform',v.platform,'accountId',v.account_id,
  'accountName',coalesce(a.name,'Удалённый аккаунт'),'externalId',v.external_id,
  'status',v.business_status,'mode',v.automation_mode,'epoch',v.automation_epoch::text,
  'accountEnabled',coalesce(a.enabled,false),'accountNeedsAuth',(a.auth_error IS NOT NULL))`;
const listBase = `SELECT c.id,c.display_name AS "displayName",c.phone_e164 AS phone,
 c.imported_stage AS "importedStage",c.comment,(c.opted_out_at IS NOT NULL) AS "optedOut",c.created_at AS "createdAt",
 coalesce((SELECT max(t.at) FROM (SELECT i.received_at AS at FROM ai_inbox i JOIN ai_conversations iv ON iv.id=i.conversation_id WHERE iv.contact_id=c.id
 UNION ALL SELECT o.updated_at AS at FROM ai_outbox o WHERE o.contact_id=c.id) t),c.created_at) AS "lastActivity",
 (SELECT i.text FROM ai_inbox i JOIN ai_conversations iv ON iv.id=i.conversation_id WHERE iv.contact_id=c.id ORDER BY i.occurred_at DESC,i.event_key DESC LIMIT 1) AS "lastMessage",
 (SELECT jsonb_agg(${conversationObject} ORDER BY v.platform,v.account_id,v.id) FROM ai_conversations v LEFT JOIN integrations a ON a.id=v.account_id WHERE v.contact_id=c.id) AS conversations
 FROM ai_contacts c`;

async function readSnapshot<T>(
  pool: Pool,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export function createConversationRouter(options: {
  pool: Pool;
  authorize: RequestHandler;
  enabled: boolean;
  workflow?: WorkspaceWorkflow;
}) {
  const router = Router();
  const business=new BusinessEvents(options.pool);
  router.use(options.authorize);
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!options.enabled)
      return res
        .status(503)
        .json({ error: "Рабочее место диалогов пока не включено" });
    next();
  });
  router.get("/contacts", async (req, res) => {
    const q = querySchema.parse(req.query),
      values: unknown[] = [],
      clauses = [
        "EXISTS (SELECT 1 FROM ai_conversations v WHERE v.contact_id=c.id)",
      ];
    const param = (v: unknown) => {
      values.push(v);
      return "$" + values.length;
    };
    if (q.q) {
      const p = param("%" + q.q.replace(/[\\%_]/g, "\\$&") + "%");
      clauses.push(
        `(c.display_name ILIKE ${p} ESCAPE '\\' OR coalesce(c.phone_e164,'') ILIKE ${p} ESCAPE '\\' OR EXISTS(SELECT 1 FROM ai_inbox i JOIN ai_conversations v ON v.id=i.conversation_id WHERE v.contact_id=c.id AND i.text ILIKE ${p} ESCAPE '\\'))`,
      );
    }
    const convFilters = ["v.contact_id=c.id"];
    if (q.status) convFilters.push("v.business_status=" + param(q.status));
    if (q.mode) convFilters.push("v.automation_mode=" + param(q.mode));
    if (q.platform) convFilters.push("v.platform=" + param(q.platform));
    if (q.accountId) convFilters.push("v.account_id=" + param(q.accountId));
    if (convFilters.length > 1)
      clauses.push(
        "EXISTS(SELECT 1 FROM ai_conversations v WHERE " +
          convFilters.join(" AND ") +
          ")",
      );
    const where = clauses.join(" AND "),
      order =
        q.sort === "name"
          ? '"displayName" ASC,id'
          : q.sort === "oldest"
            ? '"lastActivity" ASC,id'
            : '"lastActivity" DESC,id';
    res.json(
      await readSnapshot(options.pool, async (client) => {
        const total = (
          await client.query(
            "SELECT count(*)::int n FROM ai_contacts c WHERE " + where,
            values,
          )
        ).rows[0].n;
        const rows = (
          await client.query(
            listBase +
              " WHERE " +
              where +
              " ORDER BY " +
              order +
              " LIMIT $" +
              (values.length + 1) +
              " OFFSET $" +
              (values.length + 2),
            [...values, q.limit, q.offset],
          )
        ).rows;
        const counters = (
          await client.query(`SELECT
     count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ai_conversations v WHERE v.contact_id=c.id AND v.business_status='new'))::int AS new,
     count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ai_conversations v WHERE v.contact_id=c.id AND v.business_status='qualified'))::int AS qualified,
     count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ai_conversations v WHERE v.contact_id=c.id AND v.business_status IN ('ai_dialog','insufficient_data')))::int AS waiting,
     count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM ai_conversations v WHERE v.contact_id=c.id AND v.business_status NOT IN ('closed','refused','unqualified')))::int AS closed,
     count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ai_conversations v WHERE v.contact_id=c.id AND v.business_status IN ('manager_required','manager_working')) OR EXISTS(SELECT 1 FROM ai_outbox o WHERE o.contact_id=c.id AND o.state='unknown') OR EXISTS(SELECT 1 FROM ai_inbox i JOIN ai_conversations v ON v.id=i.conversation_id WHERE v.contact_id=c.id AND i.origin='unresolved'))::int AS review
     FROM ai_contacts c WHERE EXISTS(SELECT 1 FROM ai_conversations v WHERE v.contact_id=c.id)`)
        ).rows[0];
        return {
          contacts: rows,
          total,
          limit: q.limit,
          offset: q.offset,
          counters,
          counterRule: "contact-presence-v1",
        };
      }),
    );
  });
  router.get("/contacts/:id", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      paging = z
        .object({
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          conversationId: z.string().uuid().optional(),
        })
        .parse(req.query);
    const detail = await readSnapshot(options.pool, async (client) => {
      const contact = (await client.query(listBase + " WHERE c.id=$1", [id]))
        .rows[0];
      if (!contact) return null;
      if (
        paging.conversationId &&
        !contact.conversations?.some(
          (v: { id: string }) => v.id === paging.conversationId,
        )
      )
        return null;
      const messages = (
        await client.query(
          `SELECT i.event_key AS id,i.conversation_id AS "conversationId",i.external_message_id AS "externalMessageId",i.direction,i.origin,i.disposition,i.text,i.occurred_at AS "occurredAt",i.received_at AS "receivedAt" FROM ai_inbox i JOIN ai_conversations v ON v.id=i.conversation_id WHERE v.contact_id=$1 AND ($4::uuid IS NULL OR v.id=$4) ORDER BY i.occurred_at DESC,i.event_key DESC LIMIT $2 OFFSET $3`,
          [id, paging.limit, paging.offset, paging.conversationId ?? null],
        )
      ).rows;
      const messageTotal = (
        await client.query(
          "SELECT count(*)::int n FROM ai_inbox i JOIN ai_conversations v ON v.id=i.conversation_id WHERE v.contact_id=$1 AND ($2::uuid IS NULL OR v.id=$2)",
          [id, paging.conversationId ?? null],
        )
      ).rows[0].n;
      const actions = (
        await client.query(
          `SELECT id,conversation_id AS "conversationId",kind,text,state,outcome_code AS "outcomeCode",external_message_id AS "externalMessageId",cancellation_requested AS "cancellationRequested",created_at AS "createdAt",updated_at AS "updatedAt" FROM ai_outbox WHERE contact_id=$1 AND ($2::uuid IS NULL OR conversation_id=$2) ORDER BY created_at DESC,id DESC LIMIT 100`,
          [id, paging.conversationId ?? null],
        )
      ).rows;
      return {
        contact,
        messages: messages.reverse(),
        messageTotal,
        offset: paging.offset,
        limit: paging.limit,
        actions,
      };
    });
    if (!detail) return res.status(404).json({ error: "Контакт не найден" });
    res.json(detail);
  });
  router.get("/conversations/:id/workflow", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    if (!options.workflow?.detail)
      return res.status(503).json({
        error: "Сведения о передаче и повторных обращениях пока не подключены",
      });
    const data = await readSnapshot(options.pool, async (client) => {
      const conversation = (
        await client.query(
          "SELECT id,business_status,automation_mode FROM ai_conversations WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!conversation) return null;
      const notifications = (
        await client.query(
          "SELECT id,reason,summary,parameters,source,state,outcome_code,external_message_id,created_at FROM ai_handoff_notifications WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20",
          [id],
        )
      ).rows;
      const followups = (
        await client.query(
          "SELECT id,scenario,step,text,due_at,state,cancellation_reason FROM ai_followup_jobs WHERE conversation_id=$1 ORDER BY due_at DESC,id DESC LIMIT 50",
          [id],
        )
      ).rows;
      const statusHistory = (
        await client.query(
          "SELECT id,from_status,to_status,reason,created_at FROM ai_workflow_status_history WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
          [id],
        )
      ).rows;
      return {
        conversation,
        notifications,
        followups,
        statusHistory,
        business: await business.detail(id,client),
        stageLabels: (await client.query("SELECT scenario,label FROM ai_followup_rules")).rows,
        limits: { notifications: 20, followups: 50, statusHistory: 100 },
      };
    });
    if (!data) return res.status(404).json({ error: "Диалог не найден" });
    res.json(data);
  });
  router.post("/conversations/:id/business-events", async (req,res)=>{
    const conversationId=z.string().uuid().parse(req.params.id);
    const input=businessEventSchema.parse({...req.body,conversationId});
    res.json(await business.record(input));
  });
  router.get('/settings/storage',async (_req,res)=>res.json(await new DialogueRetention(options.pool).preview()));
  router.put('/settings/storage',async (req,res)=>res.json(await new DialogueRetention(options.pool).save(req.body)));
  router.get("/settings", async (_req, res) => {
    if (!options.workflow?.managerTarget || !options.workflow.followupRules)
      return res
        .status(503)
        .json({ error: "Настройки сценариев пока не подключены" });
    res.json({
      managerTarget: await options.workflow.managerTarget(),
      followupRules: await options.workflow.followupRules(),
    });
  });
  router.put("/settings/manager", async (req, res) => {
    if (!options.workflow?.saveManagerTarget)
      return res
        .status(503)
        .json({ error: "Передача менеджеру пока не подключена" });
    const data = z
      .object({
        accountId: z.string().uuid(),
        externalId: z.string().trim().min(1).max(256),
      })
      .strict()
      .parse(req.body);
    res.json(await options.workflow.saveManagerTarget(data));
  });
  router.put("/settings/followups", async (req, res) => {
    if (!options.workflow?.saveFollowupRule)
      return res
        .status(503)
        .json({ error: "Повторные обращения пока не подключены" });
    const data = z
      .object({
        scenario: z.enum([
          "no_reply",
          "not_booked",
          "not_completed",
          "requested_later",
        ]),
        enabled: z.boolean(),
        label: z.string().trim().min(1).max(120).optional(),
        channel: z.enum(['current','max','whatsapp']).optional(),
        acknowledgementMessage: z.string().trim().min(1).max(2000).optional(),
        timezone: z.string().min(1).max(100),
        weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
        startMinute: z.number().int().min(0).max(1439),
        endMinute: z.number().int().min(1).max(1440),
        steps: z
          .array(
            z
              .object({
                delaySeconds: z.number().int().min(1).max(31536000),
                text: z.string().trim().min(1).max(4000),
              })
              .strict(),
          )
          .min(1)
          .max(20),
        maxSends: z.number().int().min(1).max(20),
      })
      .strict()
      .parse(req.body);
    res.json(await options.workflow.saveFollowupRule(data));
  });
  router.post("/conversations/:id/followups", async (req, res) => {
    if (!options.workflow?.scheduleFollowup)
      return res
        .status(503)
        .json({ error: "Повторные обращения пока не подключены" });
    const conversationId = z.string().uuid().parse(req.params.id),
      data = z
        .object({
          scenario: z.enum([
            "no_reply",
            "not_booked",
            "not_completed",
            "requested_later",
          ]),
          key: z.string().uuid(),
          anchorAt: z.string().datetime({ offset: true }),
        })
        .strict()
        .parse(req.body);
    res.json(
      await options.workflow.scheduleFollowup({ conversationId, ...data }),
    );
  });
  router.post("/conversations/:id/cancel-followups", async (req, res) => {
    if (!options.workflow?.cancelFollowups)
      return res
        .status(503)
        .json({ error: "Повторные обращения пока не подключены" });
    const conversationId = z.string().uuid().parse(req.params.id),
      data = z
        .object({
          reason: z.enum([
            "customer_reply",
            "booking",
            "order_completed",
            "requested_stop",
            "closed",
          ]),
        })
        .strict()
        .parse(req.body);
    res.json(
      await options.workflow.cancelFollowups({ conversationId, ...data }),
    );
  });
  router.post("/conversations/:id/handoff", async (req, res) => {
    if (!options.workflow?.handoff)
      return res
        .status(503)
        .json({ error: "Передача менеджеру пока не подключена" });
    const conversationId = z.string().uuid().parse(req.params.id),
      data = z
        .object({
          key: z.string().uuid(),
          reason: z.enum([
            "human_requested",
            "insufficient_data",
            "reply_limit",
          ]),
          summary: z.string().trim().min(1).max(4000),
        })
        .strict()
        .parse(req.body);
    res.json(await options.workflow.handoff({ conversationId, ...data }));
  });
  const requireWorkflow: RequestHandler = (_req, res, next) =>
    options.workflow
      ? next()
      : res
          .status(503)
          .json({ error: "Управление диалогами пока не подключено" });
  router.post("/conversations/:id/mode", requireWorkflow, async (req, res) => {
    const conversationId = z.string().uuid().parse(req.params.id),
      data = z
        .object({ mode: z.enum(["auto", "manual", "paused"]) })
        .strict()
        .parse(req.body);
    res.json({
      result: await options.workflow!.control({
        conversationId,
        action:
          data.mode === "auto"
            ? "resume"
            : data.mode === "manual"
              ? "takeover"
              : "stop",
      }),
    });
  });
  router.post("/contacts/:id/opt-out", requireWorkflow, async (req, res) => {
    const contactId = z.string().uuid().parse(req.params.id),
      data = z
        .object({ reason: z.string().trim().min(1).max(512) })
        .strict()
        .parse(req.body);
    res.json({
      result: await options.workflow!.optOut({
        contactId,
        reason: data.reason,
      }),
    });
  });
  router.post(
    "/conversations/:id/status",
    requireWorkflow,
    async (req, res) => {
      const conversationId = z.string().uuid().parse(req.params.id),
        data = z
          .object({
            status: z
              .enum(statuses)
              .refine(
                (v) => v !== "qualified",
                "Qualification requires server-verified criteria",
              ),
            reason: z.string().trim().min(1).max(512),
          })
          .strict()
          .parse(req.body);
      res.json({
        result: await options.workflow!.setStatus({
          conversationId,
          status: data.status,
          reason: data.reason,
        }),
      });
    },
  );
  router.use(((error, _req, res, _next) => {
    if (error instanceof ZodError)
      return res.status(400).json({
        error:
          "Проверьте фильтры или действие. Статус «Подходит» назначается только после проверки критериев",
      });
    if(error instanceof Error && error.message==='storage_settings_changed')return res.status(409).json({error:'Настройки хранения изменились. Загрузите их заново.'});
    if(error instanceof Error && error.message.startsWith('business_'))return res.status(409).json({code:error.message,error:'Состояние заявки изменилось или отметка недоступна. Обновите карточку.'});
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (["42P01", "42703"].includes(code))
      return res.status(503).json({ error: "Требуется миграция ИИ-менеджера" });
    if (["conversation_not_found", "contact_not_found"].includes(code))
      return res
        .status(404)
        .json({ code, error: "Контакт или диалог не найден" });
    if (code && !/^[0-9A-Z]{5}$/.test(code))
      return res.status(409).json({
        code,
        error:
          "Состояние диалога изменилось или действие запрещено. Обновите карточку",
      });
    console.error("Conversation workspace request failed");
    res
      .status(500)
      .json({ error: "Не удалось обработать запрос рабочего места" });
  }) as ErrorRequestHandler);
  return router;
}
