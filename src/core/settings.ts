// Three kinds of saved choices:
//  - shared settings of a project (rules, strategy pillars, thresholds): the extension's storage in
//    Azure DevOps, the same for everyone in the project
//  - personal settings (AI provider and key, last team): the extension's storage, for this person only
//  - screen choices (switches, filters, theme): this browser only (localStorage)
import type { Api } from "../api/api.ts";
import type { Person } from "../api/types.ts";
import type { UrgencyWeights } from "./urgency.ts";
import { cleanUrgency, DEFAULT_URGENCY } from "./urgency.ts";
import type { Rule } from "./rules.ts";
import { REQUIREMENTS } from "./rules.ts";
import type { ChildTemplate } from "./templates.ts";
import type { WorkStyle } from "./workstyle.ts";
import type { CustomCheck } from "./health.ts";
import { every, knownProjectId, legacyName, storageName } from "./teamstore.ts";

export interface Pillar { id: string; name: string; description?: string; color?: string }

export interface SharedSettings {
  id: string;
  __etag?: number;
  rules: Rule[];
  pillars: Pillar[];
  /** an Epic's pillar comes from a tag "<prefix><pillar name>", or from the manual map below */
  pillarTagPrefix: string;
  epicPillars: Record<string, string>;
  staleDays: number;
  closedDays: number;
  /** board columns: the team's board columns, or the work item states */
  boardMode: "columns" | "states";
  /** the team's default checklist ("definition of done") per work item type */
  checklists: Record<string, string[]>;
  /** standard child work per parent work item type (a story's standard tasks) */
  childTemplates: Record<string, ChildTemplate[]>;
  /** Health: the checks the team added, and the built-in checks turned off */
  healthChecks: CustomCheck[];
  healthOff: string[];
  /** per team ("team name"): members Azure DevOps lists that are not really in the team (access only), and people added who are */
  teamPeople: Record<string, TeamPeople>;
  /** what counts in a story's urgency, and how much (Settings > Priority) */
  urgency: UrgencyWeights;
}

/** The fine-tuning of one team's members (Settings > Team): `off` are sign-in names (lower case) left out, `extra` are added. */
export interface TeamPeople { off: string[]; extra: Person[] }

export interface AiSettings {
  provider: "none" | "anthropic" | "openai";
  apiKey: string;
  model: string;
  /** for OpenAI-compatible services (Azure OpenAI, a local model): the chat completions address */
  endpoint: string;
}

export interface UserSettings {
  id: string;
  __etag?: number;
  ai: AiSettings;
  lastProject?: string;
  lastTeam?: string;
  /** your own working style per "project/team", over the team's (see core/workstyle.ts) */
  styles?: Record<string, WorkStyle>;
}

export const DEFAULT_SHARED: Omit<SharedSettings, "id"> = {
  rules: [], pillars: [], pillarTagPrefix: "Pillar:", epicPillars: {}, staleDays: 14, closedDays: 30, boardMode: "columns",
  checklists: {}, childTemplates: {}, healthChecks: [], healthOff: [], teamPeople: {}, urgency: DEFAULT_URGENCY,
};
export const DEFAULT_AI: AiSettings = { provider: "none", apiKey: "", model: "", endpoint: "" };

/** The shared settings document of a project, and the id older versions used (read for migration). */
export function settingsDocIds(project: string): { id: string; legacy: string } {
  return { id: "project-" + storageName([project], 92), legacy: "project-" + legacyName(project, 100) };
}

/**
 * The id of a project's shared settings document, and the older ids it is copied from once: by the
 * project's id when it is known (a renamed project keeps its settings), else by its name.
 */
export function sharedDocIds(project: string, projectId?: string): { id: string; older: string[] } {
  const { id, legacy } = settingsDocIds(project);
  const older = [...new Set([id, legacy])];
  if (!projectId) return { id, older: older.slice(1) };
  return { id: "project-id-" + storageName([projectId.replace(/-/g, "").toLowerCase()], 89), older };
}

