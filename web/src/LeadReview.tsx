import SearchSourcesPanel from "./SearchSourcesPanel";
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
  source_message_id?:string|null;
  activation_error?:string|null;
};
type Contact = { id: string; displayName: string; phone: string | null };
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init.headers },
  });
  const b = await r.json();
  if (!r.ok) throw Object.assign(new Error(b.error || "Ошибка запроса"),{status:r.status});
  return b;
}
export default function LeadReview({accounts,destinations}:{accounts:{id:string;name:string;platform:string;enabled:boolean}[];destinations:{integration_id:string;external_id:string;title:string}[]}) {
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
    [canActivate,setCanActivate]=useState(false),[sender,setSender]=useState(''),[allowedSenders,setAllowedSenders]=useState<string[]>([]),[fields,setFields]=useState<{key:string;question:string;numeric?:boolean}[]>([]),
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
      const [l, c, r, outgoing, engine, monitor] = await Promise.all([
        api<{ leads: Lead[]; total: number }>(
          `/api/ai/leads?limit=25&offset=${offset}&status=${filter}`,
        ),
        api<{ contacts: Contact[] }>("/api/ai/contacts?limit=100"),
        api<{ id: string; contactId: string }[]>("/api/ai/outreach/requests"),
        api<{accountIds:string[]}>('/api/ai/outreach/settings'),api<{settings:{fields:{key:string;question:string}[];rules?:{field:string;op:string}[]}}>('/api/ai/engine/settings'),api<{runtimeEnabled:boolean}>('/api/ai/leads/monitor'),
      ]);
      if (!mounted.current || g !== generation.current) return;
      setLeads(l.leads);
      setTotal(l.total);
      setContacts(c.contacts);
      setRequests(r);setAllowedSenders(outgoing.accountIds);setCanActivate(monitor.runtimeEnabled);setFields(engine.settings.fields.map(f=>({...f,numeric:engine.settings.rules?.some(r=>r.field===f.key&&['gte','lte'].includes(r.op))})));
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
        pending.current = action==='approve'&&current.source_message_id?{path:`/api/ai/leads/${encodeURIComponent(current.id)}/activate`,body:{expectedRevision:current.revision,...(sender?{accountId:sender}:{})}}:{
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
      const activation=pending.current.path.endsWith('/activate');
      await api(pending.current.path, {
        method: "POST",
        body: JSON.stringify(pending.current.body),
      });
      pending.current = null;
      if (!mounted.current) return;
      setAck(activation?"Источник подтверждён. Первое обращение поставлено в очередь по настройкам поиска.":"Проверка сохранена.");
      await load();
    } catch (e) {
      const status=(e as {status?:number})?.status;if(status&&status>=400&&status<500&&![408,429].includes(status))pending.current=null;
      if (mounted.current)
        setError(
          (e instanceof Error ? e.message : String(e)) +
            (pending.current?" При потерянном ответе повторите ту же операцию.":""),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function choose(lead: Lead) {
    if (pending.current) return;
    setSelected(lead.id);
    setParams(JSON.stringify(lead.params, null, 2));
    setContact("");setSender('');
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
      setAck("Результат операции получен. Проверьте состояние заявки и диалога.");
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
      <SearchSourcesPanel />
      <h2>Источники заявок — проверка</h2>
      <p>
        Здесь можно проверить неоднозначные заявки. Подтверждение источника запускает личное обращение к его автору с выбранного аккаунта. Отклонённые источники не запускают обращение.
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
                  : l.source_kind==='monitor'?'Найдено в чате':"Внесено вручную"}
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
              <dd>{accounts.find(a=>a.id===current.account_id)?.name||'Архивный аккаунт'}</dd>
              <dt>Беседа / автор</dt>
              <dd>
                {destinations.find(d=>d.integration_id===current.account_id&&d.external_id===current.chat_id)?.title||'Исходная беседа'} · автор исходного сообщения
              </dd>
              <dt>Дата сообщения</dt>
              <dd>{new Date(current.occurred_at).toLocaleString("ru-RU")}</dd>

              <dt>Заявленная уверенность, требует проверки</dt>
              <dd>{Math.round(current.confidence*100)}%</dd>
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
                {current.source_message_id?<div><h4>Извлечённые параметры</h4>{(JSON.parse(params) as Lead['params']).length===0&&<p>Параметры ещё не указаны. Их уточнит ИИ в личном диалоге.</p>}{(JSON.parse(params) as Lead['params']).map((p,i)=>{const numeric=fields.find(f=>f.key===p.key)?.numeric||typeof p.value==='number';const update=(patch:Partial<Lead['params'][number]>)=>setParams(JSON.stringify((JSON.parse(params) as Lead['params']).map((v,j)=>j===i?{...v,...patch}:v)));return <div key={i}><label>Параметр<select value={p.key} onChange={e=>update({key:e.target.value,value:fields.find(f=>f.key===e.target.value)?.numeric?0:''})}>{!fields.some(f=>f.key===p.key)&&<option value={p.key}>Из прежних настроек</option>}{fields.map(f=><option key={f.key} value={f.key} disabled={(JSON.parse(params) as Lead['params']).some((v,j)=>j!==i&&v.key===f.key)}>{f.question}</option>)}</select></label><label>Значение<input type={numeric?'number':'text'} value={p.value} onChange={e=>update({value:numeric?Number(e.target.value):e.target.value})}/></label><label>Цитата из источника<input value={p.evidenceQuote} maxLength={1000} onChange={e=>update({evidenceQuote:e.target.value})}/></label><button onClick={()=>setParams(JSON.stringify((JSON.parse(params) as Lead['params']).filter((_,j)=>j!==i)))}>Убрать параметр</button></div>;})}<button disabled={!fields.some(f=>!(JSON.parse(params) as Lead['params']).some(p=>p.key===f.key))} onClick={()=>{const field=fields.find(f=>!(JSON.parse(params) as Lead['params']).some(p=>p.key===f.key));if(field)setParams(JSON.stringify([...JSON.parse(params),{key:field.key,value:field.numeric?0:'',evidenceQuote:''}]));}}>Добавить параметр</button></div>:<><label>
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
                </small></>}
                <button onClick={() => void send("edit")}>
                  Сохранить параметры
                </button>
                {current.source_message_id?<><label>Аккаунт отправителя<select value={sender} onChange={e=>setSender(e.target.value)}><option value="">По порядку из настроек первого обращения</option>{accounts.filter(a=>a.enabled&&a.platform===current.platform&&allowedSenders.includes(a.id)).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><p>Получатель определяется по автору исходного сообщения. Групповой чат не является получателем.</p>{current.activation_error&&<p>Источник ожидает проверки маршрута или подключения аккаунта.</p>}{JSON.stringify(JSON.parse(params))!==JSON.stringify(current.params)&&<p>Сохраните изменённые параметры перед подтверждением.</p>}<button disabled={!canActivate||JSON.stringify(JSON.parse(params))!==JSON.stringify(current.params)} onClick={()=>void send('approve')}>Подтвердить источник и начать обращение</button></>:<><label>
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
                </button></>}
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
                {current.request_id ? " · заявка сохранена" : ""}
              </p>
            )}
          </div>
        )}
      </fieldset>
    </section>
  );
}
