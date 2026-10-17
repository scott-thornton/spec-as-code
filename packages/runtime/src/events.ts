import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Event, EventType } from "@spc/schema";
import { eventSchema } from "@spc/schema";

/**
 * Append-only event log. state.json is a projection over these events;
 * a corrupted or missing state file must be recoverable from here.
 */
export class EventStore {
  private readonly events: Event[] = [];

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
      this.events.push(parsed.data);
    });
  }

  append(type: EventType, payload: Record<string, unknown> = {}): Event {
    const event: Event = {
      seq: this.events.length + 1,
      id: crypto.randomUUID(),
      type,
      runId: this.runId,
      timestamp: this.now(),
      payload,
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