const LEVELS: Rule["level"][] = ["portfolio", "requirement", "task", "*"];
const KNOWN_REQUIREMENTS = new Set<string>(REQUIREMENTS.map((r) => r.id));

/**
 * A stored rule made safe to use, or null when it cannot be: one with no column or state, or no level,
 * is left out; lists that are not lists of text become lists of the texts in them, and a requirement
 * this version does not know is left out (it could never be met).
 */
export function cleanRule(v: unknown, index = 0): Rule | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const target = typeof r.target === "string" ? r.target.trim() : "";
  const level = LEVELS.find((l) => l === r.level);
  if (!target || !level) return null;
  const texts = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s.trim() !== "") : []);
  const out: Record<string, unknown> = {
    ...r,
    id: typeof r.id === "string" && r.id ? r.id : `rule-${index + 1}`,
    level, target,
    requires: texts(r.requires).filter((q) => KNOWN_REQUIREMENTS.has(q)),
    onlyBy: texts(r.onlyBy),
  };
  if ("fields" in r) out.fields = texts(r.fields);
  if ("from" in r) { if (typeof r.from === "string" && r.from.trim()) out.from = r.from; else delete out.from; }
  if ("note" in r && typeof r.note !== "string") delete out.note;
  if ("breaks" in r && typeof r.breaks !== "boolean") delete out.breaks;
  return out as unknown as Rule;
}

/**
 * The shared settings as read: a part that is missing or damaged (another version wrote it, or it was
 * edited by hand) takes its default, so the pages can rely on lists being lists and days being numbers.
 */
export function cleanShared(doc: Partial<SharedSettings> | null | undefined, id: string): SharedSettings {
  const d: Record<string, unknown> = doc && typeof doc === "object" ? { ...doc } : {};
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const map = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const days = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.min(365, Math.round(v)) : fallback);
  return {
    ...DEFAULT_SHARED, ...d,
    rules: list(d.rules).map((r, i) => cleanRule(r, i)).filter((r): r is Rule => r !== null),
    pillars: list(d.pillars).filter((p) => p && typeof p === "object") as SharedSettings["pillars"],
    pillarTagPrefix: typeof d.pillarTagPrefix === "string" ? d.pillarTagPrefix : DEFAULT_SHARED.pillarTagPrefix,
    epicPillars: map(d.epicPillars) as SharedSettings["epicPillars"],
    staleDays: days(d.staleDays, DEFAULT_SHARED.staleDays),
    closedDays: days(d.closedDays, DEFAULT_SHARED.closedDays),
    boardMode: d.boardMode === "states" ? "states" : "columns",
    checklists: map(d.checklists) as SharedSettings["checklists"],
    childTemplates: map(d.childTemplates) as SharedSettings["childTemplates"],
    healthChecks: list(d.healthChecks).filter((c) => c && typeof c === "object") as SharedSettings["healthChecks"],
    healthOff: list(d.healthOff).filter((x) => typeof x === "string") as string[],
    urgency: cleanUrgency(d.urgency),
    teamPeople: Object.fromEntries(Object.entries(map(d.teamPeople)).map(([team, v]) => {
      const t = map(v);
      const extra = list(t.extra).filter((x): x is Person => !!x && typeof x === "object" && typeof (x as Person).uniqueName === "string" && typeof (x as Person).displayName === "string");
      return [team, { off: list(t.off).filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()), extra }];
    })),
    id,
  };
}

