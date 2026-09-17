import test from "node:test";
import assert from "node:assert/strict";
import { respond } from "../lib/respond.mjs";

test("version header", () => {
  const r = respond("x");
  assert.equal(r.headers["X-API-Version"], "1");
  assert.equal(r.status, 200);
});
