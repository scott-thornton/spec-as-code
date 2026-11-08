/**
 * Moved to @spc/repo (specs/host-battery-admission: the verifier's
 * admission seam needs the kernel-lock primitive without importing
 * @spc/runtime - a package cycle). This shim keeps runtime's internal
 * importers stable.
 */
export { tryExclusiveLock, lockHeld, PLATFORM_LOCK_UNSUPPORTED } from "@spc/repo";
export type { ExclusiveLock } from "@spc/repo";
