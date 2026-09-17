import test from "node:test";
import assert from "node:assert/strict";
import { render } from "../lib/render.mjs";

test("informal greeting", () => {
  assert.equal(render({ name: "ada" }), "Hi ada");
});
