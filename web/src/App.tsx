import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type Platform = "telegram" | "max" | "whatsapp";
type View = "compose" | "connections" | "campaigns" | "history";
type Integration = { id: string; platform: Platform; name: string; enabled: boolean; destination_count: number };
type Destination = { id: string; integration_id: string; external_id: string; title: string; kind: string; platform: Platform; integration_name: string };
type DeliveryStatus = "queued" | "sending" | "sent" | "failed" | "paused" | "stopped" | "skipped" | "unknown";
type Delivery = { id: string; post_id: string; status: DeliveryStatus; attempt_count: number; last_error: string | null; last_error_kind: string | null; sent_at: string | null; queued_at: string; text: string; destination_title: string; platform: Platform };
type Dashboard = { counts: { integrations: number; destinations: number; sent: number; failed: number }; recent: Delivery[] };
type Campaign = { id: string; text: string; mode: "now" | "scheduled" | "recurring"; status: string; scheduled_at: string | null; cron_pattern: string | null; timezone: string; interval_seconds: number; max_attempts: number; retry_delay_seconds: number; scheduler_enabled: boolean; destination_count: number; attachment_count: number; sent_count: number; failed_count: number; created_at: string };
type RemoteGroup = { id: string; title: string; kind?: string; participantsCount?: number };
type TelegramStatus = { status: string; configured?: boolean; qr?: string | null; qrExpiresAt?: number | null; error?: string | null; profile?: { name: string; username?: string | null } | null };
type WhatsAppStatus = { status: string; qr?: string | null; error?: string | null };
type RecurrenceKind = "daily" | "weekdays" | "weekly" | "monthly";

const weekDays = [
  { value: 1, short: "Пн", full: "понедельникам" },
  { value: 2, short: "Вт", full: "вторникам" },
  { value: 3, short: "Ср", full: "средам" },
  { value: 4, short: "Чт", full: "четвергам" },
  { value: 5, short: "Пт", full: "пятницам" },
  { value: 6, short: "Сб", full: "субботам" },
  { value: 0, short: "Вс", full: "воскресеньям" },
];

const platformInfo: Record<Platform, { label: string; mark: string; help: string }> = {
  telegram: { label: "Telegram", mark: "TG", help: "Личный аккаунт через QR" },
  max: { label: "MAX", mark: "MX", help: "Токен личной web-сессии" },
  whatsapp: { label: "WhatsApp", mark: "WA", help: "Личный аккаунт через QR" },
};

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body as T;
}

