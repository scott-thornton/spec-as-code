import test from "node:test";
import assert from "node:assert/strict";
import { formatDate } from "../lib/format.mjs";

test("ISO output", () => {
  assert.equal(formatDate(new Date("2026-01-05")), "2026-01-05");
});
