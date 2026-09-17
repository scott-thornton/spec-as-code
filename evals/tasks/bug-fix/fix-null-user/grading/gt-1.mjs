import test from "node:test";
import assert from "node:assert/strict";
import { displayName } from "../lib/user.mjs";

test("null handling with original export name", () => {
  assert.equal(displayName(null), "anonymous");
  assert.equal(displayName({ name: "ada" }), "ADA");
});
