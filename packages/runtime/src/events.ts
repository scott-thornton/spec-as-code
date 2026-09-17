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

  load(): void {
    if (!existsSync(this.file)) return;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const parsed = eventSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) this.events.push(parsed.data);
    }
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
