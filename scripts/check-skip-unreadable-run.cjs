// Gate for quick-20261022031731: a damaged evidence log must not
// brickwall spec-level operations (the run-mvix4mfx lesson). The
// original inline gate command was mangled by shell escaping; this file
// is the same check in exact bytes.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { latestRunViewForSpec } = require("../packages/runtime/dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "spc-skipcheck-"));
const runs = path.join(root, ".spc", "runs", "run-broken");
fs.mkdirSync(runs, { recursive: true });
fs.writeFileSync(
  path.join(runs, "metadata.json"),
  JSON.stringify({ runId: "run-broken", specId: "spec-x", createdAt: new Date().toISOString() }),
);
fs.writeFileSync(path.join(runs, "state.json"), JSON.stringify({ status: "succeeded" }));
fs.writeFileSync(path.join(runs, "evidence.jsonl"), "not-json\n");
const v = latestRunViewForSpec(path.join(root, ".spc", "runs"), "spec-x");
if (v !== null) {
  console.error("FAIL: expected the unreadable run to be skipped (null)");
  process.exit(1);
}
console.log("ok: unreadable run skipped, spec-level listing still works");