function AppIcon({ name }: { name: "plus" | "connections" | "jobs" | "history" | "bell" | "upload" | "clock" | "search" }) {
  const paths = {
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
    connections: <><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 12h8"/><path d="M12 8v8"/></>,
    jobs: <><path d="M5 5h14v14H5z"/><path d="M8 9h8M8 13h8M8 17h5"/></>,
    history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8"/><path d="M4 4v4h4M12 8v5l3 2"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    upload: <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  };
  return <svg className="app-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function PlatformBadge({ platform }: { platform: Platform }) {
  return <span className={`platform-badge platform-${platform}`} aria-label={platformInfo[platform].label}>
    {platform === "telegram" && <svg viewBox="0 0 24 24"><path d="M19.7 4.7 3.9 10.8c-1.1.4-1.1 1.1-.2 1.4l4.1 1.3 1.6 4.8c.2.6.1.9.8.9.5 0 .8-.2 1-.4l2-1.9 4.2 3.1c.8.4 1.3.2 1.5-.7l2.7-12.8c.3-1.1-.4-1.7-1.9-1.8ZM9 13.2l8-5c.4-.2.7-.1.4.2l-6.6 6-.3 3.1L9 13.2Z"/></svg>}
    {platform === "max" && <svg viewBox="0 0 24 24"><path d="M6.2 6.5A4.3 4.3 0 0 1 10.5 2h3A4.5 4.5 0 0 1 18 6.5v6.7a4.8 4.8 0 0 1-4.8 4.8H11l-4.7 4v-4.8a4.4 4.4 0 0 1-2.3-3.9V9.4a3 3 0 0 1 2.2-2.9Zm2.1 2.1v5.1h2.1v-2.9l1.6 2 1.6-2v2.9h2.1V8.6h-2.1L12 10.7l-1.6-2.1H8.3Z"/></svg>}
    {platform === "whatsapp" && <svg viewBox="0 0 24 24"><path d="M12 2a9.6 9.6 0 0 0-8.2 14.5L2.5 21l4.7-1.2A9.7 9.7 0 1 0 12 2Zm0 17.3a7.7 7.7 0 0 1-3.9-1.1l-.3-.2-2.8.7.7-2.7-.2-.3a7.7 7.7 0 1 1 6.5 3.6Zm4.2-5.8c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.6.1l-.7.9c-.1.2-.3.2-.5.1-1.5-.7-2.5-1.4-3.5-3-.3-.5.3-.5.8-1.4.1-.2 0-.4 0-.5l-.7-1.7c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.8.8-1 1.8-1 2.9 0 .3.1 2.2 1.7 4.3 2.3 3 5.7 4.2 7.8 3.6 1-.3 1.7-1.5 1.9-2.3.2-.4.1-.8-.1-.9-.4-.2-1.2-.6-1.7-.7Z"/></svg>}
  </span>;
}

function extractMaxToken(value: string) {
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed.trim();
    if (parsed && typeof parsed === "object" && "token" in parsed && typeof parsed.token === "string") return parsed.token.trim();
  } catch { /* оставляем исходное значение */ }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function moscowLocalToIso(value: string) {
  return new Date(`${value.length === 16 ? `${value}:00` : value}+03:00`).toISOString();
}

function formatMoscow(value: string) {
  return new Date(value).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}

function buildRecurringCron(kind: RecurrenceKind, time: string, days: number[], monthDay: number) {
  const [hour = "9", minute = "0"] = time.split(":");
  if (kind === "weekdays") return `${Number(minute)} ${Number(hour)} * * 1-5`;
  if (kind === "weekly") return `${Number(minute)} ${Number(hour)} * * ${days.join(",")}`;
  if (kind === "monthly") return `${Number(minute)} ${Number(hour)} ${monthDay} * *`;
  return `${Number(minute)} ${Number(hour)} * * *`;
}

function describeRecurring(kind: RecurrenceKind, time: string, days: number[], monthDay: number) {
  if (kind === "weekdays") return `По будням в ${time}`;
  if (kind === "weekly") {
    const labels = weekDays.filter((day) => days.includes(day.value)).map((day) => day.short.toLowerCase()).join(", ");
    return `Каждую неделю: ${labels || "выберите дни"} в ${time}`;
  }
  if (kind === "monthly") return `${monthDay}-го числа каждого месяца в ${time}`;
  return `Каждый день в ${time}`;
}

function describeCronPattern(pattern: string | null) {
  const [minute, hour, monthDay, , weekDay] = (pattern || "").trim().split(/\s+/);
  if ([minute, hour, monthDay, weekDay].some((value) => value === undefined)) return "Регулярная отправка";
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (monthDay !== "*") return `${monthDay}-го числа каждого месяца в ${time}`;
  if (weekDay === "1-5") return `По будням в ${time}`;
  if (weekDay === "*") return `Каждый день в ${time}`;
  const labels = weekDay.split(",").map((value) => weekDays.find((day) => day.value === Number(value))?.short).filter(Boolean).join(", ");
  return labels ? `Каждую неделю: ${labels} в ${time}` : `Регулярная отправка в ${time}`;
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [view, setView] = useState<View>("compose");
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true);
    try {
      const [nextIntegrations, nextDestinations, nextDashboard, nextCampaigns] = await Promise.all([
        api<Integration[]>("/api/integrations"), api<Destination[]>("/api/destinations"),
        api<Dashboard>("/api/dashboard"), api<Campaign[]>("/api/posts"),
      ]);
      setIntegrations(nextIntegrations); setDestinations(nextDestinations); setDashboard(nextDashboard); setCampaigns(nextCampaigns); setError(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Не удалось загрузить данные";
      if (/сессия|вход/i.test(message)) setAuthenticated(false); else setError(message);
    } finally { setLoading(false); }
  }, [authenticated]);

  useEffect(() => { api("/api/auth/session").then(() => setAuthenticated(true)).catch(() => setAuthenticated(false)); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!authenticated || (view !== "history" && view !== "campaigns")) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [authenticated, view, refresh]);

  function showNotice(message: string) { setNotice(message); window.setTimeout(() => setNotice(null), 3500); }
  if (authenticated === null) return <main className="login-shell"><section className="login-card"><p className="eyebrow">Relayboard</p><h1>Запускаем диспетчерскую…</h1></section></main>;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;

  async function logout() { await api("/api/auth/logout", { method: "POST" }).catch(() => undefined); setAuthenticated(false); }
  const pageMeta: Record<View, { title: string; description: string }> = {
    compose: { title: "Новая публикация", description: "Одно сообщение для нужных бесед — отправьте сейчас или запланируйте повторение." },
    connections: { title: "Подключения", description: "Личные аккаунты и беседы, доступные для рассылки." },
    campaigns: { title: "Задания", description: "Активные, запланированные и завершённые публикации." },
    history: { title: "История доставки", description: "Результат каждой отправки по мессенджерам и беседам." },
  };
  const navigation: Array<{ view: View; label: string; icon: "plus" | "connections" | "jobs" | "history" }> = [
    { view: "compose", label: "Новая публикация", icon: "plus" },
    { view: "connections", label: "Подключения", icon: "connections" },
    { view: "campaigns", label: "Задания", icon: "jobs" },
    { view: "history", label: "История", icon: "history" },
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark small">R</div><div><strong>Relayboard</strong><small>единая рассылка</small></div></div>
      <nav>{navigation.map((item) => <button key={item.view} aria-label={item.label} className={view === item.view ? "active" : ""} onClick={() => setView(item.view)}><AppIcon name={item.icon}/><span>{item.label}</span></button>)}</nav>
      <div className="system-health"><div><i/><b>Система работает</b></div><p>{integrations.filter((item) => item.enabled).length} из 3 аккаунтов подключено</p></div>
      <button className="signout" onClick={logout}><span className="user-avatar">ВФ</span><span>Выйти</span></button>
    </aside>
    <main className="workspace">
      <header className="topbar"><div className="mobile-brand"><div className="brand-mark small">R</div><strong>Relayboard</strong></div><div className="breadcrumbs">Рабочее пространство&nbsp; / &nbsp;<b>{pageMeta[view].title}</b></div><div className="top-actions"><button className="icon-button" aria-label="Уведомления"><AppIcon name="bell"/></button>{view !== "compose" && <button className="primary create-button" onClick={() => setView("compose")}><AppIcon name="plus"/>Создать публикацию</button>}</div></header>
      {error && <div className="alert error">{error}<button onClick={() => setError(null)}>×</button></div>}
      {notice && <div className="alert success">{notice}</div>}{loading && <div className="loading-line"/>}
      <div className="content-shell"><div className="page-heading"><div><h1>{pageMeta[view].title}</h1><p>{pageMeta[view].description}</p></div>{view === "compose" && <span className="ready-chip"><i/>{integrations.filter((item) => item.enabled).length} канала готовы</span>}</div>
        {view === "compose" && <Composer destinations={destinations} onDone={() => { showNotice("Публикация поставлена в очередь"); void refresh(); setView("campaigns"); }}/>} 
        {view === "connections" && <AccountConnections integrations={integrations} destinations={destinations} onDone={() => void refresh()} notify={showNotice}/>} 
        {view === "campaigns" && <Campaigns campaigns={campaigns} onDone={() => void refresh()} notify={showNotice}/>} 
        {view === "history" && <History deliveries={dashboard?.recent ?? []} onDone={() => void refresh()} notify={showNotice}/>} 
      </div>
    </main>
    <nav className="mobile-nav">{navigation.map((item) => <button key={item.view} className={view === item.view ? "active" : ""} onClick={() => setView(item.view)}><AppIcon name={item.icon}/><span>{item.label === "Новая публикация" ? "Создать" : item.label}</span></button>)}</nav>
  </div>;
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("admin"); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }); onSuccess(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Ошибка входа"); } finally { setBusy(false); } }
  return <main className="login-shell"><section className="login-card"><div className="brand-mark">R<span>→</span></div><p className="eyebrow">Relayboard / защищённый вход</p><h1>Три канала.<br/>Одна очередь.</h1><p className="muted">Войдите под учётной записью администратора сервиса.</p><form onSubmit={submit}><label>Логин<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required autoFocus/></label><label>Пароль<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required/></label>{error && <span className="failure-reason">{error}</span>}<button className="primary" disabled={busy}>{busy ? "Проверяю…" : "Войти"}</button></form></section></main>;
}

