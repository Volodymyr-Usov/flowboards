// One team's work, loaded once and kept current: the process, the team's settings, sprints, board
// columns, people, and every Epic, Feature, story and task in the team's area paths.
// Views read from here and listen for changes; they never keep their own copy of work items.
import type { Api } from "../api/api.ts";
import type { BoardInfo, Iteration, Level, Person, ProcessInfo, TeamSettings, WorkItem } from "../api/types.ts";
import { byOrder, DAY, isRemoved, levelOf, personKey, statesOf } from "./model.ts";
import { wsjfSetup } from "./wsjf.ts";

/** How far before the sync mark each poll asks again, for changes saved a moment out of order. */
export const SYNC_OVERLAP = 2 * 60_000;

/**
 * The next sync mark: the newest change among the items read (Azure DevOps's time, so this computer's
 * clock does not matter), less the time the query and the reads took (an item read late may hold a change
 * newer than the query); never earlier than `old`. "" when there is nothing to go by.
 */
export function syncMark(old: string, items: Iterable<{ changed: string }>, elapsedMs: number): string {
  let mark = old ? Date.parse(old) : NaN;
  let newest = -Infinity;
  for (const it of items) { const t = Date.parse(it.changed); if (t > newest) newest = t; }
  if (Number.isFinite(newest)) {
    const t = newest - Math.max(0, elapsedMs);
    if (!(t <= mark)) mark = t;
  }
  return Number.isFinite(mark) ? new Date(mark).toISOString() : "";
}

export type ChangeListener =(changed: Set<number>, why: "load" | "poll" | "write" | "scope") => void;

export interface WorkspaceOptions {
  /** how many days of closed items to keep (board's Closed column, recent work) */
  closedDays: number;
  /** read the items of the team's area paths only (true) or of the whole project (false) */
  teamAreaOnly: boolean;
}

export class Workspace {
  api: Api;
  project: string;
  projectId = "";
  team: string;
  process!: ProcessInfo;
  settings!: TeamSettings;
  iterations: Iteration[] = [];
  /** the team's board for the requirement level (columns, limits), when the team has one */
  board: BoardInfo | null = null;
  members: Person[] = [];
  /** Settings > Team: members left out (sign-in names, lower case) and people added */
  private tweaks: { off: Set<string>; extra: Person[] } = { off: new Set(), extra: [] };
  items = new Map<number, WorkItem>();
  /** fields read with every item besides the standard ones (the priority score's), set from the process */
  extraFields: string[] = [];
  opts: WorkspaceOptions;
  loadedAt = 0;
  lastSync = "";
  status: "loading" | "live" | "error" = "loading";
  error = "";
  private listeners = new Set<ChangeListener>();
  private statusListeners = new Set<() => void>();
  private childIndex: Map<number, number[]> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** a poll is running: the next one waits for its turn */
  private polling = false;
  private pollCount = 0;
  /** parents that could not be read: id -> when to try again (never for ones Azure DevOps did not return) */
  private parentFailed = new Map<number, number>();
  /** revision of items taken out (removed state, left the team's areas), so an older answer cannot bring them back */
  private goneRev = new Map<number, number>();
  /** items kept by the last clean-up only because they changed lately (see dropGone) */
  private graced = new Set<number>();

  constructor(api: Api, project: string, team: string, opts: Partial<WorkspaceOptions> = {}) {
    this.api = api;
    this.project = project;
    this.team = team;
    this.opts = { closedDays: 30, teamAreaOnly: true, ...opts };
  }

