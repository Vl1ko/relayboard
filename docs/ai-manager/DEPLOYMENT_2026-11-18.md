# Production deployment — 2026-11-18 (MSK)

Published runtime: `392e6025e6345d68465f33d7e2d7de5ab5c746b1`.
Public URL: https://000vsm.ru
Server release directory: `/opt/relayboard/releases/20261117-392e602`.
Image: `relayboard:release-392e602`, ID `sha256:277f5dda6529322c36cf387aa91cd9a0f08ae7594bb952abbb11c2724315ef32`.

## Delivered

The production API, publishing worker, WhatsApp bridge and Telegram bridge use the same verified Linux/amd64 image. This includes contact import outreach, per-source inherit/extend/replace criteria, contact notes/files, manager approval of rejected qualification, and unlimited selected source chats with fair bounded polling batches.

Existing production environment, encryption key, login credentials, accounts, publication data and named volumes were preserved. AI schema migrations 1–25 were applied. The pre-cutover business snapshot matched after migration; all 162 unknown deliveries retained their statuses and were not retried. No local test database or test account session was deployed.

## Verification

- Exact Linux image: 411 tests passed, no failures/skips; smoke and preflight checks passed.
- Actual production database migrated in an isolated rehearsal; existing data/ciphertext fingerprints matched.
- API healthy, preserved login works with secure cookie, protected routes reject unauthenticated access, new UI API routes respond.
- Public HTTPS returns 200 with verified TLS; current JavaScript loads and contains the unlimited-source UI.
- Four application containers use the expected image, are running and had zero restarts at final infrastructure check; PostgreSQL and Redis remained healthy.
- Chromium launches in the exact image. WhatsApp retained stale Singleton symlinks belonging to retired container `0f98a12da427`; six volatile symlinks were removed only after verifying no running container mounted the profile volume. Profile/auth data was preserved.
- Full encrypted off-server backup on the Mac includes database, configuration/old dirty source, Redis snapshot, uploads and both bridge profile volumes. Every file hash was verified after decrypting the archive; the database was restored successfully in isolation. Old working images are separately archived and retained on the server for rollback.
- Disposable deployment test containers and their tmpfs database copies were removed; temporary decrypted snapshot/restore directories were deleted. Encrypted backups remain in `data/backups/deploy-20261117-392e602` (ignored by Git).

## Remaining operational activation

Publication does not constitute full commercial AI acceptance. Production AI sending remains disabled, external model requests remain disabled and test-only defaults remain in place. No GigaChat key was present in the production environment; production AI requires provider setup and approved runtime configuration. Existing publishing mode was preserved.

WhatsApp account readiness is separate from container health: after restart, one stored account requested QR reauthentication; the other encountered an initialization timeout and is being recovered by the existing watchdog. No profile reset or speculative message retry was performed. Recheck account statuses in Connections before relying on WhatsApp deliveries; QR login requires the account owner's participation.

Approximately 2.4 GiB disk space remained at the final infrastructure check. The 2 GiB VPS has not been certified for maximum multi-account commercial load by this deployment.

Safe evidence is in `outputs/deploy-392e602-2026-11-17/`. The source revision remains 392e602; changes to the smoke harness and this report are deployment documentation, not an unbuilt runtime revision.

## GigaChat configuration follow-up — 2026-11-18

At the user's request, the existing local GigaChat authorization key and scope were transferred through SSH directly into the production `.env` (0600, atomic replacement; no secret value in tool output or Git). Provider mode is now `gigachat`, external model requests are enabled, and model `GigaChat-2-Pro` was selected as settings version 2 while preserving existing business fields/rules. The image's pinned CA is configured through `NODE_EXTRA_CA_CERTS`; TLS verification remains enabled. The API was recreated with the new environment and the public HTTPS site still returns 200.

Production OAuth accepted the key and the models endpoint confirmed `GigaChat-2-Pro` is available. No completion was requested, no conversation was sent, and no messenger message was sent by this check. Scope is `GIGACHAT_API_PERS`, matching the local test configuration. This is not a transition to commercial access. AI sending remains `disabled`; source monitoring and additional AI/MAX worker activation were not changed. The earlier pre-configuration status above describes the original deployment check.
