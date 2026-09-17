import { readFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import { HarnessStore } from "@spc/llm-harness";
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

export function runAgentShow(id: string, cwd: string | undefined): number {
  const { store } = storeFor(cwd);
  const request = store.getRequest(id);
  if (!request) {
    throw new SpcError("HARNESS_REQUEST_NOT_FOUND", `no pending harness request with id ${id}`);
  }
  console.log(JSON.stringify(request, null, 2));
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
