import test from "node:test";
import assert from "node:assert/strict";
import { port } from "../lib/server.mjs";

test("env override and default", () => {
  process.env.PORT = "3000";
  assert.equal(port(), 3000);
  delete process.env.PORT;
  assert.equal(port(), 8080);
});
