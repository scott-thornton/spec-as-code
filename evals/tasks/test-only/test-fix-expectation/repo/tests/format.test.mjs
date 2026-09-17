import test from "node:test";
import assert from "node:assert/strict";
import { formatDate } from "../lib/format.mjs";

test("date format", () => {
  assert.equal(formatDate(new Date("2026-12-31")), "12/31/2026");
});
