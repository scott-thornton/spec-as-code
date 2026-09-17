import test from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../lib/config.mjs";

test("default and explicit retries", () => {
  assert.equal(normalize({ url: "u" }).retries, 3);
  assert.equal(normalize({ url: "u", retries: 7 }).retries, 7);
});
