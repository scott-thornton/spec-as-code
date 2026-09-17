import { mkdirSync, writeFileSync } from "node:fs";

export function build() {
  mkdirSync("dist", { recursive: true });
  writeFileSync("dist/out.txt", "built");
  return "dist/out.txt";
}
