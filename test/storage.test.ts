import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, ExtensionDoc } from "../src/api/api.ts";
import { ApiError } from "../src/api/types.ts";
import { cleanShared, NOT_READ, Settings, settingsDocIds } from "../src/core/settings.ts";
import { collectionName, storageName, TeamStore } from "../src/core/teamstore.ts";

/** Extension storage in memory; `fail` makes the next calls of a kind throw. */
function fakeDocs() {
  const data = new Map<string, Map<string, ExtensionDoc>>();
  const fail: { get?: Error; set?: Error[] } = {};
  const teams: Record<string, string[]> = { "Web-App": ["Core"], P: ["T"] };
  const coll = (c: string): Map<string, ExtensionDoc> => {
    if (!data.has(c)) data.set(c, new Map());
    return data.get(c)!;
  };
  const api = {
    async docs(c: string) { return [...coll(c).values()].map((d) => structuredClone(d)); },
    async getDoc(c: string, id: string) {
      if (fail.get) throw fail.get;
      const d = coll(c).get(id);
      return d ? structuredClone(d) : null;
    },
    async setDoc(c: string, doc: ExtensionDoc) {
      const err = fail.set?.shift();
      if (err) throw err;
      const saved = { ...doc, __etag: (coll(c).get(doc.id)?.__etag ?? 0) + 1 };
      coll(c).set(doc.id, saved);
      return structuredClone(saved);
    },
    async createDoc(c: string, doc: ExtensionDoc) {
      if (coll(c).has(doc.id)) throw new ApiError(409, "exists");
      const saved = { ...doc, __etag: 1 };
      coll(c).set(doc.id, saved);
      return structuredClone(saved);
    },
    async deleteDoc(c: string, id: string) { coll(c).delete(id); },
    // the organization's projects and teams (for the check of older storage names)
    async projects() { return Object.keys(teams).map((name) => ({ id: name, name })); },
    async teams(project: string) { return (teams[project] ?? []).map((name) => ({ id: name, name })); },
  } as unknown as Api;
  return { api, data, coll, fail, teams };
}

test("storage names: letters and digits stay, other characters never collapse", () => {
  assert.equal(storageName(["MyProject"]), "MyProject");
  assert.notEqual(storageName(["R&D"]), storageName(["R D"]));
  assert.notEqual(storageName(["R_D"]), storageName(["R D"]));
  assert.notEqual(collectionName("retro", "Web-App", "Core"), collectionName("retro", "Web", "App-Core"));
  assert.equal(collectionName("retro", "Proj", "Team1"), "retro-Proj-Team1");
  for (const s of ["R&D", "Проект", "a/b\\c", "x".repeat(300)]) assert.match(storageName(["kind", s, s]), /^[A-Za-z0-9_-]{1,100}$/);
  // long names end in a hash: still different
  assert.notEqual(storageName(["x".repeat(200) + "a"]), storageName(["x".repeat(200) + "b"]));
  assert.equal(storageName(["x".repeat(200)]).length, 100);
});

test("settings ids: old and new id, new ones do not collide", () => {
  assert.deepEqual(settingsDocIds("Plain"), { id: "project-Plain", legacy: "project-Plain" });
  const a = settingsDocIds("R&D");
  const b = settingsDocIds("R D");
  assert.equal(a.legacy, b.legacy);
  assert.notEqual(a.id, b.id);
});

test("shared settings: an old document is read, the next save goes to the new id", async () => {
  const { api, coll } = fakeDocs();
  const { id, legacy } = settingsDocIds("R&D");
  coll("settings").set(legacy, { id: legacy, __etag: 7, staleDays: 21 });
  const s = new Settings(api);
  await s.loadShared("R&D");
  assert.equal(s.shared.staleDays, 21);
  assert.equal(s.shared.id, id);
  await s.saveShared({ closedDays: 10 });
  assert.equal(coll("settings").get(id)?.staleDays, 21);
  assert.equal(coll("settings").get(id)?.closedDays, 10);
});

