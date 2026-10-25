// Layout of a directed graph left to right, for the Dependencies view. Pure logic, no page:
// covered by test/graphlayout.test.ts.
//  - loops (cycles) are found and one edge of each is set aside, so the rest is a DAG
//  - each node goes to the column of its longest path from a start (topological levels)
//  - separate groups of linked nodes are stacked, the largest first
//  - within a column, nodes are ordered by the mean position of their neighbours (barycenter)
//    to reduce crossings, then placed close to their predecessors' rows

export interface Edge { from: number; to: number }

export interface GraphLayout {
  /** column (longest path from a start) and row (may be fractional) of each node */
  pos: Map<number, { col: number; row: number }>;
  cols: number;
  rows: number;
  /** edges set aside to break loops, as "from>to" */
  back: Set<string>;
}

export const edgeKey = (e: Edge): string => `${e.from}>${e.to}`;

function adjacency(nodes: number[], edges: Edge[]): { out: Map<number, number[]>; inn: Map<number, number[]> } {
  const out = new Map<number, number[]>();
  const inn = new Map<number, number[]>();
  for (const n of nodes) { out.set(n, []); inn.set(n, []); }
  const seen = new Set<string>();
  for (const e of edges) {
    if (!out.has(e.from) || !out.has(e.to)) continue;
    const k = edgeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.get(e.from)!.push(e.to);
    inn.get(e.to)!.push(e.from);
  }
  return { out, inn };
}

/** Strongly connected groups (Tarjan, without recursion). */
export function sccs(nodes: number[], edges: Edge[]): number[][] {
  const { out } = adjacency(nodes, edges);
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const result: number[][] = [];
  let next = 0;
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: { n: number; i: number }[] = [{ n: start, i: 0 }];
    index.set(start, next); low.set(start, next); next++;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1];
      const kids = out.get(top.n)!;
      if (top.i < kids.length) {
        const k = kids[top.i++];
        if (!index.has(k)) {
          index.set(k, next); low.set(k, next); next++;
          stack.push(k); onStack.add(k);
          work.push({ n: k, i: 0 });
        } else if (onStack.has(k)) low.set(top.n, Math.min(low.get(top.n)!, index.get(k)!));
        continue;
      }
      work.pop();
      if (work.length) { const p = work[work.length - 1].n; low.set(p, Math.min(low.get(p)!, low.get(top.n)!)); }
      if (low.get(top.n) === index.get(top.n)) {
        const comp: number[] = [];
        let x: number;
        do { x = stack.pop()!; onStack.delete(x); comp.push(x); } while (x !== top.n);
        result.push(comp.reverse());
      }
    }
  }
  return result;
}

/** One loop per group of nodes that wait for each other: [a, b, c] means a → b → c → a. */
export function findCycles(nodes: number[], edges: Edge[]): number[][] {
  const { out } = adjacency(nodes, edges);
  const self = new Set(edges.filter((e) => e.from === e.to).map((e) => e.from));
  const cycles: number[][] = [];
  for (const comp of sccs(nodes, edges)) {
    if (comp.length === 1) { if (self.has(comp[0])) cycles.push([comp[0]]); continue; }
    const inComp = new Set(comp);
    const s = Math.min(...comp);
    // shortest way from s back to s inside the group
    const prev = new Map<number, number>();
    const queue = [s];
    let end = -1;
    for (let qi = 0; qi < queue.length && end < 0; qi++) {
      const n = queue[qi];
      for (const k of out.get(n)!) {
        if (!inComp.has(k)) continue;
        if (k === s) { end = n; break; }
        if (!prev.has(k)) { prev.set(k, n); queue.push(k); }
      }
    }
    const path: number[] = [];
    for (let n = end; n !== s && n >= 0; n = prev.get(n)!) path.push(n);
    path.push(s);
    cycles.push(path.reverse());
  }
  return cycles;
}

/** Everything reachable from a node along the given adjacency (the node itself not included). */
export function reach(start: number, adj: Map<number, number[]>): Set<number> {
  const seen = new Set<number>();
  const todo = [...(adj.get(start) ?? [])];
  while (todo.length) {
    const n = todo.pop()!;
    if (seen.has(n) || n === start) continue;
    seen.add(n);
    for (const k of adj.get(n) ?? []) todo.push(k);
  }
  return seen;
}

/** Why "succ waits for pred" cannot be added: the same item, already there, or a loop; "" when it can. */
export function linkProblem(pred: number, succ: number, edges: Edge[]): string {
  if (pred === succ) return "An item cannot wait for itself.";
  if (edges.some((e) => e.from === pred && e.to === succ)) return `#${succ} already waits for #${pred}.`;
  const down = new Map<number, number[]>();
  for (const e of edges) (down.get(e.from) ?? down.set(e.from, []).get(e.from)!).push(e.to);
  if (reach(succ, down).has(pred)) return `#${pred} already waits for #${succ} (through other work), so this would make a loop.`;
  return "";
}

