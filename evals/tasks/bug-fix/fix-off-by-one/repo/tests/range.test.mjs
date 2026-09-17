import test from "node:test";
import assert from "node:assert/strict";
import { range } from "../lib/range.mjs";

test("range has n elements", () => {
  assert.equal(range(3).length, 3);
});
