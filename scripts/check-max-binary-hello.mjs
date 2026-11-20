// Tests transport only. No login, account access, or messages.
// Frame layout: https://github.com/Fugguri/max-messenger-client/blob/main/PROTOCOL.md
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { pack, unpackMultiple } from 'msgpackr';

const { Ws } = await import(process.cwd() + '/node_modules/@ounezz/umax/dist/ws/index.js');
const payload = pack({ deviceId: randomUUID(), userAgent: Ws.user_agent });
const header = Buffer.alloc(10);
header[0] = 10;
header.writeUInt16BE(1, 2);
header.writeUInt16BE(6, 4);
header.writeUIntBE(payload.length, 7, 3);

const socket = new WebSocket('wss://api.oneme.ru/websocket', {
  origin: 'https://web.max.ru',
  handshakeTimeout: 6000,
  maxPayload: 1024 * 1024,
});
const timeout = AbortSignal.timeout(10000);
try {
  await once(socket, 'open', { signal: timeout });
  const response = Promise.race([
    once(socket, 'message', { signal: timeout }),
    once(socket, 'close', { signal: timeout }).then(([code]) => {
      throw new Error('Server closed WebSocket before HELLO response: ' + code);
    }),
  ]);
  socket.send(Buffer.concat([header, payload]));
  const [frame, binary] = await response;
  if (!binary || frame.length < 10 || frame[0] !== 10 ||
      frame.readUInt16BE(2) !== 1 || frame.readUInt16BE(4) !== 6 ||
      frame.readUIntBE(7, 3) !== frame.length - 10) {
    throw new Error('Unexpected HELLO reply frame');
  }
  const body = unpackMultiple(frame.subarray(10)).at(-1);
  const accepted = frame[1] === 1 && body && typeof body === 'object' && !body.error;
  console.log(JSON.stringify({ websocket: 'open', binary, opcode: 6, accepted: !!accepted }));
  if (!accepted) process.exitCode = 1;
} finally {
  socket.terminate();
}