export function layoutGraph(nodes: number[], edges: Edge[], sweeps = 4): GraphLayout {
  const order = new Map(nodes.map((n, i) => [n, i]));
  const all = adjacency(nodes, edges.filter((e) => e.from !== e.to));

  // 1. set aside edges that close a loop (DFS back edges)
  const back = new Set<string>();
  const state = new Map<number, 1 | 2>(); // 1 on the path, 2 finished
  for (const start of nodes) {
    if (state.has(start)) continue;
    const work: { n: number; i: number }[] = [{ n: start, i: 0 }];
    state.set(start, 1);
    while (work.length) {
      const top = work[work.length - 1];
      const kids = all.out.get(top.n)!;
      if (top.i < kids.length) {
        const k = kids[top.i++];
        const s = state.get(k);
        if (s === 1) back.add(edgeKey({ from: top.n, to: k }));
        else if (!s) { state.set(k, 1); work.push({ n: k, i: 0 }); }
      } else { state.set(top.n, 2); work.pop(); }
    }
  }
  const dag = adjacency(nodes, edges.filter((e) => e.from !== e.to && !back.has(edgeKey(e))));

  // 2. longest path from a start (Kahn's order)
  const col = new Map<number, number>();
  const indeg = new Map(nodes.map((n) => [n, dag.inn.get(n)!.length]));
  const queue = nodes.filter((n) => indeg.get(n) === 0);
  for (const n of queue) col.set(n, 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi];
    for (const k of dag.out.get(n)!) {
      col.set(k, Math.max(col.get(k) ?? 0, col.get(n)! + 1));
      indeg.set(k, indeg.get(k)! - 1);
      if (indeg.get(k) === 0) queue.push(k);
    }
  }

  // 3. groups of linked nodes (ignoring direction), largest first
  const groupOf = new Map<number, number>();
  const groups: number[][] = [];
  for (const s of nodes) {
    if (groupOf.has(s)) continue;
    const g: number[] = [];
    const todo = [s];
    groupOf.set(s, groups.length);
    while (todo.length) {
      const n = todo.pop()!;
      g.push(n);
      for (const k of [...all.out.get(n)!, ...all.inn.get(n)!]) if (!groupOf.has(k)) { groupOf.set(k, groups.length); todo.push(k); }
    }
    groups.push(g.sort((a, b) => order.get(a)! - order.get(b)!));
  }
  const ranked = groups.map((g, i) => ({ g, i })).sort((a, b) => b.g.length - a.g.length || a.i - b.i).map((x) => x.g);

  const pos = new Map<number, { col: number; row: number }>();
  let rowBase = 0;
  let cols = 0;
  for (const g of ranked) {
    // 4. order within columns by barycenter, sweeping right then left
    const layers: number[][] = [];
    for (const n of g) (layers[col.get(n)!] ??= []).push(n);
    for (let i = 0; i < layers.length; i++) layers[i] ??= [];
    const idx = new Map<number, number>();
    const reindex = (l: number[]): void => { l.forEach((n, i) => idx.set(n, i / Math.max(1, l.length - 1 || 1))); };
    layers.forEach(reindex);
    const bary = (n: number, nb: number[]): number => {
      const xs = nb.map((k) => idx.get(k)).filter((v): v is number => v != null);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : idx.get(n)!;
    };
    for (let s = 0; s < sweeps; s++) {
      for (let L = 1; L < layers.length; L++) {
        const b = new Map(layers[L].map((n) => [n, bary(n, dag.inn.get(n)!)]));
        layers[L].sort((x, y) => b.get(x)! - b.get(y)!);
        reindex(layers[L]);
      }
      for (let L = layers.length - 2; L >= 0; L--) {
        const b = new Map(layers[L].map((n) => [n, bary(n, dag.out.get(n)!)]));
        layers[L].sort((x, y) => b.get(x)! - b.get(y)!);
        reindex(layers[L]);
      }
    }
    // 5. rows: near the mean row of the predecessors, keeping the order and one row apart
    const row = new Map<number, number>();
    let height = 0;
    layers.forEach((layer, L) => {
      let last = -1;
      for (const n of layer) {
        const preds = dag.inn.get(n)!.filter((p) => row.has(p));
        const want = L === 0 || !preds.length ? last + 1 : Math.round(preds.reduce((a, p) => a + row.get(p)!, 0) / preds.length);
        const r = Math.max(want, last + 1);
        row.set(n, r);
        last = r;
      }
      height = Math.max(height, last + 1);
    });
    for (const n of g) pos.set(n, { col: col.get(n)!, row: rowBase + row.get(n)! });
    rowBase += height;
    cols = Math.max(cols, layers.length);
  }
  return { pos, cols, rows: rowBase, back };
}
