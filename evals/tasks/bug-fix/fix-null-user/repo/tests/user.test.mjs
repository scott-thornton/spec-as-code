import test from "node:test";
import assert from "node:assert/strict";
import { displayName } from "../lib/user.mjs";

test("null user returns anonymous", () => {
  assert.equal(displayName(null), "anonymous");
});
