import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "../context.js";

interface UsageAnsweredFile {
  file: string;
  id: string;
  value: { changes?: { op: string; content?: string; anchor?: string; replacement?: string; command?: string }[]; commands?: { command: string }[] };
  answeredAt: string;
}

/**
 * `spc usage` - corpus economics from recorded state: per-run model
 * calls by role, op distribution with exact emitted bytes, patch usage
 * rate, refusal and retry counts. Bytes are exact from answered values;
 * tokens are never claimed (no estimate is printed as a measurement).
 * Read-only: renders .spc records, writes nothing.
 */
export function runUsage(cwd: string | undefined, format: "text" | "json" = "text"): number {
  const repoRoot = resolveRepoRoot(cwd);
  const runsDir = path.join(repoRoot, ".spc", "runs");
  const answeredDir = path.join(repoRoot, ".spc", "harness", "answered");
  const answered: UsageAnsweredFile[] = [];
  if (existsSync(answeredDir)) {
    for (const f of readdirSync(answeredDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(readFileSync(path.join(answeredDir, f), "utf8"));
        if (j?.id && j?.value) answered.push({ file: f, id: j.id, value: j.value, answeredAt: j.answeredAt ?? "" });
      } catch {
        // unreadable answer: not our business here
      }
    }
  }
  answered.sort((a, b) => a.answeredAt.localeCompare(b.answeredAt));

  interface RunRow {
    runId: string;
    specId: string;
    modelCalls: number;
    modelCallsByRole: Record<string, number>;
    ops: Record<string, number>;
    emittedBytes: Record<string, number>;
    patchUsageRate: number | null;
    refusals: number;
    retries: number;
  }

  const rows: RunRow[] = [];
  if (existsSync(runsDir)) {
    for (const entry of readdirSync(runsDir).sort()) {
      const metaFile = path.join(runsDir, entry, "metadata.json");
      if (!existsSync(metaFile)) continue;
      let meta: { runId?: string; kind?: string; specId?: string };
      try {
        meta = JSON.parse(readFileSync(metaFile, "utf8"));
      } catch {
        continue;
      }
      if (meta.kind !== "apply" || !meta.runId) continue;

      const modelCallsByRole: Record<string, number> = {};
      const usageFile = path.join(runsDir, entry, "usage.jsonl");
      if (existsSync(usageFile)) {
        for (const line of readFileSync(usageFile, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as { role?: string };
            if (rec.role) modelCallsByRole[rec.role] = (modelCallsByRole[rec.role] ?? 0) + 1;
          } catch {
            // torn line: skip
          }
        }
      }

      let refusals = 0;
      let retries = 0;
      const pairs = new Set<string>();
      const stateFile = path.join(runsDir, entry, "state.json");
      if (existsSync(stateFile)) {
        try {
          const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
            tasks?: Record<string, { attempt?: number; failure?: { code?: string } }>;
          };
          for (const t of Object.values(state.tasks ?? {})) {
            const attempt = t.attempt ?? 1;
            if (attempt > 1) retries += 1;
            if (t.failure?.code && /^(PATCH_|TOUCH_SET_|COMMAND_)/.test(t.failure.code)) refusals += 1;
          }
          // Task ids for answered attribution: every attempt number seen
          // plus the current one, matching executor-<task>@<attempt> ids.
          for (const [taskId, t] of Object.entries(state.tasks ?? {})) {
            const max = t.attempt ?? 1;
            for (let a = 1; a <= max; a++) pairs.add(`${taskId}@${a}`);
          }
        } catch {
          // unreadable state: economics still reported from usage records
        }
      }

      const ops: Record<string, number> = {};
      const emittedBytes: Record<string, number> = {};
      const bump = (k: string, bytes: number): void => {
        ops[k] = (ops[k] ?? 0) + 1;
        emittedBytes[k] = (emittedBytes[k] ?? 0) + bytes;
      };
      for (const a of answered) {
        const m = a.id.match(/^executor-(T\d+)@(\d+)-\d+$/);
        if (!m || !pairs.has(`${m[1]}@${m[2]}`)) continue;
        for (const c of a.value.changes ?? []) {
          if (c.op === "patch") bump("patch", (c.anchor?.length ?? 0) + (c.replacement?.length ?? 0));
          else if (c.op === "create" || c.op === "update") bump(c.op, c.content?.length ?? 0);
          else if (c.op === "delete") bump("delete", 0);
        }
        for (const c of a.value.commands ?? []) bump("commands", c.command.length);
      }
      const denominator = (ops.patch ?? 0) + (ops.update ?? 0);
      rows.push({
        runId: meta.runId,
        specId: meta.specId ?? "?",
        modelCalls: Object.values(modelCallsByRole).reduce((s, n) => s + n, 0),
        modelCallsByRole,
        ops,
        emittedBytes,
        patchUsageRate: denominator > 0 ? (ops.patch ?? 0) / denominator : null,
        refusals,
        retries,
      });
    }
  }

  const corpusOps: Record<string, number> = {};
  const corpusBytes: Record<string, number> = {};
  let corpusPatch = 0;
  let corpusDen = 0;
  for (const r of rows) {
    for (const [k, n] of Object.entries(r.ops)) corpusOps[k] = (corpusOps[k] ?? 0) + n;
    for (const [k, n] of Object.entries(r.emittedBytes)) corpusBytes[k] = (corpusBytes[k] ?? 0) + n;
    corpusPatch += r.ops.patch ?? 0;
    corpusDen += (r.ops.patch ?? 0) + (r.ops.update ?? 0);
  }

  if (format === "json") {
    console.log(JSON.stringify({
      runs: rows,
      corpus: { ops: corpusOps, emittedBytes: corpusBytes, patchUsageRate: corpusDen > 0 ? corpusPatch / corpusDen : null },
    }, null, 2));
    return 0;
  }

  const pct = (x: number | null): string => (x === null ? "-" : `${Math.round(x * 100)}%`);
  for (const r of rows) {
    console.log(`${r.runId}  (${r.specId})`);
    console.log(`  model calls: ${r.modelCalls}  ${Object.entries(r.modelCallsByRole).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    const opsLine = Object.entries(r.ops).map(([k, v]) => `${k} ${v} (${r.emittedBytes[k] ?? 0}B)`).join(", ");
    console.log(`  ops: ${opsLine || "none"}`);
    console.log(`  patch usage: ${pct(r.patchUsageRate)}   refusals: ${r.refusals}   retries: ${r.retries}`);
  }
  console.log(`corpus: ${Object.entries(corpusOps).map(([k, v]) => `${k} ${v}`).join(", ") || "no ops"}   patch usage: ${pct(corpusDen > 0 ? corpusPatch / corpusDen : null)}   emitted: ${Object.values(corpusBytes).reduce((s, n) => s + n, 0)}B (bytes, not tokens)`);
  return 0;
}
