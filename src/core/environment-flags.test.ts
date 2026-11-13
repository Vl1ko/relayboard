import test from "node:test";
import assert from "node:assert/strict";
import { environmentBoolean } from "./environment-flags.js";
test("explicit false does not enable cookies or external requests", () => {
  assert.equal(environmentBoolean.parse("false"), false);
  assert.equal(environmentBoolean.parse("true"), true);
  assert.equal(environmentBoolean.parse(undefined), false);
  for (const bad of ["0", "1", "yes", "FALSE", ""])
    assert.throws(() => environmentBoolean.parse(bad));
});
