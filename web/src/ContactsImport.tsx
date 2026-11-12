import { useEffect, useRef, useState, type FormEvent } from "react";
import "./contacts-import.css";

type Contact = { id: string; displayName: string; phone: string | null; comment: string; stage: string; optedOut: boolean };
type Summary = { total: number; new: number; duplicate: number; invalid: number };
type Inspection = {
  inspectionId: string; filename: string;
  sheets: { name: string; columns: { index: number; label: string }[]; sampleRows: string[][] }[];
};
type PreviewRow = {
  rowNumber: number; phone?: string | null; name?: string; comment?: string; stage?: string;
  outcome: "new" | "duplicate" | "invalid"; reason?: string;
};
type Preview = { previewId: string; expiresAt: string; summary: Summary; rows: PreviewRow[] };
type Confirmation = { importId: string; summary: Summary; replayed: boolean };
type Operation = "inspect" | "preview" | "confirm" | null;
const pageSize = 50;
const outcomes = { new: "Новый контакт", duplicate: "Дубликат", invalid: "Ошибка" };
const rowReasons: Record<string, string> = {
  duplicate_in_file: "Номер уже встречается в этом файле",
  already_exists: "Контакт с этим номером уже есть в базе",
  phone_required: "Не указан номер телефона",
  country_required: "Для местного номера нужно выбрать страну",
  invalid_phone: "Некорректный номер телефона",
  invalid_country: "Некорректный код страны",
  formula_not_allowed: "Ячейки с формулами не импортируются",
  unsupported_cell_type: "Неподдерживаемый тип значения ячейки",
  extra_columns: "В строке больше столбцов, чем в заголовке",
  field_too_long: "Значение поля превышает допустимую длину",
  invalid_row: "Строка содержит некорректные данные",
};
function rowReason(reason: string | undefined) { return reason ? rowReasons[reason] || reason : "—"; }

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Ошибка запроса: ${response.status}`);
  return body as T;
}
function message(error: unknown) { return error instanceof Error ? error.message : "Не удалось выполнить запрос"; }
function Counters({ summary }: { summary: Summary }) {
  return <dl className="contact-import-counters">
    <div><dt>Всего строк</dt><dd>{summary.total}</dd></div>
    <div><dt>Новые</dt><dd>{summary.new}</dd></div>
    <div><dt>Дубликаты</dt><dd>{summary.duplicate}</dd></div>
    <div><dt>Ошибки</dt><dd>{summary.invalid}</dd></div>
  </dl>;
}

export default function ContactsImport() {
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [columns, setColumns] = useState({ phone: "", name: "", comment: "", stage: "" });
  const [country, setCountry] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [expired, setExpired] = useState(false);
  const [result, setResult] = useState<Confirmation | null>(null);
  const [confirmationUncertain, setConfirmationUncertain] = useState(false);
  const [operation, setOperation] = useState<Operation>(null);
  const [error, setError] = useState("");
  const [previewPage, setPreviewPage] = useState(0);
  const [filter, setFilter] = useState<"all" | PreviewRow["outcome"]>("all");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const generation = useRef(0);
  const operationController = useRef<AbortController | null>(null);
  const confirming = useRef(false);

  useEffect(() => () => {
    generation.current += 1;
    operationController.current?.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setListLoading(true); setListError("");
    void request<{ contacts: Contact[]; total: number }>(`/api/ai/contacts?limit=${pageSize}&offset=${offset}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { setContacts(data.contacts); setTotal(data.total); } })
      .catch(reason => { if (!controller.signal.aborted) setListError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [offset, reload]);

  useEffect(() => {
    if (!preview) { setExpired(false); return; }
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) { setExpired(true); return; }
    setExpired(false);
    const timer = window.setTimeout(() => setExpired(true), Math.min(remaining, 2147483647));
    return () => window.clearTimeout(timer);
  }, [preview]);

  function invalidatePreview() {
    generation.current += 1;
    operationController.current?.abort();
    setOperation(null); setPreview(null); setResult(null); setConfirmationUncertain(false); setError(""); setPreviewPage(0); setExpired(false);
  }
  function begin(kind: Exclude<Operation, null>) {
    operationController.current?.abort();
    const controller = new AbortController(); operationController.current = controller;
    const current = ++generation.current;
    setOperation(kind); setError("");
    return { controller, current, isCurrent: () => !controller.signal.aborted && current === generation.current };
  }
  async function inspect(event: FormEvent) {
    event.preventDefault();
    if (!file || confirming.current) return;
    if (file.size > 5 * 1024 * 1024) { setError("Файл превышает 5 МиБ. Уменьшите файл и выберите его заново."); return; }
    if (!/\.(csv|xlsx)$/i.test(file.name)) { setError("Выберите файл CSV или XLSX."); return; }
    invalidatePreview(); setInspection(null);
    const task = begin("inspect");
    const form = new FormData(); form.append("file", file);
    try {
      const data = await request<Inspection>("/api/ai/contact-imports/inspect", { method: "POST", body: form, signal: task.controller.signal });
      if (!task.isCurrent()) return;
      if (!data.sheets.length) throw new Error("В файле нет доступных листов.");
      setInspection(data); setSheetName(data.sheets[0].name);
      setColumns({ phone: "", name: "", comment: "", stage: "" });
    } catch (reason) { if (task.isCurrent()) setError(message(reason)); }
    finally { if (task.isCurrent()) setOperation(null); }
  }
  async function buildPreview(event: FormEvent) {
    event.preventDefault();
    if (!inspection || columns.phone === "" || confirming.current) return;
    const defaultCountry = country.trim().toUpperCase();
    if (defaultCountry && !/^[A-Z]{2}$/.test(defaultCountry)) { setError("Укажите двухбуквенный код страны, например RU, или оставьте поле пустым."); return; }
    invalidatePreview();
    const task = begin("preview");
    const body = {
      inspectionId: inspection.inspectionId, sheetName, phoneColumn: Number(columns.phone),
      ...(columns.name === "" ? {} : { nameColumn: Number(columns.name) }),
      ...(columns.comment === "" ? {} : { commentColumn: Number(columns.comment) }),
      ...(columns.stage === "" ? {} : { stageColumn: Number(columns.stage) }),
      ...(defaultCountry ? { defaultCountry } : {}),
    };
    try {
      const data = await request<Preview>("/api/ai/contact-imports/preview", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: task.controller.signal,
      });
      if (task.isCurrent()) { setPreview(data); setFilter("all"); setPreviewPage(0); }
    } catch (reason) { if (task.isCurrent()) setError(message(reason)); }
    finally { if (task.isCurrent()) setOperation(null); }
  }
  async function confirm() {
    if (!preview || result || confirming.current || operation) return;
    if (!confirmationUncertain && (expired || Date.parse(preview.expiresAt) <= Date.now())) return;
    confirming.current = true;
    const task = begin("confirm");
    try {
      const data = await request<Confirmation>(`/api/ai/contact-imports/${encodeURIComponent(preview.previewId)}/confirm`, {
        method: "POST", signal: task.controller.signal,
      });
      if (!task.isCurrent()) return;
      setResult(data); setConfirmationUncertain(false); setOffset(0); setReload(value => value + 1);
    } catch (reason) {
      if (task.isCurrent()) {
        setConfirmationUncertain(true);
        setError(`${message(reason)}. Если ответ потерян, повторите подтверждение этого же предпросмотра — оно не должно создавать дубли.`);
      }
    } finally { confirming.current = false; if (task.isCurrent()) setOperation(null); }
  }

  const sheet = inspection?.sheets.find(item => item.name === sheetName);
  const previewRows = preview?.rows.filter(row => filter === "all" || row.outcome === filter) || [];
  const shownRows = previewRows.slice(previewPage * pageSize, (previewPage + 1) * pageSize);
  const fieldLabels = { phone: "Телефон — обязательный столбец", name: "Имя", comment: "Комментарий", stage: "Текущий этап клиента" };
  return <div className="contacts-import">
    <section className="card contact-import-card" aria-labelledby="contact-import-title">
      <h2 id="contact-import-title">Импорт контактов</h2>
      <p className="contact-import-safety">Импорт только добавляет контакты. Сообщения не отправляются, автоматические сценарии не запускаются.</p>
      <form onSubmit={event => void inspect(event)}>
        <fieldset disabled={operation === "confirm"}>
          <label htmlFor="contact-file">Файл CSV или XLSX, до 5 МиБ</label>
          <div className="contact-import-file">
            <input id="contact-file" type="file" accept=".csv,.xlsx" onChange={event => {
              invalidatePreview(); setInspection(null); setFile(event.target.files?.[0] || null);
            }}/>
            <button type="submit" disabled={!file || operation === "inspect"}>{operation === "inspect" ? "Читаем файл…" : "Прочитать файл"}</button>
          </div>
        </fieldset>
      </form>
      {inspection && <form onSubmit={event => void buildPreview(event)}>
        <fieldset disabled={operation === "confirm"}>
          <legend>Столбцы файла «{inspection.filename}»</legend>
          <div className="contact-import-mapping">
            <label>Лист
              <select value={sheetName} onChange={event => {
                invalidatePreview(); setSheetName(event.target.value); setColumns({ phone: "", name: "", comment: "", stage: "" });
              }}>{inspection.sheets.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select>
            </label>
            {(Object.keys(fieldLabels) as (keyof typeof fieldLabels)[]).map(key => <label key={key}>{fieldLabels[key]}
              <select required={key === "phone"} value={columns[key]} onChange={event => {
                invalidatePreview(); setColumns(value => ({ ...value, [key]: event.target.value }));
              }}>
                <option value="">{key === "phone" ? "Выберите столбец" : "Не импортировать"}</option>
                {sheet?.columns.map(column => <option key={column.index} value={column.index}>{column.label || `Столбец ${column.index + 1}`}</option>)}
              </select>
            </label>)}
            <label>Страна для местных номеров — необязательно
              <input value={country} maxLength={2} placeholder="Например, RU" autoCapitalize="characters" autoComplete="off" onChange={event => {
                invalidatePreview(); setCountry(event.target.value.toUpperCase());
              }}/>
              <small>Без выбора страны принимаются международные номера с кодом страны.</small>
            </label>
          </div>
          <button type="submit" disabled={columns.phone === "" || operation === "preview"}>{operation === "preview" ? "Проверяем строки…" : "Проверить и показать предпросмотр"}</button>
        </fieldset>
        {sheet && !preview && <div className="contact-import-scroll"><table className="contact-import-table">
          <caption>Образец строк выбранного листа</caption>
          <thead><tr>{sheet.columns.map(column => <th key={column.index} scope="col">{column.label || `Столбец ${column.index + 1}`}</th>)}</tr></thead>
          <tbody>{sheet.sampleRows.map((row, index) => <tr key={index}>{sheet.columns.map(column => <td key={column.index}>{row[column.index] || "—"}</td>)}</tr>)}</tbody>
        </table></div>}
      </form>}
      {error && <p className="contact-import-error" role="alert">{error}</p>}
      {preview && <div className="contact-import-preview" aria-live="polite">
        <h3>Результаты проверки</h3>
        <Counters summary={preview.summary}/>
        <p>Дубликаты сохранят прежние данные, историю и ограничения. Ошибочные строки не будут добавлены.</p>
        <label className="contact-import-filter">Показать строки
          <select value={filter} onChange={event => { setFilter(event.target.value as typeof filter); setPreviewPage(0); }}>
            <option value="all">Все</option><option value="new">Новые</option><option value="duplicate">Дубликаты</option><option value="invalid">Ошибки</option>
          </select>
        </label>
        <div className="contact-import-scroll"><table className="contact-import-table">
          <caption>Предпросмотр импорта — строки с причинами отклонения</caption>
          <thead><tr><th scope="col">Строка</th><th scope="col">Телефон</th><th scope="col">Имя</th><th scope="col">Комментарий</th><th scope="col">Этап</th><th scope="col">Результат</th><th scope="col">Причина</th></tr></thead>
          <tbody>{shownRows.map((row, index) => <tr key={`${row.rowNumber}-${index}`} className={`contact-import-row-${row.outcome}`}>
            <td>{row.rowNumber}</td><td className="contact-import-phone">{row.phone || "Номер не указан"}</td><td>{row.name || "—"}</td><td>{row.comment || "—"}</td><td>{row.stage || "—"}</td>
            <td>{outcomes[row.outcome]}</td><td>{rowReason(row.reason)}</td>
          </tr>)}</tbody>
        </table></div>
        {!previewRows.length && <p>Нет строк для выбранного фильтра.</p>}
        <div className="contact-import-pagination">
          <button type="button" disabled={!previewPage} onClick={() => setPreviewPage(value => value - 1)}>Предыдущие строки</button>
          <span>{previewRows.length ? previewPage * pageSize + 1 : 0}–{Math.min((previewPage + 1) * pageSize, previewRows.length)} из {previewRows.length}</span>
          <button type="button" disabled={(previewPage + 1) * pageSize >= previewRows.length} onClick={() => setPreviewPage(value => value + 1)}>Следующие строки</button>
        </div>
        {expired && !result && <p className="contact-import-error" role="status">{confirmationUncertain
          ? "Срок предпросмотра истёк, но ответ предыдущего подтверждения не получен. Можно повторно запросить результат того же импорта."
          : "Срок предпросмотра истёк. Выполните проверку файла заново."}</p>}
        {!result && <button className="primary" type="button" disabled={Boolean(operation) || expired && !confirmationUncertain} onClick={() => void confirm()}>
          {operation === "confirm" ? "Сохраняем контакты…" : confirmationUncertain ? "Повторить подтверждение этого импорта" : "Подтвердить импорт контактов"}
        </button>}
      </div>}
      {result && <div className="contact-import-success" role="status">
        <h3>{result.replayed ? "Этот импорт уже был подтверждён" : "Импорт завершён"}</h3>
        <Counters summary={result.summary}/>
        <p>Сообщения не отправлялись. Новые контакты доступны в базе ниже.</p>
      </div>}
    </section>
    <section className="card contact-import-card" aria-labelledby="contact-list-title" aria-busy={listLoading}>
      <div className="contact-import-list-heading"><h2 id="contact-list-title">База контактов <span>({total})</span></h2>
        <button type="button" disabled={listLoading} onClick={() => setReload(value => value + 1)}>Обновить</button>
      </div>
      {listLoading && <p role="status">Загружаем контакты…</p>}
      {listError && <p className="contact-import-error" role="alert">{listError}</p>}
      {!listLoading && !listError && !contacts.length && <p className="empty">Контактов пока нет. Загрузите и подтвердите файл выше.</p>}
      {!listLoading && !listError && Boolean(contacts.length) && <div className="contact-import-scroll"><table className="contact-import-table">
        <caption>Сохранённые контакты</caption>
        <thead><tr><th scope="col">Телефон</th><th scope="col">Имя</th><th scope="col">Комментарий</th><th scope="col">Этап</th><th scope="col">Ограничения</th></tr></thead>
        <tbody>{contacts.map(contact => <tr key={contact.id}><td className="contact-import-phone">{contact.phone || "Номер не указан"}</td><td>{contact.displayName || "—"}</td>
          <td>{contact.comment || "—"}</td><td>{contact.stage || "—"}</td>
          <td>{contact.optedOut ? <span className="contact-import-excluded">Исключён: сообщения запрещены</span> : "Нет отказа"}</td></tr>)}</tbody>
      </table></div>}
      <div className="contact-import-pagination">
        <button type="button" disabled={offset === 0 || listLoading} onClick={() => setOffset(value => Math.max(0, value - pageSize))}>Предыдущие контакты</button>
        <span>{total && contacts.length ? offset + 1 : 0}–{Math.min(offset + contacts.length, total)} из {total}</span>
        <button type="button" disabled={listLoading || offset + pageSize >= total} onClick={() => setOffset(value => value + pageSize)}>Следующие контакты</button>
      </div>
    </section>
  </div>;
}
