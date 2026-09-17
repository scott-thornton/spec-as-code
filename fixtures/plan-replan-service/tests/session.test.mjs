import test from "node:test";
import assert from "node:assert/strict";
import { sessionPrefix } from "../packages/security/session.mjs";

test("session tokens are prefixed with sess_", () => {
  assert.equal(sessionPrefix(), "sess_");
});
