import test from "node:test";
import assert from "node:assert/strict";
import { max } from "../lib/math.mjs";

test("max", () => {
  assert.equal(max(2, 7), 7);
  assert.equal(max(9, 2), 9);
});
