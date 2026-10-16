/**
 * Advisory JSON-Schema checking for harness answers, used by
 * `spc agent validate` as a preflight BEFORE submission.
 *
 * The authoritative validation remains the runtime's zod check on the
 * provider side (validateStructured); this checker covers the keyword
 * subset that z.toJSONSchema emits for spc's request schemas
 * (type, properties, required, additionalProperties, items, enum,
 * const, minLength, oneOf; annotation keywords are ignored). It exists
 * so the answering agent can discover schema problems without burning
 * a submit-requeue-regenerate round trip - the transcript evidence
 * showed up to 21 attempts on a single request before this existed.
 */

export interface SchemaIssue {
  path: string;
  message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function checkJsonSchema(schema: unknown, value: unknown, path = "<root>"): SchemaIssue[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return [];
  const s = schema as Record<string, unknown>;
  const issues: SchemaIssue[] = [];

  if (s.const !== undefined && !jsonEqual(value, s.const)) {
    issues.push({ path, message: `expected const ${JSON.stringify(s.const)}` });
  }
  if (Array.isArray(s.enum) && !(s.enum as unknown[]).some((e) => jsonEqual(value, e))) {
    issues.push({ path, message: `expected one of ${(s.enum as unknown[]).map((e) => JSON.stringify(e)).join(" | ")}` });
  }

  if (typeof s.type === "string" || Array.isArray(s.type)) {
    const allowed = (Array.isArray(s.type) ? s.type : [s.type]).map(String);
    const actual = typeOf(value);
    const okType = allowed.some((t) => t === actual || (t === "number" && actual === "number") || (t === "integer" && actual === "number" && Number.isInteger(value)));
    if (!okType) {
      issues.push({ path, message: `expected type ${allowed.join("|")}, got ${actual}` });
      return issues; // deeper checks would only cascade
    }
  }

  if (typeOf(value) === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, unknown>;
    for (const key of Array.isArray(s.required) ? (s.required as string[]) : []) {
      if (!(key in obj)) issues.push({ path, message: `missing required property "${key}"` });
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) issues.push({ path, message: `unexpected property "${key}" (additionalProperties: false)` });
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) issues.push(...checkJsonSchema(sub, obj[key], `${path}.${key}`));
    }
  }

  if (Array.isArray(value)) {
    const items = s.items;
    if (items !== undefined) {
      value.forEach((el, i) => issues.push(...checkJsonSchema(items, el, `${path}[${i}]`)));
    }
  }

  if (typeof value === "string" && typeof s.minLength === "number" && value.length < s.minLength) {
    issues.push({ path, message: `shorter than minLength ${s.minLength}` });
  }

  if (Array.isArray(s.oneOf)) {
    const anyBranch = (s.oneOf as unknown[]).some((branch) => checkJsonSchema(branch, value, path).length === 0);
    if (!anyBranch) issues.push({ path, message: "matched none of the oneOf branches" });
  }

  return issues;
}
