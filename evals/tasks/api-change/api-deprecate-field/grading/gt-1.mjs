import test from "node:test";
import assert from "node:assert/strict";
import { summary } from "../lib/summary.mjs";

test("both fields", () => {
  const s = summary({ name: "ada" });
  assert.equal(s.displayName, "ADA");
  assert.equal(s.name, "ada");
});
