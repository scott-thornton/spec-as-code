import test from "node:test";
import assert from "node:assert/strict";
import { summary } from "../lib/summary.mjs";

test("summary has name", () => {
  assert.deepEqual(summary({ name: "ada" }), { name: "ada" });
});
