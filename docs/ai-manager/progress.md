# Прогресс, 12 ноября 2026

Единственный актуальный реестр; план — execution-plan.md; решения — open-decisions.md. Человеческая приёмка не назначается автоматически.

| Этап | Статус | Доказательство / остаток |
|---|---|---|
| E00 | READY_FOR_REVIEW для checkout | baseline.md, baseline-files.json, requirements.md:12/12 TZ; поиск/внешняя исходная версия не подтверждены |
| E01-C | IN_PROGRESS | schema/origin/key/send-outcome и10 синтетических тестов; live BLOCKED O-03/O-04 |
| E01-S | BLOCKED | Нет работающего поиска: нужно решение о модуле/новом объёме |
| E02 | IN_PROGRESS; offline-ядро READY_FOR_REVIEW | ai-manager.sql/store/migration: inbox/outbox, contact opt-out, mode/epoch, подготовленный транспорт и23 DB-теста. Полный workflow9 статусов/API и O-06 ещё не закрыты |
| E03 | READY_FOR_REVIEW локально | UI/API CSV/XLSX, миграция v2, защита временного хранения; доказательства ниже и в contact-import.md. PG16/live UNVERIFIED |
| E04 | NOT_STARTED | Шаблоны/предпросмотр/планировщик первого обращения ещё не реализованы; идентичность заявки OPEN |
| E05 | BLOCKED для реального API | Пользователь: провайдер не выбран |
| E06–E10 | NOT_STARTED | По зависимостям плана; отдельные live gates блокированы |
| E11–E13 | NOT_STARTED | Unit-тесты не релизная приёмка |

Проверки текущего запуска:
- Исходный typecheck PASS; npm test до новых модулей:36 PASS/12 SKIP/0 FAIL.
- После нового модуля: npm test58 случаев,46 PASS/12 SKIP/0 FAIL. Новые10 синтетических проверок пройдены.
- SKIP12 — retention integration без отдельной БД. PostgreSQL16/реальные коннекторы/ИИ/live E2E — UNVERIFIED.
- Typecheck PASS. Production build PASS после разрешённого повтора: первый sandbox-run остановился на EPERM очистки generated dist.
- Независимое read-only ревью выявило скрытый trim ID; исправлено и добавлен тест, исключающий схлопывание разных ID.

Контрольный build после последней правки непрозрачных ID: PASS. Проверено наличие14 выбранных навыков и12 строк TZ; SHA256 прежних изменённых/untracked файлов совпадают с инвентаризацией. Никаких production-действий/реальных сообщений/данных. Коммит этого инкремента включает только новые документы и два channel-contracts файла; точный commit ID — git log.

## Продолжение: E02, 12 ноября 2026

Актуальные доказательства этого инкремента; предыдущие записи выше — история:
- Node24.21.0; PostgreSQL18.3; отдельные временные relayboard_ai_manager_test/attachment_retention_test; только синтетические данные.
- Полный npm test:81 PASS,0 FAIL,0 SKIP; из них23 новых DB-теста E02 и12 retention integration.
- Typecheck PASS; build PASS. Для release-артефакта используется NODE_ENV=production, а не development из тестового .env.example.
- Проверены конкурентные inbox/enqueue/dispatch, atomic rollback, stale generation, persistent opt-out двух каналов, echo/manual/unresolved, auth loss/restore, unknown/late ack и прерывание.
- Ревью выявило широкую async-send границу и несовместимость legacy DELETE. Исправлено: PreparedChannelSend.start с явной привязкой target и account/platform snapshot без FK на integrations. Проверены deferred preparation, stop между claim/start, другой получатель, legacy DELETE и повтор resume.
- Реальная граница send каждого адаптера остаётся release gate: диагностика AsyncFunction не доказывает свойства произвольного wrapper.
- Миграция PG16, live платформы/ИИ/приёмка всё ещё UNVERIFIED. Production startup и HTTP/UI не подключались. SHA256 прежних изменённых/untracked файлов совпадают с E00-инвентаризацией.

Подробности и оставшийся объём — domain-core.md. Этот инкремент фиксируется отдельно без прежних незакоммиченных файлов.

## Продолжение: E03, 12 ноября 2026

- Реализован UI/API импорта: CSV UTF-8 и XLSX, лист/столбцы, явный код страны для местного номера, проверка формата, номера строк и причины, подтверждение и список с пагинацией. Источник данных не становится инструкцией или командой автоматизации.
- Обе фикстуры из 10 строк: 6 новых, 2 дубля, 2 ошибки; импорт не создаёт outbox/deliveries. Проверены повтор, пять конкурентных подтверждений, два конкурентных импорта, rollback/retry, сохранение истории/metadata/opt-out, истечение TTL, квоты, авторизация и disabled flag.
- Новые проверки: 7 parser unit + 11 PostgreSQL/HTTP integration. Защита XLSX проверена на DTD/ENTITY, сжатом oversized payload, макросах, больших ссылках листов, формулах и повреждённых архивах.
- Полное рабочее дерево: 99 PASS, 0 FAIL, 0 SKIP. Команда: `DOTENV_CONFIG_PATH=<synthetic-env> AI_MANAGER_TEST_DATABASE_URL=<dedicated-db> RETENTION_TEST_DATABASE_URL=<dedicated-db> CONTACT_IMPORT_TEST_DATABASE_URL=<dedicated-db> npm test`. Первый прогон без обязательного test-env обнаружил ошибки конфигурации в трёх прежних тестовых файлах; повтор с синтетическим окружением прошёл.
- Точная подготовленная версия коммита выгружена через `git checkout-index` в отдельную временную папку: typecheck PASS, production build PASS, 67 PASS / 0 FAIL / 0 SKIP. Разница в количестве — прежние незакоммиченные тесты/модули не входят в этот коммит. После последней правки мобильных стилей typecheck и build повторены успешно.
- Браузер Playwright/Chrome: существующий вход администратора → Клиенты → загрузка CSV → выбор четырёх столбцов → предпросмотр 6/2/2 → подтверждение → База контактов(6). Прямая проверка временной БД: contacts=6, ai_outbox=0, deliveries=0. Единственная ошибка консоли — ожидаемый 401 `/api/auth/session` до входа. Отдельная production-сборка коммита также открыта в браузере.
- Синтетические БД PostgreSQL18.3 и отдельный Redis; ни production, ни настоящие контакты/аккаунты не использовались. Флаг `CONTACT_IMPORT_ENABLED` по умолчанию false, миграция запускается отдельно. PostgreSQL16 и RAM/нагрузка на целевом сервере остаются UNVERIFIED.
- Прежние изменённые файлы сверены с SHA256 baseline; для пяти файлов интеграции проверено восстановление исходного содержимого после исключения собственных добавлений. Чужие изменения сохранены. В индекс включён только собственный инкремент; API/App/config/env/package подготовлены отдельными изменениями относительно HEAD.
- Новая зависимость ExcelJS: уязвимый вложенный uuid заменён на11.1.1; тесты XLSX повторены. Оставшиеся25 замечаний npm audit относятся к узлам, уже присутствующим в исходном lockfile. Общая санация зависимостей перед выпуском остаётся отдельной задачей; подробности — contact-import.md.

Следующий независимый этап — E04: сохранение шаблонов и конфигурации первого обращения, предпросмотр и управление запуском в синтетическом режиме. Выбор реального ИИ и live-подключения этим этапом не подменяется.
