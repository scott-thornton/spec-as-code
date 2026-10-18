import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import type { FollowUp, RequirementState, RunState } from "@spc/schema";
import { listRunIds, loadRunMeta, loadRunView, latestRunViewForSpec } from "@spc/runtime";
import { resolveRepoRoot } from "../context.js";

/**
 * `spc rectify` - scaffold a rectification spec from findings.
 *
 * The rule it mechanizes: an adversarial pass that changes what you
 * should have meant is NEW INTENT, and new intent gets a new contract -
 * never edit a spec after runs pinned evidence to its digest. The
 * scaffolder produces the stub: one requirement per finding, findings
 * cited in requirement metadata (facts carried, provenance kept), and
 * acceptance criteria left as explicit TODOs for the human - the
 * decisions stay yours. The scaffold DELIBERATELY fails SPC1004 until
 * every TODO criterion is authored; the compiler's error list is the
 * authoring checklist.
 *
 * Inputs:
 *   spc rectify <runId>            findings = that run's unsatisfied /
 *                                   indeterminate properties + open
 *                                   investigation follow-ups
 *   spc rectify --findings <file>  external findings (JSON array:
 *                                   [{id, statement, severity?, class?,
 *                                   propertyRef?}]) - pen-test reports,
 *                                   review rounds
 */

interface ExternalFinding {
  id: string;
  statement: string;
  severity?: string;
  class?: string;
  propertyRef?: string;
}

interface ScaffoldFinding {
  id: string;
  statement: string;
  severity: string;
  klass: string;
  propertyRef?: string;
}

function fromRun(repoRoot: string, runId: string): { specId: string; findings: ScaffoldFinding[]; source: string } {
  const runsDir = path.join(repoRoot, ".spc", "runs");
  const view = loadRunView(runsDir, runId);
  if (!view) throw new SpcError("RUN_NOT_FOUND", `no run ${runId} under ${runsDir}`);
  const findings: ScaffoldFinding[] = [];
  for (const [propertyId, state] of Object.entries(view.state.requirements ?? {})) {
    const s = state as RequirementState;
    if (s.status === "unsatisfied" || s.status === "indeterminate") {
      findings.push({
        id: `${propertyId}-RECT`,
        statement: `${propertyId} ended ${s.status}${s.reason ? ` (${s.reason})` : ""} in run ${runId}.`,
        severity: "major",
        klass: "contract-gap",
        propertyRef: propertyId,
      });
    }
  }
  for (const f of view.followups ?? []) {
    const fu = f as FollowUp;
    if (fu.status === "open" && fu.type === "investigation") {
      findings.push({
        id: `F-${fu.id.replace(/^F-/, "")}-RECT`,
        statement: fu.title,
        severity: "major",
        klass: "contract-gap",
        ...(fu.propertyId ? { propertyRef: fu.propertyId } : {}),
      });
    }
  }
  if (findings.length === 0) {
    throw new SpcError(
      "NOTHING_TO_RECTIFY",
      `run ${runId} has no unsatisfied/indeterminate properties and no open investigation follow-ups; nothing to scaffold`,
    );
  }
  return { specId: view.meta.specId, findings, source: `run ${runId}` };
}

