import { defineConfig } from "vitest/config";

export default defineConfig({
  // pool: threads (not vitest 3's forks default) - the forks pool trips
  // '[vitest-worker]: Timeout calling onTaskUpdate' as an UNHANDLED teardown
  // error on child-heavy long test files (the challenge corpus: ~90s driving
  // cold build pipelines) - every test passes, the process still exits 1.
  // Threads exits clean; vitest reads the pool here, criterion commands stay
  // byte-identical.
  test: { include: ["src/**/*.test.ts"], environment: "node", setupFiles: ["./src/admission-test-setup.ts"], pool: "threads" },
});
