import { describe, expect, it } from "vitest";
import type { Plan, Task } from "@spc/schema";
import { compileSpecSource } from "./spec/load.js";
import { validatePlan } from "./plan/validate.js";
import { normalizePlan, planDigest } from "./plan/normalize.js";

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: oauth-login
  title: OAuth
goal: OAuth login works.
requirements:
  - id: AUTH-001
    statement: OAuth login works.
    priority: must
    acceptance:
      - id: AUTH-001-A
        type: command
        command: node --test tests/
  - id: AUTH-002
    statement: Password login preserved.
    priority: must
    acceptance:
      - id: AUTH-002-A
        type: human
        instruction: Review password login UX.
constraints:
  - id: AUTH-C01
    statement: No plaintext tokens.
    priority: must
    acceptance:
      - id: AUTH-C01-A
        type: agent
        instruction: Inspect token persistence.
`;

const ir = compileSpecSource(specYaml, "specs/auth.yaml").ir!;

function task(partial: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: `Task ${partial.id}`,
    kind: "modify",
    intent: "do the thing",
    ...partial,
  } as Task;
}

function plan(tasks: Task[], overrides: Partial<Plan> = {}): Plan {
  return {
    apiVersion: "spc.dev/v1alpha1",
    kind: "Plan",
    metadata: { id: "plan-test", createdAt: "2026-09-17T00:00:00.000Z" },
    spec: { id: ir.spec.metadata.id, digest: ir.digest },
    repository: { revision: "9a31d52", snapshotDigest: `sha256:${"0".repeat(64)}` },
    tasks,
    ...overrides,
  } as Plan;
}

const validTasks: Task[] = [
  task({
    id: "T001",
    kind: "modify",
    satisfies: ["AUTH-001"],
    dependsOn: [],
    targets: { write: ["src/auth/github.ts"] },
  }),
  task({
    id: "T002",
    kind: "modify",
    satisfies: ["AUTH-C01"],
    dependsOn: ["T001"],
    targets: { write: ["src/auth/tokens.ts"] },
  }),
  task({
    id: "T003",
    kind: "verify",
    verifies: ["AUTH-001", "AUTH-002", "AUTH-C01"],
    dependsOn: ["T002"],
    targets: undefined,
  }),
];

describe("plan validation", () => {
  it("accepts a valid plan", () => {
    const diags = validatePlan(plan(validTasks), ir);
    expect(diags).toEqual([]);
  });

  it("verification path can come from deterministic criteria alone (no verify task)", () => {
    const tasks = validTasks.filter((t) => t.id !== "T003").map((t) =>
      t.id === "T002" ? { ...t, dependsOn: ["T001"], verifies: ["AUTH-002", "AUTH-C01"] } : t,
    );
    const diags = validatePlan(plan(tasks), ir);
    // AUTH-002 (human-only) and AUTH-C01 (agent-only) are covered via T002 verifies.
    expect(diags.filter((d) => d.code === "SPC2006")).toEqual([]);
  });

  it("SPC2001 duplicate task ids", () => {
    const tasks = [...validTasks, task({ id: "T001", kind: "verify", verifies: ["AUTH-001"] })];
    expect(validatePlan(plan(tasks), ir).some((d) => d.code === "SPC2001")).toBe(true);
  });

  it("SPC2002 unknown task dependency", () => {
    const tasks = validTasks.map((t) => (t.id === "T002" ? { ...t, dependsOn: ["T999"] } : t));
    expect(validatePlan(plan(tasks), ir).some((d) => d.code === "SPC2002")).toBe(true);
  });

  it("SPC2003 task dependency cycle", () => {
    const tasks = validTasks.map((t) =>
      t.id === "T001" ? { ...t, dependsOn: ["T003"] } : t,
    );
    const diags = validatePlan(plan(tasks), ir);
    const cyc = diags.find((d) => d.code === "SPC2003");
    expect(cyc).toBeTruthy();
  });

  it("SPC2004 unknown property reference", () => {
    const tasks = validTasks.map((t) =>
      t.id === "T001" ? { ...t, satisfies: ["AUTH-999"] } : t,
    );
    expect(validatePlan(plan(tasks), ir).some((d) => d.code === "SPC2004")).toBe(true);
  });

  it("SPC2005 must-property not covered by any task", () => {
    // Drop T002 (satisfies AUTH-C01) and drop AUTH-C01 from T003's verifies.
    const tasks = validTasks
      .filter((t) => t.id !== "T002")
      .map((t) => (t.id === "T003" ? { ...t, verifies: ["AUTH-001", "AUTH-002"] } : t));
    const diags = validatePlan(plan(tasks), ir);
    const d = diags.find((x) => x.code === "SPC2005");
    expect(d).toBeTruthy();
    expect(d!.message).toContain("AUTH-C01");
  });

  it("SPC2006 must-property without verification path", () => {
    // Remove the verify task; AUTH-002 has only a human criterion so it needs a verify task.
    const tasks = [validTasks[0]!, validTasks[1]!];
    const diags = validatePlan(plan(tasks), ir);
    const d = diags.find((x) => x.code === "SPC2006");
    expect(d).toBeTruthy();
    expect(d!.message).toContain("AUTH-002");
  });

  it("SPC2007 concurrent write conflict", () => {
    const conflicting: Task[] = [
      task({ id: "T001", satisfies: ["AUTH-001"], targets: { write: ["src/auth/**"] } }),
      task({ id: "T002", satisfies: ["AUTH-002", "AUTH-C01"], kind: "verify", verifies: ["AUTH-002", "AUTH-C01"], targets: { write: ["src/auth/session.ts"] } }),
    ];
    expect(validatePlan(plan(conflicting), ir).some((d) => d.code === "SPC2007")).toBe(true);
  });

  it("ordered writers with overlapping scopes do not conflict", () => {
    const ordered: Task[] = [
      task({ id: "T001", satisfies: ["AUTH-001"], targets: { write: ["src/auth/**"] } }),
      task({ id: "T002", satisfies: ["AUTH-C01"], dependsOn: ["T001"], targets: { write: ["src/auth/session.ts"] } }),
      task({ id: "T003", kind: "verify", verifies: ["AUTH-002"], dependsOn: ["T002"] }),
    ];
    expect(validatePlan(plan(ordered), ir).filter((d) => d.code === "SPC2007")).toEqual([]);
  });

  it("SPC2008 plan/spec id mismatch", () => {
    const p = plan(validTasks, { spec: { id: "other-spec", digest: ir.digest } });
    expect(validatePlan(p, ir).some((d) => d.code === "SPC2008")).toBe(true);
  });

  it("SPC2009 plan/spec digest mismatch", () => {
    const p = plan(validTasks, { spec: { id: ir.spec.metadata.id, digest: `sha256:${"1".repeat(64)}` } });
    expect(validatePlan(p, ir).some((d) => d.code === "SPC2009")).toBe(true);
  });

  it("SPC2010 inspect task with writes", () => {
    const tasks = validTasks.map((t) =>
      t.id === "T001" ? { ...t, kind: "inspect" as const } : t,
    );
    expect(validatePlan(plan(tasks), ir).some((d) => d.code === "SPC2010")).toBe(true);
  });

  it("SPC2011 unsafe target path", () => {
    const tasks = validTasks.map((t) =>
      t.id === "T001" ? { ...t, targets: { write: ["../outside.ts"] } } : t,
    );
    expect(validatePlan(plan(tasks), ir).some((d) => d.code === "SPC2011")).toBe(true);
  });
});

describe("plan normalization", () => {
  it("sorts and de-duplicates set-like arrays; preserves task order", () => {
    const p = plan([
      task({ id: "T002", dependsOn: ["T001", "T001"], satisfies: ["B-01", "A-01"] }),
      task({ id: "T001", targets: { write: ["z.ts", "a.ts"], read: ["r2", "r1"] } }),
    ]);
    const n = normalizePlan(p);
    expect(n.tasks[0]?.dependsOn).toEqual(["T001"]);
    expect(n.tasks[0]?.satisfies).toEqual(["A-01", "B-01"]);
    expect(n.tasks[1]?.targets?.write).toEqual(["a.ts", "z.ts"]);
    expect(n.tasks.map((t) => t.id)).toEqual(["T002", "T001"]);
    expect(planDigest(p)).toBe(planDigest(normalizePlan(n)));
  });
});
