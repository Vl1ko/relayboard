import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type Platform = "telegram" | "max" | "whatsapp" | "vk";
type View = "compose" | "connections" | "history";

type Integration = {
  id: string;
  platform: Platform;
  name: string;
  enabled: boolean;
  destination_count: number;
};

type Destination = {
  id: string;
  integration_id: string;
  external_id: string;
  title: string;
  kind: string;
  platform: Platform;
  integration_name: string;
};

type Delivery = {
  id: string;
  status: "queued" | "sending" | "sent" | "failed";
  attempt_count: number;
  last_error: string | null;
  sent_at: string | null;
  queued_at: string;
  text: string;
  destination_title: string;
  platform: Platform;
};

type Dashboard = {
  counts: { integrations: number; destinations: number; sent: number; failed: number };
  recent: Delivery[];
};

const platformInfo: Record<Platform, { label: string; mark: string; help: string }> = {
  telegram: { label: "Telegram", mark: "TG", help: "Личная MTProto-сессия" },
  max: { label: "MAX", mark: "MX", help: "Личный web-токен (неофициально)" },
  whatsapp: { label: "WhatsApp", mark: "WA", help: "Подключается через QR-код" },
  vk: { label: "VK", mark: "VK", help: "Пользовательский access token" },
};

function api<T>(path: string, apiKey: string, init?: RequestInit): Promise<T> {
  return fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-admin-key": apiKey,
      ...init?.headers,
    },
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body as T;
  });
}

function PlatformBadge({ platform }: { platform: Platform }) {
  const info = platformInfo[platform];
  return <span className={`platform-badge platform-${platform}`}>{info.mark}</span>;
}

function extractVkAccessToken(value: string) {
  const fragment = value.includes("#") ? value.slice(value.indexOf("#") + 1) : value;
  const parsed = new URLSearchParams(fragment);
  return parsed.get("access_token") || value.trim();
}

function extractMaxToken(value: string) {
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed.trim();
    if (parsed && typeof parsed === "object" && "token" in parsed && typeof parsed.token === "string") return parsed.token.trim();
  } catch {
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function App() {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem("relayboard-key") || "");
  const [draftKey, setDraftKey] = useState("");
  const [view, setView] = useState<View>("compose");
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setLoading(true);
    try {
      const [nextIntegrations, nextDestinations, nextDashboard] = await Promise.all([
        api<Integration[]>("/api/integrations", apiKey),
        api<Destination[]>("/api/destinations", apiKey),
        api<Dashboard>("/api/dashboard", apiKey),
      ]);
      setIntegrations(nextIntegrations);
      setDestinations(nextDestinations);
      setDashboard(nextDashboard);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить данные");
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (view !== "history" || !apiKey) return;
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [view, apiKey, refresh]);

  function signIn(event: FormEvent) {
    event.preventDefault();
    sessionStorage.setItem("relayboard-key", draftKey);
    setApiKey(draftKey);
  }

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3500);
  }

  if (!apiKey) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="brand-mark">R<span>→</span></div>
          <p className="eyebrow">Relayboard / вход</p>
          <h1>Один ключ.<br />Четыре маршрута.</h1>
          <p className="muted">Введите ключ администратора из файла окружения сервиса.</p>
          <form onSubmit={signIn}>
            <label>Ключ администратора<input type="password" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} required autoFocus /></label>
            <button className="primary" type="submit">Открыть диспетчерскую</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark small">R<span>→</span></div><div><strong>Relayboard</strong><small>диспетчер публикаций</small></div></div>
        <nav>
          <button className={view === "compose" ? "active" : ""} onClick={() => setView("compose")}><span>＋</span>Новая публикация</button>
          <button className={view === "connections" ? "active" : ""} onClick={() => setView("connections")}><span>◇</span>Подключения</button>
          <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}><span>↺</span>Журнал доставки</button>
        </nav>
        <div className="network-strip">
          <p>Сеть доставки</p>
          {(Object.keys(platformInfo) as Platform[]).map((platform) => {
            const online = integrations.some((item) => item.platform === platform && item.enabled);
            return <div className="network-row" key={platform}><PlatformBadge platform={platform} /><span>{platformInfo[platform].label}</span><i className={online ? "online" : ""} /></div>;
          })}
        </div>
        <button className="signout" onClick={() => { sessionStorage.removeItem("relayboard-key"); setApiKey(""); }}>Сменить ключ</button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">{view === "compose" ? "Маршрут / новый" : view === "connections" ? "Сеть / подключения" : "Контроль / доставка"}</p><h1>{view === "compose" ? "Собрать публикацию" : view === "connections" ? "Настроить каналы" : "Проверить доставку"}</h1></div>
          <div className="summary"><span><b>{dashboard?.counts.destinations ?? 0}</b> бесед</span><span><b>{dashboard?.counts.sent ?? 0}</b> доставлено</span></div>
        </header>

        {error && <div className="alert error">{error}<button onClick={() => setError(null)}>×</button></div>}
        {notice && <div className="alert success">{notice}</div>}
        {loading && <div className="loading-line" />}

        {view === "compose" && <Composer apiKey={apiKey} destinations={destinations} onDone={() => { showNotice("Публикация поставлена в маршрут"); refresh(); }} />}
        {view === "connections" && <Connections apiKey={apiKey} integrations={integrations} destinations={destinations} onDone={refresh} notify={showNotice} />}
        {view === "history" && <History apiKey={apiKey} deliveries={dashboard?.recent ?? []} onRetry={() => { showNotice("Повторная отправка поставлена в очередь"); refresh(); }} />}
      </main>
    </div>
  );
}

