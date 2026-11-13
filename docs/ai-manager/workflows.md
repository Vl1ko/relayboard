# E06/E08: управление диалогом, передача и follow-up

Локальный доменный модуль: `ConversationWorkflow` в `src/core/conversation-workflow.ts`; additive-схема `database/ai-manager-workflows.sql`. Root включает схему в общий migration runner. Исходные схемы E02/E03 не изменяются. Этот модуль не подключает реальные MAX/WhatsApp и не назначает бизнес-настройки по умолчанию.

## Режимы и статусы

`control({conversationId,action:takeover|stop|resume})` действует на все явно связанные диалоги контакта. Takeover устанавливает manual и manager_working для незакрытых диалогов. Stop устанавливает paused. Оба увеличивают epoch, отменяют pending outbox, помечают начатые cancellation_requested и отменяют follow-up jobs. Resume только явно включает auto, запрещён для opt-out/closed/refused; отменённые задания не оживают. Повтор resume уже включённого контакта epoch не меняет.

`setStatus({conversationId,status,reason,proof?,expectedEpoch?})` реализует переходы всех девяти статусов. Qualified требует server-only callback `verifyQualification(client,conversationId,proof)`; без него статус запрещён. Публичный UI не вправе передавать доказательство собственной квалификации. Refused — устойчивый opt-out на всех связанных каналах. Остальные смены статуса приостанавливают автоматику и отменяют устаревшие действия; только отдельное resume может включить auto. История переходов сохраняется. ExpectedEpoch сравнивается под блокировками и защищает от применения задержанного ИИ-результата, в том числе старого отказа.

Порядок блокировок во всех транзакциях: контакт → все его диалоги по ID → outbox/jobs/notification. Применение ИИ-решения выполняет orchestrator root; `handoff` поддерживает internal-only `resultStatus:unqualified|insufficient_data`, чтобы передача не превращала неподходящего в подходящего. Это поле и proof не должны приниматься как команды браузера.

## Передача менеджеру

`saveManagerTarget({accountId,externalId})` принимает только существующий MAX-аккаунт. Без настройки уведомление сохраняется pending с незаполненным адресом; это не «уведомлён». При последующем claim отсутствующий адрес можно привязать к явно сохранённой настройке. Уже привязанный адрес — snapshot; изменение общей настройки не перенаправляет старое уведомление.

`handoff({conversationId,key,reason,summary,parameters?,source?,proof?,expectedEpoch?,resultStatus?})` поддерживает четыре причины: qualified, human_requested, insufficient_data, reply_limit. Он атомарно приостанавливает все каналы контакта, отменяет ожидающую автоматику и сохраняет snapshot контакта/канала/аккаунта/диалога/параметров/источника. Повтор logical key с тем же смысловым payload возвращает прежнюю запись; порядок полей JSON не влияет на fingerprint. Иной payload по тому же ключу запрещён. Повтор квитанции не меняет новую generation.

Состояния: pending, dispatching, confirmed, unknown, rejected. `claimNotification` и `notificationOutcome` — внутренние интерфейсы отправителя, не браузерные действия. Подтверждение требует собственного attempt token и external message ID; unknown нельзя снова claim. Поздний confirmed того же attempt сохраняется; поздний rejected не снимает unknown.

`dispatchNotification(id, prepared)` принимает только заранее подготовленный синхронный `start`, привязанный к accountId/externalId. Перед реальным началом он повторно блокирует контакт/уведомление и MAX-аккаунт FOR SHARE, проверяет auth/enable/target, синхронно начинает transport и ждёт ack после освобождения транзакции. Текст — JSON snapshot для будущего renderer/adapter. Неопределённый/чужой ack и синхронное исключение становятся unknown. Подключение реального адаптера, его payload/size формат и live проверка native takeover остаются отдельными gates.

## Повторные обращения

Настройки пусты до явного ввода. Для каждой из четырёх последовательностей (`no_reply`, `not_booked`, `not_completed`, `requested_later`) задаются enabled, IANA timezone, weekdays1–7, startMinute/endMinute, steps с текстом/задержкой и maxSends1–20. Окно в пределах одного дня, end-exclusive; ночное пересечение в этой версии не поддерживается и не угадывается. Число шагов не превышает лимит. Таймзона обязательна. UTC minute walk учитывает изменение смещения DST и перенос выходных без fixed-offset предположения.

`scheduleFollowup({conversationId,scenario,key,anchorAt})` фиксирует snapshot правил/epoch и создаёт до20 jobs. Повтор ключа возвращает первоначальное расписание; отменённое не возрождается. `dueFollowups(now)` сначала сверяет epoch и режимы. `materializeFollowup(id,now)` атомарно создаёт одно pending outbox, не отправляет сообщение. Следующий шаг ждёт confirmed предыдущего и задержку от его фактического dispatch_started_at. Неопределённое/неподтверждённое предыдущее действие не запускает следующий шаг.

**Обязательная интеграция:** root вызывает `workflowActionGate(client,actionId,now)` внутри финальной send-транзакции E02. Gate повторно проверяет текущее enabled/лимит/рабочее окно и фактическую задержку; правило блокируется FOR SHARE до synchronous start. Проверка только при materialization недостаточна. Для старого generic follow_up без workflow job gate возвращает ready; право на его отправку остаётся у прежних guards E02.

Ответ клиента через E02 ingest увеличивает epoch и отменяет outbox; reconcileFollowups убирает его расписание. Явные booking/order_completed/requested_stop/closed, takeover, opt-out и handoff отменяют всё ожидающее. Смена статуса тоже отменяет старые ожидания. Не начатое действие может быть отменено; уже начатый внешний запрос нельзя отозвать задним числом — его ack/unknown сохраняется отдельно.

`detail(id)` ограничен последними500 inbox-сообщениями и100 notification/followup/status-history записями. Полную историю с пагинацией предоставляет workspace API; detail не источник полного контекста модели.

## Проверка и ограничения

`conversation-workflow.test.ts`: чистые правила окон/статусов и PostgreSQL integration на отдельной `relayboard_workflow_test` (собственная схема, синтетические данные). Проверены все четыре сценария, связанный контакт двух каналов, idempotency/restart-safe строки, authoritative proof, stale AI-result, ответ/запись/заказ/stop/closed/takeover/handoff/opt-out, фактическая задержка, повторный финальный gate, неизвестное и позднее подтверждение менеджера, target binding и JSON-order replay.

Это не live E06/E08 приёмка: реальные sender factory, lifecycle worker, UI/API интегрирует root. Нужны разрешённые аккаунты, письменное поручение, согласованные тексты/часы/лимиты и PostgreSQL16-проверка. Сам модуль не запускает фоновые таймеры и не инициирует сетевые вызовы без явно инжектированного prepared transport.
