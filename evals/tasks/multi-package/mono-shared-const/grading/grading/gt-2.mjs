import test from "node:test";
import assert from "node:assert/strict";
import { aInfo } from "../packages/a/index.mjs";
import { bInfo } from "../packages/b/index.mjs";

test("both consume shared", () => {
  assert.equal(aInfo(), "a:1");
  assert.equal(bInfo(), "b:1");
});
