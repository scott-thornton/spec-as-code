import test from "node:test";
import assert from "node:assert/strict";
import { greetNamed } from "../lib/greet.mjs";

test("named greeting", () => {
  assert.equal(greetNamed("ada"), "hello, ada");
});
