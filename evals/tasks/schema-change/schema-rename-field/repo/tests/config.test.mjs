import test from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../lib/config.mjs";

test("url still accepted", () => {
  assert.equal(normalize({ url: "u" }).url, "u");
});
