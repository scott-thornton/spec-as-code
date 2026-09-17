import test from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../lib/config.mjs";

test("url kept", () => {
  assert.deepEqual(normalize({ url: "u" }), { url: "u", retries: 3 });
});