function Composer({ apiKey, destinations, onDone }: { apiKey: string; destinations: Destination[]; onDone: () => void }) {
  const [text, setText] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [mode, setMode] = useState<"now" | "scheduled" | "recurring">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [cronPattern, setCronPattern] = useState("0 9 * * 1-5");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const selectedPlatforms = useMemo(() => [...new Set(destinations.filter((item) => selected.includes(item.id)).map((item) => item.platform))], [destinations, selected]);

  function toggle(id: string) {
    setSelected((value) => value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api("/api/posts", apiKey, {
        method: "POST",
        body: JSON.stringify({ text, mediaUrl, mode, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined, cronPattern: mode === "recurring" ? cronPattern : undefined, timezone: "Europe/Moscow", destinationIds: selected }),
      });
      setText(""); setMediaUrl(""); setSelected([]); setMode("now");
      onDone();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Не удалось создать публикацию");
    } finally { setBusy(false); }
  }

  return (
    <form className="compose-grid" onSubmit={submit}>
      <section className="card editor-card">
        <div className="section-heading"><span className="step">1</span><div><h2>Сообщение</h2><p>Один текст для всех выбранных бесед</p></div><small>{text.length} / 4000</small></div>
        <textarea className="message-editor" value={text} onChange={(e) => setText(e.target.value)} placeholder="Напишите сообщение…" maxLength={4000} required />
        <label className="url-field">Ссылка на изображение<input type="url" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://…" /></label>
        <div className="platform-preview">
          <span>Маршрут</span><div className="route-line">{selectedPlatforms.length ? selectedPlatforms.map((platform) => <PlatformBadge platform={platform} key={platform} />) : <em>Выберите беседы справа</em>}</div>
        </div>
      </section>

      <section className="card targets-card">
        <div className="section-heading"><span className="step">2</span><div><h2>Беседы</h2><p>Куда доставить публикацию</p></div></div>
        <div className="target-list">
          {destinations.length === 0 && <div className="empty">Сначала добавьте подключение и хотя бы одну беседу.</div>}
          {destinations.map((destination) => <label className={`target-row ${selected.includes(destination.id) ? "selected" : ""}`} key={destination.id}><input type="checkbox" checked={selected.includes(destination.id)} onChange={() => toggle(destination.id)} /><PlatformBadge platform={destination.platform} /><span><b>{destination.title}</b><small>{destination.integration_name}</small></span><i /></label>)}
        </div>
      </section>

      <section className="card schedule-card">
        <div className="section-heading"><span className="step">3</span><div><h2>Время</h2><p>Когда запустить маршрут</p></div></div>
        <div className="segmented">
          <button type="button" className={mode === "now" ? "active" : ""} onClick={() => setMode("now")}>Сейчас</button>
          <button type="button" className={mode === "scheduled" ? "active" : ""} onClick={() => setMode("scheduled")}>По времени</button>
          <button type="button" className={mode === "recurring" ? "active" : ""} onClick={() => setMode("recurring")}>Регулярно</button>
        </div>
        {mode === "scheduled" && <label>Дата и время<input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} required /></label>}
        {mode === "recurring" && <label>Cron-расписание<input value={cronPattern} onChange={(e) => setCronPattern(e.target.value)} required /><small>Сейчас: по будням в 09:00, часовой пояс Europe/Moscow</small></label>}
      </section>

      <div className="publish-bar">
        <div>{formError ? <span className="inline-error">{formError}</span> : <><b>{selected.length}</b> получателей · {mode === "now" ? "отправить сейчас" : mode === "scheduled" ? "одна отправка" : "повторять по расписанию"}</>}</div>
        <button className="primary publish" disabled={busy || selected.length === 0 || !text.trim()}>{busy ? "Ставлю в очередь…" : "Запустить маршрут →"}</button>
      </div>
    </form>
  );
}

