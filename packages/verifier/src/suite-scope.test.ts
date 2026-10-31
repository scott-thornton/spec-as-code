import { describe, expect, it } from "vitest";
import { parseFilterScope } from "./command-cache.js";

// Oracle for specs/suite-references.yaml (SR-006): the cache scope
// parser AGGREGATES across all command segments of a compound. The
// last-filter-wins scan under-scoped compounds whose pnpm -r prefix
// reads the whole workspace to the final --filter package - a
// possible false cache hit. The rule: any recursive pnpm invocation
// (-r or --recursive) anywhere widens to the whole workspace; filter
// segments union; non-pnpm segments (grep -r) contribute nothing;
// ambiguity falls BROADER, never narrower.
describe("parseFilterScope compound aggregation (SR-006)", () => {
  it("a recursive pnpm segment dominates a later --filter segment", () => {
    expect(parseFilterScope("pnpm -r typecheck && pnpm --filter @spc/cli build")).toEqual({
      packages: null,
      withDeps: true,
    });
  });

  it("--recursive is recognized as recursive", () => {
    expect(parseFilterScope("pnpm --recursive typecheck && pnpm --filter @spc/cli... test")).toEqual({
      packages: null,
      withDeps: true,
    });
  });

  it("filter segments union (sorted, deterministic) instead of last-wins", () => {
    expect(parseFilterScope("pnpm --filter @spc/b build && pnpm --filter @spc/a test")).toEqual({
      packages: ["@spc/a", "@spc/b"],
      withDeps: false,
    });
  });

  it("a deps-form filter widens withDeps for the aggregate", () => {
    expect(parseFilterScope("pnpm --filter @spc/a... build && pnpm --filter @spc/b test")).toEqual({
      packages: ["@spc/a", "@spc/b"],
      withDeps: true,
    });
  });

  it("non-pnpm segments contribute nothing - grep -r is not a recursive pnpm invocation", () => {
    expect(parseFilterScope("grep -r foo . && pnpm --filter @spc/cli test")).toEqual({
      packages: ["@spc/cli"],
      withDeps: false,
    });
  });

  it("a command with no pnpm scope anywhere is never cached", () => {
    expect(parseFilterScope("grep -r foo .")).toBeNull();
    expect(parseFilterScope("node counter.mjs")).toBeNull();
  });

  it("single-segment behavior is unchanged", () => {
    expect(parseFilterScope("pnpm --filter @spc/cli... test")).toEqual({
      packages: ["@spc/cli"],
      withDeps: true,
    });
    expect(parseFilterScope("pnpm --filter=@spc/cli test")).toEqual({
      packages: ["@spc/cli"],
      withDeps: false,
    });
    expect(parseFilterScope("pnpm -r typecheck")).toEqual({ packages: null, withDeps: true });
    expect(parseFilterScope("pnpm test")).toBeNull();
  });
});
