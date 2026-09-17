import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@spc/schema";
import {
  classifyCommand,
  evaluateCommandPolicy,
  redactSecrets,
  runCommand,
} from "./commands.js";

describe("command classification", () => {
  const cases: [string, string][] = [
    ["node --test tests/", "test"],
    ["npm test", "test"],
    ["pnpm run test", "test"],
    ["vitest run", "test"],
    ["npm run build", "build"],
    ["tsc --noEmit", "typecheck"],
    ["npm run lint", "lint"],
    ["git status", "inspect"],
    ["cat package.json", "inspect"],
    ["npm install left-pad", "packageInstall"],
    ["pnpm add zod", "packageInstall"],
    ["curl https://example.com", "network"],
    ["wget http://x/y", "network"],
    ["git push origin main", "gitPush"],
    ["npm publish", "publish"],
    ["kubectl apply -f x.yaml", "deployment"],
    ["npx prisma migrate deploy", "migration"],
    ["rm -rf /", "destructive"],
    ["git reset --hard HEAD", "destructive"],
    ["node src/cli.js", "unknown"],
  ];
  for (const [cmd, category] of cases) {
    it(`classifies "${cmd}" as ${category}`, () => {
      expect(classifyCommand(cmd)).toBe(category);
    });
  }
});

describe("command policy", () => {
  it("allows test/build/lint/typecheck/inspect by default", () => {
    for (const cmd of ["node --test tests/", "npm run build", "npm run lint", "tsc --noEmit", "git status"]) {
      expect(evaluateCommandPolicy(cmd, DEFAULT_CONFIG.commands).allowed, cmd).toBe(true);
    }
  });

  it("denies network and destructive commands by default", () => {
    expect(evaluateCommandPolicy("curl https://x", DEFAULT_CONFIG.commands).allowed).toBe(false);
    expect(evaluateCommandPolicy("rm -rf /", DEFAULT_CONFIG.commands).allowed).toBe(false);
    expect(evaluateCommandPolicy("git push origin main", DEFAULT_CONFIG.commands).allowed).toBe(false);
    expect(evaluateCommandPolicy("npm publish", DEFAULT_CONFIG.commands).allowed).toBe(false);
  });

  it("denies package installation under default approval policy with actionable reason", () => {
    const d = evaluateCommandPolicy("npm install left-pad", DEFAULT_CONFIG.commands);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("approval");
  });

  it("honors configuration overrides", () => {
    const cfg = { ...DEFAULT_CONFIG.commands, network: "allow" as const };
    expect(evaluateCommandPolicy("curl https://x", cfg).allowed).toBe(true);
  });

  it("unknown commands follow the configured default", () => {
    expect(evaluateCommandPolicy("node run-server.js", DEFAULT_CONFIG.commands).allowed).toBe(true);
  });
});

describe("runCommand", () => {
  const opts = {
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    commandsConfig: DEFAULT_CONFIG.commands,
  };

  it("captures exit code and output", async () => {
    const r = await runCommand("node -e \"console.log('spc-out')\"", opts);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("spc-out");
    expect(r.stdoutDigest).toMatch(/^sha256:/);
    expect(r.category).toBe("unknown");
    expect(r.allowed).toBe(true);
  });

  it("captures failing exit codes", async () => {
    const r = await runCommand("node -e \"process.exit(3)\"", opts);
    expect(r.exitCode).toBe(3);
  });

  it("denied commands never execute", async () => {
    const r = await runCommand("curl https://example.com", opts);
    expect(r.allowed).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toContain("denied");
  });

  it("times out long commands", async () => {
    const r = await runCommand("sleep 5", { ...opts, timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
  }, 5000);

  it("redacts secret values from output", async () => {
    const r = await runCommand("node -e \"console.log('token=abc123secretvalue')\"", {
      ...opts,
      env: { ...process.env, MY_API_TOKEN: "abc123secretvalue" },
    });
    expect(r.stdout).toContain("<redacted:MY_API_TOKEN>");
    expect(r.stdout).not.toContain("abc123secretvalue");
  });

  it("redactSecrets ignores short or non-secret names", () => {
    expect(redactSecrets("x abcdefgh", { SHORTY: "abcdefgh" })).toBe("x abcdefgh");
    expect(redactSecrets("x abcdefgh", { MY_NAME: "abcdefgh" })).toBe("x abcdefgh");
    expect(redactSecrets("x abcdefgh", { MY_TOKEN: "abcdefgh" })).toBe("x <redacted:MY_TOKEN>");
  });
});
