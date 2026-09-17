import test from "node:test";
import assert from "node:assert/strict";
import { sum } from "../lib/math.mjs";

test("sum", () => {
  assert.equal(sum(2, 3), 5);
});
