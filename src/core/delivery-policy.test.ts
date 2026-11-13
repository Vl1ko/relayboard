import assert from "node:assert/strict";
import test from "node:test";
import { classifyDeliveryError, deliveryErrorMessage, DeliveryError } from "./delivery-policy.js";

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

test("MAX token rejection pauses the account, including localized protocol errors", () => {
  assert.equal(classifyDeliveryError(Object.assign(new Error("Ошибка входа. Пожалуйста, авторизируйтесь снова"), {payload:{error:"login.token"}})), "auth_required");
  assert.equal(classifyDeliveryError(new Error("FAIL_LOGIN_TOKEN")), "auth_required");
});

test("a timeout before sending is safe to defer, a send timeout remains ambiguous", () => {
  assert.equal(classifyDeliveryError(new DeliveryError("connection timeout", "waiting")), "waiting");
  assert.equal(classifyDeliveryError(new Error("Delivery timeout after 60000ms; outcome unknown")), "ambiguous");
});