function Connections({ apiKey, integrations, destinations, onDone, notify }: { apiKey: string; integrations: Integration[]; destinations: Destination[]; onDone: () => void; notify: (value: string) => void }) {
  const [platform, setPlatform] = useState<Platform>("telegram");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [telegramApiId, setTelegramApiId] = useState("");
  const [telegramApiHash, setTelegramApiHash] = useState("");
  const [telegramPassword, setTelegramPassword] = useState("");
  const [vkAppId, setVkAppId] = useState("");
  const [integrationId, setIntegrationId] = useState("");
  const [targetTitle, setTargetTitle] = useState("");
  const [externalId, setExternalId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Integration | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [whatsappStatus, setWhatsappStatus] = useState<{ status: string; qr?: string | null } | null>(null);
  const [whatsappGroups, setWhatsappGroups] = useState<Array<{ id: string; title: string }>>([]);
  const [maxIntegrationId, setMaxIntegrationId] = useState("");
  const [maxGroups, setMaxGroups] = useState<Array<{ id: string; title: string; participantsCount: number }>>([]);
  const [maxGroupsLoading, setMaxGroupsLoading] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<{ status: string; profile?: { name: string; username?: string | null } | null; error?: string | null; qr?: string | null; qrExpiresAt?: number | null; configured?: boolean } | null>(null);
  const [telegramDialogs, setTelegramDialogs] = useState<Array<{ id: string; title: string; kind: string }>>([]);

  useEffect(() => {
    if (!integrations.some((item) => item.id === integrationId)) setIntegrationId(integrations[0]?.id || "");
  }, [integrations, integrationId]);
  useEffect(() => {
    const maxConnections = integrations.filter((item) => item.platform === "max");
    if (!maxConnections.some((item) => item.id === maxIntegrationId)) setMaxIntegrationId(maxConnections[0]?.id || "");
  }, [integrations, maxIntegrationId]);
  useEffect(() => { if (platform === "telegram") void loadTelegram(); }, [platform, apiKey]);
  useEffect(() => {
    if (platform !== "telegram" || !telegramStatus || !["starting", "qr", "password_required"].includes(telegramStatus.status)) return;
    const timer = window.setInterval(() => { void loadTelegram(); }, 1800);
    return () => window.clearInterval(timer);
  }, [platform, telegramStatus?.status, apiKey]);

  const vkAuthorizeUrl = vkAppId.trim()
    ? `https://oauth.vk.com/authorize?client_id=${encodeURIComponent(vkAppId.trim())}&display=page&redirect_uri=${encodeURIComponent("https://oauth.vk.com/blank.html")}&scope=messages,offline&response_type=token&v=5.199`
    : "";
  const maxTokenCommand = '(() => { const auth = JSON.parse(localStorage.getItem("__oneme_auth") || "{}"); if (!auth.token) throw new Error("Сначала войдите в MAX Web"); copy(auth.token); return "Токен скопирован"; })()';

  async function addIntegration(event: FormEvent) {
    event.preventDefault(); setError(null);
    try {
      await api("/api/integrations", apiKey, { method: "POST", body: JSON.stringify({ platform, name, credentials: platform === "telegram" || platform === "whatsapp" ? {} : { token } }) });
      setName(""); setToken(""); notify("Подключение сохранено"); await onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Ошибка подключения"); }
  }

  async function addDestination(event: FormEvent) {
    event.preventDefault(); setError(null);
    try {
      await api("/api/destinations", apiKey, { method: "POST", body: JSON.stringify({ integrationId, title: targetTitle, externalId, kind: "group" }) });
      setTargetTitle(""); setExternalId(""); notify("Беседа добавлена"); await onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Ошибка добавления беседы"); }
  }

  async function deleteIntegration() {
    if (!pendingDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await api(`/api/integrations/${pendingDelete.id}`, apiKey, { method: "DELETE" });
      notify(`Подключение «${pendingDelete.name}» удалено`);
      setPendingDelete(null);
      await onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось удалить подключение");
    } finally {
      setDeleting(false);
    }
  }

  async function loadWhatsapp() {
    try {
      const status = await api<{ status: string; qr?: string | null }>("/api/whatsapp/status", apiKey);
      setWhatsappStatus(status);
      if (status.status === "ready") {
        setWhatsappGroups(await api<Array<{ id: string; title: string }>>("/api/whatsapp/groups", apiKey));
      }
    }
    catch { setWhatsappStatus({ status: "offline" }); }
  }

  async function importWhatsappGroup(group: { id: string; title: string }) {
    const connection = integrations.find((item) => item.platform === "whatsapp");
    if (!connection) { setError("Сначала сохраните подключение WhatsApp"); return; }
    try {
      await api("/api/destinations", apiKey, {
        method: "POST",
        body: JSON.stringify({ integrationId: connection.id, title: group.title, externalId: group.id, kind: "group" }),
      });
      notify(`Беседа «${group.title}» добавлена`);
      await onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось добавить группу"); }
  }

  async function loadMaxGroups() {
    if (!maxIntegrationId) return;
    setError(null);
    setMaxGroupsLoading(true);
    try {
      setMaxGroups(await api<Array<{ id: string; title: string; participantsCount: number }>>(`/api/max/groups/${maxIntegrationId}`, apiKey));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить группы MAX");
    } finally {
      setMaxGroupsLoading(false);
    }
  }

  async function importMaxGroup(group: { id: string; title: string }) {
    if (!maxIntegrationId) return;
    setError(null);
    try {
      await api("/api/destinations", apiKey, {
        method: "POST",
        body: JSON.stringify({ integrationId: maxIntegrationId, title: group.title, externalId: group.id, kind: "group" }),
      });
      notify(`Группа «${group.title}» добавлена`);
      await onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось добавить группу MAX"); }
  }

  async function loadTelegram() {
    try {
      const status = await api<{ status: string; profile?: { name: string; username?: string | null } | null; error?: string | null; qr?: string | null; qrExpiresAt?: number | null; configured?: boolean }>("/api/telegram/status", apiKey);
      setTelegramStatus(status);
      if (status.status === "ready") {
        setTelegramDialogs(await api<Array<{ id: string; title: string; kind: string }>>("/api/telegram/dialogs", apiKey));
      }
    } catch { setTelegramStatus({ status: "offline" }); }
  }

  async function startTelegramQr() {
    setError(null);
    try {
      await api("/api/telegram/auth/qr", apiKey, {
        method: "POST",
        body: JSON.stringify(telegramStatus?.configured === false
          ? { apiId: telegramApiId, apiHash: telegramApiHash }
          : {}),
      });
      setTelegramStatus({ status: "starting" });
      notify("Готовлю QR-код Telegram");
      window.setTimeout(loadTelegram, 500);
      window.setTimeout(loadTelegram, 1600);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось начать вход в Telegram"); }
  }

  async function submitTelegramPassword() {
    setError(null);
    try {
      await api("/api/telegram/auth/password", apiKey, { method: "POST", body: JSON.stringify({ password: telegramPassword }) });
      setTelegramStatus({ status: "starting" });
      setTelegramPassword("");
      notify("Данные приняты, проверяю сессию");
      window.setTimeout(loadTelegram, 1200);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Ошибка авторизации Telegram"); }
  }

  async function copyMaxTokenCommand() {
    try {
      await navigator.clipboard.writeText(maxTokenCommand);
      notify("Команда получения MAX-токена скопирована");
    } catch { setError("Не удалось скопировать команду. Выделите её вручную."); }
  }

  async function importTelegramDialog(dialog: { id: string; title: string; kind: string }) {
    const connection = integrations.find((item) => item.platform === "telegram");
    if (!connection) { setError("Сначала сохраните подключение Telegram"); return; }
    try {
      await api("/api/destinations", apiKey, {
        method: "POST",
        body: JSON.stringify({ integrationId: connection.id, title: dialog.title, externalId: dialog.id, kind: dialog.kind }),
      });
      notify(`Беседа «${dialog.title}» добавлена`);
      await onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось добавить беседу"); }
  }

  const connectionCards = [
    ...integrations.map((connection) => ({ platform: connection.platform, connection })),
    ...(Object.keys(platformInfo) as Platform[])
      .filter((item) => !integrations.some((connection) => connection.platform === item))
      .map((platform) => ({ platform, connection: undefined })),
  ];

  return (
    <div className="connections-layout">
      {error && <div className="alert error">{error}</div>}
      <section className="connection-grid">
        {connectionCards.map(({ platform: item, connection }) => <article className={`connection-card platform-edge-${item}`} key={connection?.id || item}>
          <div className="connection-title"><PlatformBadge platform={item} /><div><h3>{platformInfo[item].label}</h3><p>{connection ? connection.name : platformInfo[item].help}</p></div><i className={connection?.enabled ? "online" : ""} /></div>
          <div className="connection-foot"><span>{connection?.destination_count ?? 0} бесед</span><div><b>{connection?.enabled ? "подключено" : "не настроено"}</b>{connection && <button type="button" className="delete-connection" onClick={() => setPendingDelete(connection)} aria-label={`Удалить подключение ${connection.name}`}>Удалить</button>}</div></div>
        </article>)}
      </section>

      <div className="two-columns">
        <form className="card settings-form" onSubmit={addIntegration}>
          <div className="section-heading"><div><h2>Новое подключение</h2><p>Личные сессии и токены хранятся только локально</p></div></div>
          <label>Мессенджер<select value={platform} onChange={(e) => { setPlatform(e.target.value as Platform); setToken(""); }}>{(Object.keys(platformInfo) as Platform[]).map((item) => <option value={item} key={item}>{platformInfo[item].label}</option>)}</select></label>
          <label>Название<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Рабочий аккаунт" required /></label>
          {(platform === "vk" || platform === "max") && <label>{platform === "vk" ? "Пользовательский access token" : "Токен личной web-сессии"}<input type="password" value={token} onChange={(e) => setToken(e.target.value)} onBlur={() => setToken(platform === "vk" ? extractVkAccessToken(token) : extractMaxToken(token))} placeholder={platformInfo[platform].help} required /></label>}
          {platform === "max" && <div className="token-source-card source-max">
            <div><span className="source-icon">MX</span><div><b>Получить токен в MAX Web</b><small>Войдите в аккаунт, выполните команду — чистый токен автоматически скопируется</small></div></div>
            <a href="https://web.max.ru/" target="_blank" rel="noreferrer">Открыть MAX Web ↗</a>
            <code>{maxTokenCommand}</code>
            <button type="button" className="copy-command" onClick={copyMaxTokenCommand}>Скопировать команду</button>
          </div>}
          {platform === "max" && <p className="form-hint warning">У MAX нет официального API личного аккаунта. Используется неофициальный web-клиент; сессия может завершиться, а аккаунт — попасть под ограничения. Используйте отдельный рабочий аккаунт и умеренную частоту.</p>}
          {platform === "vk" && <div className="token-source-card source-vk">
            <div><span className="source-icon">VK</span><div><b>Пользовательский токен VK</b><small>Сначала создайте приложение и скопируйте его ID</small></div></div>
            <a href="https://vk.com/apps?act=manage" target="_blank" rel="noreferrer">Открыть приложения VK ↗</a>
            <label>ID приложения<input inputMode="numeric" value={vkAppId} onChange={(e) => setVkAppId(e.target.value)} placeholder="Например, 12345678" /></label>
            <a className={`oauth-link ${!vkAuthorizeUrl ? "disabled" : ""}`} href={vkAuthorizeUrl || undefined} target="_blank" rel="noreferrer">Получить токен через VK OAuth ↗</a>
            <small>После разрешения доступа вставьте сюда всю строку из адресной строки — токен извлечётся автоматически.</small>
          </div>}
          {platform === "vk" && <p className="form-hint">При сохранении сервис проверит, что токен принадлежит пользователю, а не сообществу.</p>}
          {platform === "telegram" && <p className="form-hint">Сначала сохраните подключение, затем авторизуйте личный аккаунт ниже. Боты и BotFather не используются.</p>}
          {platform === "whatsapp" && <p className="form-hint">WhatsApp использует отдельную QR-сессию. Сначала сохраните подключение, затем откройте QR-код.</p>}
          <button className="secondary">Сохранить подключение</button>
          {platform === "max" && maxIntegrationId && <div className="session-panel max-groups-panel">
            <div className="session-actions"><b>Группы MAX</b><button type="button" className="ghost compact" onClick={loadMaxGroups} disabled={maxGroupsLoading}>{maxGroupsLoading ? "Загружаю…" : "Загрузить группы"}</button></div>
            {integrations.filter((item) => item.platform === "max").length > 1 && <label>Подключение<select value={maxIntegrationId} onChange={(event) => { setMaxIntegrationId(event.target.value); setMaxGroups([]); }}>{integrations.filter((item) => item.platform === "max").map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}
            <small>{maxGroups.length ? `${maxGroups.length} групп доступно` : "Загрузите группы, в которых состоит подключённый аккаунт."}</small>
            {maxGroups.length > 0 && <div className="wa-groups max-groups">{maxGroups.map((group) => {
              const added = destinations.some((destination) => destination.integration_id === maxIntegrationId && destination.external_id === group.id);
              return <div key={group.id}><span><b>{group.title}</b><small>{group.participantsCount} участников · ID {group.id}</small></span><button type="button" onClick={() => importMaxGroup(group)} disabled={added}>{added ? "Добавлена" : "Добавить"}</button></div>;
            })}</div>}
          </div>}
          {platform === "whatsapp" && <button type="button" className="ghost" onClick={loadWhatsapp}>Проверить QR-сессию</button>}
          {whatsappStatus && <div className="qr-panel"><b>Статус: {whatsappStatus.status}</b>{whatsappStatus.qr && <img src={whatsappStatus.qr} alt="QR-код WhatsApp" />}<small>{whatsappStatus.qr ? "Отсканируйте в WhatsApp → Связанные устройства" : whatsappStatus.status === "ready" ? "Сессия активна. Доступные группы показаны ниже." : "Запустите WhatsApp bridge или обновите статус."}</small>{whatsappGroups.length > 0 && <div className="wa-groups">{whatsappGroups.map((group) => <div key={group.id}><span>{group.title}</span><button type="button" onClick={() => importWhatsappGroup(group)}>Добавить</button></div>)}</div>}</div>}
          {platform === "telegram" && <div className="session-panel">
            <div className="session-actions"><b>Личная сессия Telegram</b><button type="button" className="ghost compact" onClick={loadTelegram}>Обновить статус</button></div>
            <small>Статус: {telegramStatus?.status || "не проверен"}{telegramStatus?.profile ? ` · ${telegramStatus.profile.name}` : ""}</small>
            {telegramStatus?.error && <small className="failure-reason">{telegramStatus.error}</small>}
            {(!telegramStatus || ["disconnected", "auth_failure", "offline"].includes(telegramStatus.status)) && <>
              {telegramStatus?.configured === false
                ? <>
                  <p className="form-hint warning">В .env нет реквизитов Telegram-приложения. Введите их здесь — они сохранятся только локально вместе с Telegram-сессией.</p>
                  <a className="setup-link" href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">Получить API ID и API Hash ↗</a>
                  <label>API ID<input inputMode="numeric" value={telegramApiId} onChange={(e) => setTelegramApiId(e.target.value)} placeholder="Например, 12345678" /></label>
                  <label>API Hash<input type="password" value={telegramApiHash} onChange={(e) => setTelegramApiHash(e.target.value)} placeholder="Строка из API development tools" /></label>
                </>
                : telegramStatus?.configured === true
                  ? <p className="form-hint">Реквизиты Telegram-приложения настроены на сервере. Для входа нужен только телефон с активным аккаунтом.</p>
                  : <p className="form-hint">Проверяю настройки Telegram…</p>}
              <button type="button" className="ghost telegram-login" onClick={startTelegramQr} disabled={telegramStatus?.configured === undefined || (telegramStatus.configured === false && (!telegramApiId.trim() || !telegramApiHash.trim()))}>Войти через QR</button>
            </>}
            {telegramStatus?.status === "starting" && <div className="session-wait"><i /><span>Создаю защищённый QR-сеанс…</span></div>}
            {telegramStatus?.status === "qr" && telegramStatus.qr && <div className="telegram-qr-card">
              <div className="qr-frame"><img src={telegramStatus.qr} alt="QR-код для входа в Telegram" /><span className="scan-line" /></div>
              <div><span className="status-chip">Ожидает сканирования</span><b>Подтвердите вход с телефона</b><small>Telegram → Настройки → Устройства → Подключить устройство</small><em>QR-код обновляется автоматически</em></div>
            </div>}
            {telegramStatus?.status === "password_required" && <div className="inline-auth"><input type="password" value={telegramPassword} onChange={(e) => setTelegramPassword(e.target.value)} placeholder="Пароль 2FA" /><button type="button" onClick={submitTelegramPassword}>Подтвердить</button></div>}
            {telegramDialogs.length > 0 && <div className="wa-groups">{telegramDialogs.map((dialog) => <div key={dialog.id}><span>{dialog.title}</span><button type="button" onClick={() => importTelegramDialog(dialog)}>Добавить</button></div>)}</div>}
          </div>}
        </form>

        <form className="card settings-form" onSubmit={addDestination}>
          <div className="section-heading"><div><h2>Новая беседа</h2><p>Укажите внешний ID группы или канала</p></div></div>
          <label>Подключение<select value={integrationId} onChange={(e) => setIntegrationId(e.target.value)} required><option value="">Выберите…</option>{integrations.map((item) => <option value={item.id} key={item.id}>{platformInfo[item.platform].label} · {item.name}</option>)}</select></label>
          <label>Название<input value={targetTitle} onChange={(e) => setTargetTitle(e.target.value)} placeholder="Команда продаж" required /></label>
          <label>ID беседы<input value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="-100… / 2000000001 / …@g.us" required /></label>
          <button className="secondary" disabled={!integrations.length}>Добавить беседу</button>
        </form>
      </div>

      <section className="card destination-table">
        <div className="section-heading"><div><h2>Все беседы</h2><p>{destinations.length} адресов в сети доставки</p></div></div>
        {destinations.length === 0 ? <div className="empty">Здесь появятся добавленные группы и каналы.</div> : destinations.map((item) => <div className="destination-row" key={item.id}><PlatformBadge platform={item.platform} /><span><b>{item.title}</b><small>{item.external_id}</small></span><em>{item.integration_name}</em></div>)}
      </section>

      {pendingDelete && <div className="dialog-backdrop" role="presentation" onMouseDown={() => !deleting && setPendingDelete(null)}>
        <section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
          <span className={`platform-badge platform-${pendingDelete.platform}`}>{platformInfo[pendingDelete.platform].mark}</span>
          <p className="eyebrow">Удаление подключения</p>
          <h2 id="delete-dialog-title">Удалить «{pendingDelete.name}»?</h2>
          <p>Будут удалены подключение, {pendingDelete.destination_count} связанных бесед и их записи доставки. Отменить это действие нельзя.</p>
          <div className="dialog-actions"><button type="button" className="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>Отмена</button><button type="button" className="danger-action" onClick={deleteIntegration} disabled={deleting}>{deleting ? "Удаляю…" : "Удалить подключение"}</button></div>
        </section>
      </div>}
    </div>
  );
}

function History({ apiKey, deliveries, onRetry }: { apiKey: string; deliveries: Delivery[]; onRetry: () => void }) {
  async function retry(id: string) { await api(`/api/deliveries/${id}/retry`, apiKey, { method: "POST" }); onRetry(); }
  return <section className="card history-card"><div className="section-heading"><div><h2>Последние отправки</h2><p>Статусы обновляются каждые пять секунд</p></div><span className="live-dot">LIVE</span></div>{deliveries.length === 0 ? <div className="empty large">Отправок пока нет. Создайте первую публикацию — каждый получатель появится здесь отдельной строкой.</div> : <div className="history-list">{deliveries.map((item) => <div className="history-row" key={item.id}><PlatformBadge platform={item.platform} /><div className="history-message"><b>{item.destination_title}</b><p>{item.text}</p>{item.last_error && <small className="failure-reason">{item.last_error}</small>}</div><time>{new Date(item.sent_at || item.queued_at).toLocaleString("ru-RU")}</time><span className={`status status-${item.status}`}>{item.status === "sent" ? "Доставлено" : item.status === "failed" ? "Ошибка" : item.status === "sending" ? "Отправляется" : "В очереди"}</span>{item.status === "failed" && <button className="retry" onClick={() => retry(item.id)}>Повторить</button>}</div>)}</div>}</section>;
}

export default App;
