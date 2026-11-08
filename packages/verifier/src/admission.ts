import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { tryExclusiveLock, type ExclusiveLock } from "@spc/repo";

/**
 * Host verification admission (specs/host-battery-admission). One
 * nonblocking kernel lock per user per host, OUTSIDE every repository
 * (.spc is worktree-local): processes in different repositories
 * contend on the same lock, so two fresh criteria subprocesses never
 * overlap on one machine (three crashes' worth of evidence that
 * resource exhaustion corrupts observations). The path is overridable
 * for tests; the default is stable per user and host.
 */
export function hostAdmissionLockPath(): string {
  return process.env.SPC_ADMISSION_LOCK ?? path.join(os.homedir(), ".spc", "host-admission.lock");
}

/** Acquire (nonblocking) or refuse: null means another fresh
 *  verification subprocess holds the host. Never waits. */
export function acquireHostAdmission(): ExclusiveLock | null {
  const file = hostAdmissionLockPath();
  mkdirSync(path.dirname(file), { recursive: true });
  return tryExclusiveLock(file);
}
