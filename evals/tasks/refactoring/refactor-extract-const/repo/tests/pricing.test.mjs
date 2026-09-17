import test from "node:test";
import assert from "node:assert/strict";
import { total } from "../lib/pricing.mjs";

test("total", () => {
  assert.equal(total([{}, {}, {}]), 80);
});
