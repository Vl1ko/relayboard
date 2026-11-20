# RES09 partial — text retention, 2026-11-14

333 PASS /0 FAIL /0 SKIP on isolated PostgreSQL16.16. Typecheck/production build and four compiled smokes PASS; logs included. Tests cover exact TTL boundary, all customer text/quote/snapshot copies, retained confirmed receipts/dedup, unknown notification/delivery and manager hold, active new request on the same channel,20 cleanup workers, concurrent policy revisions, rollback, rejected/pending leads and authenticated API.

Browser fixture (fake data, no model/connectors) saved policy30→45, refreshed assessment, then saved30. storage-ui.jpg shows the resulting interface. Fixture shut down with its own schema/Redis/temp cleanup. Existing local MAX backend/DB and production were not migrated or cleaned. Build updated the shared dist-web assets.

The dependency audit is an open finding, not a passing security review:17 vulnerabilities (11 high,6 moderate). No dependency changes in this increment. Resource/load, log/cache limits, external backup/restore and live acceptance remain open.
