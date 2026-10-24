import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Plan } from "@spc/schema";
import { compileSpecSource } from "@spc/core";
import { FakeProvider, parseFakeScript } from "@spc/llm-fake";
import { git } from "@spc/repo";
import { applyPlan, spcPaths } from "./index.js";

// Oracle for specs/oracle-validity.yaml (OV-002): an oracle-invalid red
// refuses the apply BEFORE executor work proceeds - the burned-run class
// of the three motivating incidents.
const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: ovr
  title: Oracle validity refusal
goal: fixture
requirements:
  - id: OVR-001
    statement: Marker exists.
    priority: must
    acceptance:
      - id: OVR-001-A
        type: command
        command: pnpm exec vitest run tests/marker.test.ts
        discriminating: true
`;

let roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function setup(oracleBody: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), "spc-ovr-"));
  roots.push(repo);
  mkdirSync(path.join(repo, "specs"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  mkdirSync(path.join(repo, ".spc"), { recursive: true });
  writeFileSync(path.join(repo, "specs", "spec.yaml"), specYaml);
  writeFileSync(path.join(repo, "tests", "marker.test.ts"), oracleBody, "utf8");
  writeFileSync(
    path.join(repo, ".spc", "config.yaml"),
    "version: 1\nprovider:\n  name: fake\n  script: .spc/fake.yaml\nexecution:\n  inPlace: true\n  inPlaceBranch: current\nverification:\n  requireRedPhase: true\n",
  );
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "ovr-fixture", private: true }), "utf8");
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n", "utf8");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function fakeNeverCalled(): FakeProvider {
  // If the executor is ever consulted, this provider throws - the test
  // asserts executor work NEVER PROCEEDS.
  const script = ["planner:", "  value: {}", "executor:", "  T001:", "    status: blocked", "    summary: must not run", ""].join("\n");
  return new Proxy(new FakeProvider(parseFakeScript(script)), {
    get(target, prop, receiver) {
      if (prop === "generateStructured") {
        return (...args: unknown[]) => {
          throw new Error("executor was consulted - refusal did not precede executor work");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as FakeProvider;
}

function planFor(digest: string): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "p1", createdAt: "2026-10-25T00:00:00.000Z" },
    spec: { id: "ovr", digest },
    repository: { revision: "0000", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks: [
      { id: "T001", title: "Work", kind: "modify", intent: "write", dependsOn: [], satisfies: ["OVR-001"], targets: { write: ["src/marker.ts"] } },
    ],
  } as never;
}

describe("oracle-invalid red refusal (OV-002)", () => {
  it("a syntax-broken oracle refuses the apply before executor work - named error", async () => {
    // The 2026-10-24 incident shape: an unquoted dashed key - the file
    // cannot parse, so the red it establishes is entitled to nothing.
    const repo = setup(`import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
describe("marker", () => {
  it("exists", () => {
    expect(readFileSync("src/marker.ts", "utf8")).toContain("MARKER");
  });
  const broken = { BAD-KEY: 1 };
});
`);
    const ir = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths = spcPaths(repo);
    mkdirSync(paths.plansDir, { recursive: true });
    writeFileSync(paths.planFile("p1"), JSON.stringify(planFor(ir.digest), null, 2));
    await expect(
      applyPlan({ repoRoot: repo }, { providerFactory: async () => fakeNeverCalled() as never, log: () => {} }),
    ).rejects.toThrow(/ORACLE_INVALID/);
  });

  it("a legitimate assertion-red oracle proceeds to the executor (the control)", async () => {
    const repo = setup(`import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
describe("marker", () => {
  it("exists", () => {
    expect(readFileSync("src/marker.ts", "utf8")).toContain("MARKER");
  });
});
`);
    const ir2 = compileSpecSource(specYaml, "specs/spec.yaml").ir!;
    const paths2 = spcPaths(repo);
    mkdirSync(paths2.plansDir, { recursive: true });
    writeFileSync(paths2.planFile("p1"), JSON.stringify(planFor(ir2.digest), null, 2));
    const script = [
      "planner:",
      "  value: {}",
      "executor:",
      "  T001:",
      "    status: completed",
      "    summary: work",
      "    changes:",
      "      - op: create",
      "        path: src/marker.ts",
      "        content: |",
      "          export const MARKER = true;",
      "",
    ].join("\n");
    const run = await applyPlan({ repoRoot: repo }, { providerFactory: async () => new FakeProvider(parseFakeScript(script)), log: () => {} });
    expect(run.status).toBe("succeeded");
  });
});
