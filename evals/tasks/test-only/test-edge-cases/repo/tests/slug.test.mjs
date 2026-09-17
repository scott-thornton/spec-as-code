import test from "node:test";
import assert from "node:assert/strict";
import { slug } from "../lib/slug.mjs";

test("simple", () => {
  assert.equal(slug("Hello World"), "hello-world");
});
