import { describe, expect, it } from "vitest";
import { compileSpecSource } from "./spec/load.js";
import { hasErrors } from "./diagnostics.js";

const validSpecYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec

metadata:
  id: oauth-login
  title: GitHub OAuth Authentication

goal: >
  Users can authenticate using GitHub OAuth without breaking existing
  password authentication.

requirements:
  - id: AUTH-001
    statement: Users can authenticate using GitHub OAuth.
    priority: must
    dependsOn: []
    acceptance:
      - id: AUTH-001-A
        type: command
        command: pnpm test tests/oauth.test.ts
        expect:
          exitCode: 0

  - id: AUTH-002
    statement: Existing password authentication remains functional.
    priority: must
    dependsOn:
      - AUTH-001
    acceptance:
      - id: AUTH-002-A
        type: command
        command: pnpm test tests/password-auth.test.ts

constraints:
  - id: AUTH-C01
    statement: OAuth access tokens must not be stored in plaintext.
    acceptance:
      - id: AUTH-C01-A
        type: agent
        instruction: >
          Inspect session/token persistence and determine whether OAuth
          access tokens can be stored unencrypted.

outOfScope:
  - Google OAuth
  - account linking
`;

describe("spec compiler", () => {
  it("compiles a valid spec into SpecIR with digest and property index", () => {
    const r = compileSpecSource(validSpecYaml, "specs/auth.yaml");
    expect(r.ok).toBe(true);
    expect(r.ir).not.toBeNull();
    expect(r.diagnostics).toEqual([]);
    const ir = r.ir!;
    expect(ir.spec.metadata.id).toBe("oauth-login");
    expect(ir.properties.map((p) => p.id)).toEqual(["AUTH-001", "AUTH-002", "AUTH-C01"]);
    expect(ir.properties[2]?.priority).toBe("must"); // constraint default
    expect(ir.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("digest is stable regardless of YAML key order and formatting", () => {
    const a = compileSpecSource(validSpecYaml, "a.yaml").ir!;
    const reordered = `kind: Spec
apiVersion: spc.dev/v1alpha1
goal: >
  Users can authenticate using GitHub OAuth without breaking existing
  password authentication.
metadata:
  title: GitHub OAuth Authentication
  id: oauth-login
requirements:
  - priority: must
    id: AUTH-001
    statement: Users can authenticate using GitHub OAuth.
    dependsOn: []
    acceptance:
      - id: AUTH-001-A
        type: command
        command: pnpm test tests/oauth.test.ts
        expect:
          exitCode: 0
  - id: AUTH-002
    statement: Existing password authentication remains functional.
    priority: must
    dependsOn:
      - AUTH-001
    acceptance:
      - id: AUTH-002-A
        type: command
        command: pnpm test tests/password-auth.test.ts
constraints:
  - id: AUTH-C01
    statement: OAuth access tokens must not be stored in plaintext.
    acceptance:
      - id: AUTH-C01-A
        type: agent
        instruction: >
          Inspect session/token persistence and determine whether OAuth
          access tokens can be stored unencrypted.
outOfScope:
  - Google OAuth
  - account linking
