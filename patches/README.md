# MAX binary transport

`@ounezz+umax+1.0.8.patch` switches UMax to `wss://api.oneme.ru/websocket`.
The dependency is pinned because the patch replaces its private transport.
`postinstall` applies the patch with `--error-on-fail`; both Docker stages copy
this directory before installing dependencies.

The transport uses the version 10 binary header, MessagePack ID extension 1,
bounded raw LZ4 decompression for every nonzero compression flag, and integer
timestamps. It normalizes maps and IDs to UMax's existing object API, keeping
integers outside JavaScript's safe range as decimal strings. Request sequences
wrap at 16 bits, and invalid responses reject pending requests instead of
silently becoming a successful null response.

Regression coverage: `src/core/max-binary-transport.test.ts`. Read-only live
verification: `node scripts/check-max-connection.mjs` with a token on stdin, or
`--stored-account` in the configured application container. `--keepalive` also
waits across one automatic keepalive interval. Run this before starting the
MAX owner: a second login with the same token can displace an active session.
The probe never sends messages or prints credentials/chat contents.

Protocol reference: https://github.com/Fugguri/max-messenger-client/blob/main/maxmessenger/codec.py
The implementation was checked against actual server HELLO, LOGIN, chat info,
history and keepalive responses, not just the reference.
