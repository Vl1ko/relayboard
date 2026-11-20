import assert from "node:assert/strict";
import test from "node:test";
import {
  channelMessageKey, channelMessageSchema, channelSendOutcomeSchema,
  messageDisposition, permitsAutomaticRetry, resolveMessageOrigin,
} from "./channel-contracts.js";

const base = {
  version: 1, platform: "max", accountId: "synthetic-account",
  conversationId: "synthetic-dialog", messageId: "synthetic-message",
  occurredAt: "2026-11-12T10:00:00Z", direction: "inbound", origin: "customer", text: "synthetic text",
};

for (const platform of ["max", "whatsapp"]) {
  test(platform + ": customer, service echo and human have distinct dispositions", () => {
    assert.equal(messageDisposition({ ...base, platform }), "process_customer");
    assert.equal(messageDisposition({ ...base, platform, direction: "outbound", origin: "service" }), "suppress_service_echo");
    assert.equal(messageDisposition({ ...base, platform, direction: "outbound", origin: "human" }), "takeover");
    assert.equal(messageDisposition({ ...base, platform, direction: "outbound", origin: "unresolved" }), "hold_for_review");
  });
  test(platform + ": replay/reconnect uses one transport identity regardless of receipt time/text", () => {
    const keys = Array.from({ length: 5 }, (_, n) => channelMessageKey({
      ...base, platform, text: "copy " + n, occurredAt: "2026-11-12T11:00:00Z", receivedAt: n,
    }));
    assert.equal(new Set(keys).size, 1);
  });
}

test("event identity isolates platform, account, conversation and message", () => {
  const events = [base, { ...base, platform: "whatsapp" }, { ...base, accountId: "other" },
    { ...base, conversationId: "other" }, { ...base, messageId: "other" }];
  assert.equal(new Set(events.map(channelMessageKey)).size, 5);
  assert.notEqual(channelMessageKey({ ...base, accountId: "a:b", conversationId: "c" }),
    channelMessageKey({ ...base, accountId: "a", conversationId: "b:c" }));
});

test("opaque external IDs are never silently trimmed into a different identity", () => {
  assert.notEqual(channelMessageKey(base), channelMessageKey({ ...base, messageId: " " + base.messageId + " " }));
  assert.equal(channelMessageSchema.parse({ ...base, messageId: " id " }).messageId, " id ");
  assert.equal(channelMessageSchema.safeParse({ ...base, messageId: "   " }).success, false);
});

test("own-message flag without verified provenance never becomes a customer or human event", () => {
  assert.equal(resolveMessageOrigin("outbound", "unresolved"), "unresolved");
  assert.equal(resolveMessageOrigin("outbound", "remote_sender"), "unresolved");
  assert.equal(resolveMessageOrigin("inbound", "service_receipt"), "unresolved");
  assert.equal(resolveMessageOrigin("inbound", "native_human"), "unresolved");
  assert.equal(resolveMessageOrigin("inbound", "remote_sender"), "customer");
  assert.equal(resolveMessageOrigin("outbound", "service_receipt"), "service");
  assert.equal(resolveMessageOrigin("outbound", "native_human"), "human");
});

test("contradictory provenance, missing IDs and unsupported major versions are rejected", () => {
  for (const event of [{ ...base, direction: "outbound" }, { ...base, origin: "service" },
    { ...base, origin: "human" }, { ...base, accountId: "" }, { ...base, messageId: "" },
    { ...base, version: 2 }, { ...base, occurredAt: "not-a-date" }]) {
    assert.equal(channelMessageSchema.safeParse(event).success, false);
  }
  assert.equal(channelMessageSchema.safeParse({ ...base, futureMetadata: true }).success, true);
});

test("confirmed and unknown outcomes can never authorize an automatic resend", () => {
  assert.equal(permitsAutomaticRetry({ operationId: "op", code: "sent", outcome: "confirmed", externalMessageId: "external", retryCondition: "never" }), false);
  assert.equal(permitsAutomaticRetry({ operationId: "op", code: "transport_timeout", outcome: "unknown", retryCondition: "reconcile_or_manual_review" }), false);
  assert.equal(channelSendOutcomeSchema.safeParse({ operationId: "op", code: "timeout", outcome: "unknown", retryCondition: "after_delay" }).success, false);
});

test("only rejected-before-dispatch outcomes may permit retry after rechecking business guards", () => {
  for (const code of ["auth_required", "future_provider_error"]) {
    assert.equal(permitsAutomaticRetry({ operationId: "op", code, outcome: "rejected", dispatchState: "not_started", retryCondition: "refresh_auth" }), true);
  }
  assert.equal(channelSendOutcomeSchema.safeParse({ operationId: "op", code: "transport", outcome: "rejected", retryCondition: "after_delay" }).success, false);
  assert.equal(permitsAutomaticRetry({ operationId: "op", code: "forbidden", outcome: "rejected", dispatchState: "not_started", retryCondition: "never" }), false);
});
