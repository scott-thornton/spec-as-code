import test from "node:test";
import assert from "node:assert/strict";
import { link } from "../lib/link.mjs";

test("encoding handled", () => {
  assert.equal(link({ q: "a b" }), "https://example.test/?q=a+b");
  assert.equal(link({ a: 1, b: 2 }), "https://example.test/?a=1&b=2");
});
