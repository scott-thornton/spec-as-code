/** Shared compact constructors for benchmark task definitions. */

// ---------- spec-construction helpers (treatment arm format) ----------

export function cmdAcc(id, command, exitCode = 0) {
  return { id, type: "command", command, expect: { exitCode } };
}

export function fileAcc(id, p, assert) {
  return { id, type: "file", path: p, assert };
}

export function req(id, statement, priority, acceptance) {
  return { id, statement, priority, acceptance };
}

export function constraint(id, statement, acceptance) {
  return { id, statement, acceptance };
}

// ---------- plan-task helpers ----------

export function planTask({ id, title, kind = "modify", intent, deps = [], satisfies = [], verifies = [], read = [], write = [] }) {
  return {
    id,
    title,
    kind,
    intent,
    ...(deps.length ? { dependsOn: deps } : {}),
    ...(satisfies.length ? { satisfies } : {}),
    ...(verifies.length ? { verifies } : {}),
    ...(read.length || write.length ? { targets: { ...(read.length ? { read } : {}), ...(write.length ? { write } : {}) } } : {}),
  };
}

export function verifyTask(id, deps, verifies) {
  return planTask({ id, title: `Verify ${verifies.join(", ")}`, kind: "verify", intent: "run acceptance criteria for the listed properties", deps, verifies });
}

// ---------- executor / control helpers ----------

export function ch(op, p, content) {
  return op === "delete" ? { op, path: p } : { op, path: p, content };
}

export function execDone(summary, changes) {
  return { status: "completed", summary, changes };
}

// ---------- ground-truth helpers (task.yaml format) ----------

export function gtCmd(command, expectExitCode = 0) {
  return { type: "command", command, expectExitCode };
}

export function gtFile(p, { contains, notContains } = {}) {
  return { type: "file", path: p, ...(contains !== undefined ? { contains } : {}), ...(notContains !== undefined ? { notContains } : {}) };
}

export function gt(id, description, verify) {
  return { id, description, verify };
}

const TESTS = `node --test "tests/*.test.mjs"`;
export const TEST_CMD = TESTS;

export function defaultRegression(command = TESTS, expectBefore = "pass") {
  return { command, expectBefore };
}

