import assert from "node:assert/strict";
import test from "node:test";
import { sentMessageId } from "./whatsapp-receipt.js";
import { classifyDeliveryError } from "./delivery-policy.js";

test("only a real returned WhatsApp identifier with server ack confirms a send", () => {
  assert.equal(sentMessageId({ id: { _serialized: "true_123@c.us_ABC" }, ack:1 }), "true_123@c.us_ABC");
  assert.equal(sentMessageId({ id: { $1: "legacy-ID" }, ack:2 }), "legacy-ID");
  for (const result of [{id:{_serialized:"local-only"},ack:0},{id:{_serialized:"local-only"}},{id:{_serialized:"failed"},ack:-1},undefined, {}, { id: {} }, { id: { _serialized: "" } }, { id: { _serialized: 42 } }]) {
    assert.throws(() => sentMessageId(result), error => classifyDeliveryError(error) === "ambiguous");
  }
});
