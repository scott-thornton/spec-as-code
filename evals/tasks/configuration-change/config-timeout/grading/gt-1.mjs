import test from "node:test";
import assert from "node:assert/strict";
import { TIMEOUT_MS } from "../lib/client.mjs";

test("default timeout", () => {
  assert.equal(TIMEOUT_MS, 5000);
});
