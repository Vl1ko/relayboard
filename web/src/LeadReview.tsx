import { useEffect, useRef, useState } from "react";
type Lead = {
  id: string;
  platform: string;
  account_id: string;
  chat_id: string;
  author_id: string;
  message_id: string;
  occurred_at: string;
  source_link: string | null;
  original_text: string;
  source_kind: string;
  params: { key: string; value: string | number; evidenceQuote: string }[];
  confidence: number;
  status: "pending" | "approved" | "rejected";
  revision: number;
  request_id: string | null;
};
type Contact = { id: string; displayName: string; phone: string | null };
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init.headers },
  });
  const b = await r.json();
  if (!r.ok) throw new Error(b.error || "Ошибка запроса");
  return b;
}
export default function LeadReview() {
  const [leads, setLeads] = useState<Lead[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [filter, setFilter] = useState("pending"),
    [contacts, setContacts] = useState<Contact[]>([]),
    [requests, setRequests] = useState<{ id: string; contactId: string }[]>([]),
    [requestId, setRequestId] = useState(""),
    [selected, setSelected] = useState(""),
    [contact, setContact] = useState(""),
    [params, setParams] = useState("[]"),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ack, setAck] = useState("");
  const current = leads.find((x) => x.id === selected),
    generation = useRef(0),
    mounted = useRef(true),
    pending = useRef<{ path: string; body: unknown } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    void load();
  }, [offset, filter]);
  async function load() {
    const g = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const [l, c, r] = await Promise.all([
        api<{ leads: Lead[]; total: number }>(
          `/api/ai/leads?limit=25&offset=${offset}&status=${filter}`,
        ),
        api<{ contacts: Contact[] }>("/api/ai/contacts?limit=100"),
        api<{ id: string; contactId: string }[]>("/api/ai/outreach/requests"),
      ]);
      if (!mounted.current || g !== generation.current) return;
      setLeads(l.leads);
      setTotal(l.total);
      setContacts(c.contacts);
      setRequests(r);
      setSelected("");
      setParams("[]");
    } catch (e) {
      if (mounted.current && g === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current && g === generation.current) setBusy(false);
    }
  }
  async function send(action: "edit" | "approve" | "reject") {
    if (!current || busy) return;
    setBusy(true);
    setError("");
    setAck("");
    try {
      if (!pending.current) {
        const parsed = JSON.parse(params);
        pending.current = {
          path: `/api/ai/leads/${encodeURIComponent(current.id)}/review`,
          body: {
            operationId: crypto.randomUUID(),
            expectedRevision: current.revision,
            action,
            params: parsed,
            ...(action === "approve"
              ? {
                  contactId: contact,
                  requestId: requestId || crypto.randomUUID(),
                }
              : {}),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          },
        };
      }
      await api(pending.current.path, {
        method: "POST",
        body: JSON.stringify(pending.current.body),
      });
      pending.current = null;
      if (!mounted.current) return;
      setAck("Проверка сохранена. Сообщения не отправлялись.");
      await load();
    } catch (e) {
      if (mounted.current)
        setError(
          (e instanceof Error ? e.message : String(e)) +
            " При потерянном ответе повторите ту же операцию.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function choose(lead: Lead) {
    if (pending.current) return;
    setSelected(lead.id);
    setParams(JSON.stringify(lead.params, null, 2));
    setContact("");
    setRequestId("");
    setReason("");
    setError("");
    setAck("");
  }
  async function retry() {
    if (!pending.current || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(pending.current.path, {
        method: "POST",
        body: JSON.stringify(pending.current.body),
      });
      pending.current = null;
      setAck("Результат операции получен. Отправок нет.");
      await load();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      className="card contact-import-card"
      style={{ overflowWrap: "anywhere" }}
    >
      <h2>Источники заявок — проверка</h2>
      <p>
        Подключённого поиска сейчас нет. Здесь отображаются вручную внесённые
        или тестовые сообщения. Высокая оценка уверенности не запускает
        обращение автоматически.
      </p>
      {error && (
        <p role="alert" className="contact-import-error">
          {error}
        </p>
      )}
      {ack && <p role="status">{ack}</p>}
      {pending.current && (
        <div>
          <p>
            Ответ операции не получен. Изменение выбора заблокировано до
            выяснения результата.
          </p>
          <button disabled={busy} onClick={() => void retry()}>
            Повторить ту же операцию
          </button>
          <button
            disabled={busy}
            onClick={() => {
              pending.current = null;
              setError("");
              void load();
            }}
          >
            Проверить состояние по списку
          </button>
        </div>
      )}
      <fieldset disabled={busy || !!pending.current}>
        <label>
          Состояние
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setOffset(0);
            }}
          >
            <option value="pending">Ожидает проверки</option>
            <option value="approved">Одобрено</option>
            <option value="rejected">Отклонено</option>
          </select>
        </label>
        <button onClick={() => void load()}>Обновить</button>
        <p>
          {total} источников, показаны {leads.length}
        </p>
        <ul>
          {leads.map((l) => (
            <li key={l.id}>
              <button onClick={() => choose(l)}>
                {l.platform} · {l.original_text.slice(0, 100)} ·{" "}
                {l.source_kind === "fixture"
                  ? "Тестовый источник"
                  : "Внесено вручную"}
              </button>
            </li>
          ))}
        </ul>
        <button
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 25))}
        >
          Предыдущие
        </button>
        <button
          disabled={offset + 25 >= total}
          onClick={() => setOffset(offset + 25)}
        >
          Следующие
        </button>
        {current && (
          <div>
            <h3>Исходное сообщение</h3>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {current.original_text}
            </pre>
            <dl>
              <dt>Аккаунт</dt>
              <dd>{current.account_id}</dd>
              <dt>Беседа / автор</dt>
              <dd>
                {current.chat_id} / {current.author_id}
              </dd>
              <dt>Дата сообщения</dt>
              <dd>{new Date(current.occurred_at).toLocaleString("ru-RU")}</dd>
              <dt>ID сообщения</dt>
              <dd>{current.message_id}</dd>
              <dt>Заявленная уверенность, требует проверки</dt>
              <dd>{current.confidence}</dd>
            </dl>
            {current.source_link && (
              <a
                href={current.source_link}
                target="_blank"
                rel="noopener noreferrer"
              >
                Открыть источник
              </a>
            )}
            {current.status === "pending" ? (
              <>
                <label>
                  Параметры с точными цитатами, JSON
                  <textarea
                    rows={7}
                    value={params}
                    onChange={(e) => setParams(e.target.value)}
                  />
                </label>
                <small>
                  Каждый параметр: key, value, evidenceQuote. Цитата должна
                  находиться в исходном сообщении.
                </small>
                <button onClick={() => void send("edit")}>
                  Сохранить параметры
                </button>
                <label>
                  Явно подтверждённый контакт
                  <select
                    value={contact}
                    onChange={(e) => {
                      setContact(e.target.value);
                      setRequestId("");
                    }}
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
                  Явная заявка
                  <select
                    value={requestId}
                    onChange={(e) => setRequestId(e.target.value)}
                    disabled={!contact}
                  >
                    <option value="">Создать отдельную новую заявку</option>
                    {requests
                      .filter((r) => r.contactId === contact)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          Существующая заявка {r.id}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  disabled={!contact}
                  onClick={() => void send("approve")}
                >
                  Одобрить и привязать заявку
                </button>
                <label>
                  Причина / заметка
                  <input
                    value={reason}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <button
                  disabled={!reason.trim()}
                  onClick={() => void send("reject")}
                >
                  Отклонить
                </button>
              </>
            ) : (
              <p>
                Результат:{" "}
                {current.status === "approved" ? "Одобрено" : "Отклонено"}
                {current.request_id ? " · заявка " + current.request_id : ""}
              </p>
            )}
          </div>
        )}
      </fieldset>
    </section>
  );
}
