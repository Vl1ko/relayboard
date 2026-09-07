import assert from "node:assert/strict";
import test from "node:test";
import { postInput } from "./schemas.js";

test("scheduled post requires a date", () => {
  const result = postInput.safeParse({
    text: "Тест",
    mode: "scheduled",
    destinationIds: ["b73f76fc-0b99-4bf7-8a69-9dc90838ecf0"],
  });
  assert.equal(result.success, false);
});

test("recurring post accepts cron and timezone", () => {
  const result = postInput.safeParse({
    text: "Тест",
    mode: "recurring",
    cronPattern: "0 9 * * 1-5",
    timezone: "Europe/Moscow",
    destinationIds: ["b73f76fc-0b99-4bf7-8a69-9dc90838ecf0"],
  });
  assert.equal(result.success, true);
});
