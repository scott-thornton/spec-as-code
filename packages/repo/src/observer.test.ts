import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitAll, gitOk } from "./git.js";
import { observeRepository, readExcerpt } from "./observer.js";
import { compileSpecSource } from "@spc/core";

const root = mkdtempSync(path.join(tmpdir(), "spc-observer-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const repo = path.join(root, "proj");
mkdirSync(path.join(repo, "src", "auth"), { recursive: true });
mkdirSync(path.join(repo, "tests"), { recursive: true });
gitOk(repo, ["init", "-b", "main"]);
writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "proj", scripts: { test: "node --test", build: "tsc" } }));
writeFileSync(path.join(repo, "src", "auth", "session.ts"), "export const x = 1;\n");
writeFileSync(path.join(repo, "tests", "session.test.ts"), "import { x } from '../src/auth/session.ts';\n");
writeFileSync(path.join(repo, "README.md"), "# proj\n");
commitAll(repo, "init");

const specYaml = `apiVersion: spc.dev/v1alpha1
kind: Spec
metadata:
  id: session-fix
  title: Session
goal: Session tokens work.
requirements:
  - id: SESSION-001
    statement: Session tokens are prefixed.
    priority: must
    acceptance:
      - id: SESSION-001-A
        type: command
        command: node --test tests/
`;
const ir = compileSpecSource(specYaml, "specs/session.yaml").ir!;

describe("repository observer", () => {
  it("produces a bounded snapshot with digest", () => {
    const snap = observeRepository(repo, ir);
    expect(snap.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.dirty).toBe(false);
    expect(snap.languages).toContain("typescript");
    expect(snap.manifests[0]?.kind).toBe("npm");
    expect(snap.manifests[0]?.name).toBe("proj");
    expect(snap.commands.test).toBe("npm test");
    expect(snap.commands.build).toBe("npm run build");
    expect(snap.tests.map((t) => t.path)).toContain("tests/session.test.ts");
    expect(snap.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snap.relevantArtifacts.map((a) => a.path)).toContain("src/auth/session.ts");
  });

  it("digest is deterministic for identical observations", () => {
    const a = observeRepository(repo, ir, () => "2026-09-17T00:00:00.000Z");
    const b = observeRepository(repo, ir, () => "2026-09-17T00:00:00.000Z");
    expect(a.digest).toBe(b.digest);
  });

  it("readExcerpt returns bounded content", () => {
    expect(readExcerpt(repo, "src/auth/session.ts")).toContain("export const x");
    expect(readExcerpt(repo, "missing.ts")).toBeNull();
  });
});
