import MonitorControls from './MonitorControls';
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
    <><details className="workflow-disclosure workflow-card"><summary>Чаты для поиска{state?' · '+state.sources.length:''}</summary><section className="card contact-import-card">
      <h2>Чаты для поиска заявок</h2>
      <p>
        Выберите до пяти чатов MAX и пяти WhatsApp. Для одного чата используйте один аккаунт чтения. Ответ отправляется автору заявки в личку.
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
          <p>MAX: {state.sources.filter(s=>s.platform==='max').length} из 5 · WhatsApp: {state.sources.filter(s=>s.platform==='whatsapp').length} из 5</p>
          {state.sources.filter(s=>!state.choices.some(c=>c.accountId===s.accountId&&c.chatId===s.chatId)).map(s=><p key={s.accountId+':'+s.chatId}>Недоступный источник · {s.platform} <button onClick={()=>set({...state,sources:state.sources.filter(v=>v!==s)})}>Убрать из поиска</button></p>)}
          <div className="search-source-options">{state.choices.map((c) => {
            const selected = state.sources.some(
              (s) => s.accountId === c.accountId && s.chatId === c.chatId,
            );
            return (
              <label key={c.accountId + ":" + c.chatId}>
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={!selected&&!state.sources.some(s=>s.platform===c.platform&&s.chatId===c.chatId)&&state.sources.filter(s=>s.platform===c.platform).length>=5}
                  onChange={(e) =>
                    set({
                      ...state,
                      sources: e.target.checked
                        ? [
                            ...state.sources.filter(s=>!(s.platform===c.platform&&s.chatId===c.chatId)),
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
          })}</div>
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
                    "Выбранные чаты сохранены.",
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
    </section></details><MonitorControls/></>
  );
}
