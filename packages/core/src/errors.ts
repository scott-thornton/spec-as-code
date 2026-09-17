/**
 * Typed application error. Library code throws or returns these; only the
 * CLI entrypoint may translate them into process exit codes.
 */
export class SpcError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SpcError";
    this.code = code;
    this.details = details;
  }
}

export function isSpcError(e: unknown): e is SpcError {
  return e instanceof SpcError;
}