test("shared settings: a failed read blocks saving until a read works", async () => {
  const { api, coll, fail } = fakeDocs();
  const { id } = settingsDocIds("P");
  coll("settings").set(id, { id, __etag: 1, rules: [{ id: "r1" }] });
  fail.get = new ApiError(500, "server error");
  const s = new Settings(api);
  await s.loadShared("P");
  assert.equal(s.sharedReadFailed, true);
  await assert.rejects(s.saveShared({ staleDays: 3 }), (e: Error) => e.message === NOT_READ);
  assert.deepEqual(coll("settings").get(id)?.rules, [{ id: "r1" }]);
  fail.get = undefined;
  await s.loadShared("P");
  await s.saveShared({ staleDays: 3 });
  assert.equal(coll("settings").get(id)?.staleDays, 3);
});

test("shared settings: not found means defaults, and saving works", async () => {
  const { api, coll } = fakeDocs();
  const s = new Settings(api);
  await s.loadShared("P");
  assert.equal(s.sharedReadFailed, false);
  await s.saveShared({ staleDays: 5 });
  assert.equal(coll("settings").get("project-P")?.staleDays, 5);
});

test("shared settings: after a conflict the newer version is read, so the next save works", async () => {
  const { api, coll, fail } = fakeDocs();
  const s = new Settings(api);
  await s.loadShared("P");
  await s.saveShared({ staleDays: 5 });
  // someone else saves meanwhile
  coll("settings").set("project-P", { ...coll("settings").get("project-P")!, __etag: 9, closedDays: 60 });
  fail.set = [new ApiError(409, "version conflict")];
  await assert.rejects(s.saveShared({ staleDays: 6 }), /saved these settings at the same time/);
  assert.equal(s.shared.__etag, 9);
  assert.equal(s.shared.closedDays, 60);
  await s.saveShared({ staleDays: 6 });
  assert.equal(coll("settings").get("project-P")?.staleDays, 6);
});

test("personal settings: a failed read blocks saving", async () => {
  const { api, fail } = fakeDocs();
  fail.get = new ApiError(0, "network");
  const s = new Settings(api);
  await s.loadUser();
  await assert.rejects(s.saveUser({ lastTeam: "T" }), (e: Error) => e.message === NOT_READ);
});

test("team store: documents of the old collection are read, and written to the new one", async () => {
  const { api, coll } = fakeDocs();
  const name = collectionName("retro", "Web-App", "Core");
  const old = "retro-Web-App-Core";
  coll(old).set("n1", { id: "n1", __etag: 4, text: "old note" });
  const store = new TeamStore<{ id: string; __etag?: number; text: string }>(api, name);
  assert.deepEqual((await store.all()).map((d) => d.text), ["old note"]);
  const up = await store.update("n1", (d) => ({ ...d, text: "changed" }));
  assert.equal(up?.text, "changed");
  assert.equal(coll(name).get("n1")?.text, "changed");
  assert.deepEqual((await store.all()).map((d) => d.text), ["changed"]);
  await store.remove("n1");
  assert.deepEqual(await store.all(), []);
});

test("team store: update tries again only on a conflict", async () => {
  const { api, coll, fail } = fakeDocs();
  const name = collectionName("poker", "P", "T");
  coll(name).set("d", { id: "d", __etag: 1, n: 1 });
  const store = new TeamStore<{ id: string; __etag?: number; n: number }>(api, name);
  fail.set = [new ApiError(409, "conflict")];
  assert.equal((await store.update("d", (x) => ({ ...x, n: 2 })))?.n, 2);
  fail.set = [new ApiError(403, "forbidden"), new ApiError(403, "forbidden")];
  await assert.rejects(store.update("d", (x) => ({ ...x, n: 3 })), /forbidden/);
  assert.equal(fail.set.length, 1, "403 was not tried again");
});

