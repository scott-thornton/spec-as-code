import { describe, expect, it } from "vitest";
import { computeChainFlipMemory, criterionDigestOf } from "./chain-memory.js";

// Oracle for specs/chain-memory.yaml (red, committed pre-run): the
// flip memory that crosses digest forks. Field evidence: the probe on
// branch probe/digest-fork-repro (run-mw8arnxy) - PROBE-B byte-identical,
// flip recorded one run earlier, indeterminate passed_at_base because
// the ancestor walk stops at the same-digest parent chain. Today no
// fork-crossing memory exists - these imports are red.
//
// Record shape mirrors evidence.jsonl entries; isEligibleRed semantics
// are inherited from @spc/verifier (oracle-invalid reds establish
// nothing), exactly as the same-run adoption in apply.ts uses them.

interface Rec {
  criterionId?: string;
  outcome?: string;
  phase?: string;
  payload?: Record<string, unknown>;
}

function criterion(command: string, discriminating = true): Record<string, unknown> {
  return { id: "C-001-A", type: "command", command, expect: { exitCode: 0 }, discriminating };
}

const CURRENT = new Map([["C-001-A", criterionDigestOf(criterion("pnpm test"))]]);

function source(runId: string, digests: Map<string, string> | undefined, records: Rec[]) {
  return { runId, criterionDigests: digests, records };
}

describe("CHMEM-001: adoption crosses the digest fork, gated on the criterion's own definition", () => {
  it("same-run red-to-green in a cross-digest ancestor is adopted (the LIST-001 case, unforked)", () => {
    const r = computeChainFlipMemory(
      [
        source("run-old", CURRENT, [
          { criterionId: "C-001-A", outcome: "contradicts", phase: "red", payload: { command: "pnpm test" } },
          { criterionId: "C-001-A", outcome: "supports", payload: { command: "pnpm test" } },
        ]),
      ],
      CURRENT,
    );
    expect(r.get("C-001-A")).toBe("run-old");
  });

  it("a criterion whose compiled definition changed adopts nothing - the memory is the criterion's, not the id's", () => {
    const changed = new Map([["C-001-A", criterionDigestOf(criterion("pnpm test --changed"))]]);
    const r = computeChainFlipMemory(
      [
        source("run-old", changed, [
          { criterionId: "C-001-A", outcome: "contradicts", phase: "red", payload: { command: "pnpm test --changed" } },
          { criterionId: "C-001-A", outcome: "supports", payload: { command: "pnpm test --changed" } },
        ]),
      ],
      CURRENT,
    );
    expect(r.has("C-001-A")).toBe(false);
  });

  it("the discriminating flag is part of the definition - a de-flagged ancestor does not serve a re-flagged criterion", () => {
    const unflagged = new Map([["C-001-A", criterionDigestOf(criterion("pnpm test", false))]]);
    const r = computeChainFlipMemory(
      [
        source("run-old", unflagged, [
          { criterionId: "C-001-A", outcome: "contradicts", phase: "red", payload: { command: "pnpm test" } },
          { criterionId: "C-001-A", outcome: "supports", payload: { command: "pnpm test" } },
        ]),
      ],
      CURRENT,
    );
    expect(r.has("C-001-A")).toBe(false);
  });

  it("a source whose spec cannot be compiled (no criterion digests) is skipped conservatively", () => {
    const r = computeChainFlipMemory(
      [
        source("run-legacy", undefined, [
          { criterionId: "C-001-A", outcome: "contradicts", phase: "red" },
          { criterionId: "C-001-A", outcome: "supports" },
        ]),
      ],
      CURRENT,
    );
    expect(r.size).toBe(0);
  });
});

describe("CHMEM-002: synthesis across runs - red in one ancestor, green in a later one", () => {
  it("red strictly preceding green establishes the flip with provenance naming both runs", () => {
    const r = computeChainFlipMemory(
      [
        source("run-a", CURRENT, [
          { criterionId: "C-001-A", outcome: "contradicts", phase: "red", payload: { command: "pnpm test" } },
        ]),
        source("run-b", CURRENT, [
          { criterionId: "C-001-A", outcome: "supports", payload: { command: "pnpm test" } },
        ]),
      ],
      CURRENT,
    );
    expect(r.get("C-001-A")).toBe("run-a->run-b");
  });

  it("the earliest red wins when several ancestors record reds", () => {
    const r = computeChainFlipMemory(
      [
        source("run-a", CURRENT, [
          { criterionId: "C-001-A", outcome: "contradicts", phase: "red", payload: { command: "pnpm test" } },
        ]),
        source("run-b", CURRENT, [
          { criterionId: "C-001-A", outcome: "contradicts", phase: "red", payload: { command: "pnpm test" } },
        ]),
        source("run-c", CURRENT, [
          { criterionId: "C-001-A", outcome: "supports", payload: { command: "pnpm test" } },
        ]),
      ],
      CURRENT,
    );
    expect(r.get("C-001-A")).toBe("run-a->run-c");
  });
});

describe("CHMEM-003: refusals - absence of memory never fabricates", () => {
  it("a green that PRECEDES its red establishes nothing (the regression shape)", () => {
    const r = computeChainFlipMemory(
      [
        source("run-a", CURRENT, [
          { criterionId: "C-001-A", outcome: "supports", payload: { command: "pnpm test" } },
        ]),
        source("run-b", CURRENT, [
          { criterionId: "C-001-A", outcome: "contradicts", phase: "red", payload: { command: "pnpm test" } },
        ]),
      ],
      CURRENT,
    );
    expect(r.has("C-001-A")).toBe(false);
  });

  it("an oracle-invalid red establishes nothing (existing semantics preserved)", () => {
    const r = computeChainFlipMemory(
      [
        source("run-a", CURRENT, [
          {
            criterionId: "C-001-A",
            outcome: "contradicts",
            phase: "red",
            payload: { command: "pnpm test", oracleValidity: "invalid" },
          },
        ]),
        source("run-b", CURRENT, [
          { criterionId: "C-001-A", outcome: "supports", payload: { command: "pnpm test" } },
        ]),
      ],
      CURRENT,
    );
    expect(r.has("C-001-A")).toBe(false);
  });

  it("criterionDigestOf: identical definitions digest identically; any change differs", () => {
    expect(criterionDigestOf(criterion("pnpm test"))).toBe(criterionDigestOf(criterion("pnpm test")));
    expect(criterionDigestOf(criterion("pnpm test"))).not.toBe(criterionDigestOf(criterion("pnpm other")));
  });
});
