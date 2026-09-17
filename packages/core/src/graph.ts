/** Small deterministic graph utilities shared by spec and plan validation. */

export type EdgeFn = (node: string) => string[];

/** Returns a cycle path (e.g. [A, B, A]) or null when acyclic. */
export function findCycle(nodes: readonly string[], edges: EdgeFn): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n, WHITE);

  const stack: string[] = [];

  function visit(n: string): string[] | null {
    const c = color.get(n);
    if (c === GRAY) {
      const start = stack.indexOf(n);
      return [...stack.slice(start === -1 ? 0 : start), n];
    }
    if (c === BLACK) return null;
    color.set(n, GRAY);
    stack.push(n);
    for (const m of edges(n)) {
      if (!color.has(m)) color.set(m, WHITE);
      const cyc = visit(m);
      if (cyc !== null) return cyc;
    }
    stack.pop();
    color.set(n, BLACK);
    return null;
  }

  for (const n of nodes) {
    if (color.get(n) === WHITE) {
      const cyc = visit(n);
      if (cyc !== null) return cyc;
    }
  }
  return null;
}

/** All nodes reachable from `start` (excluding start unless cyclic). */
export function reachableFrom(start: string, edges: EdgeFn): Set<string> {
  const out = new Set<string>();
  const queue = [...edges(start)];
  while (queue.length > 0) {
    const n = queue.pop()!;
    if (out.has(n)) continue;
    out.add(n);
    queue.push(...edges(n));
  }
  return out;
}

/** Deterministic topological order, or null when cyclic. */
export function topoSort(nodes: readonly string[], edges: EdgeFn): string[] | null {
  if (findCycle(nodes, edges) !== null) return null;
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  for (const n of nodes) {
    for (const m of edges(n)) {
      if (indeg.has(m)) indeg.set(m, (indeg.get(m) ?? 0) + 1);
    }
  }
  const ready = nodes.filter((n) => (indeg.get(n) ?? 0) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    order.push(n);
    for (const m of edges(n)) {
      if (!indeg.has(m)) continue;
      const d = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, d);
      if (d === 0) ready.push(m);
    }
  }
  return order.length === nodes.length ? order : null;
}
