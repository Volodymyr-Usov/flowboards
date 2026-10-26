// Things the whole team edits together (retrospective notes, poker votes), kept in the extension's
// shared storage in Azure DevOps. One document per note or vote, so two people rarely touch the same
// document; a change to a shared document re-reads it and tries again when someone else saved first.
// Collections are named by the project's and the team's ids once the page knows them (rememberIds), so a
// renamed project or team keeps its documents; those kept under the names before are copied over once.
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

/**
 * The ids behind project and team names, once the page knows them (see rememberIds). Storage is kept
 * by id, so renaming a project or a team keeps its documents. Key: project name, or project and team name.
 */
const knownIds = new Map<string, string>();
const idKey = (project: string, team?: string): string => (team === undefined ? project : project + "\u0000" + team);
/** A GUID without its dashes (shorter names); any other id as it is. */
const compactId = (id: string): string => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.replace(/-/g, "").toLowerCase() : id);

/** The ids of this project (and team): from now on their storage names use the ids. */
export function rememberIds(project: string, projectId: string, team?: string, teamId?: string): void {
  if (!projectId) return;
  knownIds.set(idKey(project), projectId);
  if (team !== undefined && teamId) knownIds.set(idKey(project, team), teamId);
}

/** The project's id, when the page knows it. */
export function knownProjectId(project: string): string | undefined { return knownIds.get(idKey(project)); }

/** Forget every remembered id (tests). */
export function forgetIds(): void { knownIds.clear(); }

/** id-keyed collection name -> the name-keyed collection it was copied from once */
const movedFrom = new Map<string, string>();

/** The id of the marker document that says the copy from the name-keyed collection is done. */
export const MOVED_DOC = "flowboards-moved";

/**
 * The collection of a team's documents of one kind. By the project's and the team's ids once they are
 * known (rememberIds); the collection under their names is then copied over once (see TeamStore).
 * Without the ids: by the names, as before.
 */
export function collectionName(kind: string, project: string, team: string): string {
  const name = storageName([kind, project, team]);
  const old = legacyName(`${kind}-${project}-${team}`, 100);
  if (old !== name) legacyNames.set(name, { old, kind, project, team });
  const pid = knownIds.get(idKey(project));
  const tid = knownIds.get(idKey(project, team));
  if (!pid || !tid) return name;
  // four parts ("id" between): never the same as a name-keyed collection (three parts)
  const byId = storageName([kind, "id", compactId(pid), compactId(tid)]);
  movedFrom.set(byId, name);
  return byId;
}

/** A collection of its own for one part of a team's collection (one retrospective board's notes), so a read takes only that part. */
export function subCollectionName(base: string, part: string): string {
  return storageName([base, "part", compactId(part)]);
}

