import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileDigest, stageChanges, type ProposedChange } from "@spc/executor";

const CLI = new URL("../dist/main.js", import.meta.url).pathname;
const root = mkdtempSync(path.join(tmpdir(), "spc-patchbuild-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CONTENT = `export function authorize(user: string): boolean {
  const ok = check(user);
  return false;
}

export function logout(): void {
  clear(user);
}
`;

function spc(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.stdout ?? "") };
}

function repo(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), CONTENT, "utf8");
  return dir;
}

function digestOf(s: string): string {
  return "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
}

describe("spc patch build", () => {
  it("emits a verified op: correct digest from reality, applicable via stageChanges", () => {
    const dir = repo("happy");
    const r = spc(dir, ["patch", "build", "src/a.ts", "--anchor", "return false;", "--replacement", "return ok;"]);
    expect(r.status).toBe(0);
    const op = JSON.parse(r.stdout) as Extract<ProposedChange, { op: "patch" }>;
    expect(op).toMatchObject({ op: "patch", path: "src/a.ts", anchor: "return false;", replacement: "return ok;" });
    expect(op.baseDigest).toBe(digestOf(CONTENT));
    const staged = stageChanges(dir, [op]);
    expect(staged.ok).toBe(true);
    if (staged.ok) expect(staged.writes[0]!.content).toBe(CONTENT.replace("return false;", "return ok;"));
  });

  it("refuses a non-unique anchor at composition time with PATCH_ANCHOR_NOT_UNIQUE", () => {
    const dir = repo("nonunique");
    const r = spc(dir, ["patch", "build", "src/a.ts", "--anchor", "user", "--replacement", "u"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("PATCH_ANCHOR_NOT_UNIQUE");
  });

  it("refuses an absent anchor with PATCH_ANCHOR_ABSENT (no fuzzy match)", () => {
    const dir = repo("absent");
    const r = spc(dir, ["patch", "build", "src/a.ts", "--anchor", "not there at all", "--replacement", "x"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("PATCH_ANCHOR_ABSENT");
  });

  it("refuses a missing base file with PATCH_BASE_MISSING", () => {
    const dir = repo("missing");
    const r = spc(dir, ["patch", "build", "src/gone.ts", "--anchor", "a", "--replacement", "b"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("PATCH_BASE_MISSING");
  });

  it("refuses when --expect-digest disagrees with the tree (PATCH_BASE_MISMATCH)", () => {
    const dir = repo("drift");
    const r = spc(dir, [
      "patch", "build", "src/a.ts",
      "--anchor", "return false;", "--replacement", "return ok;",
      "--expect-digest", "sha256:" + "9".repeat(64),
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("PATCH_BASE_MISMATCH");
  });

  it("chains via --after: the new op bases on the overlay of prior ops", () => {
    const dir = repo("chain");
    const first = spc(dir, ["patch", "build", "src/a.ts", "--anchor", "return false;", "--replacement", "throw new AuthorizationError();"]);
    expect(first.status).toBe(0);
    const opsFile = path.join(dir, "ops.json");
    writeFileSync(opsFile, JSON.stringify([JSON.parse(first.stdout)]), "utf8");
    const afterFirst = CONTENT.replace("return false;", "throw new AuthorizationError();");
    const second = spc(dir, [
      "patch", "build", "src/a.ts",
      "--anchor", "throw new AuthorizationError();", "--replacement", "throw new AuthError();",
      "--after", opsFile,
    ]);
    expect(second.status).toBe(0);
    const op2 = JSON.parse(second.stdout) as Extract<ProposedChange, { op: "patch" }>;
    expect(op2.baseDigest).toBe(digestOf(afterFirst));
    const staged = stageChanges(dir, [JSON.parse(first.stdout) as ProposedChange, op2]);
    expect(staged.ok).toBe(true);
    if (staged.ok) expect(staged.writes[0]!.content).toBe(CONTENT.replace("return false;", "throw new AuthError();"));
  });

  it("propagates a refusal from the --after ops themselves", () => {
    const dir = repo("badprior");
    const opsFile = path.join(dir, "ops.json");
    writeFileSync(
      opsFile,
      JSON.stringify([{ op: "patch", path: "src/a.ts", baseDigest: "sha256:" + "7".repeat(64), anchor: "return false;", replacement: "x" }]),
      "utf8",
    );
    const r = spc(dir, [
      "patch", "build", "src/a.ts",
      "--anchor", "return false;", "--replacement", "y",
      "--after", opsFile,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("PATCH_BASE_MISMATCH");
  });

  it("accepts anchor and replacement from files as exact bytes", () => {
    const dir = repo("files");
    const anchorFile = path.join(dir, "anchor.txt");
    const replacementFile = path.join(dir, "replacement.txt");
    writeFileSync(anchorFile, "return false;\n", "utf8");
    writeFileSync(replacementFile, "return ok;\n", "utf8");
    const r = spc(dir, [
      "patch", "build", "src/a.ts",
      "--anchor-file", anchorFile, "--replacement-file", replacementFile,
    ]);
    expect(r.status).toBe(0);
    const op = JSON.parse(r.stdout) as Extract<ProposedChange, { op: "patch" }>;
    expect(op.anchor).toBe("return false;\n");
    expect(op.replacement).toBe("return ok;\n");
  });
});
