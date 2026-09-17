import test from "node:test";
import assert from "node:assert/strict";
import { greet } from "../lib/greet.mjs";

test("anonymous greeting preserved", () => {
  assert.equal(greet(), "hello");
});
