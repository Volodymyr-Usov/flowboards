// Checklists on work items ("definition of done"): a short list of things to tick. Kept in the
// extension's shared storage, one document per work item in a collection per project, not in the
// work item's fields. The team's default list per work item type is in the shared settings.
import type { Api } from "../api/api.ts";
import { storageName, TeamStore } from "./teamstore.ts";

export interface CheckItem {
  id: string;
  text: string;
  done: boolean;
  /** who ticked it, and when */
  by?: string;
  at?: string;
}

export interface ChecklistDoc { id: string; __etag?: number; items: CheckItem[]; changed?: string; changedBy?: string }

export function newCheckItem(text: string): CheckItem {
  return { id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, text: text.trim().replace(/\s+/g, " "), done: false };
}

/** A list of texts as saved: trimmed, no empty ones, no two the same (ignoring case). */
export function cleanList(texts: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of texts ?? []) {
    const text = String(t ?? "").trim().replace(/\s+/g, " ");
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

/** A new checklist from the team's default list. */
export function fromList(texts: string[] | undefined): CheckItem[] {
  return cleanList(texts).map(newCheckItem);
}

export function progress(items: CheckItem[] | undefined): { done: number; total: number } {
  const list = items ?? [];
  return { done: list.filter((i) => i.done).length, total: list.length };
}

/** The items with one moved up (-1) or down (1); the same list when it cannot move. */
export function moveItem(items: CheckItem[], id: string, d: -1 | 1): CheckItem[] {
  const i = items.findIndex((x) => x.id === id);
  const j = i + d;
  if (i < 0 || j < 0 || j >= items.length) return items;
  const out = [...items];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Tick or untick one item, noting who and when. */
export function tick(items: CheckItem[], id: string, done: boolean, by: string, at = new Date().toISOString()): CheckItem[] {
  return items.map((x) => {
    if (x.id !== id) return x;
    const next: CheckItem = { id: x.id, text: x.text, done };
    if (done) { next.by = by; next.at = at; }
    return next;
  });
}

/** The checklists of one project's work items, with the last read kept for drawing at once. */
export class Checklists {
  private store: TeamStore<ChecklistDoc>;
  private cache = new Map<number, CheckItem[]>();

  constructor(api: Api, project: string) {
    this.store = new TeamStore<ChecklistDoc>(api, storageName(["checklist", project]));
  }

  /** The last checklist read for this item, if any was read yet. */
  cached(id: number): CheckItem[] | undefined { return this.cache.get(id); }

  /** The item's checklist ([] when it has none). */
  async get(id: number): Promise<CheckItem[]> {
    const doc = await this.store.get(String(id));
    const items = Array.isArray(doc?.items) ? doc!.items : [];
    this.cache.set(id, items);
    return items;
  }

  /**
   * Change an item's checklist, starting from the newest saved version (someone else may have
   * changed it). Two people saving at once never lose a change: a first checklist is created only
   * when nobody created one meanwhile, a change is saved with the version it started from, and on
   * a conflict the newest version is read and the change made again. An empty result removes the
   * checklist, unless someone changed it after we emptied it.
   */
  async change(id: number, fn: (items: CheckItem[]) => CheckItem[], by: string): Promise<CheckItem[]> {
    const key = String(id);
    const stamp = (items: CheckItem[]): ChecklistDoc => ({ id: key, items, changed: new Date().toISOString(), changedBy: by });
    let result: CheckItem[] = [];
    const saved = await this.store.upsert(key, (doc) => {
      result = fn(doc && Array.isArray(doc.items) ? doc.items : []);
      // nothing to keep and nothing saved yet: nothing to write
      if (!doc && !result.length) return null;
      return stamp(result);
    });
    // emptied: saved empty first (with the version check), then removed if nobody changed it since
    if (saved && !result.length) await this.store.removeIfUnchanged(key, saved.__etag);
    this.cache.set(id, result);
    return result;
  }

}