function fromFile(file: string): { findings: ScaffoldFinding[]; source: string } {
  if (!existsSync(file)) throw new SpcError("FILE_NOT_FOUND", `no findings file at ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new SpcError("FILE_INVALID", `findings file is not valid JSON: ${(e as Error).message}`);
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const findings: ScaffoldFinding[] = [];
  for (const raw of arr) {
    const f = raw as Partial<ExternalFinding>;
    if (typeof f.id !== "string" || typeof f.statement !== "string") {
      throw new SpcError("FILE_INVALID", "each finding needs at least {id, statement}");
    }
    findings.push({
      id: `${f.id}-RECT`,
      statement: f.statement,
      severity: f.severity ?? "major",
      klass: f.class ?? "contract-gap",
      ...(f.propertyRef ? { propertyRef: f.propertyRef } : {}),
    });
  }
  if (findings.length === 0) throw new SpcError("FILE_INVALID", "findings file contains no findings");
  return { findings, source: path.basename(file) };
}

/** Most recent spec id with any run, for external-findings lineage. */
function latestSpecId(repoRoot: string): string {
  const runs = listRunIds(path.join(repoRoot, ".spc", "runs"))
    .map((id) => loadRunMeta(path.join(repoRoot, ".spc", "runs"), id))
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return runs[0]?.specId ?? "";
}

function slug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function runRectify(options: { runId?: string; findingsFile?: string; cwd?: string }): number {
  const repoRoot = resolveRepoRoot(options.cwd);
  if (!options.runId && !options.findingsFile) {
    throw new SpcError("RECTIFY_INPUT", "pass a run id or --findings <file.json>");
  }

  let specId: string;
  let findings: ScaffoldFinding[];
  let source: string;
  if (options.runId) {
    ({ specId, findings, source } = fromRun(repoRoot, options.runId));
  } else {
    ({ findings, source } = fromFile(path.resolve(process.cwd(), options.findingsFile!)));
    // External findings carry no spec id; use the most recent run's
    // spec for lineage when one exists, else the placeholder.
    const latest = latestRunViewForSpec(path.join(repoRoot, ".spc", "runs"), latestSpecId(repoRoot));
    specId = latest ? latest.meta.specId : "TARGET-SPEC";
  }

  const rectId = `${slug(specId)}-rectify`;
  const file = path.join(repoRoot, "specs", `${rectId}.yaml`);
  if (existsSync(file)) {
    throw new SpcError("SPEC_EXISTS", `${file} already exists; rectification scaffolds are written once`);
  }

  const lines: string[] = [
    "apiVersion: spc.dev/v1alpha1",
    "kind: Spec",
    "metadata:",
    `  id: ${rectId}`,
    `  title: ${specId} rectification (from ${source})`,
    `goal: >`,
    `  Rectify the findings below against ${specId}. The original spec stays`,
    "  untouched and keeps verifying as a regression gate; this spec is the",
    "  new contract the findings demanded. Human authors every acceptance",
    "  criterion - findings are facts, criteria are decisions.",
    "requirements:",
  ];
  for (const f of findings) {
    lines.push(
      `  - id: ${f.id}`,
      `    statement: ${JSON.stringify(f.statement)}`,
      "    priority: must",
      "    metadata:",
      `      finding: ${JSON.stringify(f.id.replace(/-RECT$/, ""))}`,
      `      findingClass: ${JSON.stringify(f.klass)}`,
      `      findingSeverity: ${JSON.stringify(f.severity)}`,
      ...(f.propertyRef ? [`      relatedProperty: ${JSON.stringify(f.propertyRef)}`] : []),
      "    acceptance:",
      "      # TODO(author): write the criteria that prove this is fixed.",
      "      # Discriminating command criteria for behavior changes; file",
      "      # criteria for structure; human criteria for judgment. A must",
      "      # property without criteria fails SPC1004 - the compiler's",
      "      # error list is the authoring checklist.",
      "      - id: TODOS",
      "        type: file",
      "        path: PATH-THAT-DOES-NOT-EXIST",
      "        assert:",
      "          exists: false",
    );
  }
  lines.push(
    "outOfScope:",
    "  - editing the original spec (its digest history is load-bearing)",
    "",
  );
  mkdirSync(path.join(repoRoot, "specs"), { recursive: true });
  writeFileSync(file, lines.join("\n"), "utf8");

  console.log(`Scaffolded: ${path.relative(process.cwd(), file)}`);
  console.log(`Findings carried as facts: ${findings.length} (from ${source})`);
  console.log("");
  console.log("The scaffold FAILS validation until you author criteria (by design):");
  console.log(`  spc spec validate ${path.relative(process.cwd(), file)}`);
  console.log("");
  console.log("Then plan and apply like any spec:");
  console.log(`  spc plan ${path.relative(process.cwd(), file)}`);
  console.log("The original spec keeps verifying as the regression gate:");
  console.log(`  spc verify specs/${slug(specId)}.yaml`);
  return 0;
}
