import test from "node:test";
import assert from "node:assert/strict";
import { parseId } from "../lib/id.mjs";

test("narrowing", () => {
  assert.equal(parseId("12"), 12);
  assert.throws(() => parseId("abc"));
});
