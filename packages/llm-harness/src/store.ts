import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * File-backed request/response store for the harness provider. Layout under
 * `<root>/.spc/harness/`:
 *
 *   counters/<role>-<key>.json   { n }  - invocation counter per request key
 *   pending/<id>.json            the request currently awaiting an answer
 *   answered/<id>.json           the agent's answer for a request
 *
 * `spc agent list/show/respond` operate on the same directory, so any
 * external agent (a coding harness, a human with an editor) participates
 * without touching library internals.
 */

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
  /** Set when a previous answer failed validation; the reason is included. */
  lastError?: string;
}

export interface HarnessAnswer {
  id: string;
  /** The structured value itself. */
  value: unknown;
  answeredBy?: string;
  answeredAt: string;
}

export class HarnessStore {
  readonly base: string;

  constructor(rootDir: string) {
    this.base = path.join(rootDir, ".spc", "harness");
    for (const sub of ["counters", "pending", "answered"]) {
      mkdirSync(path.join(this.base, sub), { recursive: true });
    }
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
    writeFileSync(path.join(this.base, "pending", `${request.id}.json`), JSON.stringify(request, null, 2), "utf8");
  }

  getRequest(id: string): HarnessRequest | null {
    const file = path.join(this.base, "pending", `${id}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as HarnessRequest;
  }

  listPending(): HarnessRequest[] {
    const dir = path.join(this.base, "pending");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as HarnessRequest);
  }

  getAnswer(id: string): HarnessAnswer | null {
    const file = path.join(this.base, "answered", `${id}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as HarnessAnswer;
  }

  /** Submit an answer for a pending request; refuses unknown ids. */
  answer(id: string, value: unknown, answeredBy?: string): HarnessAnswer {
    const request = this.getRequest(id);
    if (!request) {
      throw new Error(`no pending request with id ${id}`);
    }
    const answer: HarnessAnswer = {
      id,
      value,
      answeredAt: new Date().toISOString(),
      ...(answeredBy ? { answeredBy } : {}),
    };
    writeFileSync(path.join(this.base, "answered", `${id}.json`), JSON.stringify(answer, null, 2), "utf8");
    return answer;
  }

  /**
   * Move an answer back to pending after validation failure, attaching the
   * failure so the answering agent can retry with feedback. Keeps the same
   * request id.
   */
  requeueWithFeedback(id: string, error: string): void {
    const request = this.getRequest(id);
    if (!request) return;
    const answer = this.getAnswer(id);
    request.lastError = error;
    if (answer) {
      request.lastError = error + "\nPrior answer (invalid): " + JSON.stringify(answer.value).slice(0, 2000);
    }
    this.putRequest(request);
  }

  /** Remove the pending file once its answer is accepted; answers are kept. */
  clearPending(id: string): void {
    rmSync(path.join(this.base, "pending", `${id}.json`), { force: true });
  }

  /** True once an answer file exists for the id. */
  hasAnswer(id: string): boolean {
    return existsSync(path.join(this.base, "answered", `${id}.json`));
  }
}

function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9@._-]+/g, "_");
}
