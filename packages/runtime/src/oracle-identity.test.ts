import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyCommandOracle,
  compareOracleSnapshots,
  evaluateSynthesisCandidate,
  evaluateInRunFlip,
  oracleSnapshotAt,
  auditSpecsClassification,
} from "./oracle-identity.js";

// Oracle for specs/oracle-identity.yaml (red, committed pre-run): the
// operator's 2026-11-14 ruling, implemented - flips attribute only
// under established oracle identity. Cross-run synthesis with oracle
// drift is REJECTED with the candidate preserved; in-run drift demands
// same-oracle counterfactual replay; extraction is five-way and
// fail-closed; snapshots are recorded at evaluation revisions, never
// from the working tree. Decision record:
// .spc/reviews/oracle-identity-decision.md. Today the module does not
// exist - this is red.

const PKGS = new Map([
  ["@spc/cli", "packages/cli"],
  ["@spc/runtime", "packages/runtime"],
]);

describe("OID-001: extraction classifies five ways, fail-closed", () => {
  it("the dominant grammar resolves: build prefix is command-only, the vitest segment references the oracle file under the filtered package", () => {
    const c = classifyCommandOracle(
      "pnpm --filter @spc/cli... build > /dev/null && pnpm --filter @spc/cli exec vitest run src/challenge-skew-carveout.test.ts",
      PKGS,
    );
    expect(c.kind).toBe("referenced");
    if (c.kind === "referenced") {
      expect(c.files).toEqual(["packages/cli/src/challenge-skew-carveout.test.ts"]);
    }
  });

  it("package test scripts and pnpm -r are UNSUPPORTED (discovery-defined instrument), never implicitly unreferenced", () => {
    expect(classifyCommandOracle("pnpm --filter @spc/cli test", PKGS).kind).toBe("unsupported");
    expect(classifyCommandOracle("pnpm -r run build", PKGS).kind).toBe("unsupported");
  });

  it("shell pipelines, git grep, and unknown grammars are unsupported (fail closed)", () => {
    expect(classifyCommandOracle('test "$(grep -l x specs/*.yaml | grep -cv y)" -eq 0', PKGS).kind).toBe("unsupported");
    expect(classifyCommandOracle("spc agent submit planner-1 --file /tmp/a.json", PKGS).kind).toBe("unsupported");
    expect(classifyCommandOracle("voltron frobnicate", PKGS).kind).toBe("unsupported");
  });

  it("POSITIVELY command-only: test -f and node -e with no repo-file execution are unreferenced", () => {
    expect(classifyCommandOracle("test -f fact.txt", PKGS).kind).toBe("unreferenced");
    expect(classifyCommandOracle('node -e "process.exit(0)"', PKGS).kind).toBe("unreferenced");
  });

  it("node-executed repo scripts are referenced", () => {
    const c = classifyCommandOracle("node scripts/check-skip-unreadable-run.cjs", PKGS);
    expect(c.kind).toBe("referenced");
    if (c.kind === "referenced") expect(c.files).toEqual(["scripts/check-skip-unreadable-run.cjs"]);
  });

  it("compound commands: the WORST segment wins (unsupported beats unreferenced)", () => {
    const c = classifyCommandOracle("test -f fact.txt && pnpm --filter @spc/cli test", PKGS);
    expect(c.kind).toBe("unsupported");
  });

  it("the pinned audit: every command criterion in specs/ classifies; the distribution matches the measured audit (272+ discriminating referenced, at most a handful fail-closed)", () => {
    const audit = auditSpecsClassification(path.resolve(import.meta.dirname, "../../.."), PKGS);
    expect(audit.totalCommands).toBeGreaterThan(370);
    const disc = audit.byFlag.discriminating;
    expect(disc.referenced).toBeGreaterThanOrEqual(270);
    expect(disc.unsupported + disc.unresolved).toBeLessThanOrEqual(4);
  });
});

