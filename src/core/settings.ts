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
import type { ChildTemplate } from "./templates.ts";
import type { WorkStyle } from "./workstyle.ts";
import type { CustomCheck } from "./health.ts";
import { legacyName, storageName } from "./teamstore.ts";

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
    rules: list(d.rules).filter((r) => r && typeof r === "object") as SharedSettings["rules"],
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

export const NOT_READ = "Settings could not be read, so they are not saved; reload the page.";
const CONFLICT = "Someone else saved these settings at the same time. They were read again; make your change again.";
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

  async loadShared(project: string): Promise<void> {
    this.project = project;
    const { id, legacy } = settingsDocIds(project);
    try {
      let doc = await this.api.getDoc("settings", id, "shared");
      if (!doc && legacy !== id) {
        // saved by an older version under the old id: use it; the next save writes the new id
        const old = await this.api.getDoc("settings", legacy, "shared");
        if (old) { doc = { ...old }; delete doc.__etag; }
      }
      this.shared = cleanShared(doc as Partial<SharedSettings> | null, id);
      this.sharedReadFailed = false;
    } catch (e) {
      console.warn("Shared settings not read", e);
      this.shared = { ...DEFAULT_SHARED, id };
      this.sharedReadFailed = true;
    }
    this.emit();
  }

  async saveShared(patch: Partial<SharedSettings>): Promise<void> {
    if (this.sharedReadFailed) throw new Error(NOT_READ);
    const next = { ...this.shared, ...patch };
    let saved;
    try {
      saved = await this.api.setDoc("settings", next as unknown as { id: string }, "shared");
    } catch (e) {
      if (!isConflict(e)) throw e;
      // read the newer version, so the next save carries its version
      await this.loadShared(this.project);
      throw new Error(CONFLICT);
    }
    this.shared = { ...next, __etag: saved.__etag };
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
      await this.loadUser();
      this.emit();
      throw new Error(CONFLICT);
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
  const keep = (k: string): boolean => k.startsWith("team:");
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
