import test from "node:test";
import assert from "node:assert/strict";
import { median } from "../lib/stats.mjs";

test("median behaviour unchanged", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});
