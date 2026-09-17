import {
  TEST_CMD,
  ch,
  cmdAcc,
  constraint,
  execDone,
  fileAcc,
  gt,
  gtCmd,
  gtFile,
  planTask,
  req,
  verifyTask,
} from "./helpers.mjs";

/** Categories: feature-addition, bug-fix, refactoring, api-change, schema-change. */

export const TASKS_PART_1 = [

  // ---------------------------------------------------------------- 1
  {
    id: "feat-greeting-name",
    category: "feature-addition",
    title: "Add a personalized greeting",
    description:
      "The service greets anonymously. Add greetNamed(name) returning \"hello, <name>\". Keep the existing greet() working.",
    repoFiles: {
      "lib/greet.mjs": 'export const greet = () => "hello";\n',
      "tests/greet.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "../lib/greet.mjs";\n\ntest("anonymous greeting", () => {\n  assert.equal(greet(), "hello");\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greetNamed } from "../lib/greet.mjs";\n\ntest("named greeting", () => {\n  assert.equal(greetNamed("ada"), "hello, ada");\n});\n',
      "grading/gt-2.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "../lib/greet.mjs";\n\ntest("anonymous greeting preserved", () => {\n  assert.equal(greet(), "hello");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "feat-greeting-name", title: "Personalized greeting" },
      goal: "Greet users by name without breaking the anonymous greeting.",
      requirements: [
        req("FEAT-001", "greetNamed(name) returns \"hello, <name>\".", "must", [cmdAcc("FEAT-001-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "named greeting works", gtCmd('node --test "grading/gt-1.mjs"')),
        gt("GT-002", "anonymous greeting preserved", gtCmd('node --test "grading/gt-2.mjs"')),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Implement named greeting", intent: "add greetNamed and a test for it", satisfies: ["FEAT-001"], read: ["tests/**"], write: ["lib/greet.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["FEAT-001"]),
      ],
      executor: {
        T001: execDone("Added greetNamed with test.", [
          ch("update", "lib/greet.mjs", 'export const greet = () => "hello";\n\nexport function greetNamed(name) {\n  return `hello, ${name}`;\n}\n'),
          ch("create", "tests/named.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greetNamed } from "../lib/greet.mjs";\n\ntest("named greeting", () => {\n  assert.equal(greetNamed("ada"), "hello, ada");\n});\n'),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Edit lib/greet.mjs to add greetNamed.\n2. Done.",
      summary: "Added greetNamed.",
      changes: [ch("update", "lib/greet.mjs", 'export const greet = () => "hello";\n\nexport function greetNamed(name) {\n  return `hello, ${name}`;\n}\n')],
      claimedDone: true,
      ranTests: false,
    },
  },

  // ---------------------------------------------------------------- 2
  {
    id: "feat-math-max",
    category: "feature-addition",
    title: "Add max() to the math helpers",
    description: "lib/math.mjs has sum(). Add max(a, b) returning the larger number. Keep sum() working.",
    repoFiles: {
      "lib/math.mjs": "export function sum(a, b) {\n  return a + b;\n}\n",
      "tests/math.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "../lib/math.mjs";\n\ntest("sum", () => {\n  assert.equal(sum(2, 3), 5);\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { max } from "../lib/math.mjs";\n\ntest("max", () => {\n  assert.equal(max(2, 7), 7);\n  assert.equal(max(9, 2), 9);\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "feat-math-max", title: "max() helper" },
      goal: "max(a, b) exists alongside sum().",
      requirements: [req("FEAT-001", "max(a, b) returns the larger argument.", "must", [cmdAcc("FEAT-001-A", TEST_CMD)])],
    },
    groundTruth: {
      requirements: [gt("GT-001", "max works", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Implement max", intent: "add max with a test", satisfies: ["FEAT-001"], read: ["tests/**"], write: ["lib/math.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["FEAT-001"]),
      ],
      executor: {
        T001: execDone("Added max with test.", [
          ch("update", "lib/math.mjs", "export function sum(a, b) {\n  return a + b;\n}\n\nexport function max(a, b) {\n  return a > b ? a : b;\n}\n"),
          ch("create", "tests/max.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { max } from "../lib/math.mjs";\n\ntest("max", () => {\n  assert.equal(max(2, 7), 7);\n});\n'),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Add max to lib/math.mjs.\n",
      summary: "Added max.",
      changes: [ch("update", "lib/math.mjs", "export function sum(a, b) {\n  return a + b;\n}\n\nexport function max(a, b) {\n  return a > b ? a : b;\n}\n")],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 3 (trap: under-specified)
  {
    id: "feat-log-levels",
    category: "feature-addition",
    trap: "under-specified requirement",
    title: "Add leveled logging",
    description:
      "lib/logger.mjs logs plain messages. Introduce leveled logging. (The task deliberately does not name the levels or the default level.)",
    repoFiles: {
      "lib/logger.mjs": "export function log(message) {\n  console.error(message);\n}\n",
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { log } from "../lib/logger.mjs";\n\ntest("plain logging still works", () => {\n  assert.doesNotThrow(() => log("x"));\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "feat-log-levels", title: "Leveled logging" },
      goal: "Messages can be logged at levels.",
      requirements: [
        req("FEAT-001", "Log messages can be emitted at levels.", "must", [fileAcc("FEAT-001-A", "lib/logger.mjs", { exists: true })]),
      ],
    },
    groundTruth: {
      requirements: [gt("GT-001", "plain logging still works", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: "node -e 0", expectBefore: "pass" },
    },
    treatment: {
      // The planner recognizes the ambiguity and refuses to invent the level
      // set: blocking spec_clarination follow-up, run blocked before any change.
      planTasks: [
        planTask({ id: "T001", title: "Inspect logging usage", kind: "inspect", intent: "find all log() call sites", satisfies: ["FEAT-001"], read: ["lib/**"] }),
      ],
      followups: [
        {
          type: "spec_clarification",
          blocking: true,
          title: "Which log levels, and what default?",
          description:
            "The spec says messages \"can be emitted at levels\" but never names the levels nor the default level. Choose: (a) debug/info/warn/error with default info, (b) another set, or (c) amend the spec.",
          propertyId: "FEAT-001",
        },
      ],
    },
    control: {
      planMarkdown: "## Plan\n\n1. Add levels info/warn/error with default info to lib/logger.mjs.\n2. log(message) keeps working at the default level.\n",
      summary: "Added leveled logging with default level info.",
      changes: [
        ch("update", "lib/logger.mjs", 'export const LEVELS = ["info", "warn", "error"];\n\nexport function log(message, level = "info") {\n  console.error(`[${level}] ${message}`);\n}\n'),
      ],
      claimedDone: true,
      ranTests: false,
    },
  },

  // ---------------------------------------------------------------- 4
  {
    id: "fix-off-by-one",
    category: "bug-fix",
    title: "Fix the off-by-one in range()",
    description: "range(n) must return exactly n elements [0..n-1]; it currently returns n+1. The failing test documents the bug.",
    repoFiles: {
      "lib/range.mjs": "export function range(n) {\n  const out = [];\n  for (let i = 0; i <= n; i++) {\n    out.push(i);\n  }\n  return out;\n}\n",
      "tests/range.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { range } from "../lib/range.mjs";\n\ntest("range has n elements", () => {\n  assert.equal(range(3).length, 3);\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { range } from "../lib/range.mjs";\n\ntest("range contents", () => {\n  assert.deepEqual(range(3), [0, 1, 2]);\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "fix-off-by-one", title: "range() fix" },
      goal: "range(n) returns exactly n elements.",
      requirements: [req("FIX-001", "range(n) has exactly n elements.", "must", [cmdAcc("FIX-001-A", TEST_CMD)])],
    },
    groundTruth: {
      requirements: [gt("GT-001", "range contents correct", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: TEST_CMD, expectBefore: "fail" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Fix loop bound", intent: "change <= to < in range()", satisfies: ["FIX-001"], read: ["tests/**"], write: ["lib/range.mjs"] }),
        verifyTask("T002", ["T001"], ["FIX-001"]),
      ],
      executor: {
        T001: execDone("Fixed the loop bound.", [
          ch("update", "lib/range.mjs", "export function range(n) {\n  const out = [];\n  for (let i = 0; i < n; i++) {\n    out.push(i);\n  }\n  return out;\n}\n"),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. The loop runs one step too far; change `i <= n` to `i < n`.\n",
      summary: "Fixed loop bound.",
      changes: [ch("update", "lib/range.mjs", "export function range(n) {\n  const out = [];\n  for (let i = 0; i < n; i++) {\n    out.push(i);\n  }\n  return out;\n}\n")],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 5
  {
    id: "fix-null-user",
    category: "bug-fix",
    title: "displayName(null) must not throw",
    description:
      "displayName(user) throws on null. Return \"anonymous\" for null. Keep the export name displayName and the normal behaviour.",
    repoFiles: {
      "lib/user.mjs": "export function displayName(user) {\n  return user.name.toUpperCase();\n}\n",
      "tests/user.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { displayName } from "../lib/user.mjs";\n\ntest("null user returns anonymous", () => {\n  assert.equal(displayName(null), "anonymous");\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { displayName } from "../lib/user.mjs";\n\ntest("null handling with original export name", () => {\n  assert.equal(displayName(null), "anonymous");\n  assert.equal(displayName({ name: "ada" }), "ADA");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "fix-null-user", title: "null-safe displayName" },
      goal: "displayName handles null without throwing.",
      requirements: [
        req("FIX-001", "displayName(null) returns \"anonymous\".", "must", [cmdAcc("FIX-001-A", TEST_CMD)]),
      ],
      constraints: [
        constraint("FIX-C01", "The export name displayName and the non-null behaviour are preserved.", [cmdAcc("FIX-C01-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [gt("GT-001", "null handled, export name preserved", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: TEST_CMD, expectBefore: "fail" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Guard null user", intent: "return anonymous for null", satisfies: ["FIX-001"], read: ["tests/**"], write: ["lib/user.mjs"] }),
        verifyTask("T002", ["T001"], ["FIX-001", "FIX-C01"]),
      ],
      executor: {
        T001: execDone("Added null guard.", [
          ch("update", "lib/user.mjs", 'export function displayName(user) {\n  if (user === null || user === undefined) {\n    return "anonymous";\n  }\n  return user.name.toUpperCase();\n}\n'),
        ]),
      },
    },
    control: {
      // The baseline agent "improves" the API while fixing the bug: renames
      // the export, then updates the repo test to match. Hidden grading still
      // imports displayName.
      planMarkdown: "## Plan\n\n1. Fix null handling in lib/user.mjs.\n2. Rename displayName to display for clarity and update the test.\n",
      summary: "Fixed null handling and renamed the export.",
      changes: [
        ch("update", "lib/user.mjs", 'export function display(user) {\n  if (user === null || user === undefined) {\n    return "anonymous";\n  }\n  return user.name.toUpperCase();\n}\n'),
        ch("update", "tests/user.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { display } from "../lib/user.mjs";\n\ntest("null user returns anonymous", () => {\n  assert.equal(display(null), "anonymous");\n});\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 6
  {
    id: "fix-date-format",
    category: "bug-fix",
    title: "Fix the date format to ISO",
    description: "formatDate must emit YYYY-MM-DD; it currently emits MM-DD-YYYY. The failing test documents the bug.",
    repoFiles: {
      "lib/format.mjs":
        'export function formatDate(date) {\n  const y = date.getFullYear();\n  const m = String(date.getMonth() + 1).padStart(2, "0");\n  const d = String(date.getDate()).padStart(2, "0");\n  return `${m}-${d}-${y}`;\n}\n',
      "tests/format.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { formatDate } from "../lib/format.mjs";\n\ntest("ISO format", () => {\n  assert.equal(formatDate(new Date("2026-12-31")), "2026-12-31");\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { formatDate } from "../lib/format.mjs";\n\ntest("ISO output", () => {\n  assert.equal(formatDate(new Date("2026-01-05")), "2026-01-05");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "fix-date-format", title: "ISO dates" },
      goal: "formatDate emits YYYY-MM-DD.",
      requirements: [req("FIX-001", "formatDate emits ISO dates.", "must", [cmdAcc("FIX-001-A", TEST_CMD)])],
    },
    groundTruth: {
      requirements: [gt("GT-001", "ISO output", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: TEST_CMD, expectBefore: "fail" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Fix date ordering", intent: "emit year first", satisfies: ["FIX-001"], read: ["tests/**"], write: ["lib/format.mjs"] }),
        verifyTask("T002", ["T001"], ["FIX-001"]),
      ],
      executor: {
        T001: execDone("Fixed the format order.", [
          ch("update", "lib/format.mjs", 'export function formatDate(date) {\n  const y = date.getFullYear();\n  const m = String(date.getMonth() + 1).padStart(2, "0");\n  const d = String(date.getDate()).padStart(2, "0");\n  return `${y}-${m}-${d}`;\n}\n'),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Swap the template order in formatDate.\n",
      summary: "Fixed format order.",
      changes: [
        ch("update", "lib/format.mjs", 'export function formatDate(date) {\n  const y = date.getFullYear();\n  const m = String(date.getMonth() + 1).padStart(2, "0");\n  const d = String(date.getDate()).padStart(2, "0");\n  return `${y}-${m}-${d}`;\n}\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 7
  {
    id: "refactor-split-module",
    category: "refactoring",
    title: "Split handlers.mjs into focused modules",
    description:
      "lib/handlers.mjs holds two unrelated handlers. Split into lib/handlers/handle-a.mjs and lib/handlers/handle-b.mjs, with lib/handlers.mjs kept as a re-export barrel so existing imports continue to work. No behaviour change.",
    repoFiles: {
      "lib/handlers.mjs": 'export function handleA(x) {\n  return `a:${x}`;\n}\n\nexport function handleB(x) {\n  return `b:${x}`;\n}\n',
      "tests/handlers.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { handleA, handleB } from "../lib/handlers.mjs";\n\ntest("handlers", () => {\n  assert.equal(handleA(1), "a:1");\n  assert.equal(handleB(2), "b:2");\n});\n',
    },
    gradingFiles: {
      "grading/gt-3.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { handleA, handleB } from "../lib/handlers.mjs";\n\ntest("barrel still exports both", () => {\n  assert.equal(handleA(1), "a:1");\n  assert.equal(handleB(2), "b:2");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "refactor-split-module", title: "Split handlers" },
      goal: "Handlers live in focused modules behind the existing import path.",
      requirements: [
        req("RF-001", "handleA lives in lib/handlers/handle-a.mjs.", "must", [fileAcc("RF-001-A", "lib/handlers/handle-a.mjs", { exists: true })]),
        req("RF-002", "handleB lives in lib/handlers/handle-b.mjs.", "must", [fileAcc("RF-002-A", "lib/handlers/handle-b.mjs", { exists: true })]),
      ],
      constraints: [
        constraint("RF-C01", "Existing imports from lib/handlers.mjs keep working.", [cmdAcc("RF-C01-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "handle-a module exists", gtFile("lib/handlers/handle-a.mjs", { contains: "handleA" })),
        gt("GT-002", "handle-b module exists", gtFile("lib/handlers/handle-b.mjs", { contains: "handleB" })),
        gt("GT-003", "barrel re-exports both", gtCmd('node --test "grading/gt-3.mjs"')),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Split handler modules", intent: "create focused modules and keep the barrel", satisfies: ["RF-001", "RF-002"], read: ["lib/**", "tests/**"], write: ["lib/handlers/**", "lib/handlers.mjs"] }),
        verifyTask("T002", ["T001"], ["RF-001", "RF-002", "RF-C01"]),
      ],
      executor: {
        T001: execDone("Split handlers and kept the barrel.", [
          ch("create", "lib/handlers/handle-a.mjs", 'export function handleA(x) {\n  return `a:${x}`;\n}\n'),
          ch("create", "lib/handlers/handle-b.mjs", 'export function handleB(x) {\n  return `b:${x}`;\n}\n'),
          ch("update", "lib/handlers.mjs", 'export { handleA } from "./handlers/handle-a.mjs";\nexport { handleB } from "./handlers/handle-b.mjs";\n'),
        ]),
      },
    },
    control: {
      // The baseline agent splits the files but deletes the old module.
      planMarkdown: "## Plan\n\n1. Create lib/handlers/handle-a.mjs and handle-b.mjs.\n2. Remove the old lib/handlers.mjs (superseded).\n",
      summary: "Split the handlers module.",
      changes: [
        ch("create", "lib/handlers/handle-a.mjs", 'export function handleA(x) {\n  return `a:${x}`;\n}\n'),
        ch("create", "lib/handlers/handle-b.mjs", 'export function handleB(x) {\n  return `b:${x}`;\n}\n'),
        ch("delete", "lib/handlers.mjs"),
      ],
      claimedDone: true,
      ranTests: false,
    },
  },

  // ---------------------------------------------------------------- 8 (trap: concurrent write / overwrite)
  {
    id: "refactor-rename-internal",
    category: "refactoring",
    trap: "two edits, one file (serialization)",
    title: "Rename internal helpers, keeping aliases",
    description:
      "lib/util.mjs exports doubleInternal and halveInternal. Rename them to double and halve, keeping the old names as aliases. Both renames are independent concerns in the same file; behaviour must not change.",
    repoFiles: {
      "lib/util.mjs": "export function doubleInternal(n) {\n  return n * 2;\n}\n\nexport function halveInternal(n) {\n  return n / 2;\n}\n",
      "tests/util.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { doubleInternal, halveInternal } from "../lib/util.mjs";\n\ntest("helpers", () => {\n  assert.equal(doubleInternal(4), 8);\n  assert.equal(halveInternal(4), 2);\n});\n',
    },
    gradingFiles: {
      "grading/gt-3.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { doubleInternal, halveInternal } from "../lib/util.mjs";\n\ntest("aliases preserved", () => {\n  assert.equal(doubleInternal(4), 8);\n  assert.equal(halveInternal(4), 2);\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "refactor-rename-internal", title: "Rename helpers" },
      goal: "Internal helpers get clean names; old names keep working.",
      requirements: [
        req("RF-001", "double(n) exists.", "must", [fileAcc("RF-001-A", "lib/util.mjs", { contains: "export function double" })]),
        req("RF-002", "halve(n) exists.", "must", [fileAcc("RF-002-A", "lib/util.mjs", { contains: "export function halve" })]),
      ],
      constraints: [
        constraint("RF-C01", "doubleInternal and halveInternal remain exported aliases.", [cmdAcc("RF-C01-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "double exists", gtFile("lib/util.mjs", { contains: "export function double(" })),
        gt("GT-002", "halve exists", gtFile("lib/util.mjs", { contains: "export function halve(" })),
        gt("GT-003", "aliases still work", gtCmd('node --test "grading/gt-3.mjs"')),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      // The planner serializes two tasks that write the same file.
      planTasks: [
        planTask({ id: "T001", title: "Rename doubleInternal to double", intent: "rename with alias", satisfies: ["RF-001"], read: ["tests/**"], write: ["lib/util.mjs"] }),
        planTask({ id: "T002", title: "Rename halveInternal to halve", intent: "rename with alias", deps: ["T001"], satisfies: ["RF-002"], read: ["tests/**"], write: ["lib/util.mjs"] }),
        verifyTask("T003", ["T002"], ["RF-001", "RF-002", "RF-C01"]),
      ],
      executor: {
        T001: execDone("Renamed doubleInternal.", [
          ch("update", "lib/util.mjs", "export function double(n) {\n  return n * 2;\n}\n\nexport const doubleInternal = double;\n\nexport function halveInternal(n) {\n  return n / 2;\n}\n"),
        ]),
        T002: execDone("Renamed halveInternal.", [
          ch("update", "lib/util.mjs", "export function double(n) {\n  return n * 2;\n}\n\nexport const doubleInternal = double;\n\nexport function halve(n) {\n  return n / 2;\n}\n\nexport const halveInternal = halve;\n"),
        ]),
      },
    },
    control: {
      // Both planned edits target the same file; the second edit rewrites the
      // whole file and loses the first rename (classic overwrite).
      planMarkdown: "## Plan\n\n1. Rename doubleInternal to double (keep alias).\n2. Rename halveInternal to halve (keep alias).\n",
      summary: "Renamed both helpers.",
      changes: [
        ch("update", "lib/util.mjs", "export function double(n) {\n  return n * 2;\n}\n\nexport const doubleInternal = double;\n\nexport function halveInternal(n) {\n  return n / 2;\n}\n"),
      ],
      claimedDone: true,
      ranTests: false,
    },
  },

  // ---------------------------------------------------------------- 9
  {
    id: "refactor-extract-const",
    category: "refactoring",
    title: "Extract pricing constants",
    description:
      "lib/pricing.mjs embeds magic numbers. Extract UNIT_PRICE = 25 and BASE_FEE = 5 as named constants. No behaviour change.",
    repoFiles: {
      "lib/pricing.mjs": "export function total(items) {\n  return items.length * 25 + 5;\n}\n",
      "tests/pricing.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { total } from "../lib/pricing.mjs";\n\ntest("total", () => {\n  assert.equal(total([{}, {}, {}]), 80);\n});\n',
    },
    gradingFiles: {
      "grading/gt-2.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { total } from "../lib/pricing.mjs";\n\ntest("behaviour preserved", () => {\n  assert.equal(total([]), 5);\n  assert.equal(total([{}]), 30);\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "refactor-extract-const", title: "Named pricing constants" },
      goal: "Pricing numbers are named constants; behaviour unchanged.",
      requirements: [
        req("RF-001", "UNIT_PRICE and BASE_FEE constants exist.", "must", [fileAcc("RF-001-A", "lib/pricing.mjs", { contains: "UNIT_PRICE" })]),
      ],
      constraints: [
        constraint("RF-C01", "total() behaviour unchanged.", [cmdAcc("RF-C01-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "constants extracted", gtFile("lib/pricing.mjs", { contains: "UNIT_PRICE" })),
        gt("GT-002", "behaviour preserved", gtCmd('node --test "grading/gt-2.mjs"')),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Extract constants", intent: "name the magic numbers", satisfies: ["RF-001"], read: ["tests/**"], write: ["lib/pricing.mjs"] }),
        verifyTask("T002", ["T001"], ["RF-001", "RF-C01"]),
      ],
      executor: {
        T001: execDone("Extracted constants.", [
          ch("update", "lib/pricing.mjs", "export const UNIT_PRICE = 25;\nexport const BASE_FEE = 5;\n\nexport function total(items) {\n  return items.length * UNIT_PRICE + BASE_FEE;\n}\n"),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Introduce constants and use them in total().\n",
      summary: "Extracted constants.",
      changes: [
        ch("update", "lib/pricing.mjs", "export const UNIT_PRICE = 25;\nexport const BASE_FEE = 5;\n\nexport function total(items) {\n  return items.length * UNIT_PRICE + BASE_FEE;\n}\n"),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 10 (trap: preserve old API)
  {
    id: "api-optional-param",
    category: "api-change",
    trap: "preserve old API",
    title: "Add an optional formal mode to render()",
    description:
      "render(user) returns \"Hi <name>\". Add an optional second argument { formal: true } returning \"Dear <name>\". The existing one-argument call must keep working exactly as before; the existing tests must keep passing.",
    repoFiles: {
      "lib/render.mjs": 'export function render(user) {\n  return `Hi ${user.name}`;\n}\n',
      "tests/render.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { render } from "../lib/render.mjs";\n\ntest("informal greeting", () => {\n  assert.equal(render({ name: "ada" }), "Hi ada");\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { render } from "../lib/render.mjs";\n\ntest("formal mode", () => {\n  assert.equal(render({ name: "ada" }, { formal: true }), "Dear ada");\n});\n',
      "grading/gt-2.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { render } from "../lib/render.mjs";\n\ntest("old API preserved", () => {\n  assert.equal(render({ name: "ada" }), "Hi ada");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "api-optional-param", title: "Formal render mode" },
      goal: "render() supports a formal mode without breaking its existing signature.",
      requirements: [
        req("API-001", "render(user, { formal: true }) returns \"Dear <name>\".", "must", [cmdAcc("API-001-A", TEST_CMD)]),
      ],
      constraints: [
      ],
      constraints: [
        constraint("API-C01", "render(user) with one argument still returns \"Hi <name>\"; the existing test suite must keep passing.", [cmdAcc("API-C01-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "formal mode works", gtCmd('node --test "grading/gt-1.mjs"')),
        gt("GT-002", "old API preserved", gtCmd('node --test "grading/gt-2.mjs"')),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Add optional formal mode", intent: "extend render with an options argument and cover both modes with tests", satisfies: ["API-001"], read: ["tests/**"], write: ["lib/render.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["API-001", "API-C01"]),
      ],
      executor: {
        T001: execDone("Added formal mode with tests for both signatures.", [
          ch("update", "lib/render.mjs", 'export function render(user, opts = {}) {\n  return `${opts.formal ? "Dear" : "Hi"} ${user.name}`;\n}\n'),
          ch("create", "tests/render-formal.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { render } from "../lib/render.mjs";\n\ntest("formal mode", () => {\n  assert.equal(render({ name: "ada" }, { formal: true }), "Dear ada");\n});\n'),
        ]),
      },
    },
    control: {
      // The baseline agent "modernizes" the signature and updates the old
      // test to the new call convention, breaking every existing caller.
      planMarkdown: "## Plan\n\n1. Change render to accept ({ user, formal }) — cleaner than positional args.\n2. Update the old test to the new call convention.\n",
      summary: "Modernized the render signature with a formal mode.",
      changes: [
        ch("update", "lib/render.mjs", 'export function render({ user, formal }) {\n  return `${formal ? "Dear" : "Hi"} ${user.name}`;\n}\n'),
        ch("update", "tests/render.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { render } from "../lib/render.mjs";\n\ntest("informal greeting", () => {\n  assert.equal(render({ user: { name: "ada" } }), "Hi ada");\n});\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 11
  {
    id: "api-deprecate-field",
    category: "api-change",
    title: "Add displayName alongside name",
    description: "summary(user) returns { name }. Add a displayName field (upper-cased); keep the name field for compatibility.",
    repoFiles: {
      "lib/summary.mjs": "export function summary(user) {\n  return { name: user.name };\n}\n",
      "tests/summary.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { summary } from "../lib/summary.mjs";\n\ntest("summary has name", () => {\n  assert.deepEqual(summary({ name: "ada" }), { name: "ada" });\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { summary } from "../lib/summary.mjs";\n\ntest("both fields", () => {\n  const s = summary({ name: "ada" });\n  assert.equal(s.displayName, "ADA");\n  assert.equal(s.name, "ada");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "api-deprecate-field", title: "displayName field" },
      goal: "Summary exposes displayName while name remains.",
      requirements: [
        req("API-001", "summary() returns displayName (upper-case) and keeps name.", "must", [cmdAcc("API-001-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [gt("GT-001", "both fields present", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Add displayName", intent: "extend summary and adjust the test to the new object shape", satisfies: ["API-001"], read: ["tests/**"], write: ["lib/summary.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["API-001"]),
      ],
      executor: {
        T001: execDone("Added displayName.", [
          ch("update", "lib/summary.mjs", "export function summary(user) {\n  return { name: user.name, displayName: user.name.toUpperCase() };\n}\n"),
          ch("update", "tests/summary.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { summary } from "../lib/summary.mjs";\n\ntest("summary has both fields", () => {\n  assert.deepEqual(summary({ name: "ada" }), { name: "ada", displayName: "ADA" });\n});\n'),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Add displayName to the summary object; keep name.\n2. Update the shape test.\n",
      summary: "Added displayName.",
      changes: [
        ch("update", "lib/summary.mjs", "export function summary(user) {\n  return { name: user.name, displayName: user.name.toUpperCase() };\n}\n"),
        ch("update", "tests/summary.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { summary } from "../lib/summary.mjs";\n\ntest("summary has both fields", () => {\n  assert.deepEqual(summary({ name: "ada" }), { name: "ada", displayName: "ADA" });\n});\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 12
  {
    id: "api-version-header",
    category: "api-change",
    title: "Include an API version header",
    description: "respond(body) returns { status: 200, body }. Add headers: { \"X-API-Version\": \"1\" }. Keep status and body.",
    repoFiles: {
      "lib/respond.mjs": "export function respond(body) {\n  return { status: 200, body };\n}\n",
      "tests/respond.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { respond } from "../lib/respond.mjs";\n\ntest("respond shape", () => {\n  assert.deepEqual(respond("x"), { status: 200, body: "x" });\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { respond } from "../lib/respond.mjs";\n\ntest("version header", () => {\n  const r = respond("x");\n  assert.equal(r.headers["X-API-Version"], "1");\n  assert.equal(r.status, 200);\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "api-version-header", title: "API version header" },
      goal: "Responses carry the API version.",
      requirements: [req("API-001", "respond() includes the X-API-Version header.", "must", [cmdAcc("API-001-A", TEST_CMD)])],
    },
    groundTruth: {
      requirements: [gt("GT-001", "header present", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Add version header", intent: "extend respond and update the shape test", satisfies: ["API-001"], read: ["tests/**"], write: ["lib/respond.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["API-001"]),
      ],
      executor: {
        T001: execDone("Added the version header.", [
          ch("update", "lib/respond.mjs", 'export function respond(body) {\n  return { status: 200, body, headers: { "X-API-Version": "1" } };\n}\n'),
          ch("update", "tests/respond.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { respond } from "../lib/respond.mjs";\n\ntest("respond shape", () => {\n  assert.deepEqual(respond("x"), { status: 200, body: "x", headers: { "X-API-Version": "1" } });\n});\n'),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Add headers to the respond object.\n2. Update the shape test.\n",
      summary: "Added version header.",
      changes: [
        ch("update", "lib/respond.mjs", 'export function respond(body) {\n  return { status: 200, body, headers: { "X-API-Version": "1" } };\n}\n'),
        ch("update", "tests/respond.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { respond } from "../lib/respond.mjs";\n\ntest("respond shape", () => {\n  assert.deepEqual(respond("x"), { status: 200, body: "x", headers: { "X-API-Version": "1" } });\n});\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 13
  {
    id: "schema-add-field",
    category: "schema-change",
    title: "Accept a retries field with default",
    description:
      "normalize({ url }) returns { url }. Accept an optional retries number; when absent default it to 3; when present keep it.",
    repoFiles: {
      "lib/config.mjs": "export function normalize(input) {\n  return { url: input.url };\n}\n",
      "tests/config.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { normalize } from "../lib/config.mjs";\n\ntest("url kept", () => {\n  assert.deepEqual(normalize({ url: "u" }), { url: "u", retries: 3 });\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { normalize } from "../lib/config.mjs";\n\ntest("default and explicit retries", () => {\n  assert.equal(normalize({ url: "u" }).retries, 3);\n  assert.equal(normalize({ url: "u", retries: 7 }).retries, 7);\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "schema-add-field", title: "retries field" },
      goal: "Configuration accepts retries with a default of 3.",
      requirements: [req("SCH-001", "normalize() applies retries default 3 and keeps explicit values.", "must", [cmdAcc("SCH-001-A", TEST_CMD)])],
    },
    groundTruth: {
      requirements: [gt("GT-001", "default and explicit retries", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: TEST_CMD, expectBefore: "fail" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Add retries with default", intent: "extend normalize and the test", satisfies: ["SCH-001"], read: ["tests/**"], write: ["lib/config.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["SCH-001"]),
      ],
      executor: {
        T001: execDone("Added retries with default.", [
          ch("update", "lib/config.mjs", "export function normalize(input) {\n  return { url: input.url, retries: input.retries ?? 3 };\n}\n"),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Add retries with a ?? default in normalize.\n",
      summary: "Added retries default.",
      changes: [ch("update", "lib/config.mjs", "export function normalize(input) {\n  return { url: input.url, retries: input.retries ?? 3 };\n}\n")],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 14
  {
    id: "schema-rename-field",
    category: "schema-change",
    title: "Prefer endpoint, keep url as alias",
    description:
      "normalize() currently reads url. Accept endpoint as the preferred field name; when only url is given it must still work (endpoint falls back to url).",
    repoFiles: {
      "lib/config.mjs": "export function normalize(input) {\n  return { url: input.url };\n}\n",
      "tests/config.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { normalize } from "../lib/config.mjs";\n\ntest("url still accepted", () => {\n  assert.equal(normalize({ url: "u" }).url, "u");\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { normalize } from "../lib/config.mjs";\n\ntest("endpoint preferred, url alias", () => {\n  assert.equal(normalize({ endpoint: "e" }).endpoint, "e");\n  assert.equal(normalize({ url: "u" }).endpoint, "u");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "schema-rename-field", title: "endpoint field" },
      goal: "endpoint is the preferred config field; url remains accepted.",
      requirements: [
        req("SCH-001", "normalize() accepts endpoint, falling back to url.", "must", [cmdAcc("SCH-001-A", TEST_CMD)]),
      ],
      constraints: [
      ],
      constraints: [
        constraint("SCH-C01", "Existing url-only configuration keeps working.", [cmdAcc("SCH-C01-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [gt("GT-001", "preferred + alias both work", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Add endpoint with url fallback", intent: "extend normalize with a test for both spellings", satisfies: ["SCH-001"], read: ["tests/**"], write: ["lib/config.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["SCH-001", "SCH-C01"]),
      ],
      executor: {
        T001: execDone("Added endpoint with url fallback.", [
          ch("update", "lib/config.mjs", "export function normalize(input) {\n  const url = input.endpoint ?? input.url;\n  return { url, endpoint: url };\n}\n"),
          ch("update", "tests/config.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { normalize } from "../lib/config.mjs";\n\ntest("url alias and endpoint", () => {\n  assert.equal(normalize({ url: "u" }).endpoint, "u");\n  assert.equal(normalize({ endpoint: "e" }).endpoint, "e");\n});\n'),
        ]),
      },
    },
    control: {
      // The baseline agent renames without keeping the alias.
      planMarkdown: "## Plan\n\n1. Replace url with endpoint in normalize (clean break).\n",
      summary: "Renamed url to endpoint.",
      changes: [ch("update", "lib/config.mjs", "export function normalize(input) {\n  return { endpoint: input.endpoint };\n}\n")],
      claimedDone: true,
      ranTests: false,
    },
  },

  // ---------------------------------------------------------------- 15
  {
    id: "schema-narrow-type",
    category: "schema-change",
    title: "parseId must return numbers",
    description:
      "parseId(v) currently returns whatever it is given. It must return a number: numeric strings and numbers are converted, anything else throws.",
    repoFiles: {
      "lib/id.mjs": "export function parseId(value) {\n  return value;\n}\n",
      "tests/id.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { parseId } from "../lib/id.mjs";\n\ntest("numeric ids", () => {\n  assert.equal(parseId("12"), 12);\n  assert.equal(parseId(7), 7);\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { parseId } from "../lib/id.mjs";\n\ntest("narrowing", () => {\n  assert.equal(parseId("12"), 12);\n  assert.throws(() => parseId("abc"));\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "schema-narrow-type", title: "numeric ids" },
      goal: "parseId produces numbers or throws.",
      requirements: [req("SCH-001", "parseId converts numeric input and throws otherwise.", "must", [cmdAcc("SCH-001-A", TEST_CMD)])],
    },
    groundTruth: {
      requirements: [gt("GT-001", "conversion + rejection", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: TEST_CMD, expectBefore: "fail" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Narrow parseId", intent: "validate and convert with a rejection test", satisfies: ["SCH-001"], read: ["tests/**"], write: ["lib/id.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["SCH-001"]),
      ],
      executor: {
        T001: execDone("Narrowed parseId.", [
          ch("update", "lib/id.mjs", "export function parseId(value) {\n  const n = Number(value);\n  if (!Number.isFinite(n) || String(value).trim() === \"\") {\n    throw new Error(`invalid id: ${String(value)}`);\n  }\n  return n;\n}\n"),
          ch("update", "tests/id.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { parseId } from "../lib/id.mjs";\n\ntest("numeric ids", () => {\n  assert.equal(parseId("12"), 12);\n  assert.equal(parseId(7), 7);\n  assert.throws(() => parseId("abc"));\n});\n'),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Coerce with Number() and throw when NaN.\n",
      summary: "Narrowed parseId.",
      changes: [
        ch("update", "lib/id.mjs", "export function parseId(value) {\n  const n = Number(value);\n  if (!Number.isFinite(n) || String(value).trim() === \"\") {\n    throw new Error(`invalid id: ${String(value)}`);\n  }\n  return n;\n}\n"),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },
];
