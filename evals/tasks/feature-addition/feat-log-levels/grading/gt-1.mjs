import test from "node:test";
import assert from "node:assert/strict";
import { log } from "../lib/logger.mjs";

test("plain logging still works", () => {
  assert.doesNotThrow(() => log("x"));
});
