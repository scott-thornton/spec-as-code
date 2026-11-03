import { resolveRepoRoot } from "../context.js";
import { tryExclusiveLock, lockHeld } from "@spc/runtime";
import { readIntent } from "@spc/runtime";
import path from "node:path";

/** `spc apply owner` - the three-authority report (AO-006). */
export function runApplyOwner(cwd?: string): number {
  const repoRoot = resolveRepoRoot(cwd);
  const lockPath = path.join(repoRoot, ".spc", "apply.lock");

  // Authority 1: kernel lock (authoritative for coordinator ownership)
  const lockOccupied = lockHeld(lockPath);
  console.log(`Lock (kernel-authoritative):    ${lockOccupied ? "HELD - another coordinator owns execution" : "free"}`);

  // Authority 2: safety block (authoritative for workspace safety)
  const intent = readIntent(repoRoot);
  if (intent.ok) {
    console.log(`Safety block (safety-authoritative): PRESENT`);
    console.log(`  Run: ${intent.intent.runId} | Cause: ${intent.intent.cause}`);
    console.log(`  Workers: ${intent.intent.workers.length} registered`);
    console.log(`  Coordinator: pid ${intent.intent.coordinator.pid} on ${intent.intent.coordinator.host}`);
    console.log(`  → The workspace may be unsafe. Recover: spc apply recover`);
  } else {
    console.log(`Safety block (safety-authoritative): clear (no unresolved execution intent)`);
  }

  // Authority 3: advisory metadata
  console.log(`Metadata (advisory):             ${intent.ok ? `recorded for run ${intent.intent.runId}` : "none"}`);

  // Actionable next steps
  console.log("");
  if (lockOccupied && intent.ok) {
    console.log(`Next: spc run cancel ${intent.intent.runId}  (stop the holder)`);
  } else if (!lockOccupied && intent.ok) {
    console.log(`Next: spc apply recover  (clear the safety block)`);
  } else {
    console.log(`Next: proceed - workspace is free and safe`);
  }
  return 0;
}
