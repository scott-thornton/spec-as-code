import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getCandidate } from "./candidates.js";

/**
 * File-backed request/response store for the harness provider. Layout under
 * `<root>/.spc/harness/`:
 *
 *   counters/<role>-<key>.json   { n }  - invocation counter per request key
 *   pending/<id>.json            the request currently awaiting an answer
 *   answered/<id>.json           the agent's answer for a request
 *   stale/<id>.json              retired requests (records, never deleted)
 *   .lock/                       cross-process mutation lock (mkdir-atomic)
 *
 * `spc agent list/show/respond` operate on the same directory, so any
 * external agent (a coding harness, a human with an editor) participates
 * without touching library internals.
 */

export const REQUEST_WINDOW_ELAPSED = "REQUEST_WINDOW_ELAPSED";
export const REQUEST_ALREADY_ANSWERED = "REQUEST_ALREADY_ANSWERED";

export interface HarnessRequest {
  id: string;
  role: string;
  key: string;
  schemaName: string;
  /** JSON Schema the answer must satisfy. */
  jsonSchema: unknown;
  system: string;
  prompt: string;
  createdAt: string;
  /** Response-window deadline stamped at dispatch (ISO instant). Absent
   *  on requests written before stamping existed: classification reads
   *  them as window-unknown, never expired. Refreshed when a rejected
   *  answer invites a retry. */
  expiresAt?: string;
  /** The spc run that dispatched this request, when one exists. */
  runId?: string;
  /** Set when a previous answer failed validation; the reason is included. */
  lastError?: string;
}

export interface HarnessAnswer {
  id: string;
  /** The structured value itself. */
  value: unknown;
  answeredBy?: string;
  answeredAt: string;
  /** Present when this answer admitted a portable candidate: the
   *  candidate's id and the request it was composed against (RFC v3
   *  lineage - both identities travel with the answer record). */
  candidateId?: string;
  claimedFromRequest?: string;
}

