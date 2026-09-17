import { globMatchAny, isSafeRelativePath, normalizeRelPath } from "@spc/core";

export const OUT_OF_SCOPE_WRITE = "OUT_OF_SCOPE_WRITE";
export const UNSAFE_PATH = "UNSAFE_PATH";

export interface ScopeViolation {
  path: string;
  code: string;
  reason: string;
}

/**
 * Write-scope enforcement against the actual set of changed paths (derived
 * from git, never from agent claims). Never silently expand task scope.
 */
export function enforceWriteScope(
  writePatterns: readonly string[],
  changedPaths: readonly string[],
): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  for (const raw of changedPaths) {
    const path = normalizeRelPath(raw);
    if (!isSafeRelativePath(path)) {
      violations.push({ path: raw, code: UNSAFE_PATH, reason: `"${raw}" is not a safe relative path` });
      continue;
    }
    if (!globMatchAny(writePatterns, path)) {
      violations.push({
        path: raw,
        code: OUT_OF_SCOPE_WRITE,
        reason:
          writePatterns.length === 0
            ? `task declares no write targets but changed "${raw}"`
            : `"${raw}" does not match any declared write target`,
      });
    }
  }
  return violations;
}
