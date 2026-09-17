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

/** Categories: dependency-integration, security-fix, test-only, configuration-change, multi-package. */

export const TASKS_PART_2 = [

  // ---------------------------------------------------------------- 16
  {
    id: "dep-node-crypto",
    category: "dependency-integration",
    title: "Use node:crypto for hashing",
    description:
      "lib/hash.mjs hand-rolls a weak hash. Replace it with SHA-256 via node:crypto createHash; hash(s) returns the lowercase hex digest.",
    repoFiles: {
      "lib/hash.mjs": "export function hash(s) {\n  let h = 0;\n  for (const c of s) {\n    h = (h * 31 + c.charCodeAt(0)) | 0;\n  }\n  return String(h);\n}\n",
      "tests/hash.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { createHash } from "node:crypto";\nimport { hash } from "../lib/hash.mjs";\n\ntest("sha256 hex digest", () => {\n  assert.equal(hash("abc"), createHash("sha256").update("abc").digest("hex"));\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { createHash } from "node:crypto";\nimport { hash } from "../lib/hash.mjs";\n\ntest("digest matches sha256", () => {\n  assert.equal(hash("spc"), createHash("sha256").update("spc").digest("hex"));\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "dep-node-crypto", title: "SHA-256 hashing" },
      goal: "hash() is a real SHA-256 via node:crypto.",
      requirements: [
        req("DEP-001", "hash() returns the SHA-256 hex digest using node:crypto.", "must", [cmdAcc("DEP-001-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "digest correct", gtCmd('node --test "grading/gt-1.mjs"')),
        gt("GT-002", "uses node:crypto", gtFile("lib/hash.mjs", { contains: "node:crypto" })),
      ],
      regression: { command: TEST_CMD, expectBefore: "fail" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Switch to node:crypto", intent: "replace the hand-rolled hash and update the test", satisfies: ["DEP-001"], read: ["tests/**"], write: ["lib/hash.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["DEP-001"]),
      ],
      executor: {
        T001: execDone("Replaced with node:crypto SHA-256.", [
          ch("update", "lib/hash.mjs", 'import { createHash } from "node:crypto";\n\nexport function hash(s) {\n  return createHash("sha256").update(s).digest("hex");\n}\n'),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Import createHash and return the sha256 hex digest.\n",
      summary: "Switched to node:crypto.",
      changes: [
        ch("update", "lib/hash.mjs", 'import { createHash } from "node:crypto";\n\nexport function hash(s) {\n  return createHash("sha256").update(s).digest("hex");\n}\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 17
  {
    id: "dep-intl-currency",
    category: "dependency-integration",
    title: "Format currency with Intl",
    description:
      "lib/money.mjs builds \"$1,234.57\" by hand. Use Intl.NumberFormat (USD, 2 fraction digits); output must stay identical.",
    repoFiles: {
      "lib/money.mjs": 'export function usd(amount) {\n  return "$" + amount.toFixed(2);\n}\n',
      "tests/money.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { usd } from "../lib/money.mjs";\n\ntest("usd", () => {\n  assert.equal(usd(5), "$5.00");\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { usd } from "../lib/money.mjs";\n\ntest("output preserved", () => {\n  assert.equal(usd(1234.567), "$1,234.57");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "dep-intl-currency", title: "Intl currency" },
      goal: "usd() delegates to Intl.NumberFormat with identical output.",
      requirements: [
        req("DEP-001", "usd() formats via Intl.NumberFormat with unchanged output.", "must", [cmdAcc("DEP-001-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "output preserved", gtCmd('node --test "grading/gt-1.mjs"')),
        gt("GT-002", "uses Intl", gtFile("lib/money.mjs", { contains: "Intl.NumberFormat" })),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Adopt Intl.NumberFormat", intent: "replace manual formatting", satisfies: ["DEP-001"], read: ["tests/**"], write: ["lib/money.mjs"] }),
        verifyTask("T002", ["T001"], ["DEP-001"]),
      ],
      executor: {
        T001: execDone("Adopted Intl.NumberFormat.", [
          ch("update", "lib/money.mjs", 'const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });\n\nexport function usd(amount) {\n  return fmt.format(amount);\n}\n'),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Replace string concatenation with an Intl.NumberFormat instance.\n",
      summary: "Adopted Intl.",
      changes: [
        ch("update", "lib/money.mjs", 'const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });\n\nexport function usd(amount) {\n  return fmt.format(amount);\n}\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 18
  {
    id: "dep-url-searchparams",
    category: "dependency-integration",
    title: "Build query strings with URLSearchParams",
    description:
      "lib/link.mjs concatenates query strings by hand. Use URLSearchParams on the base https://example.test/; link({a: 1}) must return \"https://example.test/?a=1\".",
    repoFiles: {
      "lib/link.mjs": 'export function link(params) {\n  let q = "";\n  for (const [k, v] of Object.entries(params)) {\n    q += (q ? "&" : "") + k + "=" + v;\n  }\n  return "https://example.test/?" + q;\n}\n',
      "tests/link.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { link } from "../lib/link.mjs";\n\ntest("link", () => {\n  assert.equal(link({ a: 1 }), "https://example.test/?a=1");\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { link } from "../lib/link.mjs";\n\ntest("encoding handled", () => {\n  assert.equal(link({ q: "a b" }), "https://example.test/?q=a+b");\n  assert.equal(link({ a: 1, b: 2 }), "https://example.test/?a=1&b=2");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "dep-url-searchparams", title: "URLSearchParams links" },
      goal: "link() builds URLs with URLSearchParams.",
      requirements: [req("DEP-001", "link() uses URLSearchParams and encodes correctly.", "must", [cmdAcc("DEP-001-A", TEST_CMD)])],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "encoding handled", gtCmd('node --test "grading/gt-1.mjs"')),
        gt("GT-002", "uses URLSearchParams", gtFile("lib/link.mjs", { contains: "URLSearchParams" })),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Adopt URLSearchParams", intent: "replace manual concatenation with an encoding test", satisfies: ["DEP-001"], read: ["tests/**"], write: ["lib/link.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["DEP-001"]),
      ],
      executor: {
        T001: execDone("Adopted URLSearchParams.", [
          ch("update", "lib/link.mjs", 'export function link(params) {\n  const q = new URLSearchParams();\n  for (const [k, v] of Object.entries(params)) {\n    q.set(k, String(v));\n  }\n  return `https://example.test/?${q.toString()}`;\n}\n'),
          ch("create", "tests/link-encoding.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { link } from "../lib/link.mjs";\n\ntest("encoding", () => {\n  assert.equal(link({ q: "a b" }), "https://example.test/?q=a+b");\n});\n'),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Replace manual concatenation with URLSearchParams.\n",
      summary: "Adopted URLSearchParams.",
      changes: [
        ch("update", "lib/link.mjs", 'export function link(params) {\n  const q = new URLSearchParams();\n  for (const [k, v] of Object.entries(params)) {\n    q.set(k, String(v));\n  }\n  return `https://example.test/?${q.toString()}`;\n}\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 19
  {
    id: "sec-remove-eval",
    category: "security-fix",
    title: "Remove eval from the calculator",
    description:
      "lib/calc.mjs uses eval. Replace it with a small safe evaluator supporting + - * /, integers, parentheses and spaces. No eval, no Function constructor anywhere in the file.",
    repoFiles: {
      "lib/calc.mjs": "export function calc(expr) {\n  return eval(expr);\n}\n",
      "tests/calc.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { calc } from "../lib/calc.mjs";\n\ntest("arithmetic", () => {\n  assert.equal(calc("2+3*4"), 14);\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { calc } from "../lib/calc.mjs";\n\ntest("safe evaluator", () => {\n  assert.equal(calc("2+3*4"), 14);\n  assert.equal(calc("(2+3)*2"), 10);\n  assert.equal(calc("10 / 4"), 2.5);\n  assert.throws(() => calc("process.exit(1)"));\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "sec-remove-eval", title: "Safe calculator" },
      goal: "calc() evaluates arithmetic without eval.",
      requirements: [
        req("SEC-001", "calc() evaluates + - * / and parentheses without eval.", "must", [cmdAcc("SEC-001-A", TEST_CMD)]),
      ],
      constraints: [
      ],
      constraints: [
        constraint("SEC-C01", "The file contains no eval and no Function constructor.", [fileAcc("SEC-C01-A", "lib/calc.mjs", { notContains: "eval(" })]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "safe evaluation", gtCmd('node --test "grading/gt-1.mjs"')),
        gt("GT-002", "no eval left", gtFile("lib/calc.mjs", { notContains: "eval(" })),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Replace eval with a parser", intent: "implement a small recursive-descent evaluator with tests", satisfies: ["SEC-001"], read: ["tests/**"], write: ["lib/calc.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["SEC-001", "SEC-C01"]),
      ],
      executor: {
        T001: execDone("Replaced eval with a recursive-descent parser.", [
          ch("update", "lib/calc.mjs", [
            "function tokenize(src) {",
            "  const tokens = [];",
            "  let i = 0;",
            "  while (i < src.length) {",
            "    const ch = src[i];",
            "    if (ch === \" \") {",
            "      i += 1;",
            "      continue;",
            "    }",
            "    if (/[0-9.]/.test(ch)) {",
            "      let j = i;",
            "      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;",
            "      tokens.push(src.slice(i, j));",
            "      i = j;",
            "      continue;",
            "    }",
            "    if (\"+-*/()\".includes(ch)) {",
            "      tokens.push(ch);",
            "      i += 1;",
            "      continue;",
            "    }",
            "    throw new Error(`unexpected character: ${ch}`);",
            "  }",
            "  return tokens;",
            "}",
            "",
            "export function calc(expr) {",
            "  const tokens = tokenize(expr);",
            "  let pos = 0;",
            "  const peek = () => tokens[pos];",
            "  const take = () => tokens[pos++];",
            "  function parseExpr() {",
            "    let value = parseTerm();",
            "    while (peek() === \"+\" || peek() === \"-\") {",
            "      const op = take();",
            "      value = op === \"+\" ? value + parseTerm() : value - parseTerm();",
            "    }",
            "    return value;",
            "  }",
            "  function parseTerm() {",
            "    let value = parseFactor();",
            "    while (peek() === \"*\" || peek() === \"/\") {",
            "      const op = take();",
            "      value = op === \"*\" ? value * parseFactor() : value / parseFactor();",
            "    }",
            "    return value;",
            "  }",
            "  function parseFactor() {",
            "    if (peek() === \"(\") {",
            "      take();",
            "      const value = parseExpr();",
            "      if (take() !== \")\") throw new Error(\"unbalanced expression\");",
            "      return value;",
            "    }",
            "    const token = take();",
            "    if (token === undefined || !/^[0-9.]+$/.test(token)) {",
            "      throw new Error(`unexpected token: ${String(token)}`);",
            "    }",
            "    return Number(token);",
            "  }",
            "  const result = parseExpr();",
            "  if (pos !== tokens.length) throw new Error(\"trailing input\");",
            "  return result;",
            "}",
            "",
          ].join("\n")),
          ch("create", "tests/calc-safe.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { calc } from "../lib/calc.mjs";\n\ntest("rejects non-arithmetic", () => {\n  assert.throws(() => calc("process.exit(1)"));\n});\n'),
        ]),
      },
    },
    control: {
      // The baseline agent replaces the entry point but leaves an eval-based
      // helper behind.
      planMarkdown: "## Plan\n\n1. Wrap eval in a sanity check for allowed characters, keep a raw escape hatch for complex input.\n",
      summary: "Sanitized the calculator.",
      changes: [
        ch("update", "lib/calc.mjs", 'export function calc(expr) {\n  if (!/^[0-9+\\-*/().\\s]+$/.test(expr)) {\n    throw new Error("invalid expression");\n  }\n  return eval(expr);\n}\n\nexport function calcUnsafe(expr) {\n  return eval(expr);\n}\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 20
  {
    id: "sec-redact-token",
    category: "security-fix",
    title: "Redact tokens in report lines",
    description:
      "lib/report.mjs logs user tokens in cleartext. line(user) must replace the token with [REDACTED]; everything else stays. Update the test to assert redaction.",
    repoFiles: {
      "lib/report.mjs": "export function line(user) {\n  return `user ${user.id} token ${user.token}`;\n}\n",
      "tests/report.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { line } from "../lib/report.mjs";\n\ntest("line format", () => {\n  assert.equal(line({ id: "u1", token: "s3cret" }), "user u1 token s3cret");\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { line } from "../lib/report.mjs";\n\ntest("token redacted", () => {\n  const out = line({ id: "u1", token: "s3cret-value" });\n  assert.ok(out.includes("[REDACTED]"));\n  assert.ok(!out.includes("s3cret-value"));\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "sec-redact-token", title: "Token redaction" },
      goal: "Tokens never appear in report lines.",
      requirements: [req("SEC-001", "line() renders the token as [REDACTED].", "must", [cmdAcc("SEC-001-A", TEST_CMD)])],
    },
    groundTruth: {
      requirements: [gt("GT-001", "token redacted", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Redact tokens", intent: "mask the token and update the test to assert redaction", satisfies: ["SEC-001"], read: ["tests/**"], write: ["lib/report.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["SEC-001"]),
      ],
      executor: {
        T001: execDone("Redacted tokens.", [
          ch("update", "lib/report.mjs", "export function line(user) {\n  return `user ${user.id} token [REDACTED]`;\n}\n"),
          ch("update", "tests/report.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { line } from "../lib/report.mjs";\n\ntest("token redacted", () => {\n  assert.equal(line({ id: "u1", token: "s3cret" }), "user u1 token [REDACTED]");\n});\n'),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Replace the token with [REDACTED] in the template.\n2. Update the test.\n",
      summary: "Redacted tokens.",
      changes: [
        ch("update", "lib/report.mjs", "export function line(user) {\n  return `user ${user.id} token [REDACTED]`;\n}\n"),
        ch("update", "tests/report.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { line } from "../lib/report.mjs";\n\ntest("token redacted", () => {\n  assert.equal(line({ id: "u1", token: "s3cret" }), "user u1 token [REDACTED]");\n});\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 21
  {
    id: "sec-path-traversal",
    category: "security-fix",
    title: "Reject path traversal in readPath",
    description:
      "lib/assets.mjs joins user input onto a base path. readPath(base, rel) must return null when rel tries to escape the base (contains ..); normal relative paths keep working.",
    repoFiles: {
      "lib/assets.mjs": "import path from \"node:path\";\n\nexport function readPath(base, rel) {\n  return path.join(base, rel);\n}\n",
      "tests/assets.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readPath } from "../lib/assets.mjs";\n\ntest("normal path", () => {\n  assert.equal(readPath("/tmp/a", "sub/x.txt"), "/tmp/a/sub/x.txt");\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readPath } from "../lib/assets.mjs";\n\ntest("traversal rejected", () => {\n  assert.equal(readPath("/tmp/a", "../etc/passwd"), null);\n});\n',
      "grading/gt-2.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readPath } from "../lib/assets.mjs";\n\ntest("normal paths still work", () => {\n  assert.equal(readPath("/tmp/a", "sub/x.txt"), "/tmp/a/sub/x.txt");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "sec-path-traversal", title: "Traversal guard" },
      goal: "readPath refuses to escape the base directory.",
      requirements: [
        req("SEC-001", "readPath returns null for traversal attempts.", "must", [cmdAcc("SEC-001-A", TEST_CMD)]),
      ],
      constraints: [
        constraint("SEC-C01", "Normal relative paths keep resolving.", [cmdAcc("SEC-C01-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "traversal returns null", gtCmd('node --test "grading/gt-1.mjs"')),
        gt("GT-002", "normal paths unaffected", gtCmd('node --test "grading/gt-2.mjs"')),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Guard traversal", intent: "reject .. segments with a test", satisfies: ["SEC-001"], read: ["tests/**"], write: ["lib/assets.mjs", "tests/**"] }),
        verifyTask("T002", ["T001"], ["SEC-001", "SEC-C01"]),
      ],
      executor: {
        T001: execDone("Added traversal guard.", [
          ch("update", "lib/assets.mjs", 'import path from "node:path";\n\nexport function readPath(base, rel) {\n  const segments = String(rel).split("/");\n  if (segments.includes("..")) {\n    return null;\n  }\n  return path.join(base, rel);\n}\n'),
          ch("create", "tests/traversal.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readPath } from "../lib/assets.mjs";\n\ntest("traversal rejected", () => {\n  assert.equal(readPath("/tmp/a", "../etc/passwd"), null);\n});\n'),
        ]),
      },
    },
    control: {
      // The baseline agent guards but returns the joined path instead of null.
      planMarkdown: "## Plan\n\n1. If rel contains .., log a warning and return the joined path so callers can handle it.\n",
      summary: "Added traversal warning.",
      changes: [
        ch("update", "lib/assets.mjs", 'import path from "node:path";\n\nexport function readPath(base, rel) {\n  if (String(rel).split("/").includes("..")) {\n    console.error("warning: traversal attempt");\n  }\n  return path.join(base, rel);\n}\n'),
      ],
      claimedDone: true,
      ranTests: false,
    },
  },

  // ---------------------------------------------------------------- 22
  {
    id: "test-add-coverage",
    category: "test-only",
    title: "Cover median()",
    description:
      "lib/stats.mjs has median() with no tests. Add tests for median covering odd and even length inputs. Do not change lib/.",
    repoFiles: {
      "lib/stats.mjs": "export function mean(xs) {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n\nexport function median(xs) {\n  const sorted = [...xs].sort((a, b) => a - b);\n  const mid = Math.floor(sorted.length / 2);\n  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;\n}\n",
      "tests/stats.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { mean } from "../lib/stats.mjs";\n\ntest("mean", () => {\n  assert.equal(mean([1, 2, 3]), 2);\n});\n',
    },
    gradingFiles: {
      "grading/gt-2.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { median } from "../lib/stats.mjs";\n\ntest("median behaviour unchanged", () => {\n  assert.equal(median([3, 1, 2]), 2);\n  assert.equal(median([4, 1, 3, 2]), 2.5);\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "test-add-coverage", title: "median coverage" },
      goal: "median() is under test.",
      requirements: [
        req("TST-001", "Tests cover median for odd and even inputs.", "must", [cmdAcc("TST-001-A", 'grep -rq "median" tests')]),
      ],
      constraints: [constraint("TST-C01", "lib/ is not modified.", [cmdAcc("TST-C01-A", TEST_CMD)])],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "median is tested", gtCmd('grep -rq "median" tests')),
        gt("GT-002", "median behaviour unchanged", gtCmd('node --test "grading/gt-2.mjs"')),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
      forbidden: ["lib/**"],
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Add median tests", kind: "test", intent: "cover odd and even inputs without touching lib/", satisfies: ["TST-001"], read: ["lib/**", "tests/**"], write: ["tests/**"] }),
        verifyTask("T002", ["T001"], ["TST-001", "TST-C01"]),
      ],
      executor: {
        T001: execDone("Added median tests.", [
          ch("create", "tests/median.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { median } from "../lib/stats.mjs";\n\ntest("median odd", () => {\n  assert.equal(median([3, 1, 2]), 2);\n});\n\ntest("median even", () => {\n  assert.equal(median([4, 1, 3, 2]), 2.5);\n});\n'),
        ]),
      },
    },
    control: {
      // The baseline agent adds the tests but cannot resist "improving" lib/.
      planMarkdown: "## Plan\n\n1. Add median tests.\n2. Tidy up median while we're in there (early return style).\n",
      summary: "Added median tests and tidied median().",
      changes: [
        ch("update", "lib/stats.mjs", "export function mean(xs) {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n\nexport function median(xs) {\n  const sorted = [...xs].sort((a, b) => a - b);\n  const mid = Math.floor(sorted.length / 2);\n  if (sorted.length % 2 === 1) {\n    return sorted[mid];\n  }\n  return (sorted[mid - 1] + sorted[mid]) / 2;\n}\n"),
        ch("create", "tests/median.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { median } from "../lib/stats.mjs";\n\ntest("median odd", () => {\n  assert.equal(median([3, 1, 2]), 2);\n});\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 23
  {
    id: "test-fix-expectation",
    category: "test-only",
    title: "Fix the wrong date expectation",
    description:
      "tests/format.test.mjs expects \"12/31/2026\" but the service intentionally emits ISO dates (YYYY-MM-DD, see formatDate). The test is wrong: fix the expectation. Do not change lib/.",
    repoFiles: {
      "lib/format.mjs": "export function formatDate(date) {\n  return date.toISOString().slice(0, 10);\n}\n",
      "tests/format.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { formatDate } from "../lib/format.mjs";\n\ntest("date format", () => {\n  assert.equal(formatDate(new Date("2026-12-31")), "12/31/2026");\n});\n',
    },
    gradingFiles: {
      "grading/gt-2.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { formatDate } from "../lib/format.mjs";\n\ntest("ISO behaviour preserved", () => {\n  assert.equal(formatDate(new Date("2026-01-05")), "2026-01-05");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "test-fix-expectation", title: "Fix the expectation" },
      goal: "The suite passes against the intended ISO behaviour; lib is untouched.",
      requirements: [
        req("TST-001", "The test expectation matches ISO output.", "must", [cmdAcc("TST-001-A", TEST_CMD)]),
      ],
      constraints: [constraint("TST-C01", "lib/format.mjs is not modified; it keeps emitting ISO dates.", [cmdAcc("TST-C01-A", TEST_CMD)])],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "suite passes", gtCmd(TEST_CMD)),
        gt("GT-002", "ISO behaviour preserved", gtCmd('node --test "grading/gt-2.mjs"')),
      ],
      regression: { command: TEST_CMD, expectBefore: "fail" },
      forbidden: ["lib/**"],
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Fix the expectation", kind: "test", intent: "align the test with documented ISO behaviour", satisfies: ["TST-001"], read: ["lib/**", "tests/**"], write: ["tests/**"] }),
        verifyTask("T002", ["T001"], ["TST-001", "TST-C01"]),
      ],
      executor: {
        T001: execDone("Fixed the expectation.", [
          ch("update", "tests/format.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { formatDate } from "../lib/format.mjs";\n\ntest("date format", () => {\n  assert.equal(formatDate(new Date("2026-12-31")), "2026-12-31");\n});\n'),
        ]),
      },
    },
    control: {
      // The baseline agent "fixes" the failing test by changing the library.
      planMarkdown: "## Plan\n\n1. Test fails — make formatDate emit 12/31/2026 so the suite is green.\n",
      summary: "Made the suite pass.",
      changes: [
        ch("update", "lib/format.mjs", 'export function formatDate(date) {\n  const y = date.getFullYear();\n  const m = String(date.getMonth() + 1).padStart(2, "0");\n  const d = String(date.getDate()).padStart(2, "0");\n  return `${m}/${d}/${y}`;\n}\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 24
  {
    id: "test-edge-cases",
    category: "test-only",
    title: "Add slug edge-case tests",
    description:
      "lib/slug.mjs is tested only for simple inputs. Add tests covering slug(\"\") (empty string) and a unicode input. Do not change lib/.",
    repoFiles: {
      "lib/slug.mjs": 'export function slug(s) {\n  return s\n    .normalize("NFKD")\n    .replace(/[\\p{Diacritic}]/gu, "")\n    .toLowerCase()\n      .replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-+|-+$/g, "");\n}\n',
      "tests/slug.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../lib/slug.mjs";\n\ntest("simple", () => {\n  assert.equal(slug("Hello World"), "hello-world");\n});\n',
    },
    gradingFiles: {
      "grading/gt-2.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../lib/slug.mjs";\n\ntest("behaviour unchanged", () => {\n  assert.equal(slug("Hello World"), "hello-world");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "test-edge-cases", title: "slug edge cases" },
      goal: "slug() is tested for empty and unicode input.",
      requirements: [
        req("TST-001", "Tests cover slug(\"\") and a unicode input.", "must", [cmdAcc("TST-001-A", 'grep -rq \'slug("")\' tests')]),
      ],
      constraints: [constraint("TST-C01", "lib/ is not modified.", [cmdAcc("TST-C01-A", TEST_CMD)])],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "edge cases tested", gtCmd('grep -rq \'slug("")\' tests')),
        gt("GT-002", "behaviour unchanged", gtCmd('node --test "grading/gt-2.mjs"')),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
      forbidden: ["lib/**"],
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Add edge-case tests", kind: "test", intent: "cover empty and unicode inputs", satisfies: ["TST-001"], read: ["lib/**", "tests/**"], write: ["tests/**"] }),
        verifyTask("T002", ["T001"], ["TST-001", "TST-C01"]),
      ],
      executor: {
        T001: execDone("Added edge-case tests.", [
          ch("create", "tests/slug-edge.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../lib/slug.mjs";\n\ntest("empty input", () => {\n  assert.equal(slug(""), "");\n});\n\ntest("unicode", () => {\n  assert.equal(slug("Héllo Wörld"), "hello-world");\n});\n'),
        ]),
      },
    },
    control: {
      // Adds the tests, but also "cleans up" the regex chain in lib/.
      planMarkdown: "## Plan\n\n1. Add empty/unicode tests.\n2. Reformat the slug chain for readability while we're there.\n",
      summary: "Added edge-case tests and tidied slug().",
      changes: [
        ch("update", "lib/slug.mjs", 'export function slug(s) {\n  return s\n    .normalize("NFKD")\n    .replace(/[\\p{Diacritic}]/gu, "")\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-+|-+$/g, "");\n}\n'),
        ch("create", "tests/slug-edge.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../lib/slug.mjs";\n\ntest("empty input", () => {\n  assert.equal(slug(""), "");\n});\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 25
  {
    id: "config-env-port",
    category: "configuration-change",
    title: "Make the port configurable",
    description: "lib/server.mjs hard-codes 8080. Read the port from process.env.PORT, falling back to 8080.",
    repoFiles: {
      "lib/server.mjs": "export function port() {\n  return 8080;\n}\n",
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { port } from "../lib/server.mjs";\n\ntest("env override and default", () => {\n  process.env.PORT = "3000";\n  assert.equal(port(), 3000);\n  delete process.env.PORT;\n  assert.equal(port(), 8080);\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "config-env-port", title: "PORT from environment" },
      goal: "The port comes from PORT with default 8080.",
      requirements: [
        req("CFG-001", "port() honours process.env.PORT with default 8080.", "must", [fileAcc("CFG-001-A", "lib/server.mjs", { contains: "process.env.PORT" })]),
      ],
    },
    groundTruth: {
      requirements: [gt("GT-001", "env override and default", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: "node -e 0", expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Read PORT from env", intent: "env override with default", satisfies: ["CFG-001"], write: ["lib/server.mjs"] }),
        verifyTask("T002", ["T001"], ["CFG-001"]),
      ],
      executor: {
        T001: execDone("Read PORT from the environment.", [
          ch("update", "lib/server.mjs", "export function port() {\n  const fromEnv = Number(process.env.PORT);\n  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 8080;\n}\n"),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Use process.env.PORT with a fallback.\n",
      summary: "Made the port configurable.",
      changes: [
        ch("update", "lib/server.mjs", "export function port() {\n  const fromEnv = Number(process.env.PORT);\n  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 8080;\n}\n"),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 26
  {
    id: "config-timeout",
    category: "configuration-change",
    title: "Add a request timeout constant",
    description: "lib/client.mjs has no timeout. Export TIMEOUT_MS = 5000 and use it in request()'s simulated timeout path. The value must be overridable via the TIMEOUT_MS environment variable.",
    repoFiles: {
      "lib/client.mjs": "export function request(label) {\n  return `requested:${label}`;\n}\n",
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { TIMEOUT_MS } from "../lib/client.mjs";\n\ntest("default timeout", () => {\n  assert.equal(TIMEOUT_MS, 5000);\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "config-timeout", title: "Request timeout" },
      goal: "A 5000ms default timeout, overridable via the environment.",
      requirements: [
        req("CFG-001", "TIMEOUT_MS defaults to 5000 and honours the environment.", "must", [fileAcc("CFG-001-A", "lib/client.mjs", { contains: "5000" })]),
      ],
    },
    groundTruth: {
      requirements: [gt("GT-001", "default timeout exported", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: "node -e 0", expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Add TIMEOUT_MS", intent: "export the constant with env override", satisfies: ["CFG-001"], write: ["lib/client.mjs"] }),
        verifyTask("T002", ["T001"], ["CFG-001"]),
      ],
      executor: {
        T001: execDone("Added TIMEOUT_MS.", [
          ch("update", "lib/client.mjs", "export const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 5000;\n\nexport function request(label) {\n  return `requested:${label} timeout:${TIMEOUT_MS}`;\n}\n"),
        ]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Export a TIMEOUT_MS constant (env-overridable, default 5000) and use it.\n",
      summary: "Added the timeout constant.",
      changes: [
        ch("update", "lib/client.mjs", "export const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 5000;\n\nexport function request(label) {\n  return `requested:${label} timeout:${TIMEOUT_MS}`;\n}\n"),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 27
  {
    id: "config-gitignore-dist",
    category: "configuration-change",
    title: "Ignore build output",
    description: "The build writes to dist/ but .gitignore does not exclude it. Add dist/ to .gitignore without removing existing entries.",
    repoFiles: {
      ".gitignore": "node_modules/\n",
      "lib/build.mjs": 'import { mkdirSync, writeFileSync } from "node:fs";\n\nexport function build() {\n  mkdirSync("dist", { recursive: true });\n  writeFileSync("dist/out.txt", "built");\n  return "dist/out.txt";\n}\n',
    },
    gradingFiles: {},
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "config-gitignore-dist", title: "Ignore dist/" },
      goal: "Build output is not tracked.",
      requirements: [
        req("CFG-001", ".gitignore contains dist/ and keeps node_modules/.", "must", [fileAcc("CFG-001-A", ".gitignore", { contains: "dist/" })]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "dist ignored", gtFile(".gitignore", { contains: "dist/" })),
        gt("GT-002", "node_modules entry kept", gtFile(".gitignore", { contains: "node_modules" })),
      ],
      regression: { command: "node -e 0", expectBefore: "pass" },
      forbidden: ["tests/**"],
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Add dist/ to .gitignore", intent: "append the build output entry", satisfies: ["CFG-001"], write: [".gitignore"] }),
        verifyTask("T002", ["T001"], ["CFG-001"]),
      ],
      executor: {
        T001: execDone("Ignored dist/.", [ch("update", ".gitignore", "node_modules/\ndist/\n")]),
      },
    },
    control: {
      planMarkdown: "## Plan\n\n1. Add dist/ to .gitignore.\n",
      summary: "Ignored dist/.",
      changes: [ch("update", ".gitignore", "node_modules/\ndist/\n")],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 28
  {
    id: "mono-shared-const",
    category: "multi-package",
    title: "Share the version constant",
    description:
      "packages/a and packages/b each define their own VERSION = \"1\". Create packages/shared/version.mjs as the single source and have both packages re-export from it. Behaviour must not change.",
    repoFiles: {
      "packages/a/index.mjs": 'export const VERSION = "1";\n\nexport function aInfo() {\n  return `a:${VERSION}`;\n}\n',
      "packages/b/index.mjs": 'export const VERSION = "1";\n\nexport function bInfo() {\n  return `b:${VERSION}`;\n}\n',
      "tests/version.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { VERSION as va, aInfo } from "../packages/a/index.mjs";\nimport { VERSION as vb, bInfo } from "../packages/b/index.mjs";\n\ntest("versions agree", () => {\n  assert.equal(va, vb);\n  assert.equal(aInfo(), "a:1");\n  assert.equal(bInfo(), "b:1");\n});\n',
    },
    gradingFiles: {
      "grading/gt-2.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { aInfo } from "../packages/a/index.mjs";\nimport { bInfo } from "../packages/b/index.mjs";\n\ntest("both consume shared", () => {\n  assert.equal(aInfo(), "a:1");\n  assert.equal(bInfo(), "b:1");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "mono-shared-const", title: "Shared version module" },
      goal: "One version constant, consumed by both packages.",
      requirements: [
        req("MONO-001", "packages/shared/version.mjs is the single source of VERSION.", "must", [fileAcc("MONO-001-A", "packages/shared/version.mjs", { exists: true })]),
        req("MONO-002", "Both packages re-export the shared constant.", "must", [cmdAcc("MONO-002-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "shared module exists", gtFile("packages/shared/version.mjs", { contains: '"1"' })),
        gt("GT-002", "both consume it", gtCmd('node --test "grading/gt-2.mjs"')),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Extract shared version and repoint packages", intent: "create the shared module and re-export in both packages", satisfies: ["MONO-001", "MONO-002"], read: ["tests/**"], write: ["packages/shared/**", "packages/a/**", "packages/b/**"] }),
        verifyTask("T002", ["T001"], ["MONO-001", "MONO-002"]),
      ],
      executor: {
        T001: execDone("Extracted the shared constant.", [
          ch("create", "packages/shared/version.mjs", 'export const VERSION = "1";\n'),
          ch("update", "packages/a/index.mjs", 'export { VERSION } from "../shared/version.mjs";\n\nimport { VERSION } from "../shared/version.mjs";\n\nexport function aInfo() {\n  return `a:${VERSION}`;\n}\n'),
          ch("update", "packages/b/index.mjs", 'export { VERSION } from "../shared/version.mjs";\n\nimport { VERSION } from "../shared/version.mjs";\n\nexport function bInfo() {\n  return `b:${VERSION}`;\n}\n'),
        ]),
      },
    },
    control: {
      // The baseline agent extracts the shared module and updates package a,
      // then declares done having forgotten package b.
      planMarkdown: "## Plan\n\n1. Create packages/shared/version.mjs.\n2. Repoint packages/a (the one with the failing-ish usage).\n",
      summary: "Shared the version constant.",
      changes: [
        ch("create", "packages/shared/version.mjs", 'export const VERSION = "1";\n'),
        ch("update", "packages/a/index.mjs", 'export { VERSION } from "../shared/version.mjs";\n\nimport { VERSION } from "../shared/version.mjs";\n\nexport function aInfo() {\n  return `a:${VERSION}`;\n}\n'),
      ],
      claimedDone: true,
      ranTests: true,
    },
  },

  // ---------------------------------------------------------------- 29
  {
    id: "mono-cross-feature",
    category: "multi-package",
    title: "App greeting uses strings.exclaim",
    description:
      "packages/strings exports exclaim(s) (appends \"!\"); packages/app exports greeting(s) returning the input unchanged. Change greeting to return exclaim(s). Update the existing app test to the new behaviour.",
    repoFiles: {
      "packages/strings/index.mjs": "export function exclaim(s) {\n  return `${s}!`;\n}\n",
      "packages/app/index.mjs": "export function greeting(s) {\n  return s;\n}\n",
      "tests/app.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greeting } from "../packages/app/index.mjs";\n\ntest("greeting", () => {\n  assert.equal(greeting("hi"), "hi");\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greeting } from "../packages/app/index.mjs";\n\ntest("cross-package greeting", () => {\n  assert.equal(greeting("hi"), "hi!");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "mono-cross-feature", title: "Cross-package greeting" },
      goal: "app.greeting composes strings.exclaim.",
      requirements: [
        req("MONO-001", "greeting(s) returns exclaim(s).", "must", [cmdAcc("MONO-001-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [gt("GT-001", "cross-package composition", gtCmd('node --test "grading/gt-1.mjs"'))],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Compose exclaim into greeting", intent: "wire app to strings and update the app test", satisfies: ["MONO-001"], read: ["tests/**", "packages/**"], write: ["packages/app/**", "tests/**"] }),
        verifyTask("T002", ["T001"], ["MONO-001"]),
      ],
      executor: {
        T001: execDone("Composed exclaim into greeting.", [
          ch("update", "packages/app/index.mjs", 'import { exclaim } from "../strings/index.mjs";\n\nexport function greeting(s) {\n  return exclaim(s);\n}\n'),
          ch("update", "tests/app.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greeting } from "../packages/app/index.mjs";\n\ntest("greeting", () => {\n  assert.equal(greeting("hi"), "hi!");\n});\n'),
        ]),
      },
    },
    control: {
      // Implements the composition but never updates the existing test.
      planMarkdown: "## Plan\n\n1. Import exclaim in packages/app and use it in greeting.\n",
      summary: "Wired greeting to exclaim.",
      changes: [
        ch("update", "packages/app/index.mjs", 'import { exclaim } from "../strings/index.mjs";\n\nexport function greeting(s) {\n  return exclaim(s);\n}\n'),
      ],
      claimedDone: true,
      ranTests: false,
    },
  },

  // ---------------------------------------------------------------- 30
  {
    id: "mono-version-bump",
    category: "multi-package",
    title: "Bump the shared API version to v2",
    description:
      "packages/shared/meta.mjs exports API = \"v1\"; packages/a and packages/b expose apiName() returning \"api-v1\" and are tested accordingly. Bump the shared constant to \"v2\" and update BOTH consumers (and the tests) so apiName() returns \"api-v2\" everywhere.",
    repoFiles: {
      "packages/shared/meta.mjs": 'export const API = "v1";\n',
      "packages/a/index.mjs": 'export function apiName() {\n  return "api-v1";\n}\n',
      "packages/b/index.mjs": 'export function apiName() {\n  return "api-v1";\n}\n',
      "tests/api.test.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { apiName as a } from "../packages/a/index.mjs";\nimport { apiName as b } from "../packages/b/index.mjs";\n\ntest("api names", () => {\n  assert.equal(a(), "api-v1");\n  assert.equal(b(), "api-v1");\n});\n',
    },
    gradingFiles: {
      "grading/gt-1.mjs":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { apiName as a } from "../packages/a/index.mjs";\nimport { apiName as b } from "../packages/b/index.mjs";\n\ntest("both bumped", () => {\n  assert.equal(a(), "api-v2");\n  assert.equal(b(), "api-v2");\n});\n',
    },
    spec: {
      apiVersion: "spc.dev/v1alpha1",
      kind: "Spec",
      metadata: { id: "mono-version-bump", title: "API v2" },
      goal: "The shared API version is v2 everywhere.",
      requirements: [
        req("MONO-001", "Shared constant is v2 and both apiName()s return api-v2.", "must", [cmdAcc("MONO-001-A", TEST_CMD)]),
      ],
    },
    groundTruth: {
      requirements: [
        gt("GT-001", "both consumers bumped", gtCmd('node --test "grading/gt-1.mjs"')),
        gt("GT-002", "shared constant bumped", gtFile("packages/shared/meta.mjs", { contains: '"v2"' })),
      ],
      regression: { command: TEST_CMD, expectBefore: "pass" },
    },
    treatment: {
      planTasks: [
        planTask({ id: "T001", title: "Bump shared constant", intent: "API -> v2", satisfies: ["MONO-001"], write: ["packages/shared/**"] }),
        planTask({ id: "T002", title: "Update both consumers and tests", intent: "derive apiName from the shared constant; update tests", deps: ["T001"], satisfies: ["MONO-001"], read: ["tests/**"], write: ["packages/a/**", "packages/b/**", "tests/**"] }),
        verifyTask("T003", ["T002"], ["MONO-001"]),
      ],
      executor: {
        T001: execDone("Bumped shared constant.", [ch("update", "packages/shared/meta.mjs", 'export const API = "v2";\n')]),
        T002: execDone("Updated consumers and tests.", [
          ch("update", "packages/a/index.mjs", 'import { API } from "../shared/meta.mjs";\n\nexport function apiName() {\n  return `api-${API}`;\n}\n'),
          ch("update", "packages/b/index.mjs", 'import { API } from "../shared/meta.mjs";\n\nexport function apiName() {\n  return `api-${API}`;\n}\n'),
          ch("update", "tests/api.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { apiName as a } from "../packages/a/index.mjs";\nimport { apiName as b } from "../packages/b/index.mjs";\n\ntest("api names", () => {\n  assert.equal(a(), "api-v2");\n  assert.equal(b(), "api-v2");\n});\n'),
        ]),
      },
    },
    control: {
      // Bumps shared + package a + tests for a; package b is forgotten, so the
      // updated suite goes red — yet the agent declares done.
      planMarkdown: "## Plan\n\n1. Bump packages/shared to v2.\n2. Update packages/a and the tests.\n",
      summary: "Bumped to v2.",
      changes: [
        ch("update", "packages/shared/meta.mjs", 'export const API = "v2";\n'),
        ch("update", "packages/a/index.mjs", 'import { API } from "../shared/meta.mjs";\n\nexport function apiName() {\n  return `api-${API}`;\n}\n'),
        ch("update", "tests/api.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { apiName as a } from "../packages/a/index.mjs";\nimport { apiName as b } from "../packages/b/index.mjs";\n\ntest("api names", () => {\n  assert.equal(a(), "api-v2");\n});\n'),
      ],
      claimedDone: true,
      ranTests: false,
    },
  },
];
