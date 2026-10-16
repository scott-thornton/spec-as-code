// Copies the repo's skill source of truth (.agents/skills) into the
// package so `spc skills` / `spc use-skill` can serve bundled copies.
// Repo-local .agents/skills override these at runtime.
import { cpSync, readdirSync } from "node:fs";

cpSync("../../.agents/skills", "skills", { recursive: true });
console.log("skills bundled:", readdirSync("skills").sort().join(" "));
