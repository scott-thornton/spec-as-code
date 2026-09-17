import { SpcError } from "./errors.js";

/**
 * Deterministic canonical JSON:
 * - recursively sort object keys lexicographically
 * - preserve array order
 * - omit undefined object properties
 * - reject cycles, NaN, Infinity, bigint, functions, symbols, Date objects
 *   and other non-JSON values
 *
 * Digests are computed over this representation, so identical logical
 * content always produces identical digests.
 */

export const CANONICALIZATION_ERROR = "SPC_CANONICALIZATION_ERROR";

class CanonicalContext {
  readonly seen = new Set<object>();
  readonly path: string[] = [];

  fail(reason: string): never {
    throw new SpcError(
      CANONICALIZATION_ERROR,
      `cannot canonicalize value at $.${this.path.join(".")}: ${reason}`,
    );
  }
}

function transform(value: unknown, ctx: CanonicalContext, key: string): unknown {
  ctx.path.push(key);
  try {
    return transformInner(value, ctx);
  } finally {
    ctx.path.pop();
  }
}

function transformInner(value: unknown, ctx: CanonicalContext): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) ctx.fail("NaN and Infinity are not canonicalizable");
      return value;
    case "bigint":
      ctx.fail("bigint is not canonicalizable");
      break;
    case "symbol":
      ctx.fail("symbol is not canonicalizable");
      break;
    case "function":
      ctx.fail("function is not canonicalizable");
      break;
    case "undefined":
      ctx.fail("undefined is only permitted as an omitted object property");
      break;
    case "object":
      break;
  }
  const obj = value as object;
  if (obj instanceof Date) ctx.fail("Date objects are not canonicalizable; use ISO strings");
  if (Array.isArray(obj)) {
    if (ctx.seen.has(obj)) ctx.fail("cycle detected");
    ctx.seen.add(obj);
    try {
      const out: unknown[] = [];
      for (let i = 0; i < obj.length; i++) {
        const item: unknown = obj[i];
        if (item === undefined) ctx.fail(`array item ${i} is undefined`);
        out.push(transform(item, ctx, String(i)));
      }
      return out;
    } finally {
      ctx.seen.delete(obj);
    }
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    ctx.fail(`unsupported object type ${obj.constructor?.name ?? "Object"}`);
  }
  if (ctx.seen.has(obj)) ctx.fail("cycle detected");
  ctx.seen.add(obj);
  try {
    const record = obj as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj)
      .filter((k) => record[k] !== undefined)
      .sort();
    for (const k of keys) {
      out[k] = transform(record[k], ctx, k);
    }
    return out;
  } finally {
    ctx.seen.delete(obj);
  }
}

export function canonicalize(value: unknown): unknown {
  return transformInner(value, new CanonicalContext());
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