/** Did a part a change sets differ between the copy the change was made on and a newer one? */
export function changedParts(base: SharedSettings, newer: SharedSettings, patch: Partial<SharedSettings>): boolean {
  const a = base as unknown as Record<string, unknown>;
  const b = newer as unknown as Record<string, unknown>;
  return Object.keys(patch).some((k) => k !== "id" && k !== "__etag" && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** Where a team's member tweaks (Settings > Team) are kept: by the team's id, so a renamed team keeps them. */
export function teamPeopleKey(team: string, teamId?: string): string {
  return teamId ? `id:${teamId}` : team;
}

/** A team's member tweaks: kept by its id, or (saved before) by its name. */
export function teamPeopleOf(shared: Pick<SharedSettings, "teamPeople">, team: string, teamId?: string): TeamPeople | undefined {
  return (teamId ? shared.teamPeople?.[teamPeopleKey(team, teamId)] : undefined) ?? shared.teamPeople?.[team];
}

export const NOT_READ = "Settings could not be read, so they are not saved; reload the page.";
const CONFLICT = "Someone else saved these settings at the same time. They were read again; make your change again.";
const OWN_CONFLICT = "Your settings were changed in another tab; reload.";
const isConflict = (e: unknown): boolean => [409, 412].includes((e as { status?: number }).status ?? 0);
export class Settings {
  private api: Api;
  shared: SharedSettings;
  user: UserSettings;
  /** the last read failed (not "not found"): a save would put defaults over the real settings */
  sharedReadFailed = false;
  userReadFailed = false;
  private project = "";
  private listeners = new Set<() => void>();

  constructor(api: Api) {
    this.api = api;
    this.shared = { id: "", ...DEFAULT_SHARED };
    this.user = { id: "prefs", ai: { ...DEFAULT_AI } };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void { for (const f of this.listeners) f(); }

  /**
   * The project's shared settings document: under its id (by the project's id once known), else the
   * one an older version saved under an older id, copied once to the id it has now (the old one stays).
   * Null when there is none. A copy that cannot be made now (read-only) is used as read, without a version.
   */
  private async readShared(project: string): Promise<Partial<SharedSettings> | null> {
    const { id, older } = sharedDocIds(project, knownProjectId(project));
    const doc = await this.api.getDoc("settings", id, "shared");
    if (doc) return doc as Partial<SharedSettings>;
    for (const o of older) {
      const old = await this.api.getDoc("settings", o, "shared");
      if (!old) continue;
      const { __etag: _etag, ...body } = old;
      try {
        return (await this.api.createDoc("settings", { ...body, id }, "shared")) as Partial<SharedSettings>;
      } catch (e) {
        // someone copied it first: theirs counts
        if (isConflict(e)) return (await this.api.getDoc("settings", id, "shared")) as Partial<SharedSettings> | null;
        console.warn("Shared settings not copied to their new id", e);
        return { ...body, id } as Partial<SharedSettings>;
      }
    }
    return null;
  }

  async loadShared(project: string): Promise<void> {
    this.project = project;
    const { id } = sharedDocIds(project, knownProjectId(project));
    try {
      this.shared = cleanShared(await this.readShared(project), id);
      this.sharedReadFailed = false;
    } catch (e) {
      console.warn("Shared settings not read", e);
      this.shared = { ...DEFAULT_SHARED, id };
      this.sharedReadFailed = true;
    }
    this.emit();
  }

  /** a save is running: a read again now could put an older copy over it */
  private saving = 0;

  /**
   * Read the shared settings again (while the page is open, a teammate may change the rules); the pages
   * hear of it only when something changed. A failed read keeps what is here.
   */
  async refreshShared(): Promise<void> {
    if (!this.project || this.saving) return;
    const project = this.project;
    let fresh: SharedSettings;
    try { fresh = cleanShared(await this.readShared(project), sharedDocIds(project, knownProjectId(project)).id); } catch (e) { console.warn("Shared settings not read again", e); return; }
    if (this.saving || project !== this.project) return;
    const was = JSON.stringify(this.shared);
    this.shared = fresh;
    this.sharedReadFailed = false;
    if (JSON.stringify(fresh) !== was) this.emit();
  }

  /** Read the shared settings again every `ms` (2 minutes) while the page is visible; returns the stop. */
  watchShared(ms = 120_000): () => void {
    return every(ms, () => this.refreshShared());
  }

  /**
   * Save a change to the shared settings: read the newest version first and put the change on it, so a
   * teammate's change to another part stays. The first save of a project creates the document only when
   * nobody created it meanwhile (if someone did, theirs is read and the change put on it). When someone
   * saves between our read and our save, the save is refused and the newer version is read.
   */
  async saveShared(patch: Partial<SharedSettings>): Promise<void> {
    if (this.sharedReadFailed) throw new Error(NOT_READ);
    this.saving++;
    try {
      const { id } = sharedDocIds(this.project, knownProjectId(this.project));
      // the newest version (quietly: the pages hear of it with the save)
      // take a newer version; someone changed the same part since this page read it: theirs is not overwritten unseen
      const take = (doc: Partial<SharedSettings> | null): void => {
        const fresh = cleanShared(doc, id);
        const clash = changedParts(this.shared, fresh, patch);
        this.shared = fresh;
        if (clash) { this.emit(); throw new Error(CONFLICT); }
      };
      let first: Partial<SharedSettings> | null | undefined;
      try { first = await this.readShared(this.project); } catch (e) { console.warn("Shared settings not read before saving", e); }
      if (first !== undefined) take(first);
      for (let attempt = 0; ; attempt++) {
        const next: SharedSettings = { ...this.shared, ...patch, id };
        try {
          const saved = next.__etag == null
            ? await this.api.createDoc("settings", next as unknown as { id: string }, "shared")
            : await this.api.setDoc("settings", next as unknown as { id: string }, "shared");
          // as a read would give it, so the next comparison sees only real changes
          this.shared = cleanShared({ ...next, __etag: saved.__etag }, id);
          break;
        } catch (e) {
          if (!isConflict(e)) throw e;
          const created = next.__etag == null;
          // read the newer version, so the next save carries its version
          const newer = await this.readShared(this.project).catch(() => null);
          // someone created the document first: put this change on theirs (once), unless they set the same part
          if (newer) take(newer);
          if (created && newer && attempt === 0) continue;
          this.emit();
          throw new Error(CONFLICT);
        }
      }
    } finally {
      this.saving--;
    }
    this.emit();
  }

  async loadUser(): Promise<void> {
    try {
      const d = ((await this.api.getDoc("user", "prefs", "user")) ?? {}) as Partial<UserSettings>;
      this.user = { id: "prefs", ...d, ai: { ...DEFAULT_AI, ...(d.ai ?? {}) } };
      this.userReadFailed = false;
    } catch (e) {
      console.warn("Personal settings not read", e);
      this.user = { id: "prefs", ai: { ...DEFAULT_AI } };
      this.userReadFailed = true;
    }
  }

  async saveUser(patch: Partial<UserSettings>): Promise<void> {
    if (this.userReadFailed) throw new Error(NOT_READ);
    const next = { ...this.user, ...patch };
    let saved;
    try {
      saved = await this.api.setDoc("user", next as unknown as { id: string }, "user");
    } catch (e) {
      if (!isConflict(e)) throw e;
      // personal settings are only this person's: the other save came from their own other tab
      await this.loadUser();
      this.emit();
      throw new Error(OWN_CONFLICT);
    }
    this.user = { ...next, __etag: saved.__etag };
    this.emit();
  }
}

/** Screen choices kept in this browser. Reads and writes never throw (private windows block storage). */
const PREFIX = "ado-dashboard:";
/** the person's screen choices in Azure DevOps (their own extension storage), once connected */
let cloud: { schedule: () => void; flush: () => Promise<void> } | null = null;

/**
 * Screen choices (switches, filters, layouts, column widths, theme…). Read and written at once in
 * this browser; once `syncPrefs` ran they are also kept in the person's own storage in Azure DevOps,
 * so they follow them to another browser or computer.
 */
export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = held.get(key) ?? localStorage.getItem(PREFIX + key);
      return v == null ? fallback : (JSON.parse(v) as T);
    } catch { return fallback; }
  },
  set(key: string, value: unknown): void {
    store(key, value);
    cloud?.schedule();
  },
};

