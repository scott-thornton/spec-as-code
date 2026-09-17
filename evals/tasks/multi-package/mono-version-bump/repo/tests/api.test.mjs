import test from "node:test";
import assert from "node:assert/strict";
import { apiName as a } from "../packages/a/index.mjs";
import { apiName as b } from "../packages/b/index.mjs";

test("api names", () => {
  assert.equal(a(), "api-v1");
  assert.equal(b(), "api-v1");
});
