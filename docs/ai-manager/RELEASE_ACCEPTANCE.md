# Матрица приёмки и финальное участие владельца

15 ноября2026. Исходный объём [RELEASE_PLAN.md](RELEASE_PLAN.md) сохранён. Здесь «автоматически проверено» означает только изолированный контур без настоящей модели и рассылки. Общий лог исходников: outputs/res01-final-rc-source-2026-11-15/tests.log —370 PASS/0 FAIL/0 SKIP. Итоговый Linux RC фиксируется отдельно в release manifest.

|Требование|Реализация и автономное доказательство|Что остаётся на реальном контуре F08|
|---|---|---|
|TC01 Import|contact-file/contact-import tests: CSV/XLSX, ошибки, дубли; [описание](contact-import.md)|Разрешённый тестовый файл, понятность отчёта и отсутствие обращения при повторе|
|TC02 Routing|account-routing, MAX/WhatsApp sessions/readiness/route tests; owner/SIGKILL smoke|Авторизовать5+5, выбрать отправителя и источники, проверить адресата, auth loss и восстановление|
|TC03 First+dedup|outreach/outreach-runner/delivery-policy, request-lifecycle concurrency; [первое обращение](first-outreach.md)|Шаблон/интервал, реальная квитанция и проверяемый повтор после рестарта|
|TC04 Qualification|ai-engine, numeric-evidence, cross-channel request-lifecycle, corpus; [финальные регрессии](final-regressions.md)|Настроенные бизнес-критерии и настоящий GigaChat на корпусе, включая12,5/противоречия/нехватку данных|
|TC05 Handoff|handoff-context/ai-orchestrator/conversation-workflow, четыре причины, negative-completion|Все4 уведомления в выбранном MAX-чате, тексты успеха/прощания и правильные ссылки/параметры|
|TC06 Manager hold|ai-manager/workflow/lifecycle, stale guards; [история](request-history.md)|UI/native takeover,0 вмешательств после handoff, закрытие и новый источник на обоих каналах|
|TC07 Follow-ups|automatic-followups/requested-later/workflow; [четыре сценария](automatic-followups.md)|Окна/интервалы, отмеченные этапы и отмена после ответа/передачи/отказа|
|TC08 Search|source-monitor/search-sources/lead-intake/gigachat-source-scorer, повтор источника; [поиск](source-monitor.md)|Выбранные настоящие группы, порог модели, review approve/edit/reject, первое обращение именно в личку|
|TC09 Isolation/errors|Origin/auth/upload checks, engine proof/injection/provider errors, opt-out tests; [security](security-and-recovery-acceptance.md)|20 неизвестных коммерческих вопросов настоящей модели:0 выдуманных фактов; разрешённые identity/route границы|
|TC10 Inbox|workspace/workflow tests, browser390px, настройки reload/conflict; [UI](settings-acceptance.md)|Бизнес-приёмка фильтров/счётчиков/очереди/ручного ответа и двух каналов контакта|
|TC11 Operations|owner/SIGKILL/Chrome, full PG/Redis/API synthetic recovery, legacy Linux smoke; [recovery](recovery-runbook.md)|Реальное восстановление сессий, текущий production snapshot и проверка возврата фактической версии, публикации/медиа|
|TC12 Capacity+retention|dialogue/attachment/upload retention, queue bounds;24ч synthetic ещё идёт; [capacity](capacity-and-operations.md)|Измерить реальную ёмкость5+5 и≥20 диалогов/сутки на платформу; подтвердить ресурсный запас и расписание копий|

## Порядок последней совместной проверки

1. Подключить разрешённые тестовые MAX/WhatsApp аккаунты и собеседников через интерфейс; для полной capacity-приёмки нужны5+5. Назначить группы-источники и чат уведомлений (до смены — «Тестовая»). Секреты в чат не присылать.
2. Проверить действующий коммерческий маршрут GigaChat и credential, доступную модель/квоту/условия. Текущий адаптер — Sber OAuth; Cloud.ru совместимость не подразумевается. Согласовать лимит стоимости модельной приёмки, затем подключить секрет в защищённой конфигурации.
3. В интерфейсе заполнить поля/критерии, знания, три сообщения, этапы/дожимы, порог и retention (по умолчанию30 дней). Провести TC01–10 на разрешённых тестовых данных; все4 причины handoff, отказ и hold обязательны.
4. Измерить реальные сессии/нагрузку; решить размещение с достаточной памятью. Текущий2GB VPS с почти полным swap не принят для5+5. Затем TC11–12, проверяемое восстановление и возврат с фактической старой версии.
5. До рабочих данных оформить ранее оговорённое поручение на их обработку. Утвердить расписание/RPO/ротацию полных копий на Mac, обеспечить доступность Mac и отдельное хранение ключа восстановления.
6. После устранения найденных дефектов согласовать конкретный commit/image, окно установки и создание свежего полного production backup. Только затем миграции/установка, server smoke, сверка очередей/unknown/hold/opt-out и включение разрешённых внешних действий.

Владелец участвует только в этом заключительном блоке. До него не запускаются платные проверки, реальная рассылка или установка на VPS. Пройденный synthetic тест не заменяет соответствующий реальный пункт.

## Повторяемая безопасная проверка RC

`work/docker-compose.rc-test.yml` предназначен только для отдельного проекта relayboard-rc-test-20261115. Он использует tmpfs БД/Redis/uploads, вымышленные секреты и internal network без внешней сети. Work-скрипты отказоустойчиво проверяют имя тестовой БД/режим. Никогда не соединять этот файл с production Compose или реальными volumes. Его успешный smoke не разрешает включение live.

Перед установкой сохранить resolved Compose и приватную конфигурацию отдельно с0600, проверить режимы каждого процесса и единичное владение профилями. Не выводить `docker compose config`, `docker inspect .Config.Env` и содержимое .env в общие логи: там могут быть ключи. Существующий APP_ENCRYPTION_KEY сохраняется при обновлении; случайная замена делает зашифрованные credentials недоступными.
