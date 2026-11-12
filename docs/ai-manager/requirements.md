# Матрица ТЗ → результат

Источник: Приложение1 PDF стр.7–11; полный план — execution-plan.md. Номера кейсов ниже — план создания, не существующие PASS-тесты.

| TZ | Этап | Кейсы | Измеримый результат / текущий gap |
|---|---|---|---|
| 2.1 | E03 | TC-IMPORT | Локальные UI/API CSV/XLSX; фикстуры 6/2/2, конкурентный/replayed confirm, rollback и сохранение истории/opt-out. Доказательства — contact-import.md и progress.md; PG16/live UNVERIFIED |
| 2.2 | E01-C/E04 | TC-CHANNEL | 2 личных канала, account isolation, inbound/outbound/own/human. Только synthetic контракт |
| 2.3 | E04 | TC-FIRST | Предпросмотр, пустой шаблон, обновление ещё не начатых, интервал/пауза/resume. NOT_STARTED |
| 2.4 | E02/E04 | TC-DEDUPE | Durable transport/operation dedup и unknown/no replay проверены offline; реальный send и семантика «той же заявки» остаются OPEN |
| 2.5 | E05 | TC-PROVIDER | Один реальный API, versioned настройки, лимит, секреты. BLOCKED O-02 |
| 2.6 | E07 | TC-QUALIFY | 9 статусов, обязательные поля, уточнения, исключения/handoff. BLOCKED O-02/O-05 для реального сценария |
| 2.7 | E08 | TC-FOLLOWUP | 4 сценария, часы/лимиты, 7 причин отмены, импорт не оживляет. NOT_STARTED/O-07 |
| 2.8 | E09 | TC-LEADS | Источник/параметры/confidence, approve/edit/reject, нет повторной заявки. BLOCKED O-01/O-05/O-06 |
| 2.9 | E06 | TC-HANDOFF | 4 причины MAX-уведомления, все поля, unknown/dedup. NOT_STARTED/live BLOCKED |
| 2.10 | E06 | TC-MANUAL | Takeover/native human в 2 каналах, отмена LLM/jobs, явный resume. Только синтетическая классификация |
| 2.11 | E02/E06/E11 | TC-STOP | Opt-out переживает импорт/поиск, auth/AI/notification outage без ложного успеха. NOT_STARTED |
| 2.12 | E10 | TC-INBOX | Единая карточка, аккаунтные истории, 4 фильтра, 5 счётчиков/actions. UI prototype/O-10 |

Дополнительно: TZ-3.1 — закрытый браузер и регрессия прежних функций; TZ-3.4 — 20 независимых неизвестных коммерческих вопросов, 20 безопасных передач/0 выдумок, защита от injection; TZ-4.2 — live 12/12 на разрешённых аккаунтах и реальном выбранном ИИ; TZ-4.3 — version/provider/model/settings/evidence и пакет передачи. Live gates сейчас UNVERIFIED.

G8: TZ2.1–2.7 на8-й рабочий день; G14: полный установленный результат за14 рабочих дней после подтверждённого старта. Дата старта неизвестна; это условия договора, не прогноз Codex.
