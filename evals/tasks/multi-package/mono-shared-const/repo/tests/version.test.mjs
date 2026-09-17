import test from "node:test";
import assert from "node:assert/strict";
import { VERSION as va, aInfo } from "../packages/a/index.mjs";
import { VERSION as vb, bInfo } from "../packages/b/index.mjs";

test("versions agree", () => {
  assert.equal(va, vb);
  assert.equal(aInfo(), "a:1");
  assert.equal(bInfo(), "b:1");
});
