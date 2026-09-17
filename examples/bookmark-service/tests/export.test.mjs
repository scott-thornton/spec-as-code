import test from "node:test";
import assert from "node:assert/strict";
import { exportJson } from "../src/export.mjs";

test("exportJson returns the list as JSON with no arguments", () => {
  const out = exportJson();
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
});

test("exportJson output round-trips through JSON.parse", () => {
  assert.doesNotThrow(() => JSON.parse(exportJson()));
});
