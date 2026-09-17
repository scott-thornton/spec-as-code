import test from "node:test";
import assert from "node:assert/strict";
import { addBookmark, listBookmarks } from "../src/index.mjs";

test("addBookmark returns the stored bookmark", () => {
  const b = addBookmark("https://example.com", "Example");
  assert.equal(b.url, "https://example.com");
  assert.equal(b.title, "Example");
  assert.ok(b.addedAt);
});

test("listBookmarks returns copies — mutating them does not affect the store", () => {
  addBookmark("https://copy.test", "Copy");
  const first = listBookmarks()[0];
  const originalTitle = first.title;
  first.title = "mutated";
  assert.equal(listBookmarks()[0].title, originalTitle);
});
