import { describe, expect, it } from "vitest";
import { enforceWriteScope, OUT_OF_SCOPE_WRITE, UNSAFE_PATH } from "./enforce.js";

describe("write-scope enforcement", () => {
  it("allows changes inside declared scope", () => {
    const v = enforceWriteScope(["src/auth/**"], ["src/auth/github.ts", "src/auth/deep/x.ts"]);
    expect(v).toEqual([]);
  });

  it("flags changes outside scope with OUT_OF_SCOPE_WRITE", () => {
    const v = enforceWriteScope(["src/auth/github.ts"], ["src/auth/github.ts", "package.json"]);
    expect(v).toHaveLength(1);
    expect(v[0]!.path).toBe("package.json");
    expect(v[0]!.code).toBe(OUT_OF_SCOPE_WRITE);
  });

  it("rejects everything when the task declares no write targets", () => {
    const v = enforceWriteScope([], ["src/new.ts"]);
    expect(v[0]!.code).toBe(OUT_OF_SCOPE_WRITE);
    expect(v[0]!.reason).toContain("no write targets");
  });

  it("flags unsafe paths", () => {
    const v = enforceWriteScope(["**"], ["../outside.ts", "/abs/path"]);
    expect(v.map((x) => x.code)).toEqual([UNSAFE_PATH, UNSAFE_PATH]);
  });
});
