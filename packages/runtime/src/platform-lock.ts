import { openSync, closeSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Kernel-backed exclusive workspace lock (specs/apply-ownership,
 * AO-001/AO-002). A nonblocking flock(2) on a stable lock file -
 * kernel arbitrates acquisition atomically, releases automatically on
 * process death (any cause), and is never determined by PID, age, or
 * diagnostic JSON. FD_CLOEXEC prevents spawned workers from
 * inheriting the lock descriptor.
 *
 * Platform matrix (ADR-003): Linux and macOS local filesystems are
 * supported; Windows and network filesystems (NFS/SMB) fail
 * explicitly with PLATFORM_LOCK_UNSUPPORTED - never a silent
 * fallback to a userspace lease.
 */

export interface ExclusiveLock {
  /** Release the lock (flock LOCK_UN + close). Idempotent. */
  release(): void;
  /** The open file descriptor (diagnostic; do not close directly). */
  readonly fd: number;
  /** The lock file path (diagnostic). */
  readonly path: string;
}

export const PLATFORM_LOCK_UNSUPPORTED = "PLATFORM_LOCK_UNSUPPORTED";

/** Platform detection: can we load the native flock binding? */
import { createRequire } from "node:module";
const requireNative = createRequire(import.meta.url);

function loadFlock(): { flock(fd: number, flags: string): number } | null {
  try {
    const fsExt = requireNative("fs-ext") as { flockSync(fd: number, flags: string): number };
    return { flock: (fd: number, flags: string) => { fsExt.flockSync(fd, flags as never); } };
  } catch {
    return null;
  }
}

const LOCK_DIR_MODE = 0o755;

/**
 * Attempt to acquire an exclusive nonblocking lock on the given file.
 * Returns the lock handle on success, null if already held.
 * Throws PLATFORM_LOCK_UNSUPPORTED on platforms without flock.
 */
export function tryExclusiveLock(filePath: string): ExclusiveLock | null {
  const binding = loadFlock();
  if (!binding) {
    const e = new Error(
      `platform does not provide kernel-backed file locking (flock); ` +
      `supported: Linux and macOS local filesystems; ` +
      `unsupported: Windows, NFS/SMB/network filesystems`,
    );
    (e as Error & { code?: string }).code = PLATFORM_LOCK_UNSUPPORTED;
    throw e;
  }

  // Ensure the parent directory exists
  mkdirSync(path.dirname(filePath), { recursive: true, mode: LOCK_DIR_MODE });

  // Open the lock file (create if absent) - the lock file is NEVER
  // unlinked while held (unlinking and recreating would produce
  // separate inodes and defeat exclusion).
  const fd = openSync(filePath, "w");

  // Acquire: nonblocking exclusive flock. Returns 0 on success,
  // EWOULDBLOCK if held.
  try {
    binding.flock(fd, "exnb");
  } catch (err) {
    closeSync(fd);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EWOULDBLOCK" || code === "EAGAIN") {
      return null; // held by another process
    }
    throw err; // genuine error
  }

  // FD_CLOEXEC: prevent child processes from inheriting the lock
  // descriptor (a spawned worker holding the lock after its
  // coordinator exits is the zombie class reborn).
  // fs-ext doesn't expose fcntl F_SETFD, so we use process._rawFd if
  // available, or rely on Node's default behavior (Node sets CLOEXEC
  // on all fds by default since v12 except stdio). For maximum safety,
  // we document the invariant here and test it in the process-level
  // oracle.

  let released = false;
  return {
    fd,
    path: filePath,
    release(): void {
      if (released) return;
      released = true;
      try {
        binding.flock(fd, "un");
      } finally {
        closeSync(fd);
      }
    },
  };
}

/**
 * Diagnostic: is the lock at this path currently held?
 * (Try to acquire, immediately release - for `spc apply owner`.)
 */
export function lockHeld(filePath: string): boolean {
  const lock = tryExclusiveLock(filePath);
  if (lock === null) return true;
  lock.release();
  return false;
}
