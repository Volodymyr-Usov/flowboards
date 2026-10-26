// Progress that also counts the children the workspace does not hold: stories closed longer ago than the
// kept days, and stories in other teams' areas. The Backlog and the Roadmap add these to the counts of the
// loaded children (which stay live). Read with a WIQL query by parent ([System.Parent] IN …), level by level,
// kept per parent, and read again after the parent or a child changed, or after 10 minutes.
// descendantsOf and outsideCounts are pure (test/childcounts.test.ts).
import type { Level, WorkItem } from "../api/types.ts";
import { isDone, isRemoved, levelOf } from "../core/model.ts";
import type { Workspace } from "../core/workspace.ts";

/** A child found under a parent: its parent, level kind, done or not, removed or not. */
export interface Found { id: number; parent?: number; kind?: Level["kind"]; done: boolean; removed: boolean }

/**
 * The items each root counts, with done or not: tasks for a requirement item; requirement items for a
 * portfolio item, also those under its lower portfolio items. Removed items do not count.
 */
export function descendantsOf(roots: { id: number; kind?: Level["kind"] }[], found: Found[]): Map<number, Map<number, boolean>> {
  const byParent = new Map<number, Found[]>();
  for (const f of found) if (f.parent) byParent.set(f.parent, [...(byParent.get(f.parent) ?? []), f]);
  const out = new Map<number, Map<number, boolean>>();
  for (const r of roots) {
    const counted = new Map<number, boolean>();
    const want: Level["kind"] = r.kind === "requirement" ? "task" : "requirement";
    const seen = new Set<number>([r.id]);
    const todo = [r.id];
    while (todo.length) {
      for (const k of byParent.get(todo.pop()!) ?? []) {
        if (seen.has(k.id)) continue;
        seen.add(k.id);
        if (k.kind === want) { if (!k.removed) counted.set(k.id, k.done); }
        else if (r.kind === "portfolio" && k.kind === "portfolio") todo.push(k.id);
      }
    }
    out.set(r.id, counted);
  }
  return out;
}

/** Done and all of the counted children that are not loaded (the loaded ones are counted live by the page). */
export function outsideCounts(kids: Map<number, boolean> | undefined, loaded: (id: number) => boolean): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const [id, d] of kids ?? []) if (!loaded(id)) { total++; if (d) done++; }
  return { done, total };
}

/** How long a parent's counts are kept before they are read again. */
const TTL = 10 * 60_000;
/** After a failed read, wait this long before asking again. */
const RETRY = 2 * 60_000;
/** Parents per query. */
const CHUNK = 200;
/** Children read per call to the API (it reads 200 per request). */
const READ_AT_ONCE = 400;

/** The counts of children that are not loaded, per parent, read when a page asks and kept while it is open. */
export class ChildCounts {
  private ws: Workspace;
  private onChange: () => void;
  private cache = new Map<number, { at: number; kids: Map<number, boolean> }>();
  private failed = new Map<number, number>();
  private queue = new Set<number>();
  private busy = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(ws: Workspace, onChange: () => void) {
    this.ws = ws;
    this.onChange = onChange;
  }

  /** Ask for the counts of these parents (Epics, Features, stories); the page is told when they are read. */
  want(ids: Iterable<number>): void {
    const now = Date.now();
    for (const id of ids) {
      const c = this.cache.get(id);
      if ((c && now - c.at < TTL) || this.queue.has(id) || now - (this.failed.get(id) ?? -Infinity) < RETRY) continue;
      this.queue.add(id);
    }
    if (this.queue.size && !this.timer && !this.busy) this.timer = setTimeout(() => { this.timer = null; void this.run(); }, 300);
  }

  /** Done and all children of a parent that are not loaded; zero until read. */
  extra(id: number): { done: number; total: number } {
    return outsideCounts(this.cache.get(id)?.kids, (k) => this.ws.items.has(k));
  }

  /** Items changed: their counts, their parents' and those of the parents that counted them are read again when asked. */
  changed(ids: Iterable<number>): void {
    const set = new Set(ids);
    for (const id of set) {
      this.cache.delete(id);
      const it = this.ws.items.get(id);
      if (it) for (const a of this.ws.ancestors(it)) this.cache.delete(a.id);
    }
    for (const [p, c] of [...this.cache]) if ([...c.kids.keys()].some((k) => set.has(k))) this.cache.delete(p);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async run(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let any = false;
    try {
      while (this.queue.size && !this.stopped) {
        const roots = [...this.queue].slice(0, CHUNK);
        for (const r of roots) this.queue.delete(r);
        try { await this.read(roots); any = true; } catch { const now = Date.now(); for (const r of roots) this.failed.set(r, now); }
      }
    } finally {
      this.busy = false;
    }
    if (any && !this.stopped) this.onChange();
  }

  /** Read the children of these parents level by level (portfolio items lead further down) and keep the counts. */
  private async read(rootIds: number[]): Promise<void> {
    const ws = this.ws;
    const p = ws.process;
    const kindOf = (type: string): Level["kind"] | undefined => levelOf(p, type)?.kind;
    const roots = rootIds.map((id) => ({ id, kind: kindOf(ws.get(id)?.type ?? "") })).filter((r) => r.kind === "requirement" || r.kind === "portfolio");
    const types = p.levels.flatMap((l) => l.types);
    const found: Found[] = [];
    // a root may be the child of another root (a story under a Feature): it is found as a child too
    const seen = new Set<number>();
    const asked = new Set<number>();
    let frontier = roots.map((r) => r.id);
    for (let depth = 0; frontier.length && depth < p.levels.length; depth++) {
      for (const id of frontier) asked.add(id);
      const ids: number[] = [];
      for (let i = 0; i < frontier.length; i += CHUNK) ids.push(...await ws.api.query(ws.project, { parents: frontier.slice(i, i + CHUNK), types }));
      const fresh = [...new Set(ids)].filter((id) => !seen.has(id));
      for (const id of fresh) seen.add(id);
      const unloaded = fresh.filter((id) => !ws.items.has(id));
      // a few hundred at a time, so a long-lived Epic's history does not send dozens of reads at once
      const read: WorkItem[] = [];
      for (let i = 0; i < unloaded.length && !this.stopped; i += READ_AT_ONCE) read.push(...await ws.api.items(ws.project, unloaded.slice(i, i + READ_AT_ONCE)));
      const items: WorkItem[] = [...fresh.map((id) => ws.items.get(id)).filter((w): w is WorkItem => !!w), ...read];
      for (const w of items) found.push({ id: w.id, parent: w.parent, kind: kindOf(w.type), done: isDone(w), removed: isRemoved(w) });
      // only portfolio items lead further down (a story counts its own tasks only)
      frontier = items.filter((w) => kindOf(w.type) === "portfolio" && !asked.has(w.id)).map((w) => w.id);
    }
    const at = Date.now();
    const desc = descendantsOf(roots, found);
    // every asked id is kept (one that counts nothing too), so it is not asked again before the time is up
    for (const id of rootIds) { this.cache.set(id, { at, kids: desc.get(id) ?? new Map() }); this.failed.delete(id); }
  }
}