// A tiny git fixture: two revisions whose oracle bytes differ.
const repo = mkdtempSync(path.join(tmpdir(), "spc-oracle-id-"));
let base = "";
let drifted = "";
beforeAll(() => {
  const git = (args: string[]): void => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  mkdirSync(path.join(repo, "packages/cli/src"), { recursive: true });
  writeFileSync(path.join(repo, "packages/cli/src/foo.test.ts"), "it('v1', () => {})\n");
  writeFileSync(path.join(repo, ".gitignore"), ".spc/\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  writeFileSync(path.join(repo, "packages/cli/src/foo.test.ts"), "it('v2 - the corrected oracle', () => {})\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "oracle fix"]);
  drifted = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("OID-004: snapshots are taken at evaluation revisions, never the working tree", () => {
  it("oracleSnapshotAt digests the referenced files at the revision via the hardened git adapter", () => {
    const snap = oracleSnapshotAt(repo, base, "pnpm --filter @spc/cli exec vitest run src/foo.test.ts", PKGS);
    expect(snap?.files[0]?.path).toBe("packages/cli/src/foo.test.ts");
    expect(snap?.files[0]?.digest).toMatch(/^sha256:/);
    const snap2 = oracleSnapshotAt(repo, drifted, "pnpm --filter @spc/cli exec vitest run src/foo.test.ts", PKGS);
    expect(snap2?.files[0]?.digest).not.toBe(snap?.files[0]?.digest);
  });

  it("compareOracleSnapshots: same revision matched; different revisions drifted; missing file unresolved", () => {
    const cmd = "pnpm --filter @spc/cli exec vitest run src/foo.test.ts";
    const r = compareOracleSnapshots(oracleSnapshotAt(repo, base, cmd, PKGS), oracleSnapshotAt(repo, base, cmd, PKGS));
    expect(r.status).toBe("matched");
    const d = compareOracleSnapshots(oracleSnapshotAt(repo, base, cmd, PKGS), oracleSnapshotAt(repo, drifted, cmd, PKGS));
    expect(d.status).toBe("drifted");
    const u = compareOracleSnapshots(
      oracleSnapshotAt(repo, base, cmd, PKGS),
      { criterionDigest: "x", revision: "nosuchrev", files: [{ path: "packages/cli/src/foo.test.ts", digest: "sha256:y" }] },
    );
    expect(u.status).toBe("unresolved");
  });
});

describe("OID-002: cross-run synthesis gates on oracle identity", () => {
  const cmd = "pnpm --filter @spc/cli exec vitest run src/foo.test.ts";
  const redSnap = oracleSnapshotAt(repo, base, cmd, PKGS);
  const greenSnap = oracleSnapshotAt(repo, drifted, cmd, PKGS);
  const sameSnap = oracleSnapshotAt(repo, base, cmd, PKGS);

  it("matched (or unreferenced) synthesizes with synthesizedFlip provenance", () => {
    const d = evaluateSynthesisCandidate({ runId: "run-a", revision: base }, { runId: "run-b", revision: base }, compareOracleSnapshots(redSnap, sameSnap));
    expect(d.established).toBe(true);
    expect(d.provenance).toBe("synthesizedFlip");
  });

  it("drifted REJECTS: no flip, the candidate preserved with reason, paths, and both revisions - rendered as 'Synthesis rejected: oracle drift'", () => {
    const d = evaluateSynthesisCandidate({ runId: "run-a", revision: base }, { runId: "run-b", revision: drifted }, compareOracleSnapshots(redSnap, greenSnap));
    expect(d.established).toBe(false);
    expect(d.rejected?.reason).toBe("oracle-drift");
    expect(d.rejected?.paths).toContain("packages/cli/src/foo.test.ts");
    expect(d.rejected?.redRevision).toBe(base);
    expect(d.rejected?.greenRevision).toBe(drifted);
    expect(d.render()).toMatch(/Synthesis rejected: oracle drift/i);
    expect(d.render()).toContain("packages/cli/src/foo.test.ts");
  });

  it("unresolved REJECTS (fail closed)", () => {
    const d = evaluateSynthesisCandidate({ runId: "run-a", revision: base }, { runId: "run-b", revision: "nosuchrev" }, compareOracleSnapshots(redSnap, undefined));
    expect(d.established).toBe(false);
    expect(d.rejected?.reason).toBe("oracle-unresolved");
  });
});

describe("OID-003: in-run drift demands same-oracle counterfactual replay", () => {
  it("replay red -> green ESTABLISHES with counterfactualFlip provenance (a distinct kind, never flattened)", () => {
    const d = evaluateInRunFlip({ drifted: true }, "red");
    expect(d.established).toBe(true);
    expect(d.provenance).toBe("counterfactualFlip");
  });

  it("replay green -> green, or replay unavailable, renders indeterminate - never an unqualified flip", () => {
    expect(evaluateInRunFlip({ drifted: true }, "green").established).toBe(false);
    expect(evaluateInRunFlip({ drifted: true }, "unavailable").established).toBe(false);
    expect(evaluateInRunFlip({ drifted: true }, "unavailable").provenance).not.toBe("inRunFlip");
  });

  it("undrifted in-run flips stay inRunFlip (the normal case)", () => {
    const d = evaluateInRunFlip({ drifted: false }, "green");
    expect(d.established).toBe(true);
    expect(d.provenance).toBe("inRunFlip");
  });
});

describe("OID-005: the real CHAL-004-A history shape", () => {
  it("the actual criterion command classifies referenced, resolving the inaugural oracle under @spc/cli", () => {
    const c = classifyCommandOracle(
      "pnpm --filter @spc/cli... build > /dev/null && pnpm --filter @spc/cli exec vitest run src/challenge-skew-carveout.test.ts",
      PKGS,
    );
    expect(c.kind).toBe("referenced");
    if (c.kind === "referenced") {
      expect(c.files).toEqual(["packages/cli/src/challenge-skew-carveout.test.ts"]);
    }
  });

  it("the demotion predicted: a fixture replay of run-mw81uztk (red) -> run-mw86ka7e (green) whose oracle bytes differ across those revisions REJECTS under the gate", () => {
    // The fixture: the oracle bytes differ between base and drifted -
    // exactly the session's actual history (the oracle was fixed between
    // those runs). The gate must reject what today synthesizes silently.
    const cmd = "pnpm --filter @spc/cli exec vitest run src/foo.test.ts";
    const decision = evaluateSynthesisCandidate(
      { runId: "run-mw81uztk", revision: base },
      { runId: "run-mw86ka7e", revision: drifted },
      compareOracleSnapshots(oracleSnapshotAt(repo, base, cmd, PKGS), oracleSnapshotAt(repo, drifted, cmd, PKGS)),
    );
    expect(decision.established).toBe(false);
    expect(decision.rejected?.reason).toBe("oracle-drift");
  });
});