/** Choices the browser would not keep (storage blocked or full), as text: held for this page, so they still count and still reach the cloud copy. */
const held = new Map<string, string>();

function store(key: string, value: unknown): void {
  const text = JSON.stringify(value);
  try {
    localStorage.setItem(PREFIX + key, text);
    held.delete(key);
  } catch {
    if (text === undefined) held.delete(key); else held.set(key, text);
  }
}

/**
 * Back to the defaults: every screen choice of this person (switches, bars, columns, filters, widths,
 * theme…) is forgotten, here and in their stored copy. The team they picked stays. Resolves once the
 * stored copy is written, so the page can load again at once.
 */
export async function resetPrefs(): Promise<void> {
  // the team picked, and the ids of projects and teams (where their storage is) are not screen choices
  const keep = (k: string): boolean => k.startsWith("team:") || k.startsWith("ids:");
  try {
    const gone: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(PREFIX) && !k.startsWith(PREFIX + "doc:") && !keep(k.slice(PREFIX.length))) gone.push(k);
    }
    for (const k of gone) localStorage.removeItem(k);
  } catch { /* storage blocked: only the held ones */ }
  for (const k of [...held.keys()]) if (!keep(k)) held.delete(k);
  await cloud?.flush();
}

/** The choices that make up the layout: bars, tabs and crosses, the Board's switches and columns, the layout picked per team, the calendar's view. */
export const isLayoutKey = (k: string): boolean => k === "blocks.off" || k === "blocks.noCrosses" || k === "board" || k.startsWith("board.layout:") || k === "board.burndownFolded" || k === "calendar:mode";

