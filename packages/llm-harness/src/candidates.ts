import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkJsonSchema } from "./schema-check.js";
import type { HarnessAnswer, HarnessRequest, HarnessStore } from "./store.js";

/**
 * Portable answer candidates (RFC v3, docs/rfc-compose-off-the-clock.md):
 * computation produces candidates; authority admits candidates. An
 * immutable candidate is composed off the clock against a request's
 * recorded premises (pending or stale - composition against an expired
 * request is legal; the candidate confers no authority). A LIVE
 * successor request admits it via claim - the single atomic commit,
 * one rename of the answer file. The fingerprint is derived from the
 * AUTHORITATIVE records at each derivation, never trusted from the
 * candidate file. Consumption is derived: an answer record naming the
 * candidate exists or does not - crash recovery is a predicate, not a
 * reconciliation. An expired request stays dead forever.
 */

export interface CandidateFingerprint {
  taskDigest: string;
  schemaName: string;
  schemaDigest: string;
  baseRevision: string | null;
  writeScope: string[];
  configDigest: string;
}

export interface CandidateRecord {
  id: string;
  value: unknown;
  composedAgainst: CandidateFingerprint;
  composedFromRequest: string;
  composedAt: string;
  composedBy?: string;
}

export type ClaimResult =
  | { ok: true; answer: HarnessAnswer }
  | { ok: false; code: string; detail: string };

const sha = (v: unknown): string => "sha256:" + createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

/** The prompt's embedded JSON object (banner lines, then JSON). */
function extractPayload(prompt: string): Record<string, unknown> | null {
  const start = prompt.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < prompt.length; i++) {
    const ch = prompt[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(prompt.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function candidatesDir(store: HarnessStore): string {
  return path.join(store.base, "candidates");
}

/** Derived from the request's OWN records - never from a candidate file. */
export function deriveFingerprint(store: HarnessStore, request: HarnessRequest): CandidateFingerprint {
  const payload = extractPayload(request.prompt) ?? {};
  const task = (payload.task ?? {}) as Record<string, unknown>;
  const targets = (task.targets ?? {}) as { write?: string[] };
  const repository = (payload.repository ?? {}) as { revision?: string };
  const configPath = path.join(path.dirname(path.dirname(store.base)), ".spc", "config.yaml");
  return {
    taskDigest: sha(payload),
    schemaName: request.schemaName,
    schemaDigest: sha(request.jsonSchema),
    baseRevision: repository.revision ?? null,
    writeScope: targets.write ?? ((payload.allowedWritePaths as string[] | undefined) ?? []),
    configDigest: existsSync(configPath) ? "sha256:" + createHash("sha256").update(readFileSync(configPath)).digest("hex") : "none",
  };
}

function findRequestRecord(store: HarnessStore, id: string): HarnessRequest | null {
  for (const dir of ["pending", "stale"]) {
    const file = path.join(store.base, dir, `${id}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as HarnessRequest;
  }
  return null;
}

export function saveCandidate(
  store: HarnessStore,
  value: unknown,
  composedFromRequestId: string,
  composedBy?: string,
): CandidateRecord {
  const request = findRequestRecord(store, composedFromRequestId);
  if (!request) throw new Error(`no request record with id ${composedFromRequestId} (pending or stale)`);
  if (request.role !== "executor") {
    throw new Error(`CANDIDATE_ROLE_UNSUPPORTED: candidates are executors-only in v1 (request ${composedFromRequestId} is role ${request.role})`);
  }
  const record: CandidateRecord = {
    id: `cand-${randomBytes(6).toString("hex")}`,
    value,
    composedAgainst: deriveFingerprint(store, request),
    composedFromRequest: composedFromRequestId,
    composedAt: new Date().toISOString(),
    ...(composedBy ? { composedBy } : {}),
  };
  mkdirSync(candidatesDir(store), { recursive: true });
  writeFileSync(path.join(candidatesDir(store), `${record.id}.json`), JSON.stringify(record, null, 2), "utf8");
  return record;
}

export function getCandidate(store: HarnessStore, id: string): CandidateRecord | null {
  const file = path.join(candidatesDir(store), `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as CandidateRecord;
}

/** Derived consumption: an answer record names the candidate, or not. */
export function candidateConsumed(store: HarnessStore, id: string): boolean {
  const dir = path.join(store.base, "answered");
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue; // temp files are not answers
    try {
      const answer = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { candidateId?: string };
      if (answer.candidateId === id) return true;
    } catch {
      // unreadable answer record: not evidence of consumption
    }
  }
  return false;
}

function fingerprintDetail(composed: CandidateFingerprint, live: CandidateFingerprint): string | null {
  // Specific members first; the whole-payload taskDigest is a superset
  // digest and would otherwise swallow every other member's difference.
  const members: [keyof CandidateFingerprint, string][] = [
    ["baseRevision", "baseRevision"],
    ["writeScope", "writeScope"],
    ["schemaDigest", "schema"],
    ["configDigest", "config"],
    ["taskDigest", "task"],
  ];
  for (const [key, name] of members) {
    if (JSON.stringify(composed[key]) !== JSON.stringify(live[key])) {
      return `fingerprint member ${name} differs between composition and the live request`;
    }
  }
  return null;
}

export function claimCandidate(store: HarnessStore, candidateId: string, requestId: string): ClaimResult {
  const candidate = getCandidate(store, candidateId);
  if (!candidate) return { ok: false, code: "CANDIDATE_NOT_FOUND", detail: `no candidate with id ${candidateId}` };
  // Liveness first: an expired request stays dead, and that fact is
  // more fundamental than anything about the candidate.
  const request = store.getRequest(requestId);
  if (!request) {
    return { ok: false, code: "CANDIDATE_REQUEST_NOT_LIVE", detail: `request ${requestId} is not live in the pending queue (expired requests stay dead - compose a new candidate if premises still hold)` };
  }
  if (candidateConsumed(store, candidateId)) {
    return { ok: false, code: "CANDIDATE_CONSUMED", detail: `candidate ${candidateId} was already admitted by an earlier claim` };
  }
  const mismatch = fingerprintDetail(candidate.composedAgainst, deriveFingerprint(store, request));
  if (mismatch) {
    return { ok: false, code: "CANDIDATE_FINGERPRINT_MISMATCH", detail: `${mismatch}; the candidate is PRESERVED for a matching successor` };
  }
  const issues = checkJsonSchema(request.jsonSchema, candidate.value);
  if (issues.length > 0) {
    return { ok: false, code: "CANDIDATE_SCHEMA_INVALID", detail: issues.slice(0, 8).map((i) => `${i.path}: ${i.message}`).join("; ") };
  }
  // THE COMMIT: one rename installs the answer with both identities.
  // Before it: no state changed. After it: candidate consumed (derived).
  const answer: HarnessAnswer & { candidateId: string; claimedFromRequest: string } = {
    id: requestId,
    value: candidate.value,
    answeredAt: new Date().toISOString(),
    answeredBy: candidate.composedBy ?? "candidate",
    candidateId,
    claimedFromRequest: candidate.composedFromRequest,
  };
  const answeredDir = path.join(store.base, "answered");
  mkdirSync(answeredDir, { recursive: true });
  const tmp = path.join(answeredDir, `.${requestId}.tmp-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(answer, null, 2), "utf8");
  renameSync(tmp, path.join(answeredDir, `${requestId}.json`));
  return { ok: true, answer };
}
