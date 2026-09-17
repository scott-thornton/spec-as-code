import test from "node:test";
import assert from "node:assert/strict";
import { render } from "../lib/render.mjs";

test("old API preserved", () => {
  assert.equal(render({ name: "ada" }), "Hi ada");
});
