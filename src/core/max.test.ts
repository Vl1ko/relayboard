import assert from "node:assert/strict";
import test from "node:test";
import { isMaxTransportError } from "./adapters/max.js";

test("expired MAX endpoint certificate is a transport error, not a token error", () => {
  const error = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
  assert.equal(isMaxTransportError(error), true);
});

test("invalid MAX token is still treated as an authorization error", () => {
  assert.equal(isMaxTransportError(new Error("Invalid token")), false);
});
