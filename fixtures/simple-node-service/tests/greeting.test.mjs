import test from "node:test";
import assert from "node:assert/strict";
import { greeting } from "../src/greeting.mjs";

test("greeting returns hello", () => {
  assert.equal(greeting(), "hello");
});
