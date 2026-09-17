import test from "node:test";
import assert from "node:assert/strict";
import { slug } from "../lib/slug.mjs";

test("behaviour unchanged", () => {
  assert.equal(slug("Hello World"), "hello-world");
});
