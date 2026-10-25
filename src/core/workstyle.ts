// How a team works: in sprints (Scrum), in a continuous flow (Kanban), or both (Scrumban). The style
// sets defaults only (which board layout opens, the order of the tabs); every view stays reachable.
// Which style applies: your own choice for the team, else the team's (shared, anyone in the team may
// change it), else a guess from the team's sprints and where its open work sits.
import type { Api } from "../api/api.ts";
import type { Iteration, WorkItem } from "../api/types.ts";
import { DAY, isUnder } from "./model.ts";
import { collectionName, TeamStore } from "./teamstore.ts";

export type WorkStyle = "scrum" | "kanban" | "scrumban";
export type StyleSource = "mine" | "team" | "detected";

export const STYLES: { value: WorkStyle; label: string; about: string }[] = [
  { value: "scrum", label: "Scrum", about: "Work in sprints: the board opens as the sprint taskboard; Sprint, Estimate and Retro come first." },
  { value: "kanban", label: "Kanban", about: "Continuous flow: the board opens as the flow board with limits and age; Flow and Pull requests come first." },
  { value: "scrumban", label: "Scrumban", about: "Flow inside sprints: the flow board opens first, with Sprint and Flow next to it." },
];

export const styleLabel = (s: WorkStyle): string => STYLES.find((x) => x.value === s)!.label;

/** What the guess is based on: the team's sprints and where its open work sits. */
export interface StyleFacts {
  iterations: Iteration[];
  /** the team's backlog iteration: work there is in no sprint */
  backlogPath: string;
  /** the team's open items of the requirement level (stories, bugs as requirements) */
  open: WorkItem[];
  now?: number;
}

/**
 * Guess the style: no sprint with dates now → Kanban; most open work in a sprint → Scrum; little
 * of it → Kanban; in between → Scrumban. The reason is said in words.
 */
export function detectStyle(f: StyleFacts): { style: WorkStyle; why: string } {
  const now = f.now ?? Date.now();
  const dated = f.iterations.filter((i) => i.start && i.finish);
  const current = dated.find((i) => i.timeFrame === "current" || (Date.parse(i.start!) <= now && now <= Date.parse(i.finish!) + DAY));
  if (!current) return { style: "kanban", why: dated.length ? "the team has no current sprint" : "the team has no sprints with dates" };
  const sprintPaths = dated.map((i) => i.path);
  const inSprint = f.open.filter((w) => w.iteration && w.iteration !== f.backlogPath && sprintPaths.some((p) => isUnder(w.iteration, p))).length;
  if (!f.open.length) return { style: "scrum", why: `the team is in sprint ${current.name}` };
  const share = inSprint / f.open.length;
  const pct = `${Math.round(share * 100)}% of the open work is in a sprint`;
  if (share >= 0.6) return { style: "scrum", why: pct };
  if (share <= 0.2) return { style: "kanban", why: pct };
  return { style: "scrumban", why: pct };
}

/** The board layout a style opens with. */
export function defaultLayout(style: WorkStyle): "columns" | "taskboard" {
  return style === "scrum" ? "taskboard" : "columns";
}

/** View ids in tab order for a style: its own first, then the rest in the usual order. */
export function tabOrder(style: WorkStyle, ids: string[]): string[] {
  const first: Record<WorkStyle, string[]> = {
    scrum: ["board", "sprint", "tree", "poker", "retro", "flow"],
    kanban: ["board", "flow", "tree", "prs", "deps"],
    scrumban: ["board", "sprint", "flow", "tree", "retro"],
  };
  const head = first[style].filter((id) => ids.includes(id));
  return [...head, ...ids.filter((id) => !head.includes(id))];
}

/** The team's choice, shared by everyone in the team. */
export interface TeamStyleDoc { id: string; __etag?: number; style: WorkStyle; by: string; byName: string; at: string }

const isStyle = (v: unknown): v is WorkStyle => v === "scrum" || v === "kanban" || v === "scrumban";

export class TeamStyleStore {
  private store: TeamStore<TeamStyleDoc>;
  constructor(api: Api, project: string, team: string) {
    this.store = new TeamStore<TeamStyleDoc>(api, collectionName("style", project, team));
  }
  async get(): Promise<TeamStyleDoc | null> {
    const d = await this.store.get("style");
    return d && isStyle(d.style) ? d : null;
  }
  async remove(): Promise<void> { await this.store.remove("style"); }
  async set(style: WorkStyle, by: string, byName: string): Promise<TeamStyleDoc> {
    return (await this.store.upsert("style", (doc) => ({ ...(doc ?? { id: "style" }), id: "style", style, by, byName, at: new Date().toISOString() })))!;
  }
}

/** The style that applies: yours, else the team's, else the guess. */
export function resolveStyle(mine: unknown, team: TeamStyleDoc | null, detected: WorkStyle): { style: WorkStyle; source: StyleSource } {
  if (isStyle(mine)) return { style: mine, source: "mine" };
  if (team) return { style: team.style, source: "team" };
  return { style: detected, source: "detected" };
}
