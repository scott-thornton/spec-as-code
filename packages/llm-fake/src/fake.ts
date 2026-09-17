import { SpcError } from "@spc/core";
import type { LLMProvider, StructuredRequest, StructuredResponse } from "@spc/llm";
import { validateStructured } from "@spc/llm";
import { FAKE_SCRIPT_ERROR, type FakeScript } from "./script.js";

/**
 * Deterministic fake provider. Response routing by role:
 *  - planner   -> script.planner.value
 *  - executor  -> script.executor["<taskId>@<attempt>" | "<taskId>"]
 *  - replanner -> script.replanner["<triggerTaskId>"]
 *  - verifier  -> script.verifier["<propertyId>:<criterionId>"]
 */
export class FakeProvider implements LLMProvider {
  readonly name = "fake";
  readonly model = "fake-scripted";

  constructor(private readonly script: FakeScript) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const value = this.lookup(request);
    const v = validateStructured(request.schema, value);
    if (!v.ok) {
      throw new SpcError(
        FAKE_SCRIPT_ERROR,
        `fake script value for role=${request.role} key=${request.key ?? "<none>"} failed schema validation: ${v.issues
          .slice(0, 5)
          .map((i) => `${i.path || "<root>"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return {
      value: v.value,
      usage: { model: this.model, durationMs: 0 },
    };
  }

  private lookup(request: StructuredRequest<unknown>): unknown {
    const key = request.key ?? "";
    switch (request.role) {
      case "planner": {
        const value = this.script.planner?.value;
        if (value === undefined) throw missing("planner");
        return value;
      }
      case "executor": {
        const table = this.script.executor ?? {};
        if (key !== "" && table[key] !== undefined) return table[key];
        const base = key.split("@")[0] ?? key;
        if (base !== "" && table[base] !== undefined) return table[base];
        throw missing(`executor.${key || "<no key>"}`);
      }
      case "replanner": {
        const table = this.script.replanner ?? {};
        if (key !== "" && table[key] !== undefined) return table[key];
        // Replanner keys carry the repair attempt (taskId@n); fall back to
        // the bare trigger task id, mirroring the executor's attempt rule.
        const base = key.split("@")[0] ?? key;
        if (base !== "" && table[base] !== undefined) return table[base];
        throw missing(`replanner.${key || "<no key>"}`);
      }
      case "verifier": {
        const table = this.script.verifier ?? {};
        if (key !== "" && table[key] !== undefined) return table[key];
        throw missing(`verifier.${key || "<no key>"}`);
      }
    }
  }
}

function missing(where: string): SpcError {
  return new SpcError(FAKE_SCRIPT_ERROR, `fake provider script has no scripted response for ${where}`);
}
