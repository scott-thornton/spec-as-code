import { readFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import { HarnessStore, checkJsonSchema } from "@spc/llm-harness";
import { resolveRepoRoot } from "../context.js";

/**
 * `spc agent` - the harness-side half of the harness provider: the external
 * agent (a coding harness or a human) inspects pending model requests and
 * answers them, with the JSON Schema embedded in each request.
 */

function storeFor(cwd?: string): { repoRoot: string; store: HarnessStore } {
  const repoRoot = resolveRepoRoot(cwd);
  return { repoRoot, store: new HarnessStore(repoRoot) };
}

export function runAgentList(cwd: string | undefined, format: "text" | "json"): number {
  const { store } = storeFor(cwd);
  const pending = store.listPending();
  if (format === "json") {
    console.log(
      JSON.stringify(
        pending.map((r) => ({
          id: r.id,
          role: r.role,
          key: r.key,
          schemaName: r.schemaName,
          createdAt: r.createdAt,
          ...(r.lastError ? { lastError: r.lastError } : {}),
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (pending.length === 0) {
    console.log("No pending harness requests.");
    return 0;
  }
  for (const r of pending) {
    console.log(`${r.id}  [${r.role}]  ${r.schemaName}`);
    if (r.lastError) {
      console.log(`    retry needed - previous answer invalid: ${r.lastError.split("\n")[0]}`);
    }
  }
  console.log("\nInspect with:  spc agent show <id>");
  console.log("Answer with:   spc agent respond <id> --file <answer.json>");
  return 1;
}

const SHOW_PARTS = ["system", "prompt", "schema", "payload", "json"] as const;
export type AgentShowPart = (typeof SHOW_PARTS)[number];

/** Extract the prompt's embedded JSON object (banner lines, then JSON). */
function extractPromptPayload(prompt: string): unknown {
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
          return JSON.parse(prompt.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function runAgentShow(id: string, cwd: string | undefined, part?: AgentShowPart): number {
  const { store } = storeFor(cwd);
  const request = store.getRequest(id);
  if (!request) {
    throw new SpcError("HARNESS_REQUEST_NOT_FOUND", `no pending harness request with id ${id}`);
  }
  // Decomposition first: consumers should never hand-parse a request
  // blob (the first field run wrote a python script for exactly this).
  if (part === "system") {
    console.log(request.system);
    return 0;
  }
  if (part === "prompt") {
    console.log(request.prompt);
    return 0;
  }
  if (part === "schema") {
    console.log(JSON.stringify(request.jsonSchema, null, 2));
    return 0;
  }
  if (part === "payload") {
    const payload = extractPromptPayload(request.prompt);
    if (payload === null || typeof payload !== "object") {
      throw new SpcError("HARNESS_PROMPT_PAYLOAD", `the prompt for ${id} carries no parseable JSON object`);
    }
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  if (part === "json") {
    console.log(JSON.stringify(request, null, 2));
    return 0;
  }
  console.log(`=== SYSTEM ===\n${request.system}\n\n=== PROMPT ===\n${request.prompt}\n\n=== SCHEMA (${request.schemaName}) ===`);
  console.log(JSON.stringify(request.jsonSchema, null, 2));
  return 0;
}

export function runAgentRespond(options: { id: string; file?: string; stdin?: boolean; by?: string; cwd?: string }): number {
  const { store } = storeFor(options.cwd);
  let raw: string;
  if (options.file) {
    raw = readFileSync(path.resolve(process.cwd(), options.file), "utf8");
  } else if (options.stdin) {
    raw = readFileSync(0, "utf8");
  } else {
    throw new SpcError("HARNESS_RESPOND_INPUT", "pass --file <answer.json> or --stdin");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new SpcError("HARNESS_RESPOND_INPUT", `answer is not valid JSON: ${(e as Error).message}`);
  }
  const answer = store.answer(options.id, value, options.by);
  console.log(`Answered ${answer.id}. The waiting spc process will pick it up within a second or two.`);
  console.log("If the answer fails schema validation, the request reappears in spc agent list with feedback.");
  return 0;
}

/**
 * Preflight: check a draft answer against the pending request's JSON
 * Schema BEFORE submitting, so schema problems cost a local command
 * instead of a submit-requeue-regenerate round trip. Advisory - the
 * authoritative check remains the runtime's zod validation.
 */
export function runAgentValidate(options: { id: string; file: string; cwd?: string }): number {
  const { store } = storeFor(options.cwd);
  const request = store.getRequest(options.id);
  if (!request) {
    throw new SpcError("HARNESS_REQUEST_NOT_FOUND", `no pending harness request with id ${options.id}`);
  }
  const raw = readFileSync(path.resolve(process.cwd(), options.file), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new SpcError("HARNESS_RESPOND_INPUT", `answer is not valid JSON: ${(e as Error).message}`);
  }
  const issues = checkJsonSchema(request.jsonSchema, value);
  if (issues.length === 0) {
    console.log(`OK: answer satisfies the ${request.schemaName} schema. Submit with:`);
    console.log(`  spc agent respond ${request.id} --file ${options.file}`);
    return 0;
  }
  console.error(`${issues.length} schema issue(s) - fix before submitting (a submit would requeue with the same errors):`);
  for (const issue of issues.slice(0, 20)) {
    console.error(`  ${issue.path}: ${issue.message}`);
  }
  return 1;
}
