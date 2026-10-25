// Things the whole team edits together (retrospective notes, poker votes), kept in the extension's
// shared storage in Azure DevOps. One document per note or vote, so two people rarely touch the same
// document; a change to a shared document re-reads it and tries again when someone else saved first.
import type { Api, ExtensionDoc } from "../api/api.ts";

/** A short hash of a text, as 11 letters and digits. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
}

/**
 * A storage name (collection or document id) made of these parts, with letters, digits, - and _ only.
 * Letters and digits stay; every other character becomes _ and its 4-digit code, so different
 * names never give the same result. Parts are joined with "-". A name longer than `max` is cut
 * and ends in "--" and a hash of the whole (no short name contains "--").
 */
export function storageName(parts: string[], max = 100): string {
  const enc = (s: string): string => s ? s.replace(/[^A-Za-z0-9]/g, (c) => "_" + c.charCodeAt(0).toString(16).padStart(4, "0")) : "_";
  const name = parts.map(enc).join("-");
  return name.length <= max ? name : name.slice(0, max - 13) + "--" + hash(parts.join("\u0000"));
}

/** The name older versions used (it could give two teams the same name); read for migration. */
export function legacyName(s: string, max: number): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, max);
}

/** new collection name -> the older name of the same collection (and whose it is), when they differ */
const legacyNames = new Map<string, { old: string; kind: string; project: string; team: string }>();

export function collectionName(kind: string, project: string, team: string): string {
  const name = storageName([kind, project, team]);
  const old = legacyName(`${kind}-${project}-${team}`, 100);
  if (old !== name) legacyNames.set(name, { old, kind, project, team });
  return name;
}

/**
 * Is the older collection name this team's alone? Older names turned every other character into "_"
 * and joined the parts with "-", so "Team A" and "Team_A" (or project "Web-App" with team "Core" and
 * project "Web" with team "App-Core") shared one collection. When any other team of the organization
 * gives the same older name, nobody can tell whose the documents are: they are not read.
 */
export async function legacyIsOnlyOurs(api: Pick<Api, "projects" | "teams">, legacy: { old: string; kind: string; project: string; team: string }): Promise<boolean> {
  // a cut name (100 characters) may stand for many names
  if (legacy.old.length >= 100) return false;
  const projects = await api.projects();
  for (const p of projects) {
    // only projects whose older name starts the same way can give the same collection name
    if (!legacy.old.startsWith(legacyName(`${legacy.kind}-${p.name}-`, 100))) continue;
    for (const t of await api.teams(p.name)) {
      const mine = p.name === legacy.project && t.name === legacy.team;
      if (!mine && legacyName(`${legacy.kind}-${p.name}-${t.name}`, 100) === legacy.old) return false;
    }
  }
  return true;
}

export function newDocId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const isConflict = (e: unknown): boolean => [409, 412].includes((e as { status?: number }).status ?? 0);

export class TeamStore<T extends { id: string; __etag?: number }> {
  private api: Api;
  readonly collection: string;
  /** the older collection name; its documents are read too until it is empty (only when it is this team's alone) */
  private legacy: string | undefined;
  private legacyOwner: { old: string; kind: string; project: string; team: string } | undefined;
  private legacyChecked: Promise<{ ok: boolean; known: boolean }> | undefined;
  constructor(api: Api, collection: string) {
    this.api = api;
    this.collection = collection;
    this.legacyOwner = legacyNames.get(collection);
    this.legacy = this.legacyOwner?.old;
  }

  /** The older collection, when it may be read: checked once against the other teams' names. */
  private async oldName(): Promise<string | undefined> {
    if (!this.legacy || !this.legacyOwner) return undefined;
    this.legacyChecked ??= legacyIsOnlyOurs(this.api, this.legacyOwner).then((ok) => ({ ok, known: true }), (e) => {
      console.warn("Older storage not checked", e);
      return { ok: false, known: false };
    });
    const r = await this.legacyChecked;
    // not known now (the teams could not be read): not read this time, asked again next time
    if (!r.known) { this.legacyChecked = undefined; return undefined; }
    // shared with another team: never read
    if (!r.ok) { this.legacy = undefined; return undefined; }
    return this.legacy;
  }

