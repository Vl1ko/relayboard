# RES09 partial — dependency remediation, 2026-11-14

Before:17 npm findings (11 high /6 moderate). After:0 known npm audit vulnerabilities; this is not a complete security certification.

Candidate installation in a separate temporary project used only official npm packages and --ignore-scripts. Source files src/web/database/scripts were byte-compared with baseline7b57aaf before manifest/lock transfer: no differences. Node24.21.0 matches the Docker Node24 runtime. Candidate:333 PASS /0 FAIL /0 SKIP, typecheck/build PASS, four compiled process/Chrome smokes PASS, CJS SDK and zip/glob round-trip PASS. Tests and audit/SBOM/enrichment/license metadata are included. Root npm ci --ignore-scripts reproduced the lockfile without downloading browser binaries or running package hooks.

A real user-owned WhatsApp login/conversation and Linux Chromium acceptance remain required before release; the isolated Chrome fixture does not prove compatibility with the live WhatsApp website. Real profiles and production were not used. Legal distribution review of node-webpmux LGPL and missing buffers license remains open. Exact scope, policy classification, assumptions and rollback are documented in docs/ai-manager/dependency-review-2026-11-14.md.
