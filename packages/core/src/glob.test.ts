import { describe, expect, it } from "vitest";
import {
  globMatch,
  globMatchAny,
  isSafeRelativePath,
  literalPrefix,
  patternsOverlap,
} from "./glob.js";

describe("glob matching", () => {
  it("matches exact paths", () => {
    expect(globMatch("src/auth/github.ts", "src/auth/github.ts")).toBe(true);
    expect(globMatch("src/auth/github.ts", "src/auth/session.ts")).toBe(false);
  });

  it("matches directory globs", () => {
    expect(globMatch("src/auth/**", "src/auth/github.ts")).toBe(true);
    expect(globMatch("src/auth/**", "src/auth/deep/nested/x.ts")).toBe(true);
    expect(globMatch("src/auth/**", "src/routes/oauth.ts")).toBe(false);
  });

  it("matches wildcard segments", () => {
    expect(globMatch("src/**/*.test.ts", "src/a.test.ts")).toBe(true);
    expect(globMatch("src/**/*.test.ts", "src/a/b/c.test.ts")).toBe(true);
    expect(globMatch("src/**/*.test.ts", "src/a/b/c.ts")).toBe(false);
    expect(globMatch("*.test.ts", "foo.test.ts")).toBe(true);
    expect(globMatch("*.test.ts", "a/foo.test.ts")).toBe(false);
    expect(globMatch("ab?.ts", "abc.ts")).toBe(true);
    expect(globMatch("ab?.ts", "abcd.ts")).toBe(false);
  });

  it("normalizes leading ./ and trailing slashes", () => {
    expect(globMatch("./src/**", "src/x.ts")).toBe(true);
    expect(globMatchAny(["src/**/"], "src/x.ts")).toBe(true); // "src/**/" normalizes to "src/**"
  });

  it("overlap detection is conservative", () => {
    expect(patternsOverlap("src/auth/**", "src/auth/session.ts")).toBe(true);
    expect(patternsOverlap("src/**", "src/a/**")).toBe(true);
    expect(patternsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(patternsOverlap("*.test.ts", "foo.test.ts")).toBe(true);
    expect(patternsOverlap("src/a/**", "src/b/**")).toBe(false);
    expect(patternsOverlap("src/a/x.ts", "src/b/y.ts")).toBe(false);
    expect(patternsOverlap("**/*.test.ts", "src/lib/util.ts")).toBe(true); // leading wildcard => assume overlap
  });

  it("literal prefix extraction", () => {
    expect(literalPrefix("src/auth/**")).toBe("src/auth");
    expect(literalPrefix("src/auth/session.ts")).toBe("src/auth/session.ts");
    expect(literalPrefix("*.ts")).toBe("");
  });

  it("safe relative paths", () => {
    expect(isSafeRelativePath("src/a.ts")).toBe(true);
    expect(isSafeRelativePath("a/b/c")).toBe(true);
    expect(isSafeRelativePath("/abs/path")).toBe(false);
    expect(isSafeRelativePath("../escape")).toBe(false);
    expect(isSafeRelativePath("a/../b")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
  });
});
