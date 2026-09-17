import { describe, expect, it } from "vitest";
import { acceptanceCriterionSchema } from "./spec.js";
import { specSchema } from "./spec.js";
import { DEFAULT_CONFIG, configSchema } from "./config.js";

const validSpec = {
  apiVersion: "spc.dev/v1alpha1",
  kind: "Spec",
  metadata: { id: "oauth-login", title: "OAuth" },
  goal: "Users can log in with GitHub OAuth.",
  requirements: [
    {
      id: "AUTH-001",
      statement: "Users can authenticate using GitHub OAuth.",
      priority: "must",
      acceptance: [
        { id: "AUTH-001-A", type: "command", command: "pnpm test tests/oauth.test.ts", expect: { exitCode: 0 } },
      ],
    },
  ],
  constraints: [{ id: "AUTH-C01", statement: "No plaintext tokens." }],
  outOfScope: ["Google OAuth"],
};

describe("spec schema", () => {
  it("accepts a valid spec", () => {
    expect(specSchema.safeParse(validSpec).success).toBe(true);
  });

  it("rejects unknown top-level fields", () => {
    const bad = { ...validSpec, extra: true };
    const r = specSchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects unknown nested fields on requirements", () => {
    const bad = {
      ...validSpec,
      requirements: [{ ...validSpec.requirements[0]!, colour: "red" }],
    };
    const r = specSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("requires at least one requirement", () => {
    const r = specSchema.safeParse({ ...validSpec, requirements: [] });
    expect(r.success).toBe(false);
  });

  it("rejects malformed acceptance criterion discriminated union", () => {
    const r = acceptanceCriterionSchema.safeParse({ id: "X-001-A", type: "carrier-pigeon" });
    expect(r.success).toBe(false);
  });

  it("rejects file assertions without any predicate", () => {
    const r = acceptanceCriterionSchema.safeParse({
      id: "X-001-A",
      type: "file",
      path: "src/a.ts",
      assert: {},
    });
    expect(r.success).toBe(false);
  });
});

describe("config schema", () => {
  it("parses empty config into defaults", () => {
    const c = configSchema.parse({});
    expect(c.provider.name).toBe("none");
    expect(c.execution.maxModelCalls).toBe(50);
    expect(c.commands.network).toBe("deny");
    expect(c.verification.allowAgentOnlyMustRequirements).toBe(false);
  });

  it("DEFAULT_CONFIG is valid", () => {
    expect(DEFAULT_CONFIG.version).toBe(1);
  });

  it("rejects unknown provider names", () => {
    const r = configSchema.safeParse({ provider: { name: "skynet" } });
    expect(r.success).toBe(false);
  });
});