function Composer({ destinations, onDone }: { destinations: Destination[]; onDone: () => void }) {
  const [text, setText] = useState(""); const [files, setFiles] = useState<File[]>([]); const [selected, setSelected] = useState<string[]>([]);
  const [targetQuery, setTargetQuery] = useState("");
  const [mode, setMode] = useState<"now"|"scheduled"|"recurring">("now"); const [scheduledAt, setScheduledAt] = useState("");
  const [recurrenceKind, setRecurrenceKind] = useState<RecurrenceKind>("daily"); const [recurrenceTime, setRecurrenceTime] = useState("09:00"); const [recurrenceDays, setRecurrenceDays] = useState<number[]>([1]); const [recurrenceMonthDay, setRecurrenceMonthDay] = useState(1);
  const [intervalSeconds, setIntervalSeconds] = useState(30); const [maxAttempts, setMaxAttempts] = useState(3); const [retryDelaySeconds, setRetryDelaySeconds] = useState(30); const [busy, setBusy] = useState(false); const [formError, setFormError] = useState("");
  const selectedPlatforms = useMemo(() => [...new Set(destinations.filter((item) => selected.includes(item.id)).map((item) => item.platform))], [destinations, selected]);
  const allSelected = destinations.length > 0 && selected.length === destinations.length;
  const visibleDestinations = useMemo(() => { const query = targetQuery.trim().toLocaleLowerCase("ru"); return destinations.filter((item) => `${item.title} ${item.integration_name}`.toLocaleLowerCase("ru").includes(query)); }, [destinations, targetQuery]);
  const recurringCron = useMemo(() => buildRecurringCron(recurrenceKind, recurrenceTime, recurrenceDays, recurrenceMonthDay), [recurrenceKind, recurrenceTime, recurrenceDays, recurrenceMonthDay]);
  const recurringSummary = useMemo(() => describeRecurring(recurrenceKind, recurrenceTime, recurrenceDays, recurrenceMonthDay), [recurrenceKind, recurrenceTime, recurrenceDays, recurrenceMonthDay]);
  function toggleRecurrenceDay(day: number) { setRecurrenceDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day]); }
  function chooseFiles(next: FileList | null) { const list = Array.from(next || []); if (list.length > 10) return setFormError("Можно прикрепить не более 10 файлов"); if (list.some((file) => file.size > 100 * 1024 * 1024)) return setFormError("Размер одного файла не должен превышать 100 МБ"); setFiles(list); setFormError(""); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if ((!text.trim() && !files.length) || !selected.length) return setFormError("Добавьте текст или файлы и выберите получателей"); if (mode === "recurring" && recurrenceKind === "weekly" && !recurrenceDays.length) return setFormError("Выберите хотя бы один день недели"); setBusy(true); setFormError("");
    let attachmentIds: string[] = [];
    try {
      if (files.length) { const form = new FormData(); files.forEach((file) => form.append("files", file)); const uploaded = await api<Array<{ id: string }>>("/api/uploads", { method: "POST", body: form }); attachmentIds = uploaded.map((item) => item.id); }
      await api("/api/posts", { method: "POST", body: JSON.stringify({ text, mode, scheduledAt: mode === "scheduled" ? moscowLocalToIso(scheduledAt) : undefined, cronPattern: mode === "recurring" ? recurringCron : undefined, timezone: "Europe/Moscow", destinationIds: selected, attachmentIds, intervalSeconds, maxAttempts, retryDelaySeconds }) });
      setText(""); setFiles([]); setSelected([]); onDone();
    } catch (reason) { await Promise.all(attachmentIds.map((id) => api(`/api/attachments/${id}`, { method: "DELETE" }).catch(() => undefined))); setFormError(reason instanceof Error ? reason.message : "Не удалось создать публикацию"); } finally { setBusy(false); }
  }
  return <form className="compose-grid" onSubmit={submit}>
    <section className="card editor-card"><div className="section-heading"><div><h2>Сообщение</h2><p>Текст будет одинаковым во всех мессенджерах</p></div><small>{text.length} / 4000</small></div><textarea className="message-editor" value={text} onChange={(event) => setText(event.target.value)} placeholder="Напишите сообщение…" maxLength={4000}/>
      <label className="file-picker"><span className="file-icon"><AppIcon name="upload"/></span><span><b>Перетащите файлы сюда или нажмите, чтобы выбрать</b><small>Фото, видео и документы · до 10 файлов, каждый до 100 МБ</small></span><input type="file" multiple onChange={(event) => chooseFiles(event.target.files)}/></label>
      {files.length > 0 && <div className="file-list">{files.map((file, index) => <div key={`${file.name}-${index}`}><span><b>{file.name}</b><small>{(file.size / 1024 / 1024).toFixed(2)} МБ · {file.type || "документ"}</small></span><button type="button" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Удалить</button></div>)}</div>}
      <div className="platform-preview"><div><span>Маршрут доставки</span><b>{selected.length} бесед</b></div><div className="route-line">{selectedPlatforms.length ? selectedPlatforms.map((platform) => <PlatformBadge platform={platform} key={platform}/>) : <em>Выберите беседы справа</em>}</div><small>{selectedPlatforms.length ? "Все каналы готовы к отправке" : "Получатели пока не выбраны"}</small></div>
    </section>
    <section className="card targets-card"><div className="section-heading"><div><h2>Получатели</h2><p>Выберите одну или несколько бесед</p></div><small>{selected.length} выбрано</small></div><label className="target-search"><AppIcon name="search"/><input value={targetQuery} onChange={(event) => setTargetQuery(event.target.value)} placeholder="Поиск беседы"/></label><button type="button" className="ghost select-all" onClick={() => setSelected(allSelected ? [] : destinations.map((item) => item.id))}>{allSelected ? "Снять выбор" : "Выбрать все"}</button><div className="target-list">{destinations.length === 0 && <div className="empty">Сначала подключите аккаунт и импортируйте беседы.</div>}{destinations.length > 0 && visibleDestinations.length === 0 && <div className="empty">По вашему запросу ничего не найдено.</div>}{visibleDestinations.map((destination) => <label className={`target-row ${selected.includes(destination.id) ? "selected" : ""}`} key={destination.id}><input type="checkbox" checked={selected.includes(destination.id)} onChange={() => setSelected((current) => current.includes(destination.id) ? current.filter((id) => id !== destination.id) : [...current, destination.id])}/><PlatformBadge platform={destination.platform}/><span><b>{destination.title}</b><small>{platformInfo[destination.platform].label} · {destination.integration_name}</small></span><i/></label>)}</div></section>
    <section className="card schedule-card"><div className="section-heading"><span className="step">03</span><div><h2>Когда отправить</h2><p>Время указано по Москве (UTC+3)</p></div></div><div className="segmented"><button type="button" className={mode === "now" ? "active" : ""} onClick={() => setMode("now")}>Сейчас</button><button type="button" className={mode === "scheduled" ? "active" : ""} onClick={() => setMode("scheduled")}>Один раз</button><button type="button" className={mode === "recurring" ? "active" : ""} onClick={() => setMode("recurring")}>Регулярно</button></div>{mode === "scheduled" && <label>Дата и время<input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} required/></label>}{mode === "recurring" && <div className="recurrence-builder"><div className="recurrence-presets" role="group" aria-label="Периодичность"><button type="button" className={recurrenceKind === "daily" ? "active" : ""} onClick={() => setRecurrenceKind("daily")}>Каждый день</button><button type="button" className={recurrenceKind === "weekdays" ? "active" : ""} onClick={() => setRecurrenceKind("weekdays")}>По будням</button><button type="button" className={recurrenceKind === "weekly" ? "active" : ""} onClick={() => setRecurrenceKind("weekly")}>По дням</button><button type="button" className={recurrenceKind === "monthly" ? "active" : ""} onClick={() => setRecurrenceKind("monthly")}>Раз в месяц</button></div>{recurrenceKind === "weekly" && <div className="weekday-picker" role="group" aria-label="Дни недели">{weekDays.map((day) => <button type="button" key={day.value} aria-pressed={recurrenceDays.includes(day.value)} className={recurrenceDays.includes(day.value) ? "active" : ""} onClick={() => toggleRecurrenceDay(day.value)} title={`По ${day.full}`}>{day.short}</button>)}</div>}<div className={`recurrence-controls ${recurrenceKind === "monthly" ? "with-month-day" : ""}`}>{recurrenceKind === "monthly" && <label>День месяца<input type="number" min="1" max="31" value={recurrenceMonthDay} onChange={(event) => setRecurrenceMonthDay(Math.min(31, Math.max(1, Number(event.target.value))))} required/></label>}<label>Время отправки<input type="time" value={recurrenceTime} onChange={(event) => setRecurrenceTime(event.target.value)} required/></label></div><div className="schedule-summary"><span className="schedule-clock">◷</span><div><b>{recurringSummary}</b><small>Следующие отправки будут создаваться автоматически</small></div></div></div>}<details className="delivery-settings"><summary>Ограничения доставки</summary><div className="parameter-grid"><label>Интервал, сек.<input type="number" min="1" max="86400" value={intervalSeconds} onChange={(event) => setIntervalSeconds(Number(event.target.value))}/></label><label>Попыток<input type="number" min="1" max="10" value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))}/></label><label>Повтор через, сек.<input type="number" min="1" max="3600" value={retryDelaySeconds} onChange={(event) => setRetryDelaySeconds(Number(event.target.value))}/></label></div></details></section>
    <div className="publish-bar"><div>{formError ? <span className="inline-error">{formError}</span> : <><b>{selected.length}</b> получателей · <b>{files.length}</b> файлов · последовательно</>}</div><button className="primary publish" disabled={busy}>{busy ? "Загружаю и создаю…" : "Запустить публикацию"}</button></div>
  </form>;
}

