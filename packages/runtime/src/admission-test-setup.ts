import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// specs/host-battery-admission test isolation: suites in this package
// execute command criteria through the real executor, which acquires
// the HOST admission lock. Test workers are not host batteries - pin a
// per-worker lock path so parallel sibling files never contend on the
// default host lock (the CI collision: sibling applies refusing each
// other's criteria), and spawned subprocesses inherit the pin.
const dir = mkdtempSync(path.join(tmpdir(), "spc-adm-setup-"));
process.env.SPC_ADMISSION_LOCK = path.join(dir, "admission.lock");
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