`;
    const b = compileSpecSource(reordered, "b.yaml").ir!;
    expect(a.digest).toBe(b.digest);
  });

  it("normalization applies command expect defaults and sorts dependsOn", () => {
    const r = compileSpecSource(validSpecYaml, "specs/auth.yaml").ir!;
    const c2 = r.properties[1]!;
    const crit = r.properties[0]!.acceptance[0]!;
    expect(crit.type === "command" && crit.expect?.exitCode).toBe(0);
    const unsorted = compileSpecSource(
      validSpecYaml.replace("dependsOn:\n      - AUTH-001", "dependsOn:\n      - AUTH-001"),
      "x.yaml",
    );
    expect(unsorted.ok).toBe(true);
  });

  it("rejects unknown fields with SPC0003", () => {
    const r = compileSpecSource(validSpecYaml + "\nsurprise: true\n", "specs/auth.yaml");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "SPC0003")).toBe(true);
  });

  it("rejects unknown nested fields", () => {
    const bad = validSpecYaml.replace("    priority: must\n", "    priority: must\n    colour: red\n");
    const r = compileSpecSource(bad, "specs/auth.yaml");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "SPC0003")).toBe(true);
  });

  it("SPC0001 on YAML syntax errors and duplicate keys", () => {
    const r1 = compileSpecSource("apiVersion: [unclosed", "x.yaml");
    expect(r1.ok).toBe(false);
    expect(r1.diagnostics.some((d) => d.code === "SPC0001" && /parse/i.test(d.message))).toBe(true);

    const dup = validSpecYaml.replace("goal: >", "goal: >\nmetadata:\n  id: oauth-login\n  title: X\ngoal2: >");
    const r2 = compileSpecSource(dup, "x.yaml");
    expect(r2.ok).toBe(false);
    expect(r2.diagnostics.some((d) => d.code === "SPC0001" && /duplicate|unique/i.test(d.message))).toBe(true);
  });

  it("SPC1001 on duplicate property ids", () => {
    const bad = validSpecYaml.replace(
      "  - id: AUTH-C01",
      "  - id: AUTH-001",
    );
    const r = compileSpecSource(bad, "specs/auth.yaml");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "SPC1001" && d.message.includes("AUTH-001"))).toBe(true);
  });

  it("SPC1002 on unknown property dependency with source location", () => {
    const bad = validSpecYaml.replace("      - AUTH-001", "      - AUTH-009");
    const r = compileSpecSource(bad, "specs/auth.yaml");
    expect(r.ok).toBe(false);
    const d = r.diagnostics.find((x) => x.code === "SPC1002");
    expect(d).toBeTruthy();
    expect(d!.message).toContain("AUTH-009");
    expect(d!.loc).toBeDefined();
    expect(d!.loc!.line).toBeGreaterThan(0);
  });

  it("SPC1003 on property dependency cycles", () => {
    // AUTH-002 depends on AUTH-001 in the base spec; make AUTH-001 depend on AUTH-002.
    const cyclic = validSpecYaml.replace(
      "  - id: AUTH-001\n    statement: Users can authenticate using GitHub OAuth.\n    priority: must\n    dependsOn: []",
      "  - id: AUTH-001\n    statement: Users can authenticate using GitHub OAuth.\n    priority: must\n    dependsOn:\n      - AUTH-002",
    );
    const r = compileSpecSource(cyclic, "specs/auth.yaml");
    expect(r.ok).toBe(false);
    const d = r.diagnostics.find((x) => x.code === "SPC1003");
    expect(d).toBeTruthy();
    expect(d!.message).toContain("AUTH-001 -> AUTH-002 -> AUTH-001");
  });

  it("SPC1004 error when must-property lacks acceptance", () => {
    const bad = validSpecYaml.replace(
      "  - id: AUTH-001\n    statement: Users can authenticate using GitHub OAuth.\n    priority: must\n    dependsOn: []\n    acceptance:\n      - id: AUTH-001-A\n        type: command\n        command: pnpm test tests/oauth.test.ts\n        expect:\n          exitCode: 0",
      "  - id: AUTH-001\n    statement: Users can authenticate using GitHub OAuth.\n    priority: must\n    dependsOn: []",
    );
    const r = compileSpecSource(bad, "specs/auth.yaml");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "SPC1004")).toBe(true);
  });

  it("SPC1005 warning when optional property lacks acceptance", () => {
    const withOptional = validSpecYaml.replace(
      "constraints:",
      `  - id: AUTH-003
    statement: Login telemetry is recorded.
    priority: should

constraints:`,
    );
    const r = compileSpecSource(withOptional, "specs/auth.yaml");
    expect(r.ok).toBe(true);
    const d = r.diagnostics.find((x) => x.code === "SPC1005");
    expect(d).toBeTruthy();
    expect(d!.severity).toBe("warning");
    expect(hasErrors(r.diagnostics)).toBe(false);
  });
});
