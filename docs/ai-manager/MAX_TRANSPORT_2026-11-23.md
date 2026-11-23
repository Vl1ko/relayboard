# MAX connection recovery — 2026-11-23 (MSK)

Production: https://000vsm.ru, existing VPS and Compose project `/opt/relayboard`.

## Cause

The running MAX image `relayboard:max-timeout-20261119` still contained the
original JSON transport to `wss://ws-api.oneme.ru/websocket`. A bounded probe
from that server timed out before completing its handshake. The local binary
transport changes had not been deployed.

`wss://api.oneme.ru/websocket` accepted HELLO and the existing account token.
However, the unfinished local patch silently replaced undecodable responses
with null: the actual login response used compression flag 3 and raw LZ4.
The JSON-to-binary conversion also needed MessagePack extension 1 IDs and
integer timestamps. Encoding history `from: Date.now()` as float64 produced
an opcode 49 validation error; encoding it as int64 restored history reads.

Normal queue recovery also exposed explicit opcode 64 rejections:
`chat.denied` (destination permissions) and `too.many.requests` (a burst of
overdue publications). The publication adapter discarded both errors and
recorded them as unknown outcomes. Connection health alone missed this issue.

## Repair

- Completed the UMax 1.0.8 binary transport in the versioned dependency patch:
  LZ4 for every nonzero compression flag, extension IDs, participant map keys,
  precision-preserving integers, integer request timestamps, and strict framing.
- Decode failures now fail pending work explicitly. Requests match both sequence
  and opcode; the 16-bit sequence wraps without colliding with pending work.
  Handshakes are bounded, cancellation retains error handling, and synchronous
  write failures clear pending requests.
- Pinned UMax, enabled failing installation on patch errors, and copied patches
  into both Docker build stages. Added regression tests and a read-only probe.
- Preserve correlated denials through the owner RPC: `chat.denied` now reports
  a permanent permission error; `too.many.requests` keeps the job waiting and
  applies a 60-second account cooldown. Publications share a minimum three-second
  interval across posts on an account. This short wait holds no database lock.
  Explicit rejection clears only its provisional receipt; uncertain network
  outcomes remain unknown without replay.
- Log only sanitized protocol error codes/opcodes, not tokens or chat contents.

The production images were updated using two small layers over the existing
deployed images, preserving their runtime fixes and private environment:

| Services | Image |
| --- | --- |
| MAX owner | `relayboard:max-binary-v2-20261123` |
| API, publication worker, AI worker | `relayboard:personal-max-binary-v2-20261123` |

Both images carry label `relayboard.max.transport=binary-publication-v2-20261123`. These are
transport/publication overlays, not a deployment of every source file at the current
repository HEAD. WhatsApp, Telegram, PostgreSQL, Redis, accounts, private
environment files and profile/upload volumes were preserved.

## Verification

- Typecheck and production build passed; 38 focused MAX tests passed with no
  failures/skips. All 21 protocol/publication/receipt tests also passed inside
  the final Linux production image. Applying the patch to clean upstream files reproduced
  byte-identical installed files; postinstall succeeded.
- Isolated VPS probe verified account identity, 100 chats / 57 groups, chat
  metadata, actual history and keepalive. It sent no messages.
- After deployment, the running API obtained 57 groups through the actual MAX
  owner RPC twice, including after one automatic keepalive interval. A separate
  login probe was not run against the live owner.
- Public HTTPS `/api/health` returned `ok:true`. Updated API and MAX containers
  were healthy; both workers were running.
- Normal queued publications resumed: confirmed MAX deliveries increased from
  7,492 before deployment to 7,534 at the first post-recovery observation.
- The final version was observed for 70 seconds through the real API/owner:
  confirmed publications increased from 7,714 to 7,735, with 57 groups still
  available. Unknown outcomes stayed at 1,025 throughout; ID-level comparison
  found zero new unknowns after the final update. All four updated application
  containers had zero restarts. This is a bounded recovery check, not a long
  capacity or service-level guarantee.
- All 800 originally unknown MAX deliveries remained unknown, checked by their
  individual IDs. No manual retry/reset of uncertain deliveries was performed.
  No test message or forced publication was sent.
  Additional unknowns recorded during the first queue recovery, before explicit
  rejection handling was corrected, were also preserved for manual review.
  They were not inferred safe to retry from the later error distribution or
  retrospectively reset.

Remote recovery files and image Dockerfile are in
`/opt/relayboard/fixes/max-binary-20261123`. That directory retains the previous
Compose override, previous image IDs, and the unknown-delivery verification.
The temporary private probe environment file was removed after verification.
For rollback, restore `compose-override-before.yml` as the project override and
recreate only API / MAX owner / publication worker / AI worker using the saved
images; do not reset delivery states or remove volumes.

Repair checks cover MAX connectivity and normal publication recovery. They do
not constitute a fresh end-to-end acceptance of every AI/WhatsApp workflow.
