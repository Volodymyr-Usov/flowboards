// The Board's screen choices (switches, colours, hidden columns and people), kept in this browser.
// The Board reads and changes them; Settings > Cards and Columns show the switches too.
import { prefs } from "../core/settings.ts";
import type { ColorMode, ColorRules, MissingMode, PrShow } from "./boardmodel.ts";
import { DEFAULT_RULES } from "./boardmodel.ts";
import type { Fills } from "./cardfill.ts";
import { cleanFills } from "./cardfill.ts";

export const BOARD_KEY = "board";

export interface Opts {
  epics: boolean; features: boolean; empty: boolean; counts: boolean; tags: boolean;
  /** the story's number, and its parent Feature, in the line above the title */
  ids: boolean; parents: boolean;
  /** a green "new" on what was created today (otherwise 0d); tags drawn in colour, click one to change it */
  newMark: boolean; tagColors: boolean;
  /** the urgency bars on the right edge of a story card */
  urgency: boolean;
  incoming: boolean; closed: boolean; color: ColorMode; miss: MissingMode;
  /** when cards turn yellow or red, and what else counts as missing ("with…" after the ⚠ choice) */
  rules: ColorRules;
  hiddenCols: string[]; hiddenPeople: string[]; onlyPeople: string[];
  /** which pull requests count on cards */
  prs: PrShow;
  /** board columns, or the story map (Features across, sprints down) */
  layout: "columns" | "map";
  /** your own fill colours of the Epic box, the Feature card and the story card (Settings > Cards) */
  fills: Fills;
}

export const DEFAULTS: Opts = {
  epics: true, features: true, empty: false, counts: true, tags: true, ids: false, parents: false, newMark: true, tagColors: true, urgency: true, incoming: false, closed: false,
  color: "missing", miss: "rules", rules: DEFAULT_RULES, hiddenCols: [], hiddenPeople: [], onlyPeople: [], prs: "all", layout: "columns", fills: {},
};

/** Is this column hidden? New and Closed have their own switches; the others are listed by name. */
export function columnHidden(o: Opts, c: { name: string; kind: string }): boolean {
  return o.hiddenCols.includes(c.name) || (c.kind === "incoming" && !o.incoming) || (c.kind === "outgoing" && !o.closed);
}

/** The choices to save to show or hide one column (the Board's eye and arrows, and Settings). */
export function columnShownPatch(o: Opts, c: { name: string; kind: string }, shown: boolean): Partial<Opts> {
  const hiddenCols = o.hiddenCols.filter((x) => x !== c.name);
  if (c.kind === "incoming") return { incoming: shown, hiddenCols };
  if (c.kind === "outgoing") return { closed: shown, hiddenCols };
  return { hiddenCols: shown ? hiddenCols : [...hiddenCols, c.name] };
}

/**
 * Choices that belong to one team's board: its columns (by name) and its people. Kept per project and
 * team, so hiding "Review" on one team's board does not hide another team's "Review". The other
 * choices (what cards show, colours) are the person's own and the same on every board.
 */
export const TEAM_FIELDS = ["hiddenCols", "incoming", "closed", "hiddenPeople", "onlyPeople"] as const;
type TeamField = (typeof TEAM_FIELDS)[number];

/** Which team's board: "project/team". */
export const boardScope = (ws: { project: string; team: string }): string => `${ws.project}/${ws.team}`;
const teamKey = (scope: string): string => `${BOARD_KEY}:${scope}`;
const pick = (o: Partial<Opts>, team: boolean): Partial<Opts> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => TEAM_FIELDS.includes(k as TeamField) === team)) as Partial<Opts>;

/**
 * The saved choices, with defaults for anything missing or out of range. With a scope, that team's
 * columns and people; a team seen for the first time starts from the choices kept before they were
 * per team (once).
 */
export function readBoardOpts(scope?: string): Opts {
  const all = prefs.get<Partial<Opts>>(BOARD_KEY, {});
  let team: Partial<Opts> = {};
  if (scope) {
    const kept = prefs.get<Partial<Opts> | null>(teamKey(scope), null);
    if (kept) team = kept;
    else { team = pick(all, true); prefs.set(teamKey(scope), team); }
  }
  const o: Opts = { ...DEFAULTS, ...pick(all, false), ...(scope ? team : pick(all, true)) };
  o.rules = { ...DEFAULT_RULES, ...o.rules };
  if (!["all", "open", "completed"].includes(o.prs)) o.prs = "all";
  if (o.layout !== "map") o.layout = "columns";
  o.fills = cleanFills(o.fills);
  return o;
}

/** Keep every choice: the team's part under its scope, the rest for every board. */
export function writeBoardOpts(o: Opts, scope?: string): void {
  if (!scope) { prefs.set(BOARD_KEY, { ...prefs.get<Partial<Opts>>(BOARD_KEY, {}), ...o }); return; }
  prefs.set(BOARD_KEY, { ...prefs.get<Partial<Opts>>(BOARD_KEY, {}), ...pick(o, false) });
  prefs.set(teamKey(scope), pick(o, true));
}

/** Change some choices (Settings): the Board reads them when it opens. */
export function saveBoardOpts(patch: Partial<Opts>, scope?: string): void {
  writeBoardOpts({ ...readBoardOpts(scope), ...patch }, scope);
}
