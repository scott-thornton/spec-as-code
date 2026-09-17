import test from "node:test";
import assert from "node:assert/strict";
import { line } from "../lib/report.mjs";

test("token redacted", () => {
  const out = line({ id: "u1", token: "s3cret-value" });
  assert.ok(out.includes("[REDACTED]"));
  assert.ok(!out.includes("s3cret-value"));
});
