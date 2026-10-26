import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO, DemoApi } from "../src/api/demo.ts";
import type { PullRequest } from "../src/api/types.ts";
import { isTeamPr } from "../src/app/prtimes.ts";
import type { App } from "../src/app/context.ts";
import { personKey } from "../src/core/model.ts";
import { cleanShared, DEFAULT_SHARED } from "../src/core/settings.ts";
import { DEFAULT_URGENCY } from "../src/core/urgency.ts";
import { Workspace } from "../src/core/workspace.ts";

async function load() {
  const ws = new Workspace(new DemoApi({ latencyMs: 0 }), DEMO.project, DEMO.team);
  await ws.load();
  return ws;
}

test("teamMembers: Azure DevOps's members minus those left out, plus those added", async () => {
  const ws = await load();
  const all = ws.members;
  assert.ok(all.length >= 3);
  assert.equal(ws.teamMembers().length, all.length);
  ws.setTeamTweaks({ off: [all[0].uniqueName.toUpperCase()], extra: [{ displayName: "Guest", uniqueName: "guest@x.example" }] });
  const now = ws.teamMembers();
  assert.ok(!now.some((p) => personKey(p) === personKey(all[0])), "the one left out is gone (any case)");
  assert.ok(now.some((p) => p.uniqueName === "guest@x.example"), "the added one is in");
  assert.equal(now.length, all.length);
  // the people who appear on the work are still all of them
  assert.ok(ws.people().some((p) => personKey(p) === personKey(all[0])));
  ws.setTeamTweaks(undefined);
  assert.equal(ws.teamMembers().length, all.length);
});

test("a pull request is the team's when a member wrote it or is asked to review it (a group does not count)", async () => {
  const ws = await load();
  const [a, b] = ws.members;
  const app = { ws } as unknown as App;
  const pr = (author: typeof a, reviewers: { person: typeof a; isContainer?: boolean }[]) => ({ createdBy: author, reviewers } as unknown as PullRequest);
  const outsider = { displayName: "Out", uniqueName: "out@x.example" };
  const keys = new Set([personKey(a)]);
  assert.ok(isTeamPr(app, pr(a, []), keys));
  assert.ok(isTeamPr(app, pr(outsider, [{ person: a }]), keys));
  assert.ok(!isTeamPr(app, pr(outsider, [{ person: a, isContainer: true }]), keys));
  assert.ok(!isTeamPr(app, pr(outsider, [{ person: b }]), keys));
  // no members known: no filter
  assert.ok(isTeamPr(app, pr(outsider, []), new Set()));
});

test("the shared settings read safely: team people and urgency weights", () => {
  const d = cleanShared(null, "x");
  assert.deepEqual(d.teamPeople, {});
  assert.deepEqual(d.urgency, DEFAULT_URGENCY);
  assert.deepEqual(DEFAULT_SHARED.teamPeople, {});
  const c = cleanShared({ teamPeople: { T: { off: ["A@X.EXAMPLE", 5], extra: [{ displayName: "G", uniqueName: "g@x" }, { nope: 1 }] }, bad: "x" }, urgency: { own: 90, deadlineMax: 999 } } as never, "x");
  assert.deepEqual(c.teamPeople.T.off, ["a@x.example"]);
  assert.equal(c.teamPeople.T.extra.length, 1);
  assert.deepEqual(c.teamPeople.bad, { off: [], extra: [] });
  assert.equal(c.urgency.own, 90);
  assert.equal(c.urgency.deadlineMax, 100);
});

test("team member tweaks are kept by the team's id, and old ones by name are still read", async () => {
  const { teamPeopleKey, teamPeopleOf } = await import("../src/core/settings.ts");
  const byName = { off: ["a@x"], extra: [] };
  const byId = { off: ["b@x"], extra: [] };
  assert.equal(teamPeopleKey("Team A", "123"), "id:123");
  assert.equal(teamPeopleKey("Team A"), "Team A");
  assert.deepEqual(teamPeopleOf({ teamPeople: { "Team A": byName } }, "Team A", "123"), byName);
  assert.deepEqual(teamPeopleOf({ teamPeople: { "Team A": byName, "id:123": byId } }, "Team A", "123"), byId);
  assert.deepEqual(teamPeopleOf({ teamPeople: { "id:123": byId } }, "Renamed team", "123"), byId);
  assert.equal(teamPeopleOf({ teamPeople: {} }, "Team A"), undefined);
});
