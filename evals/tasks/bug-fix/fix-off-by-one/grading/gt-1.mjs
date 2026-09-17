import test from "node:test";
import assert from "node:assert/strict";
import { range } from "../lib/range.mjs";

test("range contents", () => {
  assert.deepEqual(range(3), [0, 1, 2]);
});
