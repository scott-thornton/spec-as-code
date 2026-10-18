import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { digestOf } from "@spc/core";
import { EVIDENCE_CHAIN_GENESIS } from "@spc/schema";
import type {
  Evidence,
  FollowUp,
  FollowUpDraft,
  Observation,
  ObservationDraft,
} from "@spc/schema";
import { evidenceSchema, followUpSchema, observationSchema } from "@spc/schema";

function readJsonl(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * Evidence is immutable and append-only. Contradictory evidence is kept
 * forever; nothing may erase it.
 */
export class EvidenceStore {
  private readonly records: Evidence[] = [];

  constructor(private readonly file: string) {}

  /**
   * Fail-closed replay: schema-validate every record and recompute its
   * digest - content changed while the digest was left alone (or
   * recomputed by a naive editor) must be LOUD, not silently trusted.
   * This is corruption detection, not provenance: an attacker who can
   * write the file can recompute digests coherently; anchoring (see
   * IDEAS 3a) is the answer to that class. The single tolerated case is
   * a truncated FINAL line without a trailing newline: an interrupted
   * append, which is crash physics, not tampering.
   */
  load(): void {
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file, "utf8");
    const lines = raw.split("\n");
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      const tornTail = index === lines.length - 1 && !raw.endsWith("\n");
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        if (tornTail) return; // a torn line from an interrupted process
        throw new Error(`evidence log ${this.file} is corrupted at line ${index + 1}`);
      }
      const parsed = evidenceSchema.safeParse(value);
      if (!parsed.success) {
        if (tornTail) return;
        throw new Error(
          `evidence log ${this.file} contains an invalid record at line ${index + 1}: ` +
            parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      }
      const record = parsed.data;
      const { digest, ...rest } = record;
      if (digestOf(rest) !== digest) {
        throw new Error(
          `evidence log ${this.file}: digest mismatch at line ${index + 1} (record ${record.id}) - content does not match its recorded digest`,
        );
      }
      // Chain verification mirrors the event loader: each chained record
      // must point at the digest of the previous record as stored; a
      // self-consistent forgery (recomputed digest) still breaks the
      // next pointer. Legacy logs stay legacy; mixing is tampering.
      const previous = this.records[this.records.length - 1];
      if (record.chain !== undefined) {
        if (this.chainState === "legacy") {
          throw new Error(
            `evidence log ${this.file}: partially chained at line ${index + 1} - a legacy log must stay unchained; mixing indicates tampering`,
          );
        }
        this.chainState = "chained";
        if (previous) {
          if (record.chain !== previous.digest) {
            throw new Error(
              `evidence log ${this.file}: chain break at line ${index + 1} (record ${record.id}) - the previous record does not hash to this record's chain pointer; the log was edited or records were swapped`,
            );
          }
        } else if (record.chain !== EVIDENCE_CHAIN_GENESIS) {
          throw new Error(
            `evidence log ${this.file}: first chained evidence record does not carry the genesis pointer`,
          );
        }
      } else if (this.chainState === "chained") {
        throw new Error(
          `evidence log ${this.file}: partially chained at line ${index + 1} - an unchained record inside a chained log indicates tampering`,
        );
      } else {
        this.chainState = "legacy";
      }
      this.records.push(record);
    });
  }

  private chainState: "chained" | "legacy" | null = null;

  /** Whether the loaded log is evidence-chained or legacy. */
  get chainStatus(): "chained" | "legacy" | null {
    return this.chainState;
  }

  add(record: Omit<Evidence, "digest">): Evidence {
    // Chain pointer mirrors the event chain: the digest of the previous
    // record as stored. Legacy logs stay legacy on append - a resumed
    // run must not produce a mixed log.
    const chainField =
      this.chainState === "legacy"
        ? {}
        : { chain: this.records.length === 0 ? EVIDENCE_CHAIN_GENESIS : this.records[this.records.length - 1]!.digest };
    const withChain = { ...record, ...chainField } as Omit<Evidence, "digest">;
    const { digest: _ignored, ...rest } = withChain as Evidence;
    const full: Evidence = { ...withChain, digest: digestOf(rest) };
    this.records.push(full);
    if (this.chainState === null) this.chainState = "chained";
    appendFileSync(this.file, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  all(): readonly Evidence[] {
    return this.records;
  }

  forProperty(propertyId: string): Evidence[] {
    return this.records.filter((e) => e.propertyRefs.includes(propertyId));
  }
}

export class ObservationStore {
  private readonly records: Observation[] = [];

  constructor(private readonly file: string) {}

  load(): void {
    for (const line of readJsonl(this.file)) {
      const parsed = observationSchema.safeParse(JSON.parse(line));
      if (parsed.success) this.records.push(parsed.data);
    }
  }

  add(draft: ObservationDraft & { taskId?: string }, runId: string): Observation {
    const full: Observation = {
      ...draft,
      id: `OBS-${String(this.records.length + 1).padStart(3, "0")}`,
      runId,
    };
    this.records.push(full);
    appendFileSync(this.file, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  all(): readonly Observation[] {
    return this.records;
  }
}

export class FollowupStore {
  private followups: FollowUp[] = [];

  constructor(private readonly file: string) {}

  load(): void {
    if (!existsSync(this.file)) return;
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const parsed = followUpSchema.safeParse(item);
        if (parsed.success) this.followups.push(parsed.data);
      }
    }
  }

  create(
    draft: FollowUpDraft,
    runId: string,
    now: () => string = () => new Date().toISOString(),
  ): FollowUp {
    const followup: FollowUp = {
      ...draft,
      id: `F-${String(this.followups.length + 1).padStart(3, "0")}`,
      runId,
      status: "open",
      createdAt: now(),
    };
    this.followups.push(followup);
    this.persist();
    return followup;
  }

  resolve(
    id: string,
    resolution: { optionId?: string; note?: string; resolvedBy?: string },
    now: () => string = () => new Date().toISOString(),
  ): FollowUp {
    const f = this.followups.find((x) => x.id === id);
    if (!f) throw new Error(`follow-up ${id} not found`);
    if (f.status === "resolved") return f;
    f.status = "resolved";
    f.resolvedAt = now();
    f.resolution = resolution;
    this.persist();
    return f;
  }

  persist(): void {
    writeFileSync(this.file, JSON.stringify(this.followups, null, 2), "utf8");
  }

  all(): readonly FollowUp[] {
    return this.followups;
  }

  open(): FollowUp[] {
    return this.followups.filter((f) => f.status === "open");
  }

  openBlocking(): FollowUp[] {
    return this.followups.filter((f) => f.status === "open" && f.blocking);
  }

  findOpenForCriterion(criterionId: string): FollowUp | undefined {
    return this.followups.find((f) => f.status === "open" && f.criterionId === criterionId);
  }
}

export function appendUsageRecord(file: string, record: unknown): void {
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}
