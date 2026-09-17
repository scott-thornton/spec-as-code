import test from "node:test";
import assert from "node:assert/strict";
import { usd } from "../lib/money.mjs";

test("output preserved", () => {
  assert.equal(usd(1234.567), "$1,234.57");
});
