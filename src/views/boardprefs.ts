// The Board's screen choices (switches, colours, hidden columns and people), kept in this browser.
// The Board reads and changes them; Settings > Cards and Columns show the switches too.
import { prefs } from "../core/settings.ts";
import type { ColorMode, ColorRules, MissingMode, PrShow } from "./boardmodel.ts";
import { DEFAULT_RULES } from "./boardmodel.ts";

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
}

export const DEFAULTS: Opts = {
  epics: true, features: true, empty: false, counts: true, tags: true, ids: false, parents: false, newMark: true, tagColors: true, urgency: true, incoming: false, closed: false,
  color: "missing", miss: "rules", rules: DEFAULT_RULES, hiddenCols: [], hiddenPeople: [], onlyPeople: [], prs: "all", layout: "columns",
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

/** The saved choices, with defaults for anything missing or out of range. */
export function readBoardOpts(): Opts {
  const o: Opts = { ...DEFAULTS, ...prefs.get<Partial<Opts>>(BOARD_KEY, {}) };
  o.rules = { ...DEFAULT_RULES, ...o.rules };
  if (!["all", "open", "completed"].includes(o.prs)) o.prs = "all";
  if (o.layout !== "map") o.layout = "columns";
  return o;
}

/** Change some choices (Settings): the Board reads them when it opens. */
export function saveBoardOpts(patch: Partial<Opts>): void {
  prefs.set(BOARD_KEY, { ...readBoardOpts(), ...patch });
}
