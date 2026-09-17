import test from "node:test";
import assert from "node:assert/strict";
import { usd } from "../lib/money.mjs";

test("usd", () => {
  assert.equal(usd(5), "$5.00");
});