function AccountConnections(props: { integrations: Integration[]; destinations: Destination[]; onDone: () => void; notify: (message: string) => void }) {
  const [selectedId,setSelectedId]=useState<string | null>(null);
  const [adding,setAdding]=useState(false);
  const [knownIds,setKnownIds]=useState(()=>props.integrations.map(item=>item.id));
  useEffect(()=>{const added=props.integrations.find(item=>!knownIds.includes(item.id)); if(added){setSelectedId(added.id);setAdding(false);} setKnownIds(props.integrations.map(item=>item.id));},[props.integrations]);
  const selected=props.integrations.find(item=>item.id===selectedId) || props.integrations[0];
  return <div className="connections-layout">
    <div className="section-heading"><h2>Мои аккаунты</h2><button className="primary" onClick={()=>setAdding(true)}>Добавить аккаунт</button></div>
    <div className="connection-grid">{props.integrations.map(item=><button key={item.id} className="connection-card" aria-pressed={!adding && selected?.id===item.id} onClick={()=>{setSelectedId(item.id);setAdding(false);}}><div className="connection-title"><PlatformBadge platform={item.platform}/><div><h3>{item.name}</h3><p>{platformInfo[item.platform].label} · {item.destination_count} бесед</p></div></div></button>)}</div>
    <Connections key={adding ? "new" : selected?.id || "new"} {...props} integrations={adding || !selected ? [] : [selected]} destinations={adding || !selected ? [] : props.destinations.filter(item=>item.integration_id===selected.id)}/>
  </div>;
}

