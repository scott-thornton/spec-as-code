import type { ZodType } from "zod";
import { LLMError, LLM_INVALID_STRUCTURED_OUTPUT } from "./errors.js";

export type StructuredValidation<T> =
  | { ok: true; value: T }
  | { ok: false; issues: { path: string; message: string }[] };

/** Validate raw data against a structured-output schema. */
export function validateStructured<T>(schema: ZodType<T>, data: unknown): StructuredValidation<T> {
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  };
}

/** Extract a JSON document from raw model text (tolerates code fences). */
export function extractJson(raw: string): unknown {
  const attempt = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const direct = attempt(raw.trim());
  if (direct !== undefined) return direct;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const v = attempt(fenced[1].trim());
    if (v !== undefined) return v;
  }
  const firstObj = raw.indexOf("{");
  const firstArr = raw.indexOf("[");
  const start =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  const lastObj = raw.lastIndexOf("}");
  const lastArr = raw.lastIndexOf("]");
  const end = Math.max(lastObj, lastArr);
  if (start !== -1 && end > start) {
    const v = attempt(raw.slice(start, end + 1));
    if (v !== undefined) return v;
  }
  throw new LLMError(LLM_INVALID_STRUCTURED_OUTPUT, "model output did not contain parseable JSON", raw.slice(0, 500));
}

export function parseStructured<T>(schema: ZodType<T>, raw: string): T {
  const data = extractJson(raw);
  const v = validateStructured(schema, data);
  if (!v.ok) {
    throw new LLMError(
      LLM_INVALID_STRUCTURED_OUTPUT,
      `model output failed schema validation: ${v.issues
        .slice(0, 8)
        .map((i) => `${i.path || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return v.value;
}
