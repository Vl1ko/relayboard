# E00 — исходная версия, 12 ноября 2026

Статус READY_FOR_REVIEW для checkout, не бизнес-приёмка сервиса.

Репозиторий https://github.com/Vl1ko/relayboard; ветка codex/storage-foundation. Исходный HEAD aaddf26404ae939912247a6abd0ead7c1d95fb3b. Существующие незакоммиченные изменения API, worker, адаптеров, UI и хранения сохранены; инвентаризация — baseline-files.json. Это не полная резервная копия и не готовый релиз.

AGENTS.md в проверенных родительских каталогах и дереве проекта вне node_modules/outputs не найден. Node 24.21.0 / npm 11.19.0. Целевые Compose PostgreSQL16/Redis7; PostgreSQL16 в этом запуске не проверялся.

| Возможность | Подтверждение чтением кода |
|---|---|
| Администрирование, интеграции, публикации/расписания | src/api/server.ts; live-регрессия сейчас не выполнялась |
| Fanout/dispatch/последовательная очередь | src/worker/index.ts; это не обработка входящих клиентов |
| Unknown и WhatsApp receipts | delivery-policy.ts и whatsapp-bridge; не доказательство exactly-once платформы |
| Аккаунтные сессии | WhatsApp/Telegram bridges восстанавливают integrations |
| Контакты/квалификация UI | ContactsPreview/QualificationPreview в App.tsx: прототип, настройки не сохраняются |
| Входящие и native takeover | Не найдены; MessengerAdapter содержит только send, WhatsApp без message/message_create handlers |
| MAX inbound | Не реализован в обследованном коде; disableBulkSubscriptions и одно соединение на токен требуют PoC |
| Поиск заявок | Backend не найден в src/database/API. Пользователь: «сейчас ничего не ищет» — расхождение с предпосылкой ТЗ |
| Хранение 30 дней | Локальные attachment-retention/schema/docs; на production ещё не развёрнуто |

Проверены список src, API routes и search/поиск/щеб/lead/inbound/fromMe/message_create. Это аудит checkout, не доказательство отсутствия любого внешнего сервиса.

Пользователь подтвердил: ИИ не выбран; письменного поручения и разрешённого тестового списка нет. Только синтетические данные. Demo «от 5 тонн»/регионы UI не являются критериями клиента.

Текущие проверки — progress.md. Исторические 48/48 на PostgreSQL18.3 не выдаются за сегодняшнюю проверку PostgreSQL16. Production не менялся, текущие ресурсы VPS не измерялись; прежние 15GiB/2GiB — исторический снимок. Дата старта договора не определялась.
