import test from "node:test";
import assert from "node:assert/strict";
import { readPath } from "../lib/assets.mjs";

test("normal paths still work", () => {
  assert.equal(readPath("/tmp/a", "sub/x.txt"), "/tmp/a/sub/x.txt");
});
