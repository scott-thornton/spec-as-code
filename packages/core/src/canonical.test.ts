import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalize, CANONICALIZATION_ERROR } from "./canonical.js";
import { digestOf } from "./hash.js";
import { isSpcError } from "./errors.js";

function expectSpcReject(fn: () => unknown): void {
  let thrown: unknown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeTruthy();
  expect(isSpcError(thrown)).toBe(true);
  if (isSpcError(thrown)) expect(thrown.code).toBe(CANONICALIZATION_ERROR);
}

describe("canonical serialization", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson({ list: ["b", "a", "c"] })).toBe('{"list":["b","a","c"]}');
  });

  it("omits undefined object properties", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("rejects NaN", () => {
    expectSpcReject(() => canonicalize({ x: Number.NaN }));
  });

  it("rejects Infinity", () => {
    expectSpcReject(() => canonicalize({ x: Number.POSITIVE_INFINITY }));
  });

  it("rejects bigint", () => {
    expectSpcReject(() => canonicalize({ x: 1n }));
  });

  it("rejects functions, symbols and Dates", () => {
    expectSpcReject(() => canonicalize({ x: () => 1 }));
    expectSpcReject(() => canonicalize({ x: Symbol("s") }));
    expectSpcReject(() => canonicalize({ x: new Date("2026-01-01") }));
  });

  it("rejects cycles", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expectSpcReject(() => canonicalize(a));
  });

  it("rejects undefined array items", () => {
    expectSpcReject(() => canonicalize([1, undefined]));
  });

  it("digests are stable across key order and omitted-undefined", () => {
    const a = { z: 1, y: [{ q: 2 }], w: undefined };
    const b = { y: [{ q: 2 }], z: 1 };
    expect(digestOf(a)).toBe(digestOf(b));
    expect(digestOf(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("different content produces different digests", () => {
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
    expect(digestOf({ a: [1, 2] })).not.toBe(digestOf({ a: [2, 1] }));
  });
});
