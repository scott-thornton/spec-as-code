import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "@spc/schema";
import { stringify as toYaml } from "yaml";
import { isGitRepo, observeRepository } from "@spc/repo";

const GITIGNORE_LINES = [".spc/runs/", ".spc/worktrees/", ".spc/plans/"];

/**
 * `spc init`: create specs/ and .spc/, write a default config (never guessed
 * commands), and report detected commands for the human to review.
 */
export function runInit(cwd: string): void {
  const specsDir = path.join(cwd, "specs");
  const spcDir = path.join(cwd, ".spc");
  mkdirSync(specsDir, { recursive: true });
  mkdirSync(spcDir, { recursive: true });
  mkdirSync(path.join(spcDir, "plans"), { recursive: true });
  mkdirSync(path.join(spcDir, "runs"), { recursive: true });

  const configPath = path.join(spcDir, "config.yaml");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, toYaml(DEFAULT_CONFIG), "utf8");
    console.log(`created ${path.relative(cwd, configPath)} (defaults; edit provider settings as needed)`);
  } else {
    console.log(`${path.relative(cwd, configPath)} already exists; left untouched`);
  }

  const gitignore = path.join(cwd, ".gitignore");
  if (isGitRepo(cwd)) {
    let content = "";
    if (existsSync(gitignore)) content = readFileSync(gitignore, "utf8");
    const missing = GITIGNORE_LINES.filter((l) => !content.split("\n").includes(l));
    if (missing.length > 0) {
      appendFileSync(gitignore, `${missing.join("\n")}\n`, "utf8");
      console.log(`updated .gitignore: ${missing.join(" ")}`);
    }
  }

  // Detect and REPORT commands; never silently persist guesses.
  try {
    const snapshot = observeRepository(cwd, null);
    console.log("");
    console.log("Detected commands (review, then configure manually if you want spc to use them):");
    const c = snapshot.commands;
    if (c.test) console.log(`  test:      ${c.test}`);
    if (c.build) console.log(`  build:     ${c.build}`);
    if (c.lint) console.log(`  lint:      ${c.lint}`);
    if (c.typecheck) console.log(`  typecheck: ${c.typecheck}`);
    if (!c.test && !c.build && !c.lint && !c.typecheck) console.log("  (none detected)");
  } catch {
    console.log("(repository observation skipped: not a Git repository)");
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. Author a spec:      specs/<name>.yaml   (see `spc spec show --help`)");
  console.log("  2. Validate it:        spc spec validate specs/<name>.yaml");
  console.log("  3. Plan:               spc plan specs/<name>.yaml");
  console.log("  4. Execute + verify:   spc apply && spc status");
}
