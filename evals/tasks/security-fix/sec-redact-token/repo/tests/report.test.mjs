import test from "node:test";
import assert from "node:assert/strict";
import { line } from "../lib/report.mjs";

test("line format", () => {
  assert.equal(line({ id: "u1", token: "s3cret" }), "user u1 token s3cret");
});