  async all(): Promise<T[]> {
    const docs = await this.api.docs(this.collection, "shared");
    if (!this.legacy) return docs as unknown as T[];
    const legacy = this.legacy;
    const old = await this.api.docs(legacy, "shared");
    if (!old.length) { this.legacy = undefined; return docs as unknown as T[]; }
    if (!(await this.oldName())) return docs as unknown as T[];
    const have = new Set(docs.map((d) => d.id));
    // an old document is not in the new place yet: its first save creates it there
    return [...docs, ...old.filter((d) => !have.has(d.id)).map((d) => ({ ...d, __etag: -1 }))] as unknown as T[];
  }

  async get(id: string): Promise<T | null> {
    const doc = await this.api.getDoc(this.collection, id, "shared");
    if (doc || !this.legacy) return doc as unknown as T | null;
    const legacy = await this.oldName();
    const old = legacy ? await this.api.getDoc(legacy, id, "shared") : null;
    // -1: not in the new place yet; its first save creates it there
    return old ? ({ ...old, __etag: -1 } as unknown as T) : null;
  }

  async put(doc: T): Promise<T> {
    return (await this.api.setDoc(this.collection, { ...doc, __etag: -1 } as unknown as ExtensionDoc, "shared")) as unknown as T;
  }

  /** Create a document only when none has its id: refused (409) when someone created it first. */
  async create(doc: T): Promise<T> {
    return (await this.api.createDoc(this.collection, { ...doc } as unknown as ExtensionDoc, "shared")) as unknown as T;
  }

  /** Change a document that others may change at the same time: read, change, save with its version; retry on a conflict. */
  async update(id: string, change: (doc: T) => T | null): Promise<T | null> {
    return this.upsert(id, (doc) => (doc ? change(doc) : null));
  }

  /**
   * Change a document, or create it when there is none, with conflict checks both ways: a change is
   * saved with the version it started from, a new document only when nobody created it meanwhile.
   * On a conflict the newest version is read and `change` runs again (up to 4 times).
   * `change` gets null when there is no document; it returns null to leave things as they are.
   */
  async upsert(id: string, change: (doc: T | null) => T | null): Promise<T | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await this.get(id);
      const next = change(cur ? structuredClone(cur) : null);
      if (!next) return cur;
      try {
        // not here yet (none, or only in the older collection): create, so a document someone made meanwhile is not overwritten
        if (!cur || cur.__etag === -1) return await this.create({ ...next, id });
        return (await this.api.setDoc(this.collection, { ...next, __etag: cur.__etag } as unknown as ExtensionDoc, "shared")) as unknown as T;
      } catch (e) {
        if (!isConflict(e) || attempt === 3) throw e;
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 300));
      }
    }
    return null;
  }

  async remove(id: string): Promise<void> {
    await this.api.deleteDoc(this.collection, id, "shared");
    const legacy = await this.oldName();
    if (legacy) await this.api.deleteDoc(legacy, id, "shared");
  }

  /**
   * Remove a document only when it is still the version we saved (`etag`). Storage cannot delete by
   * version, so it is read just before: a change someone saved after ours keeps the document.
   */
  async removeIfUnchanged(id: string, etag: number | undefined): Promise<boolean> {
    const cur = await this.api.getDoc(this.collection, id, "shared");
    if (cur && cur.__etag !== etag) return false;
    await this.remove(id);
    return true;
  }
}


/** Run `fn` every `ms` while the page is visible, until stopped. */
export function every(ms: number, fn: () => Promise<void> | void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (document.visibilityState === "visible") { try { await fn(); } catch (e) { console.warn(e); } }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  return () => { stopped = true; clearTimeout(timer); };
}
