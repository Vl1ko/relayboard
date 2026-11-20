// Read-only test of one named chat. Token is read from stdin, never printed.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import WebSocket from 'ws';
import { addExtension, pack, Unpackr } from 'msgpackr';

class MaxId {
  constructor(bytes) { this.bytes = Buffer.from(bytes); }
}
addExtension({ Class: MaxId, type: 1, pack: id => id.bytes, unpack: bytes => new MaxId(bytes) });

// Maximum decoded response size keeps the probe bounded.
function decodeLz4Block(source) {
  const output = Buffer.alloc(16 * 1024 * 1024);
  let read = 0;
  let written = 0;
  const size = initial => {
    let length = initial;
    if (length === 15) {
      let extra;
      do {
        if (read >= source.length) throw Error('truncated_lz4_length');
        extra = source[read++];
        length += extra;
      } while (extra === 255);
    }
    return length;
  };
  while (read < source.length) {
    const code = source[read++];
    const literals = size(code >> 4);
    if (read + literals > source.length || written + literals > output.length) throw Error('invalid_lz4_literals');
    output.set(source.subarray(read, read + literals), written);
    read += literals;
    written += literals;
    if (read === source.length) break;
    if (read + 2 > source.length) throw Error('truncated_lz4_offset');
    const offset = source.readUInt16LE(read);
    read += 2;
    const match = size(code & 15) + 4;
    if (!offset || offset > written || written + match > output.length) throw Error('invalid_lz4_match');
    for (let n = 0; n < match; n++, written++) output[written] = output[written - offset];
  }
  return output.subarray(0, written);
}

// MAX can use numeric and extension IDs as map keys.
const decoder = new Unpackr({ mapsAsObjects: false, structuredClone: false });
const get = (object, key) => object instanceof Map ? object.get(key) : object?.[key];

function decodeFrame(frame) {
  const bytes = frame.subarray(10);
  const payload = frame[6] === 3 ? decodeLz4Block(bytes) : bytes;
  return decoder.unpackMultiple(payload).at(-1);
}

const { Ws } = await import(process.cwd() + '/node_modules/@ounezz/umax/dist/ws/index.js');
const token = readFileSync(0, 'utf8').trim();
if (!token || /\s/.test(token)) throw new Error('Invalid token file format');

const socket = new WebSocket('wss://api.oneme.ru/websocket', {
  origin: 'https://web.max.ru', handshakeTimeout: 6000, maxPayload: 16 * 1024 * 1024,
});
const deadline = setTimeout(() => {
  console.log('probe_timeout');
  socket.terminate();
  process.exitCode = 1;
}, 26000);
let seq = 0;
let stage = 'connect';
async function request(op, data) {
  const id = ++seq;
  const payload = pack(data);
  const header = Buffer.alloc(10);
  header[0] = 10;
  header.writeUInt16BE(id, 2);
  header.writeUInt16BE(op, 4);
  header.writeUIntBE(payload.length, 7, 3);
  const frame = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('request_timeout')), 7500);
    function finish(error, value) {
      clearTimeout(timer);
      socket.off('message', receive);
      socket.off('close', closed);
      socket.off('error', failed);
      if (error) reject(error);
      else resolve(value);
    }
    function closed() { finish(Error('connection_closed')); }
    function failed() { finish(Error('socket_error')); }
    function receive(candidate, binary) {
      if (!binary || candidate.length < 10 || candidate[0] !== 10 ||
          candidate.readUInt16BE(2) !== id || candidate.readUInt16BE(4) !== op) return;
      finish(null, candidate);
    }
    socket.on('message', receive);
    socket.once('close', closed);
    socket.once('error', failed);
    try { socket.send(Buffer.concat([header, payload])); }
    catch { failed(); }
  });
  if (frame.readUIntBE(7, 3) !== frame.length - 10) throw Error('unexpected_length');
  let body;
  try { body = decodeFrame(frame); }
  catch (error) {
    console.log(JSON.stringify({ flags: frame[6], direction: frame[1],
      bytes: frame.length - 10, decodeErrorType: error.name }));
    throw Error('cannot_decode_payload');
  }
  if (frame[1] !== 1 || get(body, 'error')) throw Error('server_rejected');
  return body;
}
try {
  await once(socket, 'open', { signal: AbortSignal.timeout(7500) });
  stage = 'hello';
  await request(6, { deviceId: randomUUID(), userAgent: Ws.user_agent });
  stage = 'login';
  const login = await request(19, { token, interactive: true, chatsCount: 100 });
  const chats = get(login, 'chats');
  if (!get(get(get(login, 'profile'), 'contact'), 'id') || !Array.isArray(chats)) {
    throw Error('unexpected_login_reply');
  }
  const matches = chats.filter(chat => {
    const title = get(chat, 'title');
    return typeof title === 'string' && title.trim().toLowerCase() === 'тестовая';
  });
  console.log(JSON.stringify({ login: true, chats: chats.length, matchingTestChats: matches.length }));
  stage = 'history';
  if (matches.length !== 1 || get(matches[0], 'id') == null) throw Error('test_chat_not_unique');
  const history = await request(49, {
    chatId: get(matches[0], 'id'), from: Date.now(), backward: 1, forward: 0, getMessages: true,
  });
  const messages = get(history, 'messages');
  if (!Array.isArray(messages)) throw Error('unexpected_history_reply');
  console.log(JSON.stringify({ testChatHistory: true, messages: messages.length }));
} catch (error) {
  const allowed = new Set(['unexpected_length', 'cannot_decode_payload', 'server_rejected',
    'unexpected_login_reply', 'test_chat_not_unique', 'unexpected_history_reply',
    'request_timeout', 'connection_closed', 'socket_error']);
  console.log(JSON.stringify({ failedAt: stage, reason: allowed.has(error.message) ? error.message : error.name }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  socket.terminate();
}
