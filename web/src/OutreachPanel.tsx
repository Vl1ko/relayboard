import { useEffect, useRef, useState } from "react";
type Settings = {
  revision: number;
  template: string;
  intervalSeconds: number;
  platforms: ("max" | "whatsapp")[];
  accountIds: string[];
};
type RequestRow = {
  id: string;
  contactId: string;
  name: string;
  phone: string | null;
};
type Preview = {
  template: string;
  intervalSeconds: number;
  eligible: number;
  rows: {
    requestId: string;
    name: string;
    reason: string | null;
    route: {
      platform: string;
      accountId: string;
    } | null;
  }[];
};
const reasons: Record<string, string> = {
  opted_out: "Контакт отказался от сообщений",
  manual_or_closed: "Ручной режим или закрытый диалог",
  no_ready_conversation:
    "Нет подтверждённого диалога в авто-режиме у доступного аккаунта",
  same_contact_in_preview:
    "Другой запрос к этому контакту уже выбран в предпросмотре",
};
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
export default function OutreachPanel() {
  const [settings, setSettings] = useState<Settings | null>(null),
    [accounts, setAccounts] = useState<
      {
        id: string;
        name: string;
        platform: string;
      }[]
    >([]),
    [contacts, setContacts] = useState<
      {
        id: string;
        displayName: string;
        phone: string | null;
      }[]
    >([]),
    [requests, setRequests] = useState<RequestRow[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [contact, setContact] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const pendingRequest = useRef<{
      id: string;
      contactId: string;
    } | null>(null),
    mounted = useRef(true),
    generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  async function load() {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const [s, a, c, r] = await Promise.all([
        api<Settings>("/api/ai/outreach/settings"),
        api<typeof accounts>("/api/integrations"),
        api<{
          contacts: typeof contacts;
        }>("/api/ai/contacts?limit=100"),
        api<RequestRow[]>("/api/ai/outreach/requests"),
      ]);
      if (!mounted.current || current !== generation.current) return;
      setSettings(s);
      setAccounts(a.filter((x) => ["max", "whatsapp"].includes(x.platform)));
      setContacts(c.contacts);
      setRequests(r);
      setDirty(false);
      setPreview(null);
    } catch (e) {
      if (mounted.current && current === generation.current)
        setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (mounted.current && current === generation.current) setBusy(false);
    }
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function change(p: Partial<Settings>) {
    if (settings) {
      setSettings({ ...settings, ...p });
      setDirty(true);
      setPreview(null);
    }
  }
  return (
    <section className="card contact-import-card">
      <h2>Первое обращение — подготовка</h2>
      <p>
        Заявка создаётся отдельно от импорта. Здесь можно сохранить настройки и
        проверить маршрут. Отправки и запуск пока не подключены.
      </p>
      {error && (
        <p role="alert" className="contact-import-error">
          {error}
        </p>
      )}
      <button disabled={busy} onClick={() => void load()}>
        Обновить настройки, контакты и заявки
      </button>
      {settings && (
        <fieldset disabled={busy}>
          <label>
            Шаблон первого сообщения
            <textarea
              rows={4}
              maxLength={4000}
              value={settings.template}
              onChange={(e) => change({ template: e.target.value })}
            />
          </label>
          <small>
            Обычный текст без подстановок. Пустой шаблон можно сохранить как
            черновик.
          </small>
          <label>
            Минимальный интервал, секунд
            <input
              type="number"
              min={1}
              max={86400}
              value={settings.intervalSeconds}
              onChange={(e) =>
                change({ intervalSeconds: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Приоритет каналов
            <select
              value={settings.platforms.join(",")}
              onChange={(e) =>
                change({
                  platforms: e.target.value.split(",") as Settings["platforms"],
                })
              }
            >
              <option value="max,whatsapp">MAX, затем WhatsApp</option>
              <option value="whatsapp,max">WhatsApp, затем MAX</option>
              <option value="max">Только MAX</option>
              <option value="whatsapp">Только WhatsApp</option>
            </select>
          </label>
          <label>
            Разрешённые аккаунты
            <select
              multiple
              value={settings.accountIds}
              onChange={(e) =>
                change({
                  accountIds: Array.from(e.target.selectedOptions).map(
                    (x) => x.value,
                  ),
                })
              }
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.platform}
                </option>
              ))}
            </select>
          </label>
          <small>
            Сохранённый порядок аккаунтов используется внутри одного канала.
            Пустой список никому не разрешает отправку.
          </small>
          <button
            onClick={() =>
              void run(async () => {
                const s = await api<Settings>("/api/ai/outreach/settings", {
                  method: "PUT",
                  body: JSON.stringify(settings),
                });
                if (mounted.current) {
                  setSettings(s);
                  setDirty(false);
                  setPreview(null);
                }
              })
            }
          >
            Сохранить настройки
          </button>
          <hr />
          <label>
            Контакт для новой заявки
            <select
              value={contact}
              onChange={(e) => {
                setContact(e.target.value);
                pendingRequest.current = null;
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
          <button
            disabled={!contact}
            onClick={() =>
              void run(async () => {
                pendingRequest.current ??= {
                  id: crypto.randomUUID(),
                  contactId: contact,
                };
                await api("/api/ai/outreach/requests", {
                  method: "POST",
                  body: JSON.stringify(pendingRequest.current),
                });
                const r = await api<RequestRow[]>("/api/ai/outreach/requests");
                if (mounted.current) {
                  setRequests(r);
                  pendingRequest.current = null;
                  setContact("");
                  setPreview(null);
                }
              })
            }
          >
            Создать отдельную заявку
          </button>
          <label>
            Заявки для предпросмотра
            <select
              multiple
              value={selected}
              onChange={(e) => {
                setSelected(
                  Array.from(e.target.selectedOptions).map((x) => x.value),
                );
                setPreview(null);
              }}
            >
              {requests.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name || r.phone || r.contactId} · {r.id}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={dirty || !selected.length}
            onClick={() =>
              void run(async () => {
                const p = await api<Preview>("/api/ai/outreach/preview", {
                  method: "POST",
                  body: JSON.stringify({
                    revision: settings.revision,
                    requestIds: selected,
                  }),
                });
                if (mounted.current) setPreview(p);
              })
            }
          >
            Проверить выбранные заявки
          </button>
          {dirty && <p>Сохраните настройки перед проверкой.</p>}
        </fieldset>
      )}
      {preview && (
        <div aria-live="polite">
          <h3>Предпросмотр: готовых маршрутов {preview.eligible}</h3>
          <p>Интервал: {preview.intervalSeconds} сек. Запуск недоступен.</p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {preview.template}
          </pre>
          <ul>
            {preview.rows.map((r) => (
              <li key={r.requestId}>
                {r.name || r.requestId}:{" "}
                {r.reason
                  ? reasons[r.reason] ||
                    (r.reason.startsWith("existing_")
                      ? "Первое обращение по этой заявке уже записано; повтор заблокирован"
                      : r.reason)
                  : `${r.route?.platform} · ${r.route?.accountId}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
