import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO, DemoApi } from "../src/api/demo.ts";
import type { Team, WorkItem } from "../src/api/types.ts";
import { countOpenStories, isOversized, openStoryCount, OVERSIZE, savedTeamFor, teamGroups, teamMatches, withChoice } from "../src/core/teampick.ts";

const t = (name: string, description?: string): Team => ({ id: name, name, description });
const all = [t("Zeta"), t("Alpha", "Payments and checkout"), t("Beta"), t("Gamma Ops", "Run the platform")];
const mine = [t("Gamma Ops", "Run the platform"), t("Alpha", "Payments and checkout")];

test("your teams first, then all teams, each by name", () => {
  const g = teamGroups(all, mine);
  assert.deepEqual(g.map((x) => x.title), ["Your teams", "All teams"]);
  assert.deepEqual(g[0].teams.map((x) => x.name), ["Alpha", "Gamma Ops"]);
  assert.deepEqual(g[1].teams.map((x) => x.name), ["Alpha", "Beta", "Gamma Ops", "Zeta"]);
});

test("no teams of your own: only all teams", () => {
  assert.deepEqual(teamGroups(all, []).map((x) => x.id), ["all"]);
  assert.deepEqual(teamGroups([], []), []);
});

test("the search finds every word in the name or the description, any case", () => {
  assert.equal(teamMatches(t("Alpha", "Payments and checkout"), "CHECK alp"), true);
  assert.equal(teamMatches(t("Alpha"), "alpha beta"), false);
  assert.equal(teamMatches(t("Alpha"), "   "), true);
  const g = teamGroups(all, mine, "platform");
  assert.deepEqual(g.map((x) => [x.id, x.teams.map((y) => y.name)]), [["mine", ["Gamma Ops"]], ["all", ["Gamma Ops"]]]);
  assert.deepEqual(teamGroups(all, mine, "nothing like it"), []);
});

const item = (id: number, type: string, category: WorkItem["category"]): WorkItem =>
  ({ id, rev: 1, type, title: "", state: "", category, area: "", iteration: "", tags: [], created: "", changed: "", fields: {} });

test("open stories are counted at the requirement level only, closed ones left out", () => {
  const items = [item(1, "User Story", "Proposed"), item(2, "User Story", "Completed"), item(3, "Bug", "InProgress"), item(4, "Feature", "Proposed"), item(5, "Task", "Proposed")];
  assert.equal(openStoryCount(items, ["User Story", "Bug"]), 2);
  assert.equal(openStoryCount(items, ["User Story"]), 1);
});

test("a team is too big above 500 open stories", () => {
  assert.equal(OVERSIZE, 500);
  assert.equal(isOversized(500), false);
  assert.equal(isOversized(501), true);
  assert.equal(isOversized(2504), true);
});

test("the team is saved per project; a pick from the team button opens once", () => {
  let s = withChoice({}, "A", "A Team");
  assert.equal(savedTeamFor(s, "A"), "A Team");
  assert.equal(savedTeamFor(s, "B"), undefined);
  s = withChoice(s, "B", "B Team", true);
  assert.deepEqual(s.next, { project: "B", team: "B Team" });
  assert.equal(savedTeamFor(s, "A"), "A Team");
  s = withChoice(s, "B", "B Team");
  assert.equal(s.next, undefined);
  assert.equal(s.project, "B");
  // what 1.1 saved (project and team only) still counts
  assert.equal(savedTeamFor({ project: "A", team: "Old" }, "A"), "Old");
});

test("the open stories of a team are counted with one query before loading it", async () => {
  const api = new DemoApi({ latencyMs: 0 });
  const n = await countOpenStories(api, DEMO.project, DEMO.team);
  assert.ok(n > 10 && n <= OVERSIZE, String(n));
  assert.equal(await countOpenStories(api, DEMO.project, "Platform Team"), 0);
});

test("the demo knows which teams are yours", async () => {
  const api = new DemoApi({ latencyMs: 0 });
  assert.deepEqual((await api.teams(DEMO.project, { mine: true })).map((x) => x.name), ["Phoenix Team"]);
  assert.equal((await api.teams(DEMO.project)).length, 2);
});
