import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The research-pdf dogfood fixture (specs/research-pdf-dogfood): a
 * stand-alone NON-CODE git repository - research source, recorded
 * data, a committed minimal PDF, fixture-authored check scripts, a
 * spec whose acceptance criteria invoke those scripts - running the
 * ordinary spc loop through the existing CLI. Fully deterministic and
 * offline: the PDF is a handcrafted minimal artifact, the checks are
 * pure node fs scripts, and the loop's model surface is the fake
 * provider's scripted YAML. The kernel's write-scope, patch-op,
 * deadline, and ownership machinery is path-and-command shaped - this
 * fixture holds that to the light.
 *
 * Variants:
 *  - loop            defect A state (manuscript 42, faithful PDF) + the scripted planner/executor that corrects the manuscript and regenerates the PDF
 *  - faithful-defect  A: wrong number in the manuscript, PDF faithful to it (source red, correspondence green)
 *  - stale           B: correct manuscript, stale PDF (source green, correspondence red)
 *  - layout          C: correct + corresponding PDF without the page-footer marker (layout red, others green)
 *  - corrupt         D: undeterminable artifact bytes (the layout check cannot determine - it hangs past the command budget, budget-timeout, inconclusive - never a fabricated visual failure)
 */

export interface PdfFixture {
  root: string;
  specFile: string;
}

const MANUSCRIPT = (n: number): string => `# Observational findings\n\nResult: ${n}\n\n## References\n\nSee references.json.\n`;

const PDF = (n: number, withFooter: boolean): string =>
  [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj",
    "4 0 obj << /Length 0000 >> stream",
    `BT (Result: ${n}) Tj ET`,
    "BT (References) Tj ET",
    ...(withFooter ? ["BT (/1) Tj ET"] : []),
    "endstream endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
    "",
  ].join("\n");

const REFERENCES = `[{"id":"r1","title":"A observational study","year":2026}]\n`;
const OBSERVATIONS = "run,value\n1,38\n2,39\n3,40\n4,41\n";

const SOURCE_CHECK = `import { readFileSync } from "node:fs";
const ms = readFileSync("manuscript.md", "utf8");
const n = Number(/Result:\\s*(\\d+)/.exec(ms)?.[1]);
const rows = readFileSync("data/observations.csv", "utf8").trim().split("\\n");
const m = Number(rows[rows.length - 1].split(",")[1]);
if (!Number.isFinite(n) || !Number.isFinite(m)) { console.error("undeterminable source"); process.exit(1); }
if (n !== m) { console.error("manuscript says " + n + ", data says " + m); process.exit(1); }
console.log("source consistent: " + n);
`;

const CORRESPONDENCE_CHECK = `import { readFileSync } from "node:fs";
const ms = readFileSync("manuscript.md", "utf8");
const n = Number(/Result:\\s*(\\d+)/.exec(ms)?.[1]);
const pdf = readFileSync("paper.pdf", "latin1");
const p = Number(/Result:\\s*(\\d+)/.exec(pdf)?.[1]);
if (!Number.isFinite(n) || !Number.isFinite(p)) { console.error("undeterminable correspondence"); process.exit(1); }
if (n !== p) { console.error("pdf reports " + p + ", manuscript reports " + n); process.exit(1); }
console.log("pdf corresponds: " + p);
`;

const LAYOUT_CHECK = `import { readFileSync } from "node:fs";
const pdf = readFileSync("paper.pdf", "latin1");
if (!pdf.includes("%PDF")) {
  // The render check cannot determine the result deterministically -
  // it refuses to fabricate a visual verdict and outlives the command
  // budget: budget-timeout, inconclusive through the existing
  // classification family.
  console.error("render check cannot determine the artifact (no PDF header) - refusing to fabricate a visual verdict");
  setInterval(() => {}, 60_000); // a live handle: the check truly outlives the command budget
  await new Promise(() => {});
}
const missing = [];
if (!pdf.includes("(/1)")) missing.push("page footer");
if (!pdf.includes("(References)")) missing.push("references heading");
if (missing.length > 0) { console.error("layout markers missing: " + missing.join(", ")); process.exit(1); }
console.log("layout markers present");
`;

const SPEC = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: paper
  title: Manuscript integrity
goal: >
  The manuscript's reported result matches the recorded observations,
  the committed PDF corresponds to the manuscript, and the rendered
  artifact carries its layout markers.
requirements:
  - id: RPF-001
    statement: the manuscript's Result matches the final observation in data/observations.csv
    priority: must
    acceptance:
      - id: RPF-001-A
        type: command
        command: node checks/source-check.mjs
        expect: {exitCode: 0}
  - id: RPF-002
    statement: the committed PDF's reported result corresponds to the manuscript's
    priority: must
    acceptance:
      - id: RPF-002-A
        type: command
        command: node checks/correspondence-check.mjs
        expect: {exitCode: 0}
  - id: RPF-003
    statement: the rendered artifact carries its layout markers (page footer, references heading)
    priority: must
    acceptance:
      - id: RPF-003-A
        type: command
        command: node checks/layout-check.mjs
        expect: {exitCode: 0}
