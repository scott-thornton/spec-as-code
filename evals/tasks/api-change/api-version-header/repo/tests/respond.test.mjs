import test from "node:test";
import assert from "node:assert/strict";
import { respond } from "../lib/respond.mjs";

test("respond shape", () => {
  assert.deepEqual(respond("x"), { status: 200, body: "x" });
});
