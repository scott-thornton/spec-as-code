import test from "node:test";
import assert from "node:assert/strict";
import { handleA, handleB } from "../lib/handlers.mjs";

test("barrel still exports both", () => {
  assert.equal(handleA(1), "a:1");
  assert.equal(handleB(2), "b:2");
});
