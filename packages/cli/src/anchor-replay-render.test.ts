import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Oracle for specs/anchor-verification.yaml (AV-003): spc run replay
// renders the anchor state on its own line - anchored, contradicted,
// and unanchored runs are visible to whoever audits them.
const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-anchorrender-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sh(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

function gitsh(args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

mkdirSync(path.join(root, ".spc", "runs"), { recursive: true });
writeFileSync(path.join(root, ".gitignore"), ".spc/\n", "utf8");
gitsh(["init", "-q", "-b", "main"]);
gitsh(["config", "user.email", "test@example.com"]);
gitsh(["config", "user.name", "test"]);
writeFileSync(path.join(root, ".keep"), "", "utf8");
gitsh(["add", "."]);
gitsh(["commit", "-q", "-m", "base"]);

// A standalone anchored run, built by hand (the CLI render must not
// depend on how the anchor came to exist): one event, no evidence, an
// anchor commit carrying the matching heads, and an attestation that
// records the anchor.
const runId = "run-render-1";
const runDir = path.join(root, ".spc", "runs", runId);
mkdirSync(runDir, { recursive: true });
writeFileSync(
  path.join(runDir, "metadata.json"),
  JSON.stringify({ runId, specId: "av-spec", createdAt: "2026-10-23T00:00:00.000Z" }),
  "utf8",
);
const genesis = "sha256:" + "0".repeat(64);
const eventHead = genesis; // empty prefix digests to the zero head
gitsh([
  "commit",
  "--allow-empty",
  "-m",
  `spc: attest run ${runId} (status succeeded)

SPC-Run-Id: ${runId}
SPC-Attestation-Event-Count: 0
SPC-Attestation-Event-Head: ${eventHead}
SPC-Attestation-Evidence-Head: ${genesis}`,
]);
const anchorCommit = gitsh(["rev-parse", "HEAD"]);
writeFileSync(
  path.join(runDir, "attestation.json"),
  JSON.stringify({
    schema: "spc-run-attestation/1",
    runId,
    specId: "av-spec",
    status: "succeeded",
    eventCount: 0,
    eventChainHead: eventHead,
    evidenceHead: genesis,
    attestedAt: "2026-10-23T00:00:00.000Z",
    gitAnchor: { ref: "refs/heads/main", commit: anchorCommit },
  }),
  "utf8",
);
writeFileSync(path.join(runDir, "events.jsonl"), "", "utf8");
writeFileSync(path.join(runDir, "evidence.jsonl"), "", "utf8");
writeFileSync(
  path.join(runDir, "state.json"),
  JSON.stringify({ status: "succeeded", tasks: {}, requirements: {} }),
  "utf8",
);

// An unanchored run: same shape, no anchor commit, no gitAnchor field.
const runId2 = "run-render-2";
const runDir2 = path.join(root, ".spc", "runs", runId2);
mkdirSync(runDir2, { recursive: true });
writeFileSync(
  path.join(runDir2, "metadata.json"),
  JSON.stringify({ runId: runId2, specId: "av-spec", createdAt: "2026-10-23T00:00:00.000Z" }),
  "utf8",
);
writeFileSync(
  path.join(runDir2, "attestation.json"),
  JSON.stringify({
    schema: "spc-run-attestation/1",
    runId: runId2,
    specId: "av-spec",
    status: "succeeded",
    eventCount: 0,
    eventChainHead: eventHead,
    evidenceHead: genesis,
    attestedAt: "2026-10-23T00:00:00.000Z",
  }),
  "utf8",
);
writeFileSync(path.join(runDir2, "events.jsonl"), "", "utf8");
writeFileSync(path.join(runDir2, "evidence.jsonl"), "", "utf8");
writeFileSync(
  path.join(runDir2, "state.json"),
  JSON.stringify({ status: "succeeded", tasks: {}, requirements: {} }),
  "utf8",
);

describe("spc run replay renders the anchor state (AV-003)", () => {
  it("prints Anchor: verified for an anchored run", () => {
    const r = sh(["run", "replay", runId]);
    expect(r.stdout).toMatch(/Anchor:\s*verified/);
  });

  it("prints Anchor: unanchored for a run with no anchor", () => {
    const r = sh(["run", "replay", runId2]);
    expect(r.stdout).toMatch(/Anchor:\s*unanchored/);
  });
});
