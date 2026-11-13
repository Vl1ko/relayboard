import { useEffect, useState } from "react";
type Source = { accountId: string; chatId: string; platform: string };
type State = {
  revision: number;
  sources: Source[];
  choices: (Source & { accountName: string; title: string })[];
};
async function request(init: RequestInit = {}) {
  const r = await fetch("/api/ai/leads/sources", {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json" },
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Ошибка");
  return data;
}
export default function SearchSourcesPanel() {
  const [state, set] = useState<State | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function load() {
    setBusy(true);
    try {
      set(await request());
      setMessage("");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="card contact-import-card">
      <h2>Чаты для поиска заявок</h2>
      <p>
        Выберите чаты из подключённых аккаунтов. Сохранение списка не включает
        мониторинг: подключение получения сообщений ещё готовится.
      </p>
      <button disabled={busy} onClick={() => void load()}>
        Обновить список чатов
      </button>
      {message && <p role="status">{message}</p>}
      {state && (
        <fieldset disabled={busy}>
          {!state.choices.length && (
            <p>
              Подключите аккаунт и загрузите беседы в разделе «Подключения».
            </p>
          )}
          {state.choices.map((c) => {
            const selected = state.sources.some(
              (s) => s.accountId === c.accountId && s.chatId === c.chatId,
            );
            return (
              <label key={c.accountId + ":" + c.chatId}>
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(e) =>
                    set({
                      ...state,
                      sources: e.target.checked
                        ? [
                            ...state.sources,
                            {
                              accountId: c.accountId,
                              chatId: c.chatId,
                              platform: c.platform,
                            },
                          ]
                        : state.sources.filter(
                            (s) =>
                              !(
                                s.accountId === c.accountId &&
                                s.chatId === c.chatId
                              ),
                          ),
                    })
                  }
                />
                {c.title} · {c.accountName} · {c.platform}
              </label>
            );
          })}
          <button
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  const saved = await request({
                    method: "PUT",
                    body: JSON.stringify({
                      revision: state.revision,
                      sources: state.sources,
                    }),
                  });
                  set({ ...state, ...saved });
                  setMessage(
                    "Выбранные чаты сохранены. Мониторинг пока выключен.",
                  );
                } catch (e) {
                  setMessage(String(e));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            Сохранить выбранные чаты
          </button>
        </fieldset>
      )}
    </section>
  );
}
