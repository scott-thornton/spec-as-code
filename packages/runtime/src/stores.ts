import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { digestOf } from "@spc/core";
import type {
  Evidence,
  FollowUp,
  FollowUpDraft,
  Observation,
  ObservationDraft,
} from "@spc/schema";
import { followUpSchema, observationSchema } from "@spc/schema";

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

  load(): void {
    for (const line of readJsonl(this.file)) {
      try {
        this.records.push(JSON.parse(line) as Evidence);
      } catch {
        // a torn line from an interrupted process is skipped on replay
      }
    }
  }

  add(record: Omit<Evidence, "digest">): Evidence {
    const { digest: _ignored, ...rest } = record as Evidence;
    const full: Evidence = { ...record, digest: digestOf(rest) };
    this.records.push(full);
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
