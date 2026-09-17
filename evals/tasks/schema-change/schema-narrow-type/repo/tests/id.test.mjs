import test from "node:test";
import assert from "node:assert/strict";
import { parseId } from "../lib/id.mjs";

test("numeric ids", () => {
  assert.equal(parseId("12"), 12);
  assert.equal(parseId(7), 7);
});
