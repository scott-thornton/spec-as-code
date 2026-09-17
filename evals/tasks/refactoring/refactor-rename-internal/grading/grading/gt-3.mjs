import test from "node:test";
import assert from "node:assert/strict";
import { doubleInternal, halveInternal } from "../lib/util.mjs";

test("aliases preserved", () => {
  assert.equal(doubleInternal(4), 8);
  assert.equal(halveInternal(4), 2);
});
