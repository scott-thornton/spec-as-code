import test from "node:test";
import assert from "node:assert/strict";
import { readPath } from "../lib/assets.mjs";

test("traversal rejected", () => {
  assert.equal(readPath("/tmp/a", "../etc/passwd"), null);
});
