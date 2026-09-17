import test from "node:test";
import assert from "node:assert/strict";
import { total } from "../lib/pricing.mjs";

test("behaviour preserved", () => {
  assert.equal(total([]), 5);
  assert.equal(total([{}]), 30);
});
