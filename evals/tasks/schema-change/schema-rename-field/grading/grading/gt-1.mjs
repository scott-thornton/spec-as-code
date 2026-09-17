import test from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../lib/config.mjs";

test("endpoint preferred, url alias", () => {
  assert.equal(normalize({ endpoint: "e" }).endpoint, "e");
  assert.equal(normalize({ url: "u" }).endpoint, "u");
});
