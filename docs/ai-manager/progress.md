# Прогресс, 12 ноября 2026

Единственный актуальный реестр; план — execution-plan.md; решения — open-decisions.md. Человеческая приёмка не назначается автоматически.

| Этап | Статус | Доказательство / остаток |
|---|---|---|
| E00 | READY_FOR_REVIEW для checkout | baseline.md, baseline-files.json, requirements.md:12/12 TZ; поиск/внешняя исходная версия не подтверждены |
| E01-C | IN_PROGRESS | schema/origin/key/send-outcome и10 синтетических тестов; live BLOCKED O-03/O-04 |
| E01-S | BLOCKED | Нет работающего поиска: нужно решение о модуле/новом объёме |
| E02 | IN_PROGRESS; offline-ядро READY_FOR_REVIEW | ai-manager.sql/store/migration: inbox/outbox, contact opt-out, mode/epoch, подготовленный транспорт и23 DB-теста. Полный workflow9 статусов/API и O-06 ещё не закрыты |
| E03/E04 | NOT_STARTED | Независимые fixtures можно готовить; страна/заявка не выбираются молча |
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
