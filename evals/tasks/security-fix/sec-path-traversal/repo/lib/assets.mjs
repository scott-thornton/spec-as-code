import path from "node:path";

export function readPath(base, rel) {
  return path.join(base, rel);
}
