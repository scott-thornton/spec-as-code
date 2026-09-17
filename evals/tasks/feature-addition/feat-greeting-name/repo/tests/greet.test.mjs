import test from "node:test";
import assert from "node:assert/strict";
import { greet } from "../lib/greet.mjs";

test("anonymous greeting", () => {
  assert.equal(greet(), "hello");
});
