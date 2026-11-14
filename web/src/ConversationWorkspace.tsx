import StorageSettings from './StorageSettings';
import BusinessStageCard,{type BusinessDetail} from './BusinessStageCard';
import { useEffect, useMemo, useRef, useState } from "react";
import "./conversation-workspace.css";

const statuses = {
  new: "Новый",
  ai_dialog: "ИИ-диалог",
  qualified: "Подходит",
  unqualified: "Не подходит",
  insufficient_data: "Недостаточно данных",
  manager_required: "Нужен менеджер",
  manager_working: "Менеджер работает",
  refused: "Отказ",
  closed: "Закрыт",
};
const modes = { auto: "Авто", manual: "Вручную", paused: "Пауза" };
const actionStates: Record<string, string> = {
  pending: "Ожидает отправки",
  dispatching: "Вызов начат",
  confirmed: "Отправка подтверждена каналом",
  rejected: "Отклонено",
  unknown: "Исход неизвестен — нужна проверка",
  cancelled: "Отменено",
};
type Conversation = {
  id: string;
  platform: "max" | "whatsapp";
  accountId: string;
  accountName: string;
  externalId: string;
  status: keyof typeof statuses;
  mode: keyof typeof modes;
  epoch: string;
  accountEnabled: boolean;
  accountNeedsAuth: boolean;
};
type Contact = {
  id: string;
  displayName: string;
  phone: string | null;
  comment: string;
  importedStage: string;
  optedOut: boolean;
  createdAt: string;
  lastActivity: string;
  lastMessage: string | null;
  conversations: Conversation[] | null;
};
type Message = {
  id: string;
  conversationId: string;
  externalMessageId: string;
  direction: "inbound" | "outbound";
  origin: string;
  disposition: string;
  text: string;
  occurredAt: string;
};
type Action = {
  id: string;
  conversationId: string;
  kind: string;
  text: string;
  state: string;
  outcomeCode: string | null;
  externalMessageId: string | null;
  cancellationRequested: boolean;
  createdAt: string;
  updatedAt: string;
};
type Detail = {
  contact: Contact;
  messages: Message[];
  messageTotal: number;
  offset: number;
  limit: number;
  actions: Action[];
};
type List = {
  contacts: Contact[];
  total: number;
  offset: number;
  limit: number;
  counters: {
    new: number;
    qualified: number;
    waiting: number;
    closed: number;
    review: number;
  };
  counterRule: string;
};
type Workflow = {
  business?: BusinessDetail;
  stageLabels?: {scenario:string;label:string}[];
  notifications?: Record<string, unknown>[];
  followups?: Record<string, unknown>[];
  statusHistory?: Record<string, unknown>[];
  conversation?: Record<string, unknown>;
};
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch("/api/ai/workspace" + path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.error || "Не удалось выполнить запрос");
  return body;
}
function operationLabel(action: Action) {
  return action.outcomeCode === "synthetic_confirmation" ||
    action.externalMessageId?.startsWith("synthetic:")
    ? "ТЕСТ: имитация подтверждения, реальной отправки не было"
    : actionStates[action.state] || action.state;
}
function textError(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить запрос";
}
function time(value: string) {
  return new Date(value).toLocaleString("ru-RU");
}
function recordText(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return "—";
}
export default function ConversationWorkspace() {
  const [filters, setFilters] = useState({
      q: "",
      status: "",
      mode: "",
      platform: "",
      accountId: "",
      sort: "recent",
    }),
    [offset, setOffset] = useState(0),
    [list, setList] = useState<List | null>(null),
    [listError, setListError] = useState(""),
    [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0),
    [accounts, setAccounts] = useState<
      { id: string; name: string; platform: string }[]
    >([]);
  const [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<Detail | null>(null),
    [detailError, setDetailError] = useState(""),
    [detailLoading, setDetailLoading] = useState(false),
    [messageOffset, setMessageOffset] = useState(0),
    [conversationId, setConversationId] = useState(""),
    [workflow, setWorkflow] = useState<Workflow | null>(null),
    [workflowError, setWorkflowError] = useState(""),
    [operation, setOperation] = useState(false),
    [notice, setNotice] = useState(""),
    [reason, setReason] = useState(""),
    [newStatus, setNewStatus] = useState("manager_required");
  const operating = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const c = new AbortController();
    void fetch("/api/integrations", {
      credentials: "include",
      signal: c.signal,
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((a) => {
        if (!c.signal.aborted)
          setAccounts(
            a.filter((x: { platform: string }) =>
              ["max", "whatsapp"].includes(x.platform),
            ),
          );
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      c.abort();
    };
  }, []);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setListError("");
    const timer = setTimeout(() => {
      const p = new URLSearchParams({ limit: "30", offset: String(offset) });
      for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
      void api<List>("/contacts?" + p, { signal: c.signal })
        .then((data) => {
          if (!c.signal.aborted) setList(data);
        })
        .catch((e) => {
          if (!c.signal.aborted) setListError(textError(e));
        })
        .finally(() => {
          if (!c.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [filters, offset, revision]);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    const c = new AbortController();
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    void api<Detail>(
      "/contacts/" +
        selected +
        "?limit=50&offset=" +
        messageOffset +
        (conversationId ? "&conversationId=" + conversationId : ""),
      { signal: c.signal },
    )
      .then((data) => {
        if (!c.signal.aborted) {
          setDetail(data);
          setConversationId((current) =>
            data.contact.conversations?.some((v) => v.id === current)
              ? current
              : data.contact.conversations?.[0]?.id || "",
          );
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setDetailError(textError(e));
      })
      .finally(() => {
        if (!c.signal.aborted) setDetailLoading(false);
      });
    return () => c.abort();
  }, [selected, conversationId, messageOffset, revision]);
  useEffect(() => {
    setWorkflow(null);
    setWorkflowError("");
    if (!conversationId) return;
    const c = new AbortController();
    void api<Workflow>("/conversations/" + conversationId + "/workflow", {
      signal: c.signal,
    })
      .then((data) => {
        if (!c.signal.aborted) setWorkflow(data);
      })
      .catch((e) => {
        if (!c.signal.aborted) setWorkflowError(textError(e));
      });
    return () => c.abort();
  }, [conversationId, revision]);
  const conversation = useMemo(
    () => detail?.contact.conversations?.find((v) => v.id === conversationId),
    [detail, conversationId],
  );
  function filter(key: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setOffset(0);
  }
  async function act(path: string, body: unknown) {
    if (operating.current) return;
    operating.current = true;
    setOperation(true);
    setDetailError("");
    setNotice("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      if (mounted.current) {
        setNotice("Изменение сохранено");
        setRevision((v) => v + 1);
      }
    } catch (e) {
      if (mounted.current) setDetailError(textError(e));
    } finally {
      operating.current = false;
      if (mounted.current) setOperation(false);
    }
  }
  function selectContact(id: string) {
    if (operating.current) return;
    setSelected(id);
    setMessageOffset(0);
    setConversationId("");
    setWorkflow(null);
    setNotice("");
    setReason("");
  }
  const selectedMessages =
    detail?.messages.filter(
      (m) => !conversationId || m.conversationId === conversationId,
    ) || [];
  return (
    <div className="conversation-workspace">
      <section
        className="card conversation-filters"
        aria-label="Поиск и фильтры диалогов"
      >
        <label>
          Поиск по имени, телефону или сообщению
          <input
            value={filters.q}
            onChange={(e) => filter("q", e.target.value)}
            maxLength={200}
          />
        </label>
        <label>
          Статус
          <select
            value={filters.status}
            onChange={(e) => filter("status", e.target.value)}
          >
            <option value="">Все статусы</option>
            {Object.entries(statuses).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Режим
          <select
            value={filters.mode}
            onChange={(e) => filter("mode", e.target.value)}
          >
            <option value="">Все режимы</option>
            {Object.entries(modes).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Канал
          <select
            value={filters.platform}
            onChange={(e) => filter("platform", e.target.value)}
          >
            <option value="">Все каналы</option>
            <option value="max">MAX</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
        </label>
        <label>
          Аккаунт
          <select
            value={filters.accountId}
            onChange={(e) => filter("accountId", e.target.value)}
          >
            <option value="">Все аккаунты</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.platform}
              </option>
            ))}
          </select>
        </label>
        <label>
          Сортировка
          <select
            value={filters.sort}
            onChange={(e) => filter("sort", e.target.value)}
          >
            <option value="recent">Недавняя активность</option>
            <option value="oldest">Давняя активность</option>
            <option value="name">По имени</option>
          </select>
        </label>
        <button
          type="button"
          disabled={loading}
          onClick={() => setRevision((v) => v + 1)}
        >
          Обновить
        </button>
      </section>
      <BindConversation
        accounts={accounts}
        onChange={() => setRevision((v) => v + 1)}
      />
      <WorkspaceSettings
        accounts={accounts}
        selectedConversationId={conversationId}
        onChange={() => setRevision((v) => v + 1)}
      />
      {list && (
        <section
          className="conversation-counters"
          aria-label="Сводка контактов"
        >
          {(
            [
              ["new", "Новые"],
              ["qualified", "Подходящие"],
              ["waiting", "Ожидающие"],
              ["closed", "Закрытые"],
              ["review", "Требующие проверки"],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <span>{label}</span>
              <strong>{list.counters[key]}</strong>
            </div>
          ))}
          <p>
            По всей базе диалогов. Контакт может входить в несколько категорий.
          </p>
        </section>
      )}
      {listError && (
        <p role="alert" className="conversation-error">
          {listError}
        </p>
      )}
      <div className="conversation-columns">
        <section
          className="card conversation-list"
          aria-label="Контакты с диалогами"
          aria-busy={loading}
        >
          <h2>Контакты {list && `(${list.total})`}</h2>
          {loading && <p role="status">Загружаем…</p>}
          {!loading && !listError && list?.contacts.length === 0 && (
            <p>Диалогов по выбранным условиям нет.</p>
          )}
          {list?.contacts.map((c) => (
            <button
              key={c.id}
              type="button"
              className={
                "conversation-contact " + (selected === c.id ? "selected" : "")
              }
              onClick={() => selectContact(c.id)}
              disabled={operation}
            >
              <strong>{c.displayName || c.phone || "Без имени"}</strong>
              <span>{c.phone || "Телефон не указан"}</span>
              <small>
                {c.conversations
                  ?.map((v) => `${v.platform} · ${v.accountName}`)
                  .join(" / ")}
              </small>
              <span className="conversation-snippet">
                {c.lastMessage || "Входящие сообщения ещё не записаны"}
              </span>
              <small>
                {time(c.lastActivity)}
                {c.optedOut ? " · Отказ от сообщений" : ""}
              </small>
            </button>
          ))}
          <div className="conversation-pagination">
            <button
              disabled={!offset || loading}
              onClick={() => setOffset((v) => Math.max(0, v - 30))}
            >
              Назад
            </button>
            <span>
              {list?.total ? offset + 1 : 0}–
              {Math.min(
                offset + (list?.contacts.length || 0),
                list?.total || 0,
              )}{" "}
              из {list?.total || 0}
            </span>
            <button
              disabled={loading || !list || offset + 30 >= list.total}
              onClick={() => setOffset((v) => v + 30)}
            >
              Далее
            </button>
          </div>
        </section>
        <section
          className="card conversation-detail"
          aria-label="Карточка контакта"
          aria-busy={detailLoading}
        >
          {!selected && (
            <p>Выберите контакт, чтобы открыть его каналы и историю.</p>
          )}
          {detailLoading && <p role="status">Загружаем карточку…</p>}
          {detailError && (
            <p role="alert" className="conversation-error">
              {detailError}
            </p>
          )}
          {notice && (
            <p role="status" className="conversation-success">
              {notice}
            </p>
          )}
          {detail && (
            <>
              <h2>
                {detail.contact.displayName ||
                  detail.contact.phone ||
                  "Без имени"}
              </h2>
              <p>
                {detail.contact.phone || "Телефон не указан"}
                {detail.contact.optedOut
                  ? " · Контакт исключён из сообщений"
                  : ""}
              </p>
              <dl className="conversation-facts">
                <div>
                  <dt>Комментарий</dt>
                  <dd>{detail.contact.comment || "—"}</dd>
                </div>
                <div>
                  <dt>Этап из импорта</dt>
                  <dd>{detail.contact.importedStage || "—"}</dd>
                </div>
              </dl>
              <label>
                Канал и аккаунт
                <select
                  value={conversationId}
                  disabled={operation}
                  onChange={(e) => {
                    setConversationId(e.target.value);
                    setMessageOffset(0);
                  }}
                >
                  {detail.contact.conversations?.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.platform} · {v.accountName} · {v.externalId}
                    </option>
                  ))}
                </select>
              </label>
              {conversation && (
                <>
                  <p>
                    <b>{statuses[conversation.status]}</b> ·{" "}
                    {modes[conversation.mode]}
                    {!conversation.accountEnabled
                      ? " · Аккаунт недоступен"
                      : ""}
                    {conversation.accountNeedsAuth
                      ? " · Требуется авторизация"
                      : ""}
                  </p>
                  <p className="conversation-address">
                    Исходный диалог: {conversation.externalId}
                    <br />
                    Аккаунт: {conversation.accountName} (
                    {conversation.accountId})
                  </p>
                  <div className="conversation-controls">
                    <button
                      disabled={operation}
                      onClick={() =>
                        void act(
                          "/conversations/" + conversation.id + "/mode",
                          { mode: "manual" },
                        )
                      }
                    >
                      Взять в работу
                    </button>
                    <button
                      disabled={operation}
                      onClick={() =>
                        void act(
                          "/conversations/" + conversation.id + "/mode",
                          { mode: "paused" },
                        )
                      }
                    >
                      Остановить автоматику
                    </button>
                    <button
                      disabled={operation || detail.contact.optedOut}
                      onClick={() =>
                        void act(
                          "/conversations/" + conversation.id + "/mode",
                          { mode: "auto" },
                        )
                      }
                    >
                      Явно продолжить
                    </button>
                  </div>
                  <label>
                    Причина изменения или исключения
                    <input
                      value={reason}
                      maxLength={512}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <div className="conversation-status-editor">
                    <label>
                      Новый статус
                      <select
                        value={newStatus}
                        onChange={(e) => setNewStatus(e.target.value)}
                      >
                        {Object.entries(statuses)
                          .filter(([key]) => key !== "qualified")
                          .map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button
                      disabled={operation || !reason.trim()}
                      onClick={() =>
                        void act(
                          "/conversations/" + conversation.id + "/status",
                          { status: newStatus, reason: reason.trim() },
                        )
                      }
                    >
                      Сохранить статус
                    </button>
                    <button
                      disabled={
                        operation || !reason.trim() || detail.contact.optedOut
                      }
                      onClick={() =>
                        void act(
                          "/contacts/" + detail.contact.id + "/opt-out",
                          { reason: reason.trim() },
                        )
                      }
                    >
                      Исключить контакт
                    </button>
                  </div>
                  <small>
                    «Подходит» требует проверки критериев на сервере.
                    Возобновление не снимает отказ контакта.
                  </small>
                  <h3>История выбранного диалога</h3>
                  {!selectedMessages.length && (
                    <p>
                      На этой странице истории сообщений выбранного диалога нет.
                    </p>
                  )}
                  <div className="conversation-messages">
                    {selectedMessages.map((m) => (
                      <article
                        key={m.id}
                        className={"conversation-message " + m.direction}
                      >
                        <header>
                          <b>
                            {m.origin === "customer"
                              ? "Клиент"
                              : m.origin === "human"
                                ? "Менеджер"
                                : m.origin === "service"
                                  ? "Сервис"
                                  : "Источник требует проверки"}
                          </b>
                          <time>{time(m.occurredAt)}</time>
                        </header>
                        <p>{m.text || "Сообщение без текста"}</p>
                        <small>
                          {m.direction === "inbound" ? "Входящее" : "Исходящее"}{" "}
                          · ID {m.externalMessageId}
                        </small>
                      </article>
                    ))}
                  </div>
                  <div className="conversation-pagination">
                    <button
                      disabled={
                        messageOffset + 50 >= detail.messageTotal ||
                        detailLoading
                      }
                      onClick={() => setMessageOffset((v) => v + 50)}
                    >
                      Более ранние
                    </button>
                    <span>
                      Страница истории {Math.floor(messageOffset / 50) + 1};
                      всего {detail.messageTotal}
                    </span>
                    <button
                      disabled={!messageOffset || detailLoading}
                      onClick={() =>
                        setMessageOffset((v) => Math.max(0, v - 50))
                      }
                    >
                      Более поздние
                    </button>
                  </div>
                  <h3>Операции отправки</h3>
                  <p>
                    Намерение отправки не означает доставку. Ниже последние 100
                    операций контакта, отфильтрованные по выбранному диалогу.
                  </p>
                  {detail.actions
                    .filter((a) => a.conversationId === conversation.id)
                    .map((a) => (
                      <article key={a.id} className="conversation-operation">
                        <b>{operationLabel(a)}</b>
                        <p>{a.text}</p>
                        <small>
                          {time(a.updatedAt)} ·{" "}
                          {{
                            first_message: "Первое обращение",
                            reply: "Ответ",
                            follow_up: "Повторное обращение",
                            manual_reply: "Ручной ответ",
                          }[a.kind] || a.kind}
                          {a.externalMessageId
                            ? " · ID " + a.externalMessageId
                            : ""}
                          {a.cancellationRequested ? " · Запрошена отмена" : ""}
                        </small>
                      </article>
                    ))}
                  <h3>Передача и повторные обращения</h3>
                  {workflowError && (
                    <p className="conversation-muted">{workflowError}</p>
                  )}
                  {workflow && (
                    <>
                      {workflow.business&&<BusinessStageCard key={conversationId} conversationId={conversationId} data={workflow.business} labels={workflow.stageLabels??[]} closed={conversation?.status==='closed'} onChange={()=>setRevision(v=>v+1)}/>}
                      <h4>Последние 20 уведомлений менеджеру</h4>
                      {workflow.notifications?.length ? (
                        workflow.notifications.map((n, i) => (
                          <article
                            className="conversation-operation"
                            key={String(n.id || i)}
                          >
                            {{
                              qualified: "Подходящий контакт",
                              human_requested: "Клиент попросил человека",
                              insufficient_data: "Недостаточно данных",
                              reply_limit: "Достигнут лимит ответов",
                            }[recordText(n, ["reason"])] ||
                              "Передача менеджеру"}{" "}
                            ·{" "}
                            {n.outcome_code === "synthetic_confirmation" ||
                            String(n.external_message_id || "").startsWith(
                              "synthetic:",
                            )
                              ? "ТЕСТ: уведомление не отправлялось"
                              : actionStates[recordText(n, ["state"])] ||
                                recordText(n, ["state"])}
                            <br />
                            {recordText(n, ["summary"])}
                            <details>
                              <summary>Параметры и источник</summary>
                              <RecordValues value={n.parameters} />
                              <RecordValues value={n.source} />
                            </details>
                          </article>
                        ))
                      ) : (
                        <p>Уведомлений нет.</p>
                      )}
                      <h4>Последние 50 повторных обращений</h4>
                      {workflow.followups?.length ? (
                        workflow.followups.map((f, i) => (
                          <p key={String(f.id || i)}>
                            {workflow.stageLabels?.find(r=>r.scenario===f.scenario)?.label||scenarios[recordText(f,["scenario"]) as Scenario]||"Повторное обращение"}{" "}
                            ·{" "}
                            {{
                              pending: "Запланировано",
                              enqueued: "Передано в очередь",
                              cancelled: "Отменено",
                            }[recordText(f, ["status", "state"])] ||
                              "Требует проверки"}{" "}
                            · {time(recordText(f, ["due_at", "dueAt"]))}
                          </p>
                        ))
                      ) : (
                        <p>Повторные обращения не запланированы.</p>
                      )}
                    </>
                  )}
                  {workflow?.statusHistory?.length ? (
                    <details>
                      <summary>Последние 100 изменений статуса</summary>
                      {workflow.statusHistory.map((entry, i) => (
                        <p key={String(entry.id || i)}>
                          {statuses[
                            recordText(entry, [
                              "from_status",
                            ]) as keyof typeof statuses
                          ] || "—"}{" "}
                          →{" "}
                          {statuses[
                            recordText(entry, [
                              "to_status",
                            ]) as keyof typeof statuses
                          ] || "—"}
                          : {recordText(entry, ["reason"])} ·{" "}
                          {time(recordText(entry, ["created_at"]))}
                        </p>
                      ))}
                    </details>
                  ) : null}
                  <ManualReplyComposer
                    key={conversation.id}
                    conversationId={conversation.id}
                    blocked={
                      detail.contact.optedOut ||
                      Boolean(
                        detail.contact.conversations?.some(
                          (v) =>
                            v.status === "closed" || v.status === "refused",
                        ),
                      )
                    }
                    onQueued={() => setRevision((v) => v + 1)}
                  />
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

const scenarios = {
  no_reply: "Не ответил",
  not_booked: "Этап 1",
  not_completed: "Этап 2",
  requested_later: "Попросил позже",
};
type Scenario = keyof typeof scenarios;
type Rule = {
  scenario: Scenario;
  enabled: boolean;
  label: string;
  channel: "current"|"max"|"whatsapp";
  acknowledgementMessage: string;
  timezone: string;
  weekdays: number[];
  startMinute: number;
  endMinute: number;
  steps: { delaySeconds: number; text: string }[];
  maxSends: number;
};
function minuteText(minute: number) {
  return (
    String(Math.floor(minute / 60)).padStart(2, "0") +
    ":" +
    String(minute % 60).padStart(2, "0")
  );
}
function minuteValue(text: string) {
  const [h, m] = text.split(":").map(Number);
  return h * 60 + m;
}
function WorkspaceSettings({
  accounts,
  selectedConversationId,
  onChange,
}: {
  accounts: { id: string; name: string; platform: string }[];
  selectedConversationId: string;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false),
    [loaded, setLoaded] = useState(false),
    [managerAccount, setManagerAccount] = useState(""),
    [managerExternal, setManagerExternal] = useState(""),
    [rules, setRules] = useState<Record<string, unknown>[]>([]),
    [scenario, setScenario] = useState<Scenario>("no_reply"),
    [enabled, setEnabled] = useState(false),
    [label,setLabel]=useState(''),
    [channel,setChannel]=useState<Rule['channel']>('current'),
    [acknowledgementMessage,setAcknowledgementMessage]=useState('Хорошо, свяжемся позже.'),
    [ruleDirty, setRuleDirty] = useState(false),
    [timezone, setTimezone] = useState(""),
    [days, setDays] = useState<number[]>([]),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [maxSends, setMaxSends] = useState(1),
    [steps, setSteps] = useState<{ delaySeconds: number; text: string }[]>([
      { delaySeconds: 60, text: "" },
    ]),
    [anchor, setAnchor] = useState(""),
    [handoffReason, setHandoffReason] = useState<
      "human_requested" | "insufficient_data" | "reply_limit"
    >("human_requested"),
    [summary, setSummary] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const mounted = useRef(true),
    inflight = useRef(false),
    scheduleKey = useRef<string | null>(null),
    handoffKey = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(fn: () => Promise<void>) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setError(textError(e));
    } finally {
      inflight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function load() {
    await run(async () => {
      const data = await api<{
        managerTarget: { accountId: string; externalId: string } | null;
        followupRules: Record<string, unknown>[];
      }>("/settings");
      if (!mounted.current) return;
      setManagerAccount(data.managerTarget?.accountId || "");
      setManagerExternal(data.managerTarget?.externalId || "");
      setRules(data.followupRules);
      setLoaded(true);
      selectRule(scenario, data.followupRules);
    });
  }
  function selectRule(value: Scenario, source = rules) {
    setScenario(value);
    setRuleDirty(false);
    scheduleKey.current = null;
    const r = source.find((r) => r.scenario === value);
    setEnabled(Boolean(r?.enabled));
    setLabel(typeof r?.label==='string'&&r.label?r.label:scenarios[value]);
    setChannel(r?.channel==='max'||r?.channel==='whatsapp'?r.channel:'current');
    setAcknowledgementMessage(typeof r?.acknowledgement_message==='string'?r.acknowledgement_message:'Хорошо, свяжемся позже.');
    setTimezone(typeof r?.timezone === "string" ? r.timezone : "");
    setDays(Array.isArray(r?.weekdays) ? (r.weekdays as number[]) : []);
    setStart(
      typeof r?.start_minute === "number" ? minuteText(r.start_minute) : "",
    );
    setEnd(typeof r?.end_minute === "number" ? minuteText(r.end_minute) : "");
    setMaxSends(typeof r?.max_sends === "number" ? r.max_sends : 1);
    setSteps(
      Array.isArray(r?.steps)
        ? (r.steps as Rule["steps"])
        : [{ delaySeconds: 60, text: "" }],
    );
  }
  function invalidateSchedule() {
    scheduleKey.current = null;
    setRuleDirty(true);
  }
  useEffect(() => {
    scheduleKey.current = null;
    handoffKey.current = null;
  }, [selectedConversationId]);
  return (
    <section className="card conversation-settings">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          if (!loaded && !open) void load();
        }}
      >
        Настройки передачи и повторных обращений
      </button>
      {open && (
        <>
          <p>
            Включённые правила автоматически создают дожимы после новых подтверждённых
            отправок и отметок этапов. Ответ клиента отменяет ожидание. После передачи
            менеджеру автоматические сообщения заблокированы до закрытия заявки.
          </p>
          <StorageSettings/>
          {error && (
            <p role="alert" className="conversation-error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="conversation-success">
              {notice}
            </p>
          )}
          <button disabled={busy} onClick={() => void load()}>
            Загрузить настройки
          </button>
          {loaded && (
            <fieldset disabled={busy}>
              <legend>Получатель уведомлений менеджеру</legend>
              <div className="conversation-settings-grid">
                <label>
                  Аккаунт MAX
                  <select
                    value={managerAccount}
                    onChange={(e) => setManagerAccount(e.target.value)}
                  >
                    <option value="">Выберите аккаунт</option>
                    {accounts
                      .filter((a) => a.platform === "max")
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  ID беседы менеджера в MAX
                  <input
                    value={managerExternal}
                    maxLength={256}
                    onChange={(e) => setManagerExternal(e.target.value)}
                  />
                </label>
              </div>
              <button
                disabled={!managerAccount || !managerExternal.trim()}
                onClick={() =>
                  void run(async () => {
                    await api("/settings/manager", {
                      method: "PUT",
                      body: JSON.stringify({
                        accountId: managerAccount,
                        externalId: managerExternal.trim(),
                      }),
                    });
                    if (mounted.current)
                      setNotice(
                        "Получатель менеджера сохранён. Уже записанные уведомления сохраняют прежний адрес.",
                      );
                  })
                }
              >
                Сохранить получателя
              </button>
              <hr />
              <legend>Правило повторного обращения</legend>
              <div className="conversation-settings-grid">
                <label>
                  Сценарий
                  <select
                    value={scenario}
                    onChange={(e) => selectRule(e.target.value as Scenario)}
                  >
                    {Object.entries(scenarios).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Состояние правила
                  <select
                    value={enabled ? "enabled" : "disabled"}
                    onChange={(e) => {
                      setEnabled(e.target.value === "enabled");
                      invalidateSchedule();
                    }}
                  >
                    <option value="disabled">Выключено</option>
                    <option value="enabled">Включено</option>
                  </select>
                </label>
                <label>
                  Часовой пояс
                  <input
                    value={timezone}
                    placeholder="Например, Europe/Moscow"
                    onChange={(e) => {
                      setTimezone(e.target.value);
                      invalidateSchedule();
                    }}
                  />
                </label>
                <label>
                  Лимит сообщений
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={maxSends}
                    onChange={(e) => {
                      setMaxSends(Number(e.target.value));
                      invalidateSchedule();
                    }}
                  />
                </label>
                <label>
                  Начало рабочего окна
                  <input
                    type="time"
                    value={start}
                    onChange={(e) => {
                      setStart(e.target.value);
                      invalidateSchedule();
                    }}
                  />
                </label>
                <label>
                  Конец рабочего окна
                  <input
                    type="time"
                    value={end}
                    onChange={(e) => {
                      setEnd(e.target.value);
                      invalidateSchedule();
                    }}
                  />
                </label>
              </div>
              <div className="conversation-settings-grid">
                <label>Название этапа<input maxLength={120} value={label} onChange={e=>{setLabel(e.target.value);invalidateSchedule();}}/></label>
                <label>Канал дожима<select value={channel} onChange={e=>{setChannel(e.target.value as Rule['channel']);invalidateSchedule();}}><option value="current">Текущий</option><option value="max">MAX</option><option value="whatsapp">WhatsApp</option></select></label>
                {scenario==='requested_later'&&<label>Ответ на просьбу связаться позже<textarea maxLength={2000} value={acknowledgementMessage} onChange={e=>{setAcknowledgementMessage(e.target.value);invalidateSchedule();}}/></label>}
              </div>
              <p>Для другого канала нужен подтверждённый контакт в той же заявке. Старые ожидания после отключения правила не возобновляются.</p>
              <div className="conversation-weekdays" aria-label="Рабочие дни">
                {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((label, i) => (
                  <label key={label}>
                    <input
                      type="checkbox"
                      checked={days.includes(i + 1)}
                      onChange={(e) => {
                        setDays((v) =>
                          e.target.checked
                            ? [...v, i + 1].sort()
                            : v.filter((n) => n !== i + 1),
                        );
                        invalidateSchedule();
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {steps.map((step, index) => (
                <div className="conversation-followup-step" key={index}>
                  <label>
                    Задержка шага {index + 1}, секунд
                    <input
                      type="number"
                      min={1}
                      max={31536000}
                      value={step.delaySeconds}
                      onChange={(e) => {
                        setSteps((v) =>
                          v.map((s, i) =>
                            i === index
                              ? { ...s, delaySeconds: Number(e.target.value) }
                              : s,
                          ),
                        );
                        invalidateSchedule();
                      }}
                    />
                  </label>
                  <label>
                    Текст шага {index + 1}
                    <textarea
                      value={step.text}
                      maxLength={4000}
                      rows={3}
                      onChange={(e) => {
                        setSteps((v) =>
                          v.map((s, i) =>
                            i === index ? { ...s, text: e.target.value } : s,
                          ),
                        );
                        invalidateSchedule();
                      }}
                    />
                  </label>
                  <button
                    disabled={steps.length === 1}
                    onClick={() => {
                      setSteps((v) => v.filter((_, i) => i !== index));
                      invalidateSchedule();
                    }}
                  >
                    Удалить шаг
                  </button>
                </div>
              ))}
              <div className="conversation-controls">
                <button
                  disabled={steps.length >= 20}
                  onClick={() => {
                    setSteps((v) => [...v, { delaySeconds: 60, text: "" }]);
                    invalidateSchedule();
                  }}
                >
                  Добавить шаг
                </button>
                <button
                  disabled={
                    !label.trim() || !acknowledgementMessage.trim() || !timezone.trim() ||
                    !days.length ||
                    !start ||
                    !end ||
                    steps.some((s) => !s.text.trim())
                  }
                  onClick={() =>
                    void run(async () => {
                      const rule: Rule = {
                        scenario,
                        enabled,label:label.trim(),channel,acknowledgementMessage:acknowledgementMessage.trim(),
                        timezone: timezone.trim(),
                        weekdays: days,
                        startMinute: minuteValue(start),
                        endMinute: minuteValue(end),
                        steps,
                        maxSends,
                      };
                      const saved = await api<Record<string, unknown>>(
                        "/settings/followups",
                        { method: "PUT", body: JSON.stringify(rule) },
                      );
                      if (mounted.current) {
                        setRules((v) => [
                          ...v.filter((r) => r.scenario !== scenario),
                          saved,
                        ]);
                        setRuleDirty(false);
                        onChange();
                        setNotice(
                          enabled?"Правило включено для новых отправок и отметок этапов.":"Правило сохранено и выключено. Ожидания отменены.",
                        );
                      }
                    })
                  }
                >
                  Сохранить правило
                </button>
              </div>
              {ruleDirty && (
                <p>Сохраните правило перед созданием расписания.</p>
              )}
              <hr />
              <legend>Действия для выбранного диалога</legend>
              <p>
                {selectedConversationId
                  ? "Выбран диалог " + selectedConversationId
                  : "Сначала выберите контакт и его канал в карточке ниже."}
              </p>
              <label>
                Начало отсчёта — местное время устройства
                <input
                  type="datetime-local"
                  value={anchor}
                  onChange={(e) => {
                    setAnchor(e.target.value);
                    scheduleKey.current = null;
                  }}
                />
              </label>
              <div className="conversation-controls">
                <button
                  disabled={!selectedConversationId || !anchor || ruleDirty}
                  onClick={() =>
                    void run(async () => {
                      scheduleKey.current ??= crypto.randomUUID();
                      await api(
                        "/conversations/" +
                          selectedConversationId +
                          "/followups",
                        {
                          method: "POST",
                          body: JSON.stringify({
                            scenario,
                            key: scheduleKey.current,
                            anchorAt: new Date(anchor).toISOString(),
                          }),
                        },
                      );
                      if (mounted.current) {
                        setNotice(
                          "Расписание записано. Статус и ожидающие операции доступны в карточке.",
                        );
                        onChange();
                      }
                    })
                  }
                >
                  Создать расписание по сохранённому правилу
                </button>
                <button
                  disabled={!selectedConversationId}
                  onClick={() =>
                    void run(async () => {
                      await api(
                        "/conversations/" +
                          selectedConversationId +
                          "/cancel-followups",
                        {
                          method: "POST",
                          body: JSON.stringify({ reason: "requested_stop" }),
                        },
                      );
                      if (mounted.current) {
                        setNotice("Ожидающие повторные обращения отменены");
                        onChange();
                      }
                    })
                  }
                >
                  Отменить повторные обращения
                </button>
              </div>
              <label>
                Причина передачи менеджеру
                <select
                  value={handoffReason}
                  onChange={(e) => {
                    setHandoffReason(e.target.value as typeof handoffReason);
                    handoffKey.current = null;
                  }}
                >
                  <option value="human_requested">
                    Клиент попросил человека
                  </option>
                  <option value="insufficient_data">Не хватает данных</option>
                  <option value="reply_limit">Достигнут лимит ответов</option>
                </select>
              </label>
              <label>
                Резюме для менеджера
                <textarea
                  value={summary}
                  maxLength={4000}
                  rows={3}
                  onChange={(e) => {
                    setSummary(e.target.value);
                    handoffKey.current = null;
                  }}
                />
              </label>
              <button
                disabled={!selectedConversationId || !summary.trim()}
                onClick={() =>
                  void run(async () => {
                    handoffKey.current ??= crypto.randomUUID();
                    await api(
                      "/conversations/" + selectedConversationId + "/handoff",
                      {
                        method: "POST",
                        body: JSON.stringify({
                          key: handoffKey.current,
                          reason: handoffReason,
                          summary: summary.trim(),
                        }),
                      },
                    );
                    if (mounted.current) {
                      setNotice(
                        "Передача записана, автоматика остановлена. Это не подтверждение доставки уведомления менеджеру.",
                      );
                      onChange();
                    }
                  })
                }
              >
                Записать передачу менеджеру
              </button>
            </fieldset>
          )}
        </>
      )}
    </section>
  );
}

function BindConversation({
  accounts,
  onChange,
}: {
  accounts: { id: string; name: string; platform: string }[];
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false),
    [contacts, setContacts] = useState<
      { id: string; displayName: string; phone: string | null }[]
    >([]),
    [contactId, setContactId] = useState(""),
    [accountId, setAccountId] = useState(""),
    [externalId, setExternalId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const mounted = useRef(true),
    inflight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function load() {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/ai/contacts?limit=100", {
          credentials: "include",
        }),
        data = await r.json();
      if (!r.ok) throw new Error(data.error || "Не удалось загрузить контакты");
      if (mounted.current) setContacts(data.contacts);
    } catch (e) {
      if (mounted.current) setError(textError(e));
    } finally {
      inflight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function bind() {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/ai/protocol/conversations", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contactId, accountId, externalId }),
        }),
        data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Не удалось привязать диалог");
      if (mounted.current) {
        setNotice(
          "Привязка сохранена. Новые диалоги создаются на паузе; сообщения не отправлялись.",
        );
        onChange();
      }
    } catch (e) {
      if (mounted.current) setError(textError(e));
    } finally {
      inflight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="card conversation-settings">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void load();
        }}
      >
        Привязать диалог в тестовом стенде
      </button>
      {open && (
        <>
          <p>
            Выберите подтверждённый контакт и укажите точный ID его диалога у
            выбранного аккаунта. Имя и аватар не используются для
            автоматического объединения. Этот инструмент доступен только в
            разрешённом тестовом режиме.
          </p>
          {error && (
            <p role="alert" className="conversation-error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="conversation-success">
              {notice}
            </p>
          )}
          <fieldset disabled={busy}>
            <label>
              Контакт из базы
              <select
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
              >
                <option value="">Выберите контакт (первые 100)</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName || c.phone || c.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Аккаунт диалога
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">Выберите аккаунт</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.platform}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Точный ID диалога
              <input
                value={externalId}
                maxLength={512}
                onChange={(e) => setExternalId(e.target.value)}
              />
            </label>
            <div className="conversation-controls">
              <button
                disabled={!contactId || !accountId || !externalId.trim()}
                onClick={() => void bind()}
              >
                Сохранить подтверждённую привязку
              </button>
              <button onClick={() => void load()}>
                Обновить список контактов
              </button>
            </div>
          </fieldset>
        </>
      )}
    </section>
  );
}

function RecordValues({ value }: { value: unknown }) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.keys(value).length
  )
    return <p>Данные не записаны.</p>;
  return (
    <dl className="conversation-facts">
      {Object.entries(value).map(([key, v]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            {typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean"
              ? String(v)
              : "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ManualReplyComposer({
  conversationId,
  blocked,
  onQueued,
}: {
  conversationId: string;
  blocked: boolean;
  onQueued: () => void;
}) {
  const [canStart, setCanStart] = useState(false),
    [capabilitiesLoaded, setCapabilitiesLoaded] = useState(false),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [locked, setLocked] = useState(false),
    [receipt, setReceipt] = useState<string | null>(null),
    [error, setError] = useState("");
  const mounted = useRef(true),
    inflight = useRef(false),
    attempt = useRef<{ operationId: string; text: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    const c = new AbortController();
    void fetch("/api/ai/outreach/capabilities", {
      credentials: "include",
      signal: c.signal,
    })
      .then(async (r) => {
        const data = await r.json();
        if (!c.signal.aborted)
          setCanStart(r.ok && data.canStartSynthetic === true);
      })
      .catch(() => {})
      .finally(() => {
        if (!c.signal.aborted) setCapabilitiesLoaded(true);
      });
    return () => {
      mounted.current = false;
      c.abort();
    };
  }, []);
  async function submit() {
    if (inflight.current || !canStart || blocked || receipt || !text.trim())
      return;
    inflight.current = true;
    setBusy(true);
    setError("");
    attempt.current ??= { operationId: crypto.randomUUID(), text };
    setLocked(true);
    try {
      const response = await fetch(
        "/api/ai/protocol/conversations/" + conversationId + "/manual-messages",
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(attempt.current),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (
          (response.status >= 400 && response.status < 500) ||
          response.status === 503
        ) {
          attempt.current = null;
          if (mounted.current) setLocked(false);
        }
        throw new Error(
          data.error || "Не удалось подтвердить запись ручного ответа",
        );
      }
      if (mounted.current) {
        setReceipt(
          String(
            data.action?.id ||
              data.result?.action?.id ||
              attempt.current.operationId,
          ),
        );
        onQueued();
      }
    } catch (e) {
      if (mounted.current)
        setError(
          textError(e) +
            (attempt.current
              ? " Ответ мог быть записан. Повторите подтверждение этого же намерения; текст и идентификатор сохраняются."
              : ""),
        );
    } finally {
      inflight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="conversation-manual-reply">
      <h3>Ручной ответ — тестовый режим</h3>
      <p>
        Создаётся отдельное ручное намерение, автоматика контакта
        останавливается. Реальный клиент это сообщение не получит.
      </p>
      {!capabilitiesLoaded && (
        <p role="status">Проверяем доступность тестового режима…</p>
      )}
      {capabilitiesLoaded && !canStart && (
        <p>
          Ручной ответ из этого интерфейса доступен только при включённом
          синтетическом транспорте. Для реального ответа используйте исходное
          приложение и указанный аккаунт.
        </p>
      )}
      {blocked && (
        <p>
          Ручной ответ запрещён: контакт исключён либо один из его диалогов
          закрыт.
        </p>
      )}
      {error && (
        <p role="alert" className="conversation-error">
          {error}
        </p>
      )}
      {receipt ? (
        <>
          <p role="status" className="conversation-success">
            ТЕСТ: ручное намерение записано. Реальной отправки не было. Операция{" "}
            {receipt}; её состояние показано в списке операций.
          </p>
          <button
            type="button"
            onClick={() => {
              setReceipt(null);
              setText("");
              setError("");
              setLocked(false);
              attempt.current = null;
            }}
          >
            Начать новый тестовый ответ
          </button>
        </>
      ) : (
        <>
          <label>
            Текст тестового ручного ответа
            <textarea
              rows={4}
              maxLength={4000}
              value={text}
              disabled={!canStart || blocked || busy || locked}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!canStart || blocked || busy || !text.trim()}
            onClick={() => void submit()}
          >
            {busy
              ? "Записываем ручное намерение…"
              : locked
                ? "Повторить подтверждение того же ответа"
                : "Создать тестовый ручной ответ"}
          </button>
        </>
      )}
    </section>
  );
}
