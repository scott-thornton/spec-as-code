import { describe, expect, it } from "vitest";
import { compileSpecGraph } from "./spec/graph.js";
import { compileSpecSource } from "./spec/load.js";
import { hasErrors } from "./diagnostics.js";

const securitySpec = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: security-invariants
  title: Organization security invariants
goal: Organization-wide security invariants shared across feature specs.
requirements:
  - id: SEC-001
    statement: Secrets are never logged in plaintext.
    priority: must
    acceptance:
      - id: SEC-001-A
        type: file
        path: src/log.mjs
        assert:
          notContains: "console.log(process.env"
constraints:
  - id: SEC-C01
    statement: Dependencies come from the approved registry.
    priority: must
    acceptance:
      - id: SEC-C01-A
        type: command
        command: node -e 0
outOfScope:
  - custom registries
`;

const featureSpec = (imports: string, extra = "") => `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: feature-x
  title: Feature X
goal: Feature X works.
${imports}
requirements:
  - id: FEAT-001
    statement: Feature X works end to end.
    priority: must
    dependsOn:
      - SEC-001
    acceptance:
      - id: FEAT-001-A
        type: command
        command: node --test "tests/*.test.mjs"
${extra}`;

function fsOf(files: Record<string, string>): (file: string) => string {
  return (file: string): string => {
    const content = files[file];
    if (content === undefined) throw new Error("ENOENT");
    return content;
  };
}

describe("spec imports (§79)", () => {
  it("composes requirements, constraints and outOfScope from imported files", () => {
    const r = compileSpecGraph("specs/feature.yaml", fsOf({
      "specs/feature.yaml": featureSpec("imports:\n  - ./security.yaml"),
      "specs/security.yaml": securitySpec,
    }));
    expect(r.ok).toBe(true);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const ids = r.ir!.properties.map((p) => p.id);
    expect(ids).toEqual(["FEAT-001", "SEC-001", "SEC-C01"]);
    expect(r.ir!.spec.outOfScope).toContain("custom registries");
    expect(r.ir!.importedFiles).toEqual(["specs/security.yaml"]);
    // Entry identity is preserved.
    expect(r.ir!.spec.metadata.id).toBe("feature-x");
    // Cross-file dependsOn resolved during composition.
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it("digest covers the composed graph: editing an imported file changes it", () => {
    const filesA = { "specs/feature.yaml": featureSpec("imports:\n  - ./security.yaml"), "specs/security.yaml": securitySpec };
    const filesB = {
      "specs/feature.yaml": filesA["specs/feature.yaml"]!,
      "specs/security.yaml": securitySpec.replace("Secrets are never logged", "Secrets are never, ever logged"),
    };
    const a = compileSpecGraph("specs/feature.yaml", fsOf(filesA)).ir!;
    const b = compileSpecGraph("specs/feature.yaml", fsOf(filesB)).ir!;
    expect(a.digest).not.toBe(b.digest);
    // And an unrelated extra file leaves it untouched.
    const c = compileSpecGraph("specs/feature.yaml", fsOf({ ...filesA, "specs/other.yaml": "x: y" })).ir!;
    expect(c.digest).toBe(a.digest);
  });

  it("composing is equivalent to authoring one merged file (same digest)", () => {
    const merged = securitySpec
      .replace(/id: security-invariants/, "id: feature-x")
      .replace(/title: Organization security invariants/, "title: Feature X")
      .replace(/goal: .*/, "goal: Feature X works.");
    // Build the merged single-file spec by concatenating sections in the same
    // order the composer uses (entry reqs, imported reqs, constraints).
    const single = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: feature-x
  title: Feature X
goal: Feature X works.
requirements:
  - id: FEAT-001
    statement: Feature X works end to end.
    priority: must
    dependsOn:
      - SEC-001
    acceptance:
      - id: FEAT-001-A
        type: command
        command: node --test "tests/*.test.mjs"
  - id: SEC-001
    statement: Secrets are never logged in plaintext.
    priority: must
    acceptance:
      - id: SEC-001-A
        type: file
        path: src/log.mjs
        assert:
          notContains: "console.log(process.env"
constraints:
  - id: SEC-C01
    statement: Dependencies come from the approved registry.
    priority: must
    acceptance:
      - id: SEC-C01-A
        type: command
        command: node -e 0
outOfScope:
  - custom registries
`;
    const composed = compileSpecGraph("specs/feature.yaml", fsOf({
      "specs/feature.yaml": featureSpec("imports:\n  - ./security.yaml"),
      "specs/security.yaml": securitySpec,
    })).ir!;
    const singleIr = compileSpecSource(single, "specs/feature.yaml").ir!;
    expect(composed.digest).toBe(singleIr.digest);
    expect(merged.length).toBeGreaterThan(0);
  });

  it("rejects property ID collisions across files (SPC1008), never rewriting ids", () => {
    const r = compileSpecGraph("specs/feature.yaml", fsOf({
      "specs/feature.yaml": featureSpec("imports:\n  - ./security.yaml", `
  - id: SEC-001
    statement: A local property colliding with the imported one.
    priority: may
    acceptance:
      - id: LOCAL-001-A
        type: file
        path: src/x.mjs
        assert:
          exists: true
`),
      "specs/security.yaml": securitySpec,
    }));
    expect(r.ok).toBe(false);
    const d = r.diagnostics.find((x) => x.code === "SPC1008");
    expect(d).toBeTruthy();
    expect(d!.message).toContain("SEC-001");
    expect(d!.related).toContain("specs/security.yaml");
  });

  it("rejects import cycles (SPC1006)", () => {
    const r = compileSpecGraph("specs/a.yaml", fsOf({
      "specs/a.yaml": featureSpec("imports:\n  - ./b.yaml").replace("id: feature-x", "id: spec-a"),
      "specs/b.yaml": featureSpec("imports:\n  - ./a.yaml").replace("id: feature-x", "id: spec-b"),
    }));
    expect(r.ok).toBe(false);
    const d = r.diagnostics.find((x) => x.code === "SPC1006");
    expect(d).toBeTruthy();
    expect(d!.message).toMatch(/a\.yaml.*b\.yaml.*a\.yaml|b\.yaml.*a\.yaml.*b\.yaml/);
  });

  it("rejects missing imports (SPC1007)", () => {
    const r = compileSpecGraph("specs/feature.yaml", fsOf({
      "specs/feature.yaml": featureSpec("imports:\n  - ./nope.yaml"),
    }));
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((x) => x.code === "SPC1007" && x.message.includes("nope.yaml"))).toBe(true);
  });

  it("surfaces diagnostics from an invalid imported file with its filename", () => {
    const r = compileSpecGraph("specs/feature.yaml", fsOf({
      "specs/feature.yaml": featureSpec("imports:\n  - ./broken.yaml"),
      "specs/broken.yaml": `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: broken
  title: Broken
goal: g
requirements:
  - id: BAD-001
    statement: must without acceptance
    priority: must
`,
    }));
    expect(r.ok).toBe(false);
    const d = r.diagnostics.find((x) => x.code === "SPC1004");
    expect(d).toBeTruthy();
    expect(d!.loc?.file).toBe("specs/broken.yaml");
  });

  it("follows transitive imports in declaration order", () => {
    const r = compileSpecGraph("specs/top.yaml", fsOf({
      "specs/top.yaml": `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: top
  title: Top
goal: g
imports:
  - ./mid.yaml
requirements:
  - id: TOP-001
    statement: t
    priority: must
    acceptance:
      - id: TOP-001-A
        type: command
        command: node -e 0
`,
      "specs/mid.yaml": `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: mid
  title: Mid
goal: g
imports:
  - ./base.yaml
requirements:
  - id: MID-001
    statement: m
    priority: must
    acceptance:
      - id: MID-001-A
        type: command
        command: node -e 0
`,
      "specs/base.yaml": `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: base
  title: Base
goal: g
requirements:
  - id: BASE-001
    statement: b
    priority: must
    acceptance:
      - id: BASE-001-A
        type: command
        command: node -e 0
`,
    }));
    expect(r.ok).toBe(true);
    expect(r.ir!.properties.map((p) => p.id)).toEqual(["TOP-001", "MID-001", "BASE-001"]);
    expect(r.ir!.importedFiles).toEqual(["specs/mid.yaml", "specs/base.yaml"]);
  });
});