/** Synchronous sleep for lock retry (Node, any thread). */
function waitMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class HarnessStore {
  readonly base: string;

  /** Cross-process mutation lock: mkdir is atomic, so directory creation
   *  IS mutual exclusion. A live holder is waited out (bounded); a
   *  crashed holder (lock older than STALE_LOCK_MS) is broken so one
   *  dead process cannot wedge every other. */
  private static readonly LOCK_RETRY_MS = 25;
  private static readonly LOCK_BUDGET_MS = 5_000;
  private static readonly STALE_LOCK_MS = 10_000;

  private get lockDir(): string {
    return path.join(this.base, ".lock");
  }

  private acquireLock(): void {
    const deadline = Date.now() + HarnessStore.LOCK_BUDGET_MS;
    for (;;) {
      try {
        mkdirSync(this.lockDir);
        return;
      } catch {
        // Held. Break it if the holder crashed long ago.
        try {
          if (Date.now() - statSync(this.lockDir).mtimeMs > HarnessStore.STALE_LOCK_MS) {
            rmSync(this.lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          // vanished between stat and remove - fall through and retry
        }
      }
      if (Date.now() >= deadline) {
        // Budget spent: break even a young lock. The operations under the
        // lock are guarded writes and idempotent moves - worst case a
        // raced writer lands after us and the next guard sorts it out. A
        // wedged store helps nobody.
        rmSync(this.lockDir, { recursive: true, force: true });
        continue;
      }
      waitMs(HarnessStore.LOCK_RETRY_MS);
    }
  }

  private releaseLock(): void {
    rmSync(this.lockDir, { recursive: true, force: true });
  }

  /** Serialize a mutation against every other process touching this
   *  store. Nested acquisition is a deadlock by construction - locked
   *  sections must call only unlocked internals. */
  private withLock<T>(fn: () => T): T {
    this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock();
    }
  }

  constructor(rootDir: string, private readonly now: () => number = () => Date.now()) {
    this.base = path.join(rootDir, ".spc", "harness");
    for (const sub of ["counters", "pending", "answered", "stale"]) {
      mkdirSync(path.join(this.base, sub), { recursive: true });
    }
    // Self-heal: dead requests leave the live queue the moment any
    // process opens the store, so no provider ever dispatches one.
    this.sweepStale(HarnessStore.STALE_MS);
  }

  /** Allocate the next invocation number for a role+key pair. */
  nextInvocation(role: string, key: string): number {
    const file = path.join(this.base, "counters", `${sanitize(role)}-${sanitize(key)}.json`);
    let n = 0;
    if (existsSync(file)) {
      n = (JSON.parse(readFileSync(file, "utf8")) as { n: number }).n ?? 0;
    }
    n += 1;
    writeFileSync(file, JSON.stringify({ n }), "utf8");
    return n;
  }

  requestId(role: string, key: string, invocation: number): string {
    return `${sanitize(role)}-${sanitize(key)}-${invocation}`;
  }

  putRequest(request: HarnessRequest): void {
    this.withLock(() => this.writeRequest(request));
  }

  private writeRequest(request: HarnessRequest): void {
    writeFileSync(path.join(this.base, "pending", `${request.id}.json`), JSON.stringify(request, null, 2), "utf8");
  }

  getRequest(id: string): HarnessRequest | null {
    const file = path.join(this.base, "pending", `${id}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as HarnessRequest;
  }

  /**
   * Stale threshold: one hour, far beyond any response-timeout window.
   * Anything older is a dead request (abandoned run, missed polling
   * window) - it must not tax every session's queue or get answered
   * into a live run by mistake.
   */
  static readonly STALE_MS = 60 * 60 * 1000;

  listPending(): HarnessRequest[] {
    const dir = path.join(this.base, "pending");
    if (!existsSync(dir)) return [];
    const cutoff = Date.now() - HarnessStore.STALE_MS;
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as HarnessRequest)
      .filter((r) => Date.parse(r.createdAt) > cutoff || (r.expiresAt !== undefined && Date.parse(r.expiresAt) > Date.now()));
  }

  /** Everything ever pending, including swept-stale requests (records). */
  listPendingIncludingStale(): HarnessRequest[] {
    const read = (dir: string): HarnessRequest[] => {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as HarnessRequest);
    };
    return [...read(path.join(this.base, "pending")), ...read(path.join(this.base, "stale"))];
  }

  /**
   * Expire one request immediately (timeout path): out of the live
   * queue into stale/, recorded, never deleted.
   */
  expirePending(id: string): void {
    this.withLock(() => {
      const from = path.join(this.base, "pending", `${id}.json`);
      if (!existsSync(from)) return;
      const staleDir = path.join(this.base, "stale");
      mkdirSync(staleDir, { recursive: true });
      renameSync(from, path.join(staleDir, `${id}.json`));
    });
  }

  /**
   * Retire every pending request stamped with this run (the cancellation
   * path): out of the live queue into stale/, kept as records, ids
   * returned. The sanctioned kill must not orphan - requests of other
   * runs and unattributed ones are not touched.
   */
  expireForRun(runId: string): string[] {
    return this.withLock(() => {
      const dir = path.join(this.base, "pending");
      if (!existsSync(dir)) return [];
      const staleDir = path.join(this.base, "stale");
      mkdirSync(staleDir, { recursive: true });
      const retired: string[] = [];
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        const full = path.join(dir, f);
        try {
          const request = JSON.parse(readFileSync(full, "utf8")) as HarnessRequest;
          if (request.runId === runId) {
            renameSync(full, path.join(staleDir, f));
            retired.push(request.id);
          }
        } catch {
          // unreadable request file: leave it alone
        }
      }
      return retired.sort();
    });
  }

  /**
   * Move requests older than maxAgeMs out of the live queue into
   * stale/. Filed, never deleted - they are decision records. Returns
   * the number moved. Idempotent.
   */
  sweepStale(maxAgeMs: number): number {
    return this.withLock(() => {
      const dir = path.join(this.base, "pending");
      if (!existsSync(dir)) return 0;
      const cutoff = Date.now() - maxAgeMs;
      const staleDir = path.join(this.base, "stale");
      mkdirSync(staleDir, { recursive: true });
      let moved = 0;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        const full = path.join(dir, f);
        try {
          const request = JSON.parse(readFileSync(full, "utf8")) as HarnessRequest;
          if (
            Date.parse(request.createdAt) <= cutoff &&
            // An open window protects a request from sweeping however old
            // it is (executor windows at 60 minutes meet the one-hour
            // sweep head-on); unstamped legacy requests and elapsed
            // windows retire as before (specs/window-recalibration WT-004).
            (request.expiresAt === undefined || Date.parse(request.expiresAt) <= Date.now())
          ) {
            renameSync(full, path.join(staleDir, f));
            moved += 1;
          }        } catch {
          // unreadable request file: leave it alone
        }
      }
      return moved;
    });
  }

  getAnswer(id: string): HarnessAnswer | null {
    const file = path.join(this.base, "answered", `${id}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as HarnessAnswer;
  }

  /**
   * Submit an answer for a pending request. The guards live HERE, at the
   * write boundary, so every caller (CLI, library, future surfaces)
   * inherits them - a submission the machine cannot consume is refused
   * with the reason, never silently accepted:
   *
   * - unknown id: names both resolutions (consumed vs retired);
   * - window elapsed: the dispatching run stopped consuming - nothing
   *   written now will be read (compose a candidate instead);
   * - already answered with no lastError: submitted but not consumed -
   *   while the window is open the run may still accept it, so wait.
   *   Consumer death is declared ONLY by an elapsed window or a retired
   *   request, never inferred from an unanswered poll.
   *   A lastError present means the prior answer was REJECTED and a
   *   corrected retry is invited: the overwrite is the intent.
   */
  answer(id: string, value: unknown, answeredBy?: string): HarnessAnswer {
    return this.withLock(() => {
      const request = this.getRequest(id);
      if (!request) {
        throw new Error(
          `no pending request with id ${id}: it was consumed (an answered/${id}.json record remains), retired (see .spc/harness/stale/${id}.json), or never existed`,
        );
      }
      if (request.expiresAt !== undefined && Date.parse(request.expiresAt) <= this.now()) {
        throw new Error(
          `${REQUEST_WINDOW_ELAPSED}: ${id}'s response window closed at ${request.expiresAt}; the run that dispatched it stopped consuming, so nothing written now will be read. Next: spc agent list for the newest live request, or spc agent save-candidate to keep the composed work claimable.`,
        );
      }
      if (this.hasAnswer(id) && !request.lastError) {
        throw new Error(
          `${REQUEST_ALREADY_ANSWERED}: ${id} already has an answer (written ${this.getAnswer(id)?.answeredAt ?? "earlier"}) and it has not been consumed; while the window is open the dispatching run may still accept it - wait. Resubmitting cannot help.`,
        );
      }
      const answer: HarnessAnswer = {
        id,
        value,
        answeredAt: new Date().toISOString(),
        ...(answeredBy ? { answeredBy } : {}),
      };
      writeFileSync(path.join(this.base, "answered", `${id}.json`), JSON.stringify(answer, null, 2), "utf8");
      return answer;
    });
  }

  /**
   * Move an answer back to pending after validation failure, attaching the
   * failure so the answering agent can retry with feedback. Keeps the same
   * request id.
   */
  requeueWithFeedback(id: string, error: string, refreshWindowMs?: number): void {
    this.withLock(() => {
      const request = this.getRequest(id);
      if (!request) return;
      const answer = this.getAnswer(id);
      request.lastError = error;
      if (answer) {
        request.lastError = error + "\nPrior answer (invalid): " + JSON.stringify(answer.value).slice(0, 2000);
      }
      // A rejected answer invites a retry: refresh the stamped deadline so
      // the retry is not starved by the rounds already spent. Callers pass
      // the window only while they also refresh their poll anchor, so
      // garbage loops still die on time.
      if (refreshWindowMs !== undefined && request.expiresAt) {
        request.expiresAt = new Date(this.now() + refreshWindowMs).toISOString();
      }
      this.writeRequest(request);
    });
  }

  /** Remove the pending file once its answer is accepted; answers are kept. */
  clearPending(id: string): void {
    this.withLock(() => {
      rmSync(path.join(this.base, "pending", `${id}.json`), { force: true });
    });
  }

  /** True once an answer file exists for the id. */
  hasAnswer(id: string): boolean {
    return existsSync(path.join(this.base, "answered", `${id}.json`));
  }

  /** A portable answer candidate by id (see candidates.ts). */
  getCandidate(id: string): import("./candidates.js").CandidateRecord | null {
    return getCandidate(this, id);
  }
}

export type RequestState = "live" | "elapsed" | "unknown";

/**
 * Derived, never persisted: a stamped request is answerable only inside
 * its window. Unstamped requests (written before stamping existed) read
 * as unknown - live until the stale sweep retires them - because no
 * deadline was ever recorded for them.
 */
export function requestState(request: HarnessRequest, now: number = Date.now()): RequestState {
  if (!request.expiresAt) return "unknown";
  return Date.parse(request.expiresAt) > now ? "live" : "elapsed";
}

function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9@._-]+/g, "_");
}
