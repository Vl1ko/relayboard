import assert from "node:assert/strict";
import test from "node:test";
import { classifyDeliveryError, deliveryErrorMessage } from "./delivery-policy.js";

test("permanent authorization errors are not retried", () => {
  assert.equal(classifyDeliveryError(new Error("Telegram не подключён")), "permanent");
  assert.equal(classifyDeliveryError(new Error("403 Forbidden")), "permanent");
});

test("ambiguous transport outcome requires manual decision", () => {
  assert.equal(classifyDeliveryError(new Error("socket hang up after timeout")), "ambiguous");
});

test("other service errors are transient", () => {
  assert.equal(classifyDeliveryError(new Error("HTTP 429")), "transient");
});

test("stored error is bounded", () => {
  assert.equal(deliveryErrorMessage(new Error("x".repeat(3000))).length, 2000);
});
