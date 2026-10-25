// Choosing a team: the lists of the team chooser (your teams, all teams, search), the team saved per
// project, and the check for a team so big its board would be crowded (its area is the whole project).
import type { Api } from "../api/api.ts";
import type { Team, WorkItem } from "../api/types.ts";
import { statesOf } from "./model.ts";

/** More open stories than this: the team probably covers the whole project. */
export const OVERSIZE = 500;

export interface TeamGroup { id: "mine" | "all"; title: string; teams: Team[] }

/** Every word of the query is in the team's name or description (case does not matter). */
export function teamMatches(t: Team, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${t.name} ${t.description ?? ""}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** "Your teams" first, then "All teams" (every team, yours too), each by name, both narrowed by the search. */
export function teamGroups(all: Team[], mine: Team[], query = ""): TeamGroup[] {
  const byName = (a: Team, b: Team): number => a.name.localeCompare(b.name);
  const pick = (ts: Team[]): Team[] => ts.filter((t) => teamMatches(t, query)).sort(byName);
  const out: TeamGroup[] = [];
  const m = pick(mine);
  if (m.length) out.push({ id: "mine", title: "Your teams", teams: m });
  const a = pick(all);
  if (a.length) out.push({ id: "all", title: "All teams", teams: a });
  return out;
}

/** Open requirement-level items (stories) among these items. */
export function openStoryCount(items: Iterable<WorkItem>, reqTypes: string[]): number {
  let n = 0;
  for (const it of items) if (reqTypes.includes(it.type) && it.category !== "Completed" && it.category !== "Removed") n++;
  return n;
}

export function isOversized(openStories: number): boolean { return openStories > OVERSIZE; }

/** What is kept per organization (prefs "team:<org>"): the last choice, the team per project, and a pick to open next. */
export interface SavedTeams { project?: string; team?: string; byProject?: Record<string, string>; next?: { project: string; team: string } }

/** The team saved for this project, if any. */
export function savedTeamFor(saved: SavedTeams, project: string): string | undefined {
  return saved.byProject?.[project] ?? (saved.project === project && saved.team ? saved.team : undefined);
}

/** The saved choices after picking a team; with `next`, the page opens it on its next load. */
export function withChoice(saved: SavedTeams, project: string, team: string, next = false): SavedTeams {
  const out: SavedTeams = { ...saved, project, team, byProject: { ...saved.byProject, [project]: team } };
  if (next) out.next = { project, team };
  else delete out.next;
  return out;
}

/** Count the team's open stories with one query (before loading it). */
export async function countOpenStories(api: Api, project: string, team: string): Promise<number> {
  const [process, settings] = await Promise.all([api.process(project, team), api.teamSettings(project, team)]);
  const req = process.levels.find((l) => l.kind === "requirement");
  if (!req) return 0;
  const notStates = statesOf(process, req.types, ["Completed", "Removed"]);
  const ids = await api.query(project, { types: req.types, areas: settings.areas.length ? settings.areas : undefined, notStates });
  return ids.length;
}