function Connections({ integrations, destinations, onDone, notify }: { integrations: Integration[]; destinations: Destination[]; onDone: () => void; notify: (message: string) => void }) {
  const [platform, setPlatform] = useState<Platform>("telegram"); const [name, setName] = useState(""); const [token, setToken] = useState("");
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null); const [telegramApiId, setTelegramApiId] = useState(""); const [telegramApiHash, setTelegramApiHash] = useState(""); const [telegramPassword, setTelegramPassword] = useState(""); const [telegramGroups, setTelegramGroups] = useState<RemoteGroup[]>([]); const [telegramGroupsLoading, setTelegramGroupsLoading] = useState(false);
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null); const [whatsappGroups, setWhatsappGroups] = useState<RemoteGroup[]>([]); const [maxGroups, setMaxGroups] = useState<RemoteGroup[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [groupQueries, setGroupQueries] = useState<Record<Platform, string>>({ telegram: "", max: "", whatsapp: "" });
  const byPlatform = (value: Platform) => integrations.find((item) => item.platform === value);
  const maxTokenCommand = '(() => { const auth = JSON.parse(localStorage.getItem("__oneme_auth") || "{}"); if (!auth.token) throw new Error("Сначала войдите в MAX Web"); copy(auth.token); return "Токен скопирован"; })()';
  async function addIntegration(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await api("/api/integrations", { method:"POST", body: JSON.stringify({ platform, name: name || platformInfo[platform].label, credentials: platform === "max" ? { token: extractMaxToken(token) } : {} }) }); setName(""); setToken(""); notify("Подключение сохранено"); onDone(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Ошибка подключения"); } finally { setBusy(false); } }
  async function removeIntegration(item: Integration) { if (!window.confirm(`Удалить подключение «${item.name}» и связанные беседы?`)) return; await api(`/api/integrations/${item.id}`, { method:"DELETE" }); notify("Подключение удалено"); onDone(); }
  async function addDestination(integrationId: string, group: RemoteGroup) {
    setError("");
    try {
      await api("/api/destinations", { method:"POST", body: JSON.stringify({ integrationId, externalId: group.id, title: group.title, kind: group.kind || "group" }) });
      notify(`Добавлена беседа «${group.title}»`); onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось добавить беседу"); }
  }
  async function removeDestination(item: Destination) { await api(`/api/destinations/${item.id}`, { method:"DELETE" }); notify("Беседа удалена"); onDone(); }
  async function loadTelegram() { if (telegramGroupsLoading) return; try { const state = await api<TelegramStatus>(`/api/accounts/${byPlatform("telegram")!.id}/status`); setTelegram(state); if (state.status === "ready") { setTelegramGroupsLoading(true); try { setTelegramGroups(await api<RemoteGroup[]>(`/api/accounts/${byPlatform("telegram")!.id}/dialogs`)); } finally { setTelegramGroupsLoading(false); } } } catch (reason) { setError(reason instanceof Error ? reason.message : "Telegram недоступен"); setTelegramGroupsLoading(false); } }
  async function startTelegram() {
    setError("");
    if (!telegram?.configured && (!/^\d+$/.test(telegramApiId.trim()) || Number(telegramApiId) <= 0 || !/^[a-f\d]{32}$/i.test(telegramApiHash.trim()))) {
      setError("Введите API ID (только цифры) и API Hash (32 символа) из my.telegram.org/apps. Это не логин и пароль от сервиса.");
      return;
    }
    setBusy(true);
    try {
      await api(`/api/accounts/${byPlatform("telegram")!.id}/auth/qr`, { method:"POST", body:JSON.stringify({ apiId: telegramApiId.trim(), apiHash: telegramApiHash.trim() }) });
      setTelegram(current => current ? { ...current, status: "starting", error: null, qr: null } : current);
      notify("QR-код Telegram создаётся");
      await loadTelegram();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать QR-код Telegram");
    } finally { setBusy(false); }
  }
  async function sendTelegramPassword() { await api(`/api/accounts/${byPlatform("telegram")!.id}/auth/password`, { method:"POST", body:JSON.stringify({ password: telegramPassword }) }); setTelegramPassword(""); window.setTimeout(() => void loadTelegram(), 1200); }
  async function loadWhatsapp() { try { const state = await api<WhatsAppStatus>(`/api/accounts/${byPlatform("whatsapp")!.id}/status`); setWhatsapp(state); if (state.status === "ready") setWhatsappGroups(await api<RemoteGroup[]>(`/api/accounts/${byPlatform("whatsapp")!.id}/groups`)); } catch (reason) { setError(reason instanceof Error ? reason.message : "WhatsApp недоступен"); } }
  async function loadMax() { const connection = byPlatform("max"); if (!connection) return; try { setMaxGroups(await api<RemoteGroup[]>(`/api/max/groups/${connection.id}`)); } catch (reason) { setError(reason instanceof Error ? reason.message : "MAX недоступен"); } }
  async function copyMaxTokenCommand() { try { await navigator.clipboard.writeText(maxTokenCommand); notify("Команда получения MAX-токена скопирована"); } catch { setError("Не удалось скопировать команду. Выделите её вручную."); } }
  useEffect(() => { const active = telegram?.status; if (!active || !["starting","qr","password_required"].includes(active)) return; const timer = window.setInterval(() => void loadTelegram(), 1800); return () => window.clearInterval(timer); }, [telegram?.status]);
  useEffect(() => { const active = whatsapp?.status; if (!active || !["starting","authenticated"].includes(active)) return; const timer = window.setInterval(() => void loadWhatsapp(), 2500); return () => window.clearInterval(timer); }, [whatsapp?.status]);
  const renderGroups = (groupPlatform: Platform, groups: RemoteGroup[], connection: Integration | undefined) => {
    if (!connection) return null;
    const query = groupQueries[groupPlatform].trim().toLocaleLowerCase("ru");
    const visible = groups.filter((group) => `${group.title} ${group.id}`.toLocaleLowerCase("ru").includes(query));
    return <div className="group-picker">
      <label className="group-search">Найти беседу<input value={groupQueries[groupPlatform]} onChange={(event) => setGroupQueries((current) => ({ ...current, [groupPlatform]: event.target.value }))} placeholder="Название или ID…"/></label>
      <div className={`wa-groups group-list-${groupPlatform}`} tabIndex={0}>
        {visible.length === 0 && <div className="group-empty">{groups.length === 0 ? "Сначала загрузите список бесед" : "По вашему запросу ничего не найдено"}</div>}
        {visible.map((group) => {
          const added = destinations.find((item) => item.integration_id === connection.id && item.external_id === group.id);
          return <div key={group.id}><span><b>{group.title}</b><small>{group.participantsCount ? `${group.participantsCount} участников` : group.id}</small></span><button type="button" className={added ? "remove-group" : "add-group"} onClick={() => void (added ? removeDestination(added) : addDestination(connection.id, group))}>{added ? "Удалить" : "Добавить"}</button></div>;
        })}
      </div>
    </div>;
  };
  return <div className="connections-layout">
    <section className="connection-grid">{(integrations.map(item => item.platform)).map((item) => { const connection = byPlatform(item); return <article className={`connection-card platform-edge-${item}`} key={item}><div className="connection-title"><PlatformBadge platform={item}/><div><h3>{platformInfo[item].label}</h3><p>{connection?.name || platformInfo[item].help}</p></div><i className={connection?.enabled ? "online" : ""}/></div><div className="connection-foot"><span>{connection ? `${connection.destination_count} бесед` : "не подключён"}</span>{connection && <button className="delete-connection" onClick={() => void removeIntegration(connection)}>Удалить</button>}</div></article>; })}</section>
    {error && <div className="alert error">{error}<button onClick={() => setError("")}>×</button></div>}
    {integrations.length === 0 && <form className="card settings-form account-setup" onSubmit={addIntegration}><div className="section-heading"><div><h2>Добавить личный аккаунт</h2><p>Каждый аккаунт имеет собственную сессию и беседы</p></div></div><label>Мессенджер<select value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>{(Object.keys(platformInfo) as Platform[]).map((item) => <option key={item} value={item}>{platformInfo[item].label}</option>)}</select></label><label>Название<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Рабочий аккаунт" required/></label>{platform === "max" && <><label>Токен web-сессии<input type="password" value={token} onChange={(event) => setToken(event.target.value)} required/></label><div className="token-source-card source-max"><div><span className="source-icon">MX</span><div><b>Получить токен в MAX Web</b><small>Войдите, откройте DevTools → Console и выполните команду</small></div></div><a href="https://web.max.ru" target="_blank" rel="noreferrer">Открыть MAX Web ↗</a><code>{maxTokenCommand}</code><button type="button" className="copy-command" onClick={() => void copyMaxTokenCommand()}>Скопировать команду</button></div><p className="form-hint warning">В MAX используется неофициальная web-сессия личного аккаунта. Выход из MAX Web может отозвать токен.</p></>}<button className="secondary" disabled={busy || Boolean(byPlatform(platform))}>{byPlatform(platform) ? "Уже подключён" : busy ? "Проверяю…" : "Сохранить подключение"}</button></form>}
    {byPlatform("telegram") && <section className="card settings-form"><div className="section-heading"><PlatformBadge platform="telegram"/><div><h2>Вход и группы Telegram</h2><p>QR-код личного аккаунта</p></div></div><button type="button" className="ghost" disabled={telegramGroupsLoading} onClick={() => void loadTelegram()}>{telegramGroupsLoading ? "Загружаем все беседы…" : telegram?.status === "ready" ? "Обновить группы" : "Проверить сессию"}</button>{telegram?.configured === false && telegram.status !== "ready" && <div className="parameter-grid"><label>API ID<input name="telegram-api-id" autoComplete="off" inputMode="numeric" value={telegramApiId} onChange={(event) => setTelegramApiId(event.target.value)}/></label><label>API Hash<input name="telegram-api-hash" autoComplete="new-password" type="password" value={telegramApiHash} onChange={(event) => setTelegramApiHash(event.target.value)}/></label></div>}{telegram?.configured === false && telegram.status !== "ready" && <p className="form-hint">Данные приложения Telegram: <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">получить API ID и API Hash</a>. Это не логин и пароль от Relayboard.</p>}{telegram?.error && <p role="alert" className="alert error">{telegram.error}</p>}{telegram && telegram.status !== "ready" && <button type="button" className="secondary" onClick={() => void startTelegram()} disabled={busy || ["starting", "qr", "password_required"].includes(telegram.status)}>{busy || telegram.status === "starting" ? "Создаём QR-код…" : "Войти через QR"}</button>}{telegram?.qr && <div className="telegram-qr-card"><div className="qr-frame"><img src={telegram.qr} alt="QR-код Telegram"/></div><div><b>Отсканируйте в Telegram</b><small>Настройки → Устройства → Подключить устройство</small></div></div>}{telegram?.status === "password_required" && <div className="inline-auth"><input type="password" value={telegramPassword} onChange={(event) => setTelegramPassword(event.target.value)} placeholder="Пароль 2FA"/><button type="button" onClick={() => void sendTelegramPassword()}>Подтвердить</button></div>}{telegram?.status === "ready" && <p className="form-hint">{telegramGroupsLoading ? "Telegram подключён. Получаем полный список, включая архив…" : `Подключён: ${telegram.profile?.name} · найдено групп и каналов: ${telegramGroups.length}`}</p>}{renderGroups("telegram", telegramGroups, byPlatform("telegram"))}</section>}
    {byPlatform("max") && <section className="card settings-form"><div className="section-heading"><PlatformBadge platform="max"/><div><h2>Группы MAX</h2><p>Получаем из активной web-сессии</p></div></div><button type="button" className="ghost" onClick={() => void loadMax()}>Обновить группы</button>{renderGroups("max", maxGroups, byPlatform("max"))}</section>}
    {byPlatform("whatsapp") && <section className="card settings-form"><div className="section-heading"><PlatformBadge platform="whatsapp"/><div><h2>Вход и группы WhatsApp</h2><p>Связанное устройство личного аккаунта</p></div></div><button type="button" className="ghost" onClick={() => void loadWhatsapp()}>{whatsapp?.status === "ready" ? "Обновить группы" : "Проверить QR-сессию"}</button>{whatsapp?.qr && <div className="qr-panel"><img src={whatsapp.qr} alt="QR-код WhatsApp"/><b>Отсканируйте в разделе «Связанные устройства»</b></div>}{whatsapp?.status === "authenticated" && <p className="form-hint">Вход подтверждён, синхронизируем список бесед…</p>}{whatsapp?.status === "ready" && <p className="form-hint">WhatsApp подключён · найдено групп: {whatsappGroups.length}</p>}{renderGroups("whatsapp", whatsappGroups, byPlatform("whatsapp"))}</section>}
    <section className="card destination-table"><div className="section-heading"><div><h2>Все беседы</h2><p>{destinations.length} адресов доставки</p></div></div>{destinations.length === 0 ? <div className="empty">Добавьте группы из подключённых аккаунтов.</div> : destinations.map((item) => <div className="destination-row" key={item.id}><PlatformBadge platform={item.platform}/><span><b>{item.title}</b><small>{item.external_id}</small></span><em>{item.integration_name}</em><button className="delete-connection" onClick={() => void removeDestination(item)}>Удалить</button></div>)}</section>
  </div>;
}

const campaignStatusLabels: Record<string, string> = {
  draft: "Черновик", scheduled: "Запланировано", active: "Выполняется", paused: "На паузе",
  stopped: "Остановлено", completed: "Завершено", failed: "Ошибка",
};

function Campaigns({ campaigns, onDone, notify }: { campaigns: Campaign[]; onDone: () => void; notify: (message: string) => void }) {
  async function action(id: string, command: "pause"|"resume"|"stop") { await api(`/api/posts/${id}/${command}`, { method:"POST" }); notify(command === "pause" ? "Задание поставлено на паузу" : command === "resume" ? "Задание продолжено" : "Задание остановлено"); onDone(); }
  async function disable(id: string) { await api(`/api/posts/${id}/schedule`, { method:"DELETE" }); notify("Будущие повторы отключены"); onDone(); }
  async function remove(id: string) { if (!window.confirm("Удалить завершённое задание и его файлы?")) return; await api(`/api/posts/${id}`, { method:"DELETE" }); notify("Задание удалено"); onDone(); }
  const activeCount = campaigns.filter((item) => ["active", "paused"].includes(item.status)).length;
  const scheduledCount = campaigns.filter((item) => item.status === "scheduled").length;
  const deliveredCount = campaigns.reduce((sum, item) => sum + Number(item.sent_count || 0), 0);
  const failedCount = campaigns.reduce((sum, item) => sum + Number(item.failed_count || 0), 0);
  return <><div className="campaign-stats"><div><span>Активные</span><b>{activeCount}</b><small>работают по расписанию</small></div><div><span>Запланировано</span><b>{scheduledCount}</b><small>ожидают запуска</small></div><div><span>Доставлено</span><b>{deliveredCount}</b><small>во всех заданиях</small></div><div><span>Ошибки</span><b>{failedCount}</b><small>{failedCount ? "требуют внимания" : "все каналы в норме"}</small></div></div><section className="card history-card"><div className="section-heading"><div><h2>Все задания</h2><p>Управление очередью и повторениями</p></div><span className="live-dot">Обновляется</span></div>{campaigns.length === 0 ? <div className="empty large">Заданий пока нет.</div> : <div className="campaign-list">{campaigns.map((item) => <article className="campaign-row" key={item.id}><div><span className={`status status-${item.status}`}>{campaignStatusLabels[item.status] || item.status}</span><h3>{item.text || `${item.attachment_count} вложений`}</h3><p>{item.destination_count} получателей · {item.attachment_count} файлов · интервал {item.interval_seconds} сек. · {item.sent_count} доставлено · {item.failed_count} ошибок</p><small>{item.mode === "recurring" ? `${describeCronPattern(item.cron_pattern)} · по Москве` : item.scheduled_at ? formatMoscow(item.scheduled_at) : formatMoscow(item.created_at)}</small></div><div className="campaign-actions">{["scheduled","active"].includes(item.status) && <button onClick={() => void action(item.id,"pause")}>Пауза</button>}{item.status === "paused" && <button onClick={() => void action(item.id,"resume")}>Продолжить</button>}{!["stopped","completed"].includes(item.status) && <button className="danger-lite" onClick={() => void action(item.id,"stop")}>Остановить</button>}{item.mode === "recurring" && item.scheduler_enabled && <button onClick={() => void disable(item.id)}>Отключить повторы</button>}{["stopped","completed"].includes(item.status) && <button onClick={() => void remove(item.id)}>Удалить</button>}</div></article>)}</div>}</section></>;
}

const statusLabels: Record<DeliveryStatus,string> = { queued:"В очереди", sending:"Отправляется", sent:"Доставлено", failed:"Ошибка", paused:"Пауза", stopped:"Остановлено", skipped:"Пропущено", unknown:"Исход неизвестен" };
const errorKindLabels: Record<string,string> = { transient:"Временная ошибка", permanent:"Постоянная ошибка", ambiguous:"Исход неизвестен" };
function History({ deliveries, onDone, notify }: { deliveries: Delivery[]; onDone: () => void; notify: (message: string) => void }) {
  async function retry(id: string) { await api(`/api/deliveries/${id}/retry`, { method:"POST" }); notify("Повтор поставлен в очередь"); onDone(); }
  return <section className="card history-card"><div className="section-heading"><div><h2>Последние отправки</h2><p>Неизвестный исход не повторяется автоматически</p></div><span className="live-dot">LIVE</span></div>{deliveries.length === 0 ? <div className="empty large">Отправок пока нет.</div> : <div className="history-list">{deliveries.map((item) => <div className="history-row" key={item.id}><PlatformBadge platform={item.platform}/><div className="history-message"><b>{item.destination_title}</b><p>{item.text || "Сообщение с вложениями"}</p>{item.last_error && <small className="failure-reason">{item.last_error_kind ? `${errorKindLabels[item.last_error_kind] || item.last_error_kind}: ` : ""}{item.last_error}</small>}</div><time>{formatMoscow(item.sent_at || item.queued_at)}</time><span className={`status status-${item.status}`}>{statusLabels[item.status]}</span>{["failed","unknown"].includes(item.status) && <button className="retry" onClick={() => void retry(item.id)}>Повторить вручную</button>}</div>)}</div>}</section>;
}

export default App;
