# RES07 — synthetic follow-up acceptance, 2026-11-14

PostgreSQL16.16 isolated schemas, fake provider/transport and a separate local browser fixture. No real MAX/WhatsApp sessions, messages, model requests or production changes.

Typecheck and production build PASS. Four compiled smoke checks PASS: AI owner SIGKILL recovery, MAX owner, WhatsApp owner and real isolated Chrome prepared text boundary. Logs alongside this file. Full tests are recorded in tests.log.

Browser: admin login to isolated localhost fixture → Dialogues → synthetic stage client → mark first stage started with note → inspect history → settings → rename first stage → save → refresh. Card and history display the persisted name and mark. Screenshot stages-ui.jpg. A later presentation-only adjustment refreshes the card automatically when a rule is saved and accurately distinguishes disabled-rule notice.

Database migration18; see docs/ai-manager/automatic-followups.md for semantics and remaining live acceptance. Normal build also updates the shared dist-web directory served by the older local test backend. That backend, its real test database, sessions and qualified manager hold were not restarted or migrated. The isolated fixture shut down and removed its own schema, Redis and temporary directory.