/** The collection of a project's documents of one kind (checklists): by the project's id once known, else by its name. */
export function projectCollectionName(kind: string, project: string): string {
  const name = storageName([kind, project]);
  const pid = knownIds.get(idKey(project));
  if (!pid) return name;
  const byId = storageName([kind, "id", compactId(pid)]);
  movedFrom.set(byId, name);
  return byId;
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

/** per Api: the copy of each id-keyed collection from its name-keyed one, started once per page */
const moves = new WeakMap<Api, Map<string, Promise<boolean>>>();

/**
 * Copy the documents of the name-keyed collection `from` to the id-keyed collection `to`, once: each
 * document that is not there yet is created there (never over one that is), then a marker document
 * says it is done. The old documents stay where they are. When the older name of `from` could not be
 * checked, the marker is not written, so the copy runs again next time.
 */
export async function copyOnce(api: Api, to: string, from: string): Promise<void> {
  const here = await api.docs(to, "shared");
  if (here.some((d) => d.id === MOVED_DOC)) return;
  const { docs, complete } = await new TeamStore<ExtensionDoc>(api, from).readForCopy();
  const have = new Set(here.map((d) => d.id));
  await Promise.all(docs.filter((d) => !have.has(d.id) && d.id !== MOVED_DOC).map(async (d) => {
    const { __etag: _etag, ...body } = d;
    try { await api.createDoc(to, body as ExtensionDoc, "shared"); } catch (e) { if (!isConflict(e)) throw e; }
  }));
  if (!complete) throw new Error("The older storage could not be checked; copied what was there, the rest next time.");
  try {
    await api.createDoc(to, { id: MOVED_DOC, from, at: new Date().toISOString(), copied: docs.length }, "shared");
  } catch (e) { if (!isConflict(e)) throw e; }
}

export class TeamStore<T extends { id: string; __etag?: number }> {
  private api: Api;
  readonly collection: string;
  /** the older collection name; its documents are read too until it is empty (only when it is this team's alone) */
  private legacy: string | undefined;
  private legacyOwner: { old: string; kind: string; project: string; team: string } | undefined;
  private legacyChecked: Promise<{ ok: boolean; known: boolean }> | undefined;
  /** the name-keyed collection this id-keyed one is copied from once (see moved) */
  private from: string | undefined;
  constructor(api: Api, collection: string) {
    this.api = api;
    this.collection = collection;
    this.legacyOwner = legacyNames.get(collection);
    this.legacy = this.legacyOwner?.old;
    this.from = movedFrom.get(collection);
  }

  /**
   * Are the documents of the name-keyed collection copied here? The first use on a page copies them
   * (once for every store of this collection; the old documents stay where they are). When they could
   * not be copied now (read-only, no answer), false: they are read from there too, and copied next time.
   */
  private moved(): Promise<boolean> {
    const from = this.from;
    if (!from) return Promise.resolve(true);
    let jobs = moves.get(this.api);
    if (!jobs) { jobs = new Map(); moves.set(this.api, jobs); }
    let job = jobs.get(this.collection);
    if (!job) {
      const list = jobs;
      job = copyOnce(this.api, this.collection, from).then(() => true, (e) => {
        console.warn("Storage not copied to its new place yet", e);
        // refused for good (read-only, no permission): not asked again on this page
        if ((e as { status?: number }).status !== 403) list.delete(this.collection);
        return false;
      });
      jobs.set(this.collection, job);
    }
    return job;
  }

  /** Every document of this collection as stored (the marker of the copy left out), and whether the older collection could be checked. */
  private async read(): Promise<{ docs: T[]; complete: boolean }> {
    const docs = (await this.api.docs(this.collection, "shared")).filter((d) => d.id !== MOVED_DOC) as unknown as T[];
    if (!this.legacy) return { docs, complete: true };
    const legacy = this.legacy;
    const old = await this.api.docs(legacy, "shared");
    if (!old.length) { this.legacy = undefined; return { docs, complete: true }; }
    const name = await this.oldName();
    // not checked now (the teams could not be read): what is here, and "not complete"
    if (!name) return { docs, complete: !this.legacy };
    const have = new Set(docs.map((d) => d.id));
    // an old document is not in the new place yet: its first save creates it there
    return { docs: [...docs, ...old.filter((d) => !have.has(d.id)).map((d) => ({ ...d, __etag: -1 }))] as unknown as T[], complete: true };
  }

  /** Documents of the name-keyed collection that are not here (while the copy is not done): marked -1, so their first save creates them here. */
  private async notMoved(have: Set<string>): Promise<T[]> {
    const old = await this.fromStore().all();
    return old.filter((d) => !have.has(d.id)).map((d) => ({ ...d, __etag: -1 }));
  }

  private oldStore: TeamStore<T> | undefined;
  /** The store of the name-keyed collection (kept, so its check of older names is done once). */
  private fromStore(): TeamStore<T> {
    this.oldStore ??= new TeamStore<T>(this.api, this.from!);
    return this.oldStore;
  }

  /** For the copy: every document of the collection, and whether the older collection could be checked. */
  async readForCopy(): Promise<{ docs: T[]; complete: boolean }> { return this.read(); }

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
    const moved = await this.moved();
    const { docs } = await this.read();
    if (moved) return docs;
    return [...docs, ...(await this.notMoved(new Set(docs.map((d) => d.id))))];
  }

  async get(id: string): Promise<T | null> {
    const moved = await this.moved();
    const doc = await this.api.getDoc(this.collection, id, "shared");
    if (doc) return doc as unknown as T;
    if (!moved) {
      const old = await this.fromStore().get(id);
      // -1: not in the new place yet; its first save creates it there
      return old ? ({ ...old, __etag: -1 } as T) : null;
    }
    if (!this.legacy) return null;
    const legacy = await this.oldName();
    const old = legacy ? await this.api.getDoc(legacy, id, "shared") : null;
    // -1: not in the new place yet; its first save creates it there
    return old ? ({ ...old, __etag: -1 } as unknown as T) : null;
  }

  async put(doc: T): Promise<T> {
    await this.moved();
    return (await this.api.setDoc(this.collection, { ...doc, __etag: -1 } as unknown as ExtensionDoc, "shared")) as unknown as T;
  }

  /** Create a document only when none has its id: refused (409) when someone created it first. */
  async create(doc: T): Promise<T> {
    await this.moved();
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
    // after the copy, so a copy that runs later cannot bring the document back
    await this.moved();
    await this.api.deleteDoc(this.collection, id, "shared");
    const legacy = await this.oldName();
    if (legacy) await this.api.deleteDoc(legacy, id, "shared");
  }

  /**
   * Remove a document only when it is still the version we saved (`etag`). Storage cannot delete by
   * version, so it is read just before: a change someone saved after ours keeps the document.
   */
  async removeIfUnchanged(id: string, etag: number | undefined): Promise<boolean> {
    await this.moved();
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
