import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hash } from "../lib/hash.mjs";

test("digest matches sha256", () => {
  assert.equal(hash("spc"), createHash("sha256").update("spc").digest("hex"));
});
