import assert from "node:assert/strict";
import test from "node:test";
import { postInput, destinationInput, postDestinationsInput } from "./schemas.js";

test("destination accepts a one-character group name for either account", () => {
  for (const integrationId of ["b73f76fc-0b99-4bf7-8a69-9dc90838ecf0", "3a1e4585-580d-4ed7-853c-53a9b85d6282"]) {
    const input = { integrationId, externalId: "-5594765419", title: "1", kind: "group" };
    assert.equal(destinationInput.safeParse(input).success, true);
    assert.equal(destinationInput.safeParse({ ...input, title: "  " }).success, false);
  }
});

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

test("post accepts files without text", () => {
  const result = postInput.safeParse({
    text: "",
    mode: "now",
    destinationIds: ["b73f76fc-0b99-4bf7-8a69-9dc90838ecf0"],
    attachmentIds: ["c73f76fc-0b99-4bf7-8a69-9dc90838ecf0"],
  });
  assert.equal(result.success, true);
});

test("post rejects empty content", () => {
  const result = postInput.safeParse({
    text: "",
    mode: "now",
    destinationIds: ["b73f76fc-0b99-4bf7-8a69-9dc90838ecf0"],
  });
  assert.equal(result.success, false);
});

test("post validates delivery controls", () => {
  const result = postInput.safeParse({
    text: "Тест",
    mode: "now",
    destinationIds: ["b73f76fc-0b99-4bf7-8a69-9dc90838ecf0"],
    intervalSeconds: 0,
    maxAttempts: 11,
    retryDelaySeconds: 0,
  });
  assert.equal(result.success, false);
});

test("recurring post rejects malformed cron", () => {
  const result = postInput.safeParse({
    text: "Тест",
    mode: "recurring",
    cronPattern: "каждый день",
    destinationIds: ["b73f76fc-0b99-4bf7-8a69-9dc90838ecf0"],
  });
  assert.equal(result.success, false);
});

test("post rejects duplicate destinations and attachments", () => {
  const destinationId = "b73f76fc-0b99-4bf7-8a69-9dc90838ecf0";
  const attachmentId = "c73f76fc-0b99-4bf7-8a69-9dc90838ecf0";
  const result = postInput.safeParse({
    text: "Тест",
    mode: "now",
    destinationIds: [destinationId, destinationId],
    attachmentIds: [attachmentId, attachmentId],
  });
  assert.equal(result.success, false);
});

test("post destinations require unique recipients", () => {
  const destinationId = "b73f76fc-0b99-4bf7-8a69-9dc90838ecf0";
  assert.equal(postDestinationsInput.safeParse({ destinationIds: [destinationId] }).success, true);
  assert.equal(postDestinationsInput.safeParse({ destinationIds: [] }).success, false);
  assert.equal(postDestinationsInput.safeParse({ destinationIds: [destinationId, destinationId] }).success, false);
});
