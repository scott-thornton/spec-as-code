import test from "node:test";
import assert from "node:assert/strict";
import { greeting } from "../packages/app/index.mjs";

test("greeting", () => {
  assert.equal(greeting("hi"), "hi");
});
