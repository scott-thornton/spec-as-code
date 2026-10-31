import { readFileSync } from "node:fs";
import path from "node:path";
import { SpcError } from "@spc/core";
import { fileDigest, stageChanges, type ProposedChange } from "@spc/executor";

type PatchOp = Extract<ProposedChange, { op: "patch" }>;

export interface PatchBuildOptions {
  anchor?: string;
  anchorFile?: string;
  replacement?: string;
  replacementFile?: string;
  after?: string;
  expectDigest?: string;
  root?: string;
}

/**
 * "spc patch build" - first-class composition of a patch op. The agent
 * supplies the semantic choice (path, anchor, replacement); the tool
 * performs the protocol mechanics: the base digest is computed from the
 * actual tree (or the overlay of --after ops), anchor uniqueness is
 * verified through the same applicator that will apply it later, and an
 * --expect-digest cross-check refuses if the tree moved since the agent
 * read it. The tool verifies and never decides: refusals happen here,
 * at composition time, instead of costing a task retry.
 */

/**
 * `spc patch verify <ops.json>` - composition-time validation of a whole
 * changes array (specs/patch-verify): the array runs through the SAME
 * applicator that will apply it, in memory, touching nothing - per
 * path, first-op digest against the live tree, every chain position
 * against the overlay the previous ops produced, anchor uniqueness
 * throughout. The verify-dedup incidents paid queue round-trips
 * because this check existed only at staging; here it costs a local
 * command. One checker, no drift: this IS staging, run dry.
 */
export function runPatchVerify(opsFile: string, options: { root?: string } = {}): number {
  const root = options.root ? path.resolve(options.root) : process.cwd();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.resolve(process.cwd(), opsFile), "utf8"));
  } catch (e) {
    throw new SpcError("SPC_RUNTIME_ERROR", `ops file is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SpcError("SPC_RUNTIME_ERROR", `ops file must be a non-empty JSON array of change ops`);
  }
  const staged = stageChanges(root, raw as ProposedChange[]);
  if (!staged.ok) {
    console.log(`PATCH_VERIFY_FAILED: ${staged.code}`);
    console.log(staged.message);
    return 1;
  }
  const byPath = new Map<string, number>();
  for (const op of raw as ProposedChange[]) {
    byPath.set(op.path, (byPath.get(op.path) ?? 0) + 1);
  }
  console.log(`Chain valid: ${raw.length} op(s) across ${byPath.size} path(s), nothing written.`);
  for (const [p, n] of [...byPath.entries()].sort()) {
    console.log(`  ${p}  ${n} op(s)`);
  }
  return 0;
}
export function runPatchBuild(fileArg: string, options: PatchBuildOptions): number {
  const root = options.root ? path.resolve(options.root) : process.cwd();

  const exactlyOne = (text: string | undefined, file: string | undefined, label: string): string => {
    if ((text === undefined) === (file === undefined)) {
      throw new SpcError("SPC_RUNTIME_ERROR", `provide exactly one of --${label} or --${label}-file`);
    }
    return text !== undefined ? text : readFileSync(file!, "utf8");
  };
  const anchor = exactlyOne(options.anchor, options.anchorFile, "anchor");
  const replacement = exactlyOne(options.replacement, options.replacementFile, "replacement");

  let prior: ProposedChange[] = [];
  if (options.after) {
    const raw: unknown = JSON.parse(readFileSync(options.after, "utf8"));
    if (!Array.isArray(raw)) {
      throw new SpcError("SPC_RUNTIME_ERROR", "--after must be a JSON array of change ops");
    }
    prior = raw as ProposedChange[];
  }

  // Stage the prior ops to find the content this new op applies against;
  // a refusal inside the prior chain propagates unchanged.
  const staged = stageChanges(root, prior);
  if (!staged.ok) {
    throw new SpcError(staged.code, staged.message);
  }
  const overlay = staged.writes.find((w) => w.path === fileArg);
  let base: string;
  if (overlay) {
    base = overlay.content;
  } else {
    try {
      base = readFileSync(path.join(root, fileArg), "utf8");
    } catch {
      throw new SpcError(
        "PATCH_BASE_MISSING",
        `PATCH_BASE_MISSING: ${fileArg} does not exist under ${root}; a patch op needs an existing base`,
      );
    }
  }

  const actualDigest = fileDigest(base);
  if (options.expectDigest !== undefined && options.expectDigest !== actualDigest) {
    throw new SpcError(
      "PATCH_BASE_MISMATCH",
      `PATCH_BASE_MISMATCH: ${fileArg} content digests to ${actualDigest}, but --expect-digest declared ${options.expectDigest}; the tree changed since it was read - re-read and rebuild`,
    );
  }

  const op: PatchOp = { op: "patch", path: fileArg, baseDigest: actualDigest, anchor, replacement };

  // The verification pass: the same machinery that will apply it at task
  // time validates the op now (anchor uniqueness, digest, applicability).
  const verified = stageChanges(root, [...prior, op]);
  if (!verified.ok) {
    throw new SpcError(verified.code, verified.message);
  }

  console.log(JSON.stringify(op, null, 2));
  return 0;
}
