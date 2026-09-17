import test from "node:test";
import assert from "node:assert/strict";
import { calc } from "../lib/calc.mjs";

test("arithmetic", () => {
  assert.equal(calc("2+3*4"), 14);
});
