import { z } from "zod";

/**
 * Evidence is immutable and append-only once written. Contradictory
 * evidence must never be deleted because it is inconvenient.
 */

export const evidenceKindSchema = z.enum(["command", "test", "file", "diff", "agent", "human"]);

export const evidenceOutcomeSchema = z.enum(["supports", "contradicts", "inconclusive"]);

export const evidenceProducerSchema = z.strictObject({
  type: z.enum(["runtime", "agent", "human"]),
  identity: z.string().optional(),
});

export const evidenceSchema = z.strictObject({
  id: z.string().min(1),
  runId: z.string(),
  taskId: z.string().optional(),
  criterionId: z.string().optional(),
  propertyRefs: z.array(z.string()),
  kind: evidenceKindSchema,
  outcome: evidenceOutcomeSchema,
  producer: evidenceProducerSchema,
  timestamp: z.string().min(1),
  repositoryRevision: z.string(),
  payload: z.unknown(),
  digest: z.string().min(1),
});

export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
export type EvidenceOutcome = z.infer<typeof evidenceOutcomeSchema>;
export type EvidenceProducer = z.infer<typeof evidenceProducerSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

/** Trust hierarchy: provenance must stay explicit in every rendering. */
export function evidenceTrustLevel(kind: EvidenceKind): 1 | 2 | 3 | 4 {
  switch (kind) {
    case "command":
    case "test":
      return 1;
    case "file":
    case "diff":
      return 2;
    case "agent":
      return 3;
    case "human":
      return 4;
  }
}

export function evidenceTrustLabel(kind: EvidenceKind): string {
  switch (kind) {
    case "command":
      return "deterministic-command";
    case "test":
      return "deterministic-test";
    case "file":
      return "static-file";
    case "diff":
      return "static-diff";
    case "agent":
      return "agent-review";
    case "human":
      return "human-review";
  }
}