  // ---------- events ----------

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onStatus(fn: () => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  emit(changed: Set<number>, why: Parameters<ChangeListener>[1]): void {
    this.childIndex = null;
    for (const fn of this.listeners) {
      try { fn(changed, why); } catch (e) { console.error(e); }
    }
  }
  private setStatus(s: Workspace["status"], error = ""): void {
    this.status = s;
    this.error = error;
    for (const fn of this.statusListeners) fn();
  }

  // ---------- loading ----------

  async load(): Promise<void> {
    this.setStatus("loading");
    const api = this.api;
    if ("currentTeam" in api) (api as { currentTeam?: string }).currentTeam = this.team;
    try {
      const [process, settings, iterations, members, projects] = await Promise.all([
        api.process(this.project, this.team),
        api.teamSettings(this.project, this.team),
        api.iterations(this.project, this.team).catch(() => [] as Iteration[]),
        api.teamMembers(this.project, this.team).catch(() => [] as Person[]),
        api.projects().catch(() => []),
      ]);
      this.process = process;
      this.extraFields = wsjfSetup(process).fields;
      this.settings = settings;
      this.iterations = iterations;
      this.members = members;
      this.projectId = projects.find((p) => p.name === this.project)?.id ?? "";
      const req = this.requirementLevel();
      this.board = await api.board(this.project, this.team, req.name).catch(() => null);
      const started = Date.now();
      const ids = await this.queryTeamIds();
      const items = await this.read(ids);
      this.items.clear();
      for (const it of items) if (!isRemoved(it)) this.items.set(it.id, it);
      await this.loadMissingParents();
      this.loadedAt = Date.now();
      // the sync mark is Azure DevOps's time (the newest change read), never this computer's clock;
      // with nothing read yet, ten minutes back on this clock is the best start there is
      this.lastSync = syncMark("", items, Date.now() - started) || new Date(Date.now() - 10 * 60_000).toISOString();
      this.setStatus("live");
      this.emit(new Set(this.items.keys()), "load");
    } catch (e) {
      this.setStatus("error", (e as Error).message);
      throw e;
    }
  }

  /** Ids of the team's open items plus those closed in the last `closedDays` days, at every level. */
  private async queryTeamIds(): Promise<number[]> {
    const types = this.process.levels.flatMap((l) => l.types);
    const closedStates = statesOf(this.process, types, ["Completed"]);
    const removedStates = statesOf(this.process, types, ["Removed"]);
    const areas = this.opts.teamAreaOnly && this.settings.areas.length ? this.settings.areas : undefined;
    const since = new Date(Date.now() - this.opts.closedDays * DAY).toISOString().slice(0, 10);
    const [open, closed] = await Promise.all([
      this.api.query(this.project, { types, areas, notStates: [...closedStates, ...removedStates] }),
      this.api.query(this.project, { types, areas, states: closedStates, closedAfter: since }),
    ]);
    return [...new Set([...open, ...closed])];
  }

  /** Parents outside the team's area (a Feature owned by another team) are read too, up to the top level. */
  private async loadMissingParents(): Promise<Set<number>> {
    const added = new Set<number>();
    const now = Date.now();
    const skip = (p: number): boolean => (this.parentFailed.get(p) ?? 0) > now;
    for (let depth = 0; depth < this.process.levels.length; depth++) {
      const missing = [...new Set([...this.items.values()].map((i) => i.parent).filter((p): p is number => !!p && !this.items.has(p) && !skip(p)))];
      if (!missing.length) break;
      let parents: WorkItem[];
      try {
        parents = await this.read(missing);
      } catch {
        // try these again in 10 minutes, not on every poll
        for (const p of missing) this.parentFailed.set(p, now + 10 * 60_000);
        break;
      }
      // not returned (deleted, no access): not asked again this session
      const back = new Set(parents.map((p) => p.id));
      for (const p of missing) if (!back.has(p)) this.parentFailed.set(p, Infinity);
      for (const p of parents) { this.items.set(p.id, p); added.add(p.id); }
      if (!parents.length) break;
    }
    return added;
  }

  /** Read items with the standard fields and the extra ones. */
  private read(ids: number[]): Promise<WorkItem[]> {
    return this.extraFields.length ? this.api.items(this.project, ids, { fields: this.extraFields }) : this.api.items(this.project, ids);
  }

  /** Take a fresh copy from a poll: only when it is newer than what we hold (or ours is only a guess). */
  private take(it: WorkItem, changed: Set<number>): void {
    const cur = this.items.get(it.id);
    const known = cur?.rev ?? this.goneRev.get(it.id) ?? 0;
    if (it.rev <= known && !cur?.stale) return; // the same or an older revision (a slow answer)
    changed.add(it.id);
    if (isRemoved(it)) { this.items.delete(it.id); this.goneRev.set(it.id, it.rev); }
    else { this.items.set(it.id, it); this.goneRev.delete(it.id); } // links are read again when a view needs them
  }

  /**
   * Items that left: deleted, moved out of the team's areas, removed, or closed before the kept days.
   * Two queries (the same as the first load); parents of kept items stay. Changes of the last minutes
   * are kept, as the queries may have run before them.
   */
  private async dropGone(): Promise<number[]> {
    // "the last minutes" by Azure DevOps's time (the sync mark), not this computer's clock; an item is
    // kept this way once only: by the next round, a query that ran after its change has answered
    const recent = Date.parse(this.lastSync) - SYNC_OVERLAP;
    const inScope = new Set(await this.queryTeamIds());
    const keep = new Set<number>();
    const graced = new Set<number>();
    for (const it of this.items.values()) {
      if (!inScope.has(it.id)) {
        if (!(Date.parse(it.changed) >= recent) || this.graced.has(it.id)) continue;
        graced.add(it.id);
      }
      for (let p: WorkItem | undefined = it, n = 0; p && !keep.has(p.id) && n < 20; p = this.get(p.parent), n++) keep.add(p.id);
    }
    this.graced = graced;
    const gone = [...this.items.values()].filter((it) => !keep.has(it.id));
    for (const it of gone) { this.items.delete(it.id); this.goneRev.set(it.id, it.rev); }
    return gone.map((it) => it.id);
  }

  /**
   * Read again what changed since the last sync. Cheap: one query plus the changed items.
   * Every 10th poll (about 5 minutes) also drops items that left the team's work.
   */
  async poll(): Promise<void> {
    if (this.status === "loading" || !this.lastSync || this.polling) return;
    this.polling = true;
    try {
      const types = this.process.levels.flatMap((l) => l.types);
      const areas = this.opts.teamAreaOnly && this.settings.areas.length ? this.settings.areas : undefined;
      const started = Date.now();
      // a little overlap: a change saved on another server a moment before the newest one we saw is not missed
      // (items read again with the same revision are left out by take)
      const since = new Date(Date.parse(this.lastSync) - SYNC_OVERLAP).toISOString();
      const ids = await this.api.query(this.project, { types, areas, changedAfter: since });
      // items we show from other areas (parents) are checked too
      const outside = [...this.items.values()].filter((i) => areas && !areas.some((a) => i.area === a.path || (a.includeChildren && i.area.startsWith(a.path + "\\")))).map((i) => i.id);
      const extra = outside.length ? await this.api.query(this.project, { ids: outside, changedAfter: since }) : [];
      const all = [...new Set([...ids, ...extra])];
      const changed = new Set<number>();
      const read = all.length ? await this.read(all) : [];
      for (const it of read) this.take(it, changed);
      if (++this.pollCount % 10 === 0) for (const id of await this.dropGone()) changed.add(id);
      for (const id of await this.loadMissingParents()) changed.add(id);
      // only now: a failed read above is asked again next time
      this.lastSync = syncMark(this.lastSync, read, Date.now() - started);
      if (this.status !== "live") this.setStatus("live");
      if (changed.size) this.emit(changed, "poll");
    } catch (e) {
      this.setStatus("error", (e as Error).message);
    } finally {
      this.polling = false;
    }
  }

  startPolling(seconds = 30): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => { if (document.visibilityState === "visible") void this.poll(); }, seconds * 1000);
  }
  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Put a fresh copy of an item in (after a write) and tell the views. */
  put(item: WorkItem, why: "write" | "poll" = "write"): void {
    const old = this.items.get(item.id);
    // writes and refreshes read the links too: none in the answer means the last one was removed
    if (!item.relations) item.relations = [];
    // a removed item is remembered, so a slower older answer cannot bring it back
    if (isRemoved(item)) { this.items.delete(item.id); this.goneRev.set(item.id, item.rev); }
    else { this.items.set(item.id, item); this.goneRev.delete(item.id); }
    const changed = new Set([item.id]);
    if (old?.parent) changed.add(old.parent);
    if (item.parent) changed.add(item.parent);
    this.emit(changed, why);
  }

  /** Read one item again (after a refused write, or to get its links). */
  async refresh(id: number): Promise<WorkItem | undefined> {
    const [it] = await this.api.items(this.project, [id], { relations: true });
    const old = this.items.get(id);
    // a slow answer older than what we hold (a write finished meanwhile) is left out,
    // unless ours is only a guess: then Azure DevOps is right
    if (it && old && it.rev < old.rev && !old.stale) return old;
    if (it && !old && it.rev < (this.goneRev.get(id) ?? 0)) return undefined;
    if (it) this.put(it, "poll");
    else if (this.items.delete(id)) this.emit(new Set([id]), "poll");
    return it;
  }

  /** Links (relations) of these items, read in batches and kept on the items. */
  async withRelations(ids: number[]): Promise<void> {
    const need = ids.filter((id) => this.items.has(id) && !this.items.get(id)!.relations);
    if (!need.length) return;
    const got = await this.api.items(this.project, need, { relations: true });
    // an item Azure DevOps did not return (deleted, no access) gets no links, so nobody asks again and again
    const back = new Set(got.map((g) => g.id));
    for (const id of need) { const cur = this.items.get(id); if (cur && !back.has(id)) cur.relations = []; }
    for (const g of got) {
      const cur = this.items.get(g.id);
      // a copy that is only a guess is replaced by what Azure DevOps says
      if (cur && cur.rev === g.rev && !cur.stale) cur.relations = g.relations ?? [];
      else if (cur && (g.rev > cur.rev || cur.stale)) this.items.set(g.id, g);
      // an older revision (slow answer) is left out; its links are read again when asked
    }
  }

  /** Our copy of an item may be wrong (a guess, or a save was refused): the next read replaces it. */
  /** A deleted item leaves at once (its parent changes too); a slow older read cannot bring it back. */
  forget(id: number): void {
    const it = this.items.get(id);
    if (!it) return;
    this.items.delete(id);
    this.goneRev.set(id, it.rev);
    this.emit(new Set(it.parent ? [id, it.parent] : [id]), "write");
  }

  markStale(id: number): void {
    const cur = this.items.get(id);
    if (cur) this.items.set(id, { ...cur, stale: true });
  }


  // ---------- lookups ----------

  get(id: number | undefined): WorkItem | undefined { return id ? this.items.get(id) : undefined; }

  levelOf(item: WorkItem): Level | undefined { return levelOf(this.process, item.type); }
  requirementLevel(): Level { return this.process.levels.find((l) => l.kind === "requirement")!; }
  taskLevel(): Level | undefined { return this.process.levels.find((l) => l.kind === "task"); }
  portfolioLevels(): Level[] { return this.process.levels.filter((l) => l.kind === "portfolio"); }

  /** Items of a level (by its types), in backlog order. */
  ofLevel(level: Level | undefined): WorkItem[] {
    if (!level) return [];
    return [...this.items.values()].filter((i) => level.types.includes(i.type)).sort(byOrder);
  }

  children(id: number): WorkItem[] {
    if (!this.childIndex) {
      this.childIndex = new Map();
      for (const it of this.items.values()) {
        if (!it.parent) continue;
        let list = this.childIndex.get(it.parent);
        if (!list) this.childIndex.set(it.parent, (list = []));
        list.push(it.id);
      }
    }
    return (this.childIndex.get(id) ?? []).map((c) => this.items.get(c)!).filter(Boolean).sort(byOrder);
  }

  /** Parent chain, nearest first. */
  ancestors(item: WorkItem): WorkItem[] {
    const out: WorkItem[] = [];
    let p = this.get(item.parent);
    while (p && out.length < 10) { out.push(p); p = this.get(p.parent); }
    return out;
  }

  /** Set the fine-tuning of the team's members (Settings > Team). */
  setTeamTweaks(t: { off: string[]; extra: Person[] } | undefined): void {
    this.tweaks = { off: new Set((t?.off ?? []).map((x) => x.toLowerCase())), extra: t?.extra ?? [] };
  }

  /** The team's members as the team set them up: Azure DevOps's members without those left out, plus those added. */
  teamMembers(): Person[] {
    const m = new Map<string, Person>();
    for (const p of this.members) if (!this.tweaks.off.has(p.uniqueName.toLowerCase())) m.set(personKey(p), p);
    for (const p of this.tweaks.extra) if (!m.has(personKey(p))) m.set(personKey(p), p);
    return [...m.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Everyone who appears on the team's work, plus the team's members, by name. */
  people(): Person[] {
    const m = new Map<string, Person>();
    for (const p of this.members) m.set(personKey(p), p);
    for (const it of this.items.values()) if (it.assignedTo && !m.has(personKey(it.assignedTo))) m.set(personKey(it.assignedTo), it.assignedTo);
    return [...m.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  currentIteration(): Iteration | undefined {
    const now = Date.now();
    return this.iterations.find((i) => i.timeFrame === "current")
      ?? this.iterations.find((i) => i.start && i.finish && Date.parse(i.start) <= now && now <= Date.parse(i.finish) + DAY);
  }

  /** The default area path for new items of this team. */
  defaultArea(): string {
    return this.settings.defaultArea ?? this.settings.areas[0]?.path ?? this.project;
  }

  itemUrl(id: number): string {
    return this.api.itemUrl(this.get(id)?.project ?? this.project, id);
  }
}
