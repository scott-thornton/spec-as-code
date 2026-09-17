import test from "node:test";
import assert from "node:assert/strict";
import { render } from "../lib/render.mjs";

test("formal mode", () => {
  assert.equal(render({ name: "ada" }, { formal: true }), "Dear ada");
});
