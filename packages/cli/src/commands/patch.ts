import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSafeRelativePath, SpcError } from "@spc/core";
import { fileDigest, stageChanges, type ProposedChange } from "@spc/executor";

type PatchOp = Extract<ProposedChange, { op: "patch" }>;

export interface PatchBuildOptions {
  anchor?: string;
  anchorFile?: string;
  replacement?: string;
  replacementFile?: string;
  after?: string;
  expectDigest?: string;
  /** Batch composition (specs/patch-build-batch): a JSON array of op
   *  entries composed in one invocation, array order = chain order. */
  batch?: string;
  /** Where the composed ops array is written; stdout when absent. */
  out?: string;
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
/**
 * `spc patch apply <ops.json>` (specs/patch-apply): the composer's third
 * leg for between-runs work. The SAME applicator semantics - digests,
 * per-position anchor uniqueness, all-or-nothing - exposed to the client
 * for the workload the runtime deliberately excludes from runs (protected
 * paths, oracle updates, human-style edits). Every application appends a
 * durable provenance line to .spc/patch-log.jsonl where run attribution
 * cannot reach. Receipt: the slerp agent's hand-rolled Python patcher -
 * str.replace hitting every occurrence, no digests, partial per-file
 * writes.
 */
export function runPatchApply(opsFile: string, options: { root?: string } = {}): number {
  const root = options.root ? path.resolve(options.root) : process.cwd();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.resolve(process.cwd(), opsFile), "utf8"));
  } catch (e) {
    console.log(`ops file unreadable or not valid JSON: ${(e as Error).message}`);
    return 1;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    console.log("ops file must be a non-empty JSON array of change ops");
    return 1;
  }
  const staged = stageChanges(root, raw as ProposedChange[]);
  if (!staged.ok) {
    console.log(`${staged.code}: ${staged.message}`);
    return 1;
  }
  for (const w of staged.writes) {
    mkdirSync(path.dirname(path.join(root, w.path)), { recursive: true });
    writeFileSync(path.join(root, w.path), w.content, "utf8");
    console.log(`  ${w.path}  ${w.label}`);
  }
  for (const d of staged.deletes) {
    rmSync(path.join(root, d), { force: true });
    console.log(`  ${d}  deleted`);
  }
  const byPath = new Set<string>([...staged.writes.map((w) => w.path), ...staged.deletes]);
  console.log(`applied ${staged.writes.length + staged.deletes.length} op(s) across ${byPath.size} path(s)`);
  // Durable provenance where run attribution cannot reach (specs/patch-apply).
  try {
    mkdirSync(path.join(root, ".spc"), { recursive: true });
    appendFileSync(
      path.join(root, ".spc", "patch-log.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        command: "patch apply",
        file: opsFile,
        ops: [
          ...staged.writes.map((w) => ({ path: w.path, label: w.label })),
          ...staged.deletes.map((d) => ({ path: d, label: "deleted" })),
        ],
      }) + "\n",
      "utf8",
    );
  } catch {
    // best effort; the application itself already succeeded
  }
  return 0;
}

export function runPatchBuild(fileArg: string, options: PatchBuildOptions): number {
  if (options.batch !== undefined) {
    // Refusals print and exit 1 (the patch-verify pattern), never the
    // top-level SpcError path's exit 2 - a refused batch is a named
    // composition outcome, not a crash.
    try {
      return runPatchBuildBatch(options);
    } catch (e) {
      const err = e as Error & { code?: string };
      console.log(err.message);
      return 1;
    }
  }

/**
 * The composer's batch form (specs/patch-build-batch): one invocation
 * composes the whole chain - the receipt was an agent shadow-building a
 * python driver around single builds to chain 15 hunks. Array order is
 * chain order; patch entries ride the exact single-op machinery (base
 * digest from the live tree or the overlay of prior entries, anchor
 * uniqueness at each position); create/update/delete pass through
 * verbatim. All-or-nothing: any refusal composes nothing and writes
 * nothing - the applicator's contract, at composition time.
 */
function runPatchBuildBatch(options: PatchBuildOptions): number {
  const root = options.root ? path.resolve(options.root) : process.cwd();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.resolve(process.cwd(), options.batch!), "utf8"));
  } catch (e) {
    throw new SpcError("SPC_RUNTIME_ERROR", `batch file unreadable or not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SpcError("SPC_RUNTIME_ERROR", "batch spec must be a non-empty JSON array of op entries");
  }
  interface Entry {
    op?: string;
    path?: string;
    anchor?: string;
    anchorFile?: string;
    replacement?: string;
    replacementFile?: string;
    content?: string;
  }
  const chain: ProposedChange[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Entry;
    if (typeof e.path !== "string" || !isSafeRelativePath(e.path)) {
      throw new SpcError("SPC_RUNTIME_ERROR", `batch entry ${i}: missing or unsafe path`);
    }
    const kind = e.op ?? "patch";
    if (kind === "create" || kind === "update") {
      if (typeof e.content !== "string") {
        throw new SpcError("SPC_RUNTIME_ERROR", `batch entry ${i}: ${kind} requires content`);
      }
      chain.push({ op: kind, path: e.path, content: e.content });
      continue;
    }
    if (kind === "delete") {
      chain.push({ op: "delete", path: e.path });
      continue;
    }
    if (kind !== "patch") {
      throw new SpcError("SPC_RUNTIME_ERROR", `batch entry ${i}: unknown op "${kind}"`);
    }
    const pick = (v: string | undefined, f: string | undefined, label: string): string => {
      if ((v === undefined) === (f === undefined)) {
        throw new SpcError("SPC_RUNTIME_ERROR", `batch entry ${i}: provide exactly one of ${label} or ${label}File`);
      }
      return v !== undefined ? v : readFileSync(path.resolve(process.cwd(), f!), "utf8");
    };
    const anchor = pick(e.anchor, e.anchorFile, "anchor");
    const replacement = pick(e.replacement, e.replacementFile, "replacement");
    const overlay = stageChanges(root, chain);
    if (!overlay.ok) {
      throw new SpcError(overlay.code, overlay.message);
    }
    const prior = overlay.writes.find((w) => w.path === e.path);
    let base: string;
    if (prior) {
      base = prior.content;
    } else {
      try {
        base = readFileSync(path.join(root, e.path), "utf8");
      } catch {
        throw new SpcError("PATCH_BASE_MISSING", `PATCH_BASE_MISSING: ${e.path} does not exist under ${root}; a patch op needs an existing base`);
      }
    }
    const op = { op: "patch" as const, path: e.path, baseDigest: fileDigest(base), anchor, replacement };
    const verified = stageChanges(root, [...chain, op]);
    if (!verified.ok) {
      throw new SpcError(verified.code, verified.message);
    }
    chain.push(op);
  }
  const json = JSON.stringify(chain, null, 1);
  if (options.out) {
    writeFileSync(options.out, json, "utf8");
  } else {
    console.log(json);
  }
  return 0;
}


  try {
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
      `PATCH_BASE_MISMATCH: ${fileArg} content digests to ${actualDigest}, but --expect-digest declared ${options.expectDigest}; the tree changed since it was read - re-read and rebuild; compose multi-op chains in one invocation with spc patch build --batch <spec.json>, or a single follow-up with spc patch build --after <ops.json> - never op-by-op against a moving tree`,
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
  } catch (e) {
    // Refusals print and exit 1 (the patch-verify pattern), never the
    // top-level SpcError path's exit 2 - a refused op is a named
    // composition outcome, not a crash.
    console.log((e as Error).message);
    return 1;
  }
}
