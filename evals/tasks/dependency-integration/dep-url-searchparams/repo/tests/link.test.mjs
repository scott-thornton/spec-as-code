import test from "node:test";
import assert from "node:assert/strict";
import { link } from "../lib/link.mjs";

test("link", () => {
  assert.equal(link({ a: 1 }), "https://example.test/?a=1");
});
