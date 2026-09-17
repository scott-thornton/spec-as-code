/**
 * Minimal deterministic glob matching for artifact patterns and task
 * write/read scopes. Supports `**` (any number of path segments), `*`
 * (within one segment) and `?` (single character within one segment).
 */

import { SpcError } from "./errors.js";

export const GLOB_ERROR = "SPC_GLOB_ERROR";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function segmentToRegex(seg: string): string {
  let out = "";
  for (const ch of seg) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += escapeRegex(ch);
  }
  return out;
}

export function normalizeRelPath(p: string): string {
  let out = p.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  while (out.endsWith("/") && out.length > 1) out = out.slice(0, -1);
  return out;
}

export function isSafeRelativePath(p: string): boolean {
  const norm = normalizeRelPath(p);
  if (norm === "") return false;
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return false;
  const segments = norm.split("/");
  return segments.every((s) => s.length > 0 && s !== "." && s !== "..");
}

export function globToRegExp(pattern: string): RegExp {
  const norm = normalizeRelPath(pattern);
  const segs = norm.split("/");
  let re = "^";
  segs.forEach((seg, i) => {
    const isLast = i === segs.length - 1;
    if (seg === "**") {
      if (isLast) re += ".*";
      else re += "(?:[^/]+/)*";
    } else {
      re += segmentToRegex(seg);
      if (!isLast) re += "/";
    }
  });
  re += "$";
  return new RegExp(re);
}

export function globMatch(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(normalizeRelPath(path));
}

export function globMatchAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => globMatch(p, path));
}

/** Literal leading portion of a pattern, before the first wildcard segment. */
export function literalPrefix(pattern: string): string {
  const segs = normalizeRelPath(pattern).split("/");
  const literal: string[] = [];
  for (const seg of segs) {
    if (seg === "**" || seg.includes("*") || seg.includes("?")) break;
    literal.push(seg);
  }
  return literal.join("/");
}

/**
 * Conservative overlap test: answers "could these two patterns match a
 * common path?" When unsure (leading wildcards), reports overlap.
 */
export function patternsOverlap(a: string, b: string): boolean {
  if (normalizeRelPath(a) === normalizeRelPath(b)) return true;
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  if (pa === "" || pb === "") return true;
  return globToRegExp(a).test(pb) || globToRegExp(b).test(pa);
}

export function assertSafeGlob(pattern: string): void {
  if (!isSafeRelativePath(pattern) && normalizeRelPath(pattern) !== "**") {
    throw new SpcError(GLOB_ERROR, `unsafe or non-relative path pattern: ${pattern}`);
  }
  globToRegExp(pattern);
}
