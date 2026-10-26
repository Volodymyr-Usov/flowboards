import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api } from "../src/api/api.ts";
import type { Iteration, QuerySpec } from "../src/api/types.ts";
import type { Workspace } from "../src/core/workspace.ts";
import { loadBurndown, sprintQuery } from "../src/views/sprintdata.ts";

const REM = "Microsoft.VSTS.Scheduling.RemainingWork";
const SPRINT = "P\\Sprint 5";
const AREAS = [{ path: "P\\Team A", includeChildren: true }];
const ws = {
  project: "P", team: "Team A",
  settings: { areas: AREAS, workingDays: [1, 2, 3, 4, 5] },
  process: { fields: { remaining: REM }, types: { Task: { states: [{ name: "Active", category: "InProgress" }, { name: "Closed", category: "Completed" }] } } },
  taskLevel: () => ({ types: ["Task"] }),
} as unknown as Workspace;

test("sprint queries take only the team's areas", () => {
  assert.deepEqual(sprintQuery(ws, ["Story"], SPRINT), { types: ["Story"], areas: AREAS, iterationUnder: SPRINT });
  assert.equal(sprintQuery({ settings: { areas: [] } } as unknown as Workspace, ["Story"], SPRINT).areas, undefined);
});

test("burndown keeps a task moved out of the sprint on the days it was in it", async () => {
  // Monday 2 to Wednesday 4 March; task 2 was moved to the next sprint during Tuesday
  const sprint: Iteration = { id: "s5", name: "Sprint 5", path: SPRINT, start: "2026-03-02T00:00:00Z", finish: "2026-03-04T00:00:00Z" };
  const now = new Date(2026, 2, 4, 12).getTime();
  const mondayEnd = new Date(2026, 2, 2, 23, 59, 59, 999).toISOString();
  const queries: QuerySpec[] = [];
  const api = {
    async query(_p: string, spec: QuerySpec) {
      queries.push(spec);
      // in the sprint now: task 1; at the end of Monday: tasks 1 and 2
      return spec.asOf === mondayEnd ? [1, 2] : [1];
    },
    async capacity() { return { teamDaysOff: [] }; },
    async items(_p: string, ids: number[]) { return ids.map((id) => ({ id, state: "Active", created: "2026-03-01T09:00:00Z" })); },
    async fieldsAsOf(_p: string, ids: number[], _f: string[], at: string) {
      const monday = at === mondayEnd;
      return new Map(ids.map((id) => [id, { "System.State": "Active", "System.IterationPath": id === 2 && !monday ? "P\\Sprint 6" : SPRINT, [REM]: id === 1 ? 4 : 6 }]));
    },
    async revisions() { return []; },
  } as unknown as Api;
  const r = await loadBurndown(api, ws, sprint, { now });
  assert.equal(r?.kind, "points");
  assert.deepEqual(r?.kind === "points" ? r.points.map((p) => p.actual) : null, [10, 4, 4]);
  // every query keeps the team's areas; the past days are asked "as of" their end
  assert.ok(queries.every((q) => q.areas === AREAS && q.iterationUnder === SPRINT));
  assert.equal(queries.filter((q) => q.asOf).length, 2, "Monday and Tuesday; today is the query of now");
});
