import test from "node:test";
import assert from "node:assert/strict";
import { calc } from "../lib/calc.mjs";

test("safe evaluator", () => {
  assert.equal(calc("2+3*4"), 14);
  assert.equal(calc("(2+3)*2"), 10);
  assert.equal(calc("10 / 4"), 2.5);
  assert.throws(() => calc("process.exit(1)"));
});