`;

const CONFIG = `version: 1
provider:
  name: fake
  script: .spc/fake-script.yaml
execution:
  commandTimeoutMs: 8000
  inPlace: true
  inPlaceBranch: current
`;

const FAKE_SCRIPT = `planner:
  value:
    plan:
      tasks:
        - id: T001
          title: Correct the manuscript result and regenerate the PDF
          kind: modify
          intent: The manuscript reports 42 but the final observation is 41 - correct the manuscript and regenerate the committed PDF so the source and correspondence criteria both hold.
          dependsOn: []
          satisfies: [RPF-001, RPF-002, RPF-003]
          targets:
            read: [manuscript.md, data/observations.csv, paper.pdf]
            write: [manuscript.md, paper.pdf]
    observations: []
    assumptions: []
    followups: []
executor:
  T001:
    status: completed
    summary: corrected the manuscript result to 41 and re-rendered the committed PDF
    changes:
      - op: update
        path: manuscript.md
        content: |
          # Observational findings

          Result: 41

          ## References

          See references.json.
      - op: update
        path: paper.pdf
        content: |
          %PDF-1.4
          1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
          2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
          3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj
          4 0 obj << /Length 0000 >> stream
          BT (Result: 41) Tj ET
          BT (References) Tj ET
          BT (/1) Tj ET
          endstream endobj
          trailer << /Root 1 0 R >>
          %%EOF
`;

export type PdfVariant = "loop" | "faithful-defect" | "stale" | "layout" | "corrupt";

export function makePdfRepo(variant: PdfVariant): PdfFixture {
  const root = mkdtempSync(path.join(tmpdir(), "spc-rpdf-"));
  const write = (rel: string, content: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content, "utf8");
  };
  const git = (args: string[]): void => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };

  // The manuscript/PDF state per variant. Ground truth is 41.
  let manuscript = 41;
  let pdfNumber = 41;
  let withFooter = true;
  let corrupt = false;
  if (variant === "loop" || variant === "faithful-defect") {
    manuscript = 42; // the wrong number, PDF faithful to it
    pdfNumber = 42;
  } else if (variant === "stale") {
    manuscript = 41; // corrected manuscript...
    pdfNumber = 42; // ...stale PDF
  } else if (variant === "layout") {
    withFooter = false; // correct + corresponding, missing the footer marker
  } else if (variant === "corrupt") {
    corrupt = true; // undeterminable artifact bytes
  }

  write("manuscript.md", MANUSCRIPT(manuscript));
  write("references.json", REFERENCES);
  write("data/observations.csv", OBSERVATIONS);
  write("paper.pdf", corrupt ? "this is not a pdf, just bytes\n" : PDF(pdfNumber, withFooter));
  write("checks/source-check.mjs", SOURCE_CHECK);
  write("checks/correspondence-check.mjs", CORRESPONDENCE_CHECK);
  write("checks/layout-check.mjs", LAYOUT_CHECK);
  write("specs/paper.yaml", SPEC);
  write(".gitignore", ".spc/runs/\n.spc/plans/\n.spc/worktrees/\n.spc/cache/\n.spc/harness/\n");
  git(["init", "-q", "-b", "main"]);
  // spc init ON THE REAL SUBSTRATE (a git repository that already
  // carries the research content) creates specs/ and .spc/ with the
  // default config - the fixture then replaces the provider surface.
  const init = spc({ root, specFile: "" }, ["init"]);
  if (init.status !== 0) throw new Error("spc init failed on the fixture substrate: " + init.out);
  // The scripted model surface: the full loop carries the corrective
  // plan; every other variant carries an inert stub (verify constructs
  // the provider but never consults the planner).
  write(".spc/fake-script.yaml", variant === "loop" ? FAKE_SCRIPT : "planner:\n  value: {}\n");
  // spc init creates specs/ and .spc/ with the default config; the
  // fixture then carries the fake provider + a tight command budget.
  write(".spc/config.yaml", CONFIG);
  git(["add", "-A"]);
  git(["commit", "-qm", "research fixture base"]);
  return { root, specFile: "specs/paper.yaml" };
}

export function cleanupPdf(fixture: PdfFixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

/** Run the repo's spc CLI in-place (cwd-scoped, like an operator). */
export function spc(fixture: PdfFixture, args: string[], timeoutMs = 120_000): { status: number; out: string } {
  const CLI = new URL("../dist/main.js", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
  });
  return { status: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** The criteria's own stdout/stderr ride the run's evidence payloads,
 *  not the verify table - this surfaces them for assertions. */
export function evidenceOutput(fixture: PdfFixture): string {
  const runsDir = path.join(fixture.root, ".spc", "runs");
  const out: string[] = [];
  if (!existsSync(runsDir)) return "";
  for (const run of readdirSync(runsDir)) {
    const file = path.join(runsDir, run, "evidence.jsonl");
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const payload = (JSON.parse(line) as { payload?: Record<string, unknown> }).payload ?? {};
      if (typeof payload["stdout"] === "string") out.push(payload["stdout"]);
      if (typeof payload["stderr"] === "string") out.push(payload["stderr"]);
    }
  }
  return out.join("\n");
}