/**
 * Back to the default layout: only the layout choices (see isLayoutKey) are forgotten, here and in the stored
 * copy. Filters, theme, working style, team and the team's settings stay. Resolves once the stored copy is written.
 */
export async function resetLayout(): Promise<void> {
  try {
    const gone: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(PREFIX) && !k.startsWith(PREFIX + "doc:") && isLayoutKey(k.slice(PREFIX.length))) gone.push(k);
    }
    for (const k of gone) localStorage.removeItem(k);
  } catch { /* storage blocked: only the held ones */ }
  for (const k of [...held.keys()]) if (isLayoutKey(k)) held.delete(k);
  await cloud?.flush();
}

/** Every screen choice kept in this browser, by key. */
function localPrefs(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      // the documents of the demo and of the local stand-in for extension storage are not choices
      if (!k.startsWith(PREFIX) || k.startsWith(PREFIX + "doc:")) continue;
      try { out[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k)!); } catch { /* not JSON: skipped */ }
    }
  } catch { /* storage blocked */ }
  for (const [k, v] of held) { try { out[k] = JSON.parse(v); } catch { /* skipped */ } }
  return out;
}

/**
 * Keep the screen choices in the person's own extension storage ("user" scope, readable only by
 * them). The stored copy wins on start (it is the same person's latest choices from anywhere);
 * with none stored yet, this browser's choices are stored. Later changes are saved a moment after.
 */
export async function syncPrefs(api: Api, delayMs = 1500): Promise<void> {
  const DOC = "screen";
  const stored = await api.getDoc("user", DOC, "user");
  const values = (stored as { values?: Record<string, unknown> } | null)?.values;
  if (values && typeof values === "object") {
    for (const [k, v] of Object.entries(values)) store(k, v);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // one save at a time and in order: a slow older save must not land after a newer one
  let queue: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    queue = queue.then(async () => {
      try { await api.setDoc("user", { id: DOC, values: localPrefs() } as unknown as { id: string }, "user"); } catch (e) { console.warn("Screen choices not saved to Azure DevOps", e); }
    });
    return queue;
  };
  cloud = { schedule: () => { clearTimeout(timer); timer = setTimeout(() => void save(), delayMs); }, flush: () => { clearTimeout(timer); return save(); } };
  if (!values) cloud.schedule();
}
