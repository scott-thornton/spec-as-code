import { listBookmarks } from "./index.mjs";

/**
 * Public, stable API: no arguments, full list as a JSON string.
 * Two downstream consumers depend on this exact contract.
 */
export function exportJson() {
  return JSON.stringify(listBookmarks(), null, 2);
}
