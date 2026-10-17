import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { digestOf } from "@spc/core";
import type { Event, EventType } from "@spc/schema";
import { EVENT_CHAIN_GENESIS, eventSchema } from "@spc/schema";

/**
 * Append-only event log. state.json is a projection over these events;
 * a corrupted or missing state file must be recoverable from here.
 */
export type ChainStatus = "chained" | "legacy";

export class EventStore {
  private readonly events: Event[] = [];
  private chainState: ChainStatus | null = null;

  constructor(
    private readonly file: string,
    private readonly runId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Fail-closed replay: a schema-invalid or unparseable line anywhere but
   * the torn tail is a hard error, not a silent omission - state.json is
   * a projection over this log, and a plausible projection missing an
   * event is worse than a loud failure. The single tolerated case is a
   * truncated FINAL line without a trailing newline: an interrupted
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
      } catch (e) {
        if (tornTail) return; // interrupted append, never committed
        throw new Error(
          `event log ${this.file} is corrupted at line ${index + 1}: ${(e as Error).message}`,
        );
      }
      const parsed = eventSchema.safeParse(value);
      if (!parsed.success) {
        if (tornTail) return;
        throw new Error(
          `event log ${this.file} contains an invalid event at line ${index + 1}: ` +
            parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      }
      const event = parsed.data;
      const previous = this.events[this.events.length - 1];
      if (event.chain !== undefined) {
        if (this.chainState === "legacy") {
          throw new Error(
            `event log ${this.file}: partially chained at line ${index + 1} - a legacy log must stay unchained or be fully rewritten; mixing indicates tampering`,
          );
        }
        this.chainState = "chained";
        if (previous) {
          if (event.chain !== digestOf(previous)) {
            throw new Error(
              `event log ${this.file}: chain break at line ${index + 1} - the previous event does not hash to this event's chain pointer; the log was edited, reordered, or truncated`,
            );
          }
        } else if (event.chain !== EVENT_CHAIN_GENESIS) {
          throw new Error(
            `event log ${this.file}: first chained event does not carry the genesis pointer`,
          );
        }
      } else if (this.chainState === "chained") {
        throw new Error(
          `event log ${this.file}: partially chained at line ${index + 1} - an unchained event inside a chained log indicates tampering`,
        );
      } else {
        this.chainState = "legacy";
      }
      this.events.push(event);
    });
  }

  /** Whether the loaded log is hash-chained (new) or legacy (pre-chaining). */
  get chainStatus(): ChainStatus | null {
    return this.chainState;
  }

  /** Chain digest of the last loaded/appended event (null when empty). */
  chainHead(): string | null {
    const last = this.events[this.events.length - 1];
    return last ? digestOf(last) : null;
  }

  append(type: EventType, payload: Record<string, unknown> = {}): Event {
    // Legacy logs (written before chaining) stay legacy on append: a run
    // resumed across versions must not produce a mixed log.
    const chain =
      this.chainState === "legacy"
        ? {}
        : { chain: this.events.length === 0 ? EVENT_CHAIN_GENESIS : digestOf(this.events[this.events.length - 1]!) };
    const event: Event = {
      seq: this.events.length + 1,
      id: crypto.randomUUID(),
      type,
      runId: this.runId,
      timestamp: this.now(),
      payload,
      ...chain,
    };
    this.events.push(event);
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  all(): readonly Event[] {
    return this.events;
  }

  get length(): number {
    return this.events.length;
  }
}