test("team store: an older collection shared with another team is not read, copied or deleted", async () => {
  const { api, coll, teams } = fakeDocs();
  // "Team A" and "Team_A" had the same older collection name
  teams.Proj = ["Team A", "Team_A"];
  const name = collectionName("retro", "Proj", "Team A");
  coll("retro-Proj-Team_A").set("n1", { id: "n1", __etag: 2, text: "whose note?" });
  const store = new TeamStore<{ id: string; __etag?: number; text: string }>(api, name);
  assert.deepEqual(await store.all(), []);
  assert.equal(await store.get("n1"), null);
  await store.remove("n1");
  assert.equal(coll("retro-Proj-Team_A").has("n1"), true, "the other team's note stays");
  assert.equal(coll(name).size, 0);
});

test("team store: project and team names that run together are told apart", async () => {
  const { api, coll, teams } = fakeDocs();
  teams.Web = ["App-Core"]; // "Web" + "App-Core" gave the same older name as "Web-App" + "Core"
  const store = new TeamStore<{ id: string; __etag?: number; text: string }>(api, collectionName("retro", "Web-App", "Core"));
  coll("retro-Web-App-Core").set("n1", { id: "n1", __etag: 1, text: "x" });
  assert.deepEqual(await store.all(), []);
});

test("team store: a document nobody has yet is created only once; a second creator merges", async () => {
  const { api, coll } = fakeDocs();
  const name = collectionName("poker", "P", "T");
  const store = new TeamStore<{ id: string; __etag?: number; votes: string[] }>(api, name);
  const add = (v: string) => store.upsert("d", (doc) => ({ id: "d", votes: [...(doc?.votes ?? []), v] }));
  await Promise.all([add("ann"), add("bob")]);
  assert.deepEqual([...(coll(name).get("d")?.votes as string[])].sort(), ["ann", "bob"]);
});

test("shared settings: a missing or damaged part takes its default; good parts stay", async () => {
  const { api, coll } = fakeDocs();
  const { id } = settingsDocIds("P");
  coll("settings").set(id, {
    id, __etag: 4, rules: null, pillars: [{ id: "p1", name: "Growth" }, 5, null], epicPillars: [], staleDays: "soon", closedDays: 0,
    boardMode: "wall", checklists: { Story: ["a"] }, childTemplates: "x", healthChecks: {}, healthOff: ["stale", 3], pillarTagPrefix: 7, future: "kept",
  });
  const s = new Settings(api);
  await s.loadShared("P");
  const v = s.shared;
  assert.deepEqual(v.rules, []);
  assert.deepEqual(v.pillars, [{ id: "p1", name: "Growth" }]);
  assert.deepEqual(v.epicPillars, {});
  assert.equal(v.staleDays, 14);
  assert.equal(v.closedDays, 30);
  assert.equal(v.boardMode, "columns");
  assert.deepEqual(v.checklists, { Story: ["a"] });
  assert.deepEqual(v.childTemplates, {});
  assert.deepEqual(v.healthChecks, []);
  assert.deepEqual(v.healthOff, ["stale"]);
  assert.equal(v.pillarTagPrefix, "Pillar:");
  assert.equal(v.__etag, 4);
  assert.equal((v as unknown as { future: string }).future, "kept");
  // sensible days are kept, whole and at most a year
  const good = cleanShared({ staleDays: 21.4, closedDays: 900, boardMode: "states" }, id);
  assert.deepEqual([good.staleDays, good.closedDays, good.boardMode], [21, 365, "states"]);
  assert.equal(cleanShared(null, id).staleDays, 14);
});

test("team store: a document changed after our save is not removed", async () => {
  const { api, coll } = fakeDocs();
  const name = collectionName("poker", "P", "T");
  coll(name).set("d", { id: "d", __etag: 5 });
  const store = new TeamStore<{ id: string; __etag?: number }>(api, name);
  assert.equal(await store.removeIfUnchanged("d", 4), false);
  assert.equal(coll(name).has("d"), true);
  assert.equal(await store.removeIfUnchanged("d", 5), true);
  assert.equal(coll(name).has("d"), false);
});
