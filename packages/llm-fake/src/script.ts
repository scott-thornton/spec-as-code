import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { SpcError } from "@spc/core";

export const FAKE_SCRIPT_ERROR = "FAKE_SCRIPT_ERROR";

/**
 * Deterministic scripted responses for tests and fixtures. Values are
 * validated against the request schema at call time, so a script that
 * drifts from real schemas fails loudly instead of silently.
 */
export const fakeScriptSchema = z.strictObject({
  planner: z.strictObject({ value: z.unknown() }).optional(),
  executor: z.record(z.string(), z.unknown()).optional(),
  replanner: z.record(z.string(), z.unknown()).optional(),
  verifier: z.record(z.string(), z.unknown()).optional(),
});

export type FakeScript = z.infer<typeof fakeScriptSchema>;

export function parseFakeScript(source: string): FakeScript {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (e) {
    throw new SpcError(FAKE_SCRIPT_ERROR, `fake provider script is not valid YAML: ${(e as Error).message}`);
  }
  const r = fakeScriptSchema.safeParse(data ?? {});
  if (!r.success) {
    throw new SpcError(
      FAKE_SCRIPT_ERROR,
      `fake provider script is invalid: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return r.data;
}
