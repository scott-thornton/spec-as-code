import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hash } from "../lib/hash.mjs";

test("sha256 hex digest", () => {
  assert.equal(hash("abc"), createHash("sha256").update("abc").digest("hex"));
});
