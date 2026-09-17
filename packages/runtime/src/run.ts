import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileSpecSource, SpcError } from "@spc/core";
import { configSchema, planSchema, type Config, type Plan } from "@spc/schema";
import { parse as parseYaml } from "yaml";
import type { RunMeta } from "./state.js";
import type { SpcPaths } from "./paths.js";

export type { RunMeta };

export const RUNTIME_ERROR = "SPC_RUNTIME_ERROR";

export function newRunId(): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `run-${Date.now().toString(36)}-${rand}`;
}

export function newPlanId(plansDir: string, now: () => Date = () => new Date()): string {
  const d = now();
  const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  let seq = 1;
  if (existsSync(plansDir)) {
    const existing = readdirSync(plansDir)
      .filter((f) => f.startsWith(`plan-${date}`))
      .map((f) => Number(f.match(/plan-\d{8}-(\d+)\.json/)?.[1] ?? 0));
    seq = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  }
  return `plan-${date}-${String(seq).padStart(3, "0")}`;
}

export function loadPlanFile(file: string): Plan {
  let data: unknown;
  try {
    data = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    throw new SpcError(RUNTIME_ERROR, `cannot read plan ${file}: ${(e as Error).message}`);
  }
  const parsed = planSchema.safeParse(data);
  if (!parsed.success) {
    throw new SpcError(
      RUNTIME_ERROR,
      `plan ${file} failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) return configSchema.parse({});
  let data: unknown;
  try {
    data = parseYaml(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new SpcError(RUNTIME_ERROR, `.spc/config.yaml is not valid YAML: ${(e as Error).message}`);
  }
  const parsed = configSchema.safeParse(data ?? {});
  if (!parsed.success) {
    throw new SpcError(
      RUNTIME_ERROR,
      `.spc/config.yaml is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/** Find the spec file under specs/ whose metadata.id matches. */
export function findSpecFile(specsDir: string, specId: string): string | null {
  if (!existsSync(specsDir)) return null;
  for (const entry of readdirSync(specsDir).sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const file = path.join(specsDir, entry);
    const result = compileSpecSource(readFileSync(file, "utf8"), file);
    if (result.ok && result.ir?.spec.metadata.id === specId) return file;
  }
  return null;
}

export function listPlans(plansDir: string): string[] {
  if (!existsSync(plansDir)) return [];
  return readdirSync(plansDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".approved.json"))
    .sort();
}

export function latestPlanFile(plansDir: string): string | null {
  const plans = listPlans(plansDir);
  return plans.length > 0 ? path.join(plansDir, plans[plans.length - 1]!) : null;
}

export function loadRunMeta(runsDir: string, runId: string): RunMeta | null {
  const file = path.join(runsDir, runId, "metadata.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunMeta;
  } catch {
    return null;
  }
}

export function listRunIds(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((f) => existsSync(path.join(runsDir, f, "metadata.json"))).sort();
}

export function isPlanApproved(paths: SpcPaths, planId: string): boolean {
  return existsSync(paths.planApprovalFile(planId));
}
