# RES02/04 — проверенный промежуточный снимок, 14 ноября 2026

База: f7365b3, плюс изменения с SHA256 в source-manifest.json. Полный проект не готов к выпуску.

- tests.log: 289 PASS / 0 FAIL / 0 SKIP, изолированные PostgreSQL16.16 schemas, все9 dedicated DB URL, синтетические данные. Внешних моделей/мессенджеров нет.
- typecheck.log/build.log: exit0, production web/node сборка.
- whatsapp-prepared-smoke.mjs.log: фактический CDPSession в отдельном temporary Chrome profile, about:blank и синтетические WAWeb modules. Подготовка0send, exact receipt, no duplicate, ack0 unknown, смена self rejected.
- whatsapp-owner-smoke.mjs.log/max-owner-smoke.mjs.log: собранные процессы, authenticated internal HTTP, exclusive ownership, SIGKILL, unknown сохранён; аккаунты не подключаются, реальных сообщений нет.

Перед последовательным smoke один запуск был прерван очисткой dist параллельной сборкой; затем проверка повторена после её завершения. Старое ожидание MAX HTTP503 исправлено на проверку HTTP200/state unknown после нового preflight. Реальная MAX/WhatsApp, production release, коммерческий GigaChat, source monitor, полный media prepared transport и приёмка12/12 остаются открыты.
