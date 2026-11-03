import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // These are integration tests: sequential real `git` spawnSync calls
    // that vitest cannot preempt, so a loaded machine inflates them past
    // any fixed budget. The 5s default produced timeout-only false reds
    // under load epochs (51+ across run history; calm-machine worst
    // case <1s, so 30s is headroom, not a hang mask - a true hang needs
    // a subprocess deadline in the adapter, a separate concern).
    testTimeout: 30_000,
  },
});
