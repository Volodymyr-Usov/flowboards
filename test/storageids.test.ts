// Storage kept by the ids of projects and teams (a rename keeps it), the copy from the name-keyed storage,
// and the shared settings' first save, refresh and rule checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, ExtensionDoc } from "../src/api/api.ts";
import { ApiError } from "../src/api/types.ts";
import { cleanRule, cleanShared, Settings, settingsDocIds, sharedDocIds } from "../src/core/settings.ts";
import { collectionName, copyOnce, forgetIds, MOVED_DOC, projectCollectionName, rememberIds, TeamStore } from "../src/core/teamstore.ts";
import { forgetTeam, retryDelay, storageIds } from "../src/app/app.ts";

const PID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** Extension storage in memory, with counters and switches to refuse writes. */
function fakeDocs() {
  const data = new Map<string, Map<string, ExtensionDoc>>();
  const calls = { creates: 0, sets: 0, deletes: 0 };
  const opts: { refuseWrites?: ApiError; failCreatesAfter?: number } = {};
  const teams: Record<string, string[]> = { "Web-App": ["Core"], P: ["T"], Proj: ["Team A"] };
  const coll = (c: string): Map<string, ExtensionDoc> => {
    if (!data.has(c)) data.set(c, new Map());
    return data.get(c)!;
  };
  const api = {
    async docs(c: string) { return [...coll(c).values()].map((d) => structuredClone(d)); },
    async getDoc(c: string, id: string) { const d = coll(c).get(id); return d ? structuredClone(d) : null; },
    async setDoc(c: string, doc: ExtensionDoc) {
      if (opts.refuseWrites) throw opts.refuseWrites;
      calls.sets++;
      const cur = coll(c).get(doc.id);
      if (cur && doc.__etag != null && doc.__etag !== -1 && doc.__etag !== cur.__etag) throw new ApiError(409, "conflict");
      const saved = { ...doc, __etag: (cur?.__etag ?? 0) + 1 };
      coll(c).set(doc.id, saved);
      return structuredClone(saved);
    },
    async createDoc(c: string, doc: ExtensionDoc) {
      if (opts.refuseWrites) throw opts.refuseWrites;
      if (opts.failCreatesAfter !== undefined && calls.creates >= opts.failCreatesAfter) throw new ApiError(0, "no answer");
      calls.creates++;
      if (coll(c).has(doc.id)) throw new ApiError(409, "exists");
      const saved = { ...doc, __etag: 1 };
      coll(c).set(doc.id, saved);
      return structuredClone(saved);
    },
    async deleteDoc(c: string, id: string) { if (opts.refuseWrites) throw opts.refuseWrites; calls.deletes++; coll(c).delete(id); },
    async projects() { return Object.keys(teams).map((name) => ({ id: name, name })); },
    async teams(project: string) { return (teams[project] ?? []).map((name) => ({ id: name, name })); },
  } as unknown as Api;
  return { api, data, coll, calls, opts, teams };
}

type Note = { id: string; __etag?: number; text: string };

test("storage by id: the team's documents under its names are copied once to the id-keyed collection; the old ones stay", async () => {
  forgetIds();
  const { api, coll, calls } = fakeDocs();
  const byName = collectionName("retro", "P", "T");
  coll(byName).set("n1", { id: "n1", __etag: 3, text: "one" });
  coll(byName).set("n2", { id: "n2", __etag: 8, text: "two" });
  rememberIds("P", PID, "T", TID);
  const byId = collectionName("retro", "P", "T");
  assert.notEqual(byId, byName);
  assert.match(byId, /^retro-id-[0-9a-f]{32}-[0-9a-f]{32}$/);
  const store = new TeamStore<Note>(api, byId);
  assert.deepEqual((await store.all()).map((d) => d.text).sort(), ["one", "two"]);
  assert.equal(coll(byId).has(MOVED_DOC), true, "the copy is marked done");
  assert.equal(coll(byName).size, 2, "the old documents are never deleted");
  assert.ok((await store.all()).every((d) => d.id !== MOVED_DOC), "the marker is not one of the documents");
  // a later change goes to the new place only, and the copy does not run again
  const creates = calls.creates;
  await store.update("n1", (d) => ({ ...d, text: "changed" }));
  await new TeamStore<Note>(api, byId).all();
  assert.equal(calls.creates, creates);
  assert.equal(coll(byId).get("n1")?.text, "changed");
  assert.equal(coll(byName).get("n1")?.text, "one");
  // a deleted document does not come back from the old collection
  await store.remove("n2");
  assert.deepEqual((await new TeamStore<Note>(api, byId).all()).map((d) => d.id), ["n1"]);
  assert.equal(coll(byName).has("n2"), true);
  forgetIds();
});

test("storage by id: a renamed team keeps its documents (same ids, other names)", async () => {
  forgetIds();
  const { api } = fakeDocs();
  rememberIds("P", PID, "T", TID);
  await new TeamStore<Note>(api, collectionName("poker", "P", "T")).put({ id: "v", text: "vote" });
  forgetIds();
  rememberIds("P renamed", PID, "T renamed", TID);
  assert.deepEqual((await new TeamStore<Note>(api, collectionName("poker", "P renamed", "T renamed")).all()).map((d) => d.text), ["vote"]);
  forgetIds();
});

test("storage by id: a copy cut short is finished next time, without doubles and without overwriting", async () => {
  forgetIds();
  const { api, coll, opts } = fakeDocs();
  const byName = collectionName("events", "P", "T");
  for (let i = 1; i <= 5; i++) coll(byName).set(`e${i}`, { id: `e${i}`, __etag: 1, text: `old ${i}` });
  rememberIds("P", PID, "T", TID);
  const byId = collectionName("events", "P", "T");
  opts.failCreatesAfter = 2;
  await assert.rejects(copyOnce(api, byId, byName), /no answer/);
  assert.equal(coll(byId).has(MOVED_DOC), false, "not marked done");
  // meanwhile someone changed one copied document in the new place
  const first = [...coll(byId).keys()][0];
  coll(byId).set(first, { ...coll(byId).get(first)!, text: "newer" });
  opts.failCreatesAfter = undefined;
  const all = await new TeamStore<Note>(api, byId).all();
  assert.equal(all.length, 5);
  assert.equal(all.find((d) => d.id === first)?.text, "newer", "a document already there is not overwritten");
  assert.equal(coll(byId).has(MOVED_DOC), true);
  forgetIds();
});

test("storage by id: when the copy cannot be made (read-only), the old documents are still shown", async () => {
  forgetIds();
  const { api, coll, opts } = fakeDocs();
  const byName = collectionName("retro", "P", "T");
  coll(byName).set("n1", { id: "n1", __etag: 2, text: "old" });
  rememberIds("P", PID, "T", TID);
  const byId = collectionName("retro", "P", "T");
  opts.refuseWrites = new ApiError(403, "Read-only");
  const store = new TeamStore<Note>(api, byId);
  assert.deepEqual((await store.all()).map((d) => d.text), ["old"]);
  assert.equal((await store.get("n1"))?.text, "old");
  assert.equal(coll(byId).size, 0, "nothing written");
  assert.equal(coll(byName).size, 1);
  forgetIds();
});

test("storage by id: two pages copying at the same time make each document once", async () => {
  forgetIds();
  const { api, coll } = fakeDocs();
  const byName = collectionName("schedules", "P", "T");
  for (let i = 1; i <= 4; i++) coll(byName).set(`s${i}`, { id: `s${i}`, __etag: 1, text: `s${i}` });
  rememberIds("P", PID, "T", TID);
  const byId = collectionName("schedules", "P", "T");
  await Promise.all([copyOnce(api, byId, byName), copyOnce(api, byId, byName)]);
  assert.equal(coll(byId).size, 5, "four documents and the marker");
  forgetIds();
});

test("storage by id: the oldest names (before names were made unique) still come along when only ours", async () => {
  forgetIds();
  const { api, coll } = fakeDocs();
  // the oldest name of the "Web-App"/"Core" retro collection
  coll("retro-Web-App-Core").set("n1", { id: "n1", __etag: 1, text: "very old" });
  rememberIds("Web-App", PID, "Core", TID);
  const store = new TeamStore<Note>(api, collectionName("retro", "Web-App", "Core"));
  assert.deepEqual((await store.all()).map((d) => d.text), ["very old"]);
  assert.equal(coll("retro-Web-App-Core").size, 1, "kept");
  forgetIds();
});

test("storage by id: an oldest name another team could have had is not copied", async () => {
  forgetIds();
  const { api, coll, teams } = fakeDocs();
  teams.Proj = ["Team A", "Team_A"];
  coll("retro-Proj-Team_A").set("n1", { id: "n1", __etag: 2, text: "whose note?" });
  rememberIds("Proj", PID, "Team A", TID);
  const byId = collectionName("retro", "Proj", "Team A");
  assert.deepEqual(await new TeamStore<Note>(api, byId).all(), []);
  forgetIds();
});

test("storage by id: a project's checklists move to the project's id", async () => {
  forgetIds();
  const { api, coll } = fakeDocs();
  coll(projectCollectionName("checklist", "P")).set("12", { id: "12", __etag: 1, text: "x" });
  rememberIds("P", PID);
  const byId = projectCollectionName("checklist", "P");
  assert.equal(byId, "checklist-id-" + PID.replace(/-/g, ""));
  assert.equal((await new TeamStore<Note>(api, byId).get("12"))?.text, "x");
  assert.equal(coll(byId).get("12")?.text, "x");
  forgetIds();
});

test("storage by id: without the ids the names are used, as before", () => {
  forgetIds();
  assert.equal(collectionName("retro", "Proj", "Team1"), "retro-Proj-Team1");
  rememberIds("Proj", PID); // the project alone is not enough for a team's collection
  assert.equal(collectionName("retro", "Proj", "Team1"), "retro-Proj-Team1");
  forgetIds();
});

test("shared settings by the project's id: the one under the name is copied once, and stays", async () => {
  forgetIds();
  const { api, coll } = fakeDocs();
  const old = settingsDocIds("P").id;
  coll("settings").set(old, { id: old, __etag: 5, staleDays: 21 });
  rememberIds("P", PID, "T", TID);
  const { id } = sharedDocIds("P", PID);
  assert.equal(id, "project-id-" + PID.replace(/-/g, ""));
  const s = new Settings(api);
  await s.loadShared("P");
  assert.equal(s.shared.staleDays, 21);
  assert.equal(s.shared.id, id);
  assert.equal(coll("settings").get(id)?.staleDays, 21, "copied");
  assert.equal(coll("settings").get(old)?.staleDays, 21, "the old one stays");
  await s.saveShared({ closedDays: 9 });
  assert.equal(coll("settings").get(id)?.closedDays, 9);
  assert.equal(coll("settings").get(old)?.closedDays, undefined, "saves go to the new id only");
  forgetIds();
});

test("shared settings: the first save creates the document only when nobody did meanwhile; then the change goes on theirs", async () => {
  forgetIds();
  const { api, coll } = fakeDocs();
  const s = new Settings(api);
  await s.loadShared("P");
  // a teammate saves the first settings of the project after this page read them
  const realGet = api.getDoc.bind(api);
  let reads = 0;
  (api as unknown as { getDoc: typeof api.getDoc }).getDoc = async (c, id, scope) => {
    // the read just before our save does not see theirs yet: it lands between our read and our create
    if (++reads === 1) { const r = await realGet(c, id, scope); coll("settings").set("project-P", { id: "project-P", __etag: 1, pillars: [{ id: "p1", name: "Growth" }] }); return r; }
    return realGet(c, id, scope);
  };
  await s.saveShared({ staleDays: 5 });
  const doc = coll("settings").get("project-P")!;
  assert.equal(doc.staleDays, 5);
  assert.deepEqual(doc.pillars, [{ id: "p1", name: "Growth" }], "the teammate's first save is kept");
  forgetIds();
});

test("shared settings: a teammate's change to another part stays; to the same part it is a conflict", async () => {
  forgetIds();
  const { api, coll } = fakeDocs();
  coll("settings").set("project-P", { id: "project-P", __etag: 1, staleDays: 10 });
  const s = new Settings(api);
  await s.loadShared("P");
  coll("settings").set("project-P", { ...coll("settings").get("project-P")!, __etag: 2, closedDays: 60 });
  await s.saveShared({ staleDays: 7 });
  assert.equal(coll("settings").get("project-P")?.closedDays, 60);
  assert.equal(coll("settings").get("project-P")?.staleDays, 7);
  coll("settings").set("project-P", { ...coll("settings").get("project-P")!, __etag: 9, staleDays: 3 });
  await assert.rejects(s.saveShared({ staleDays: 8 }), /saved these settings at the same time/);
  assert.equal(coll("settings").get("project-P")?.staleDays, 3, "theirs is not overwritten unseen");
  assert.equal(s.shared.staleDays, 3, "and this page now shows theirs");
  await s.saveShared({ staleDays: 8 });
  assert.equal(coll("settings").get("project-P")?.staleDays, 8);
  forgetIds();
});

test("shared settings are read again: the pages hear of it only when something changed", async () => {
  forgetIds();
  const { api, coll } = fakeDocs();
  coll("settings").set("project-P", { id: "project-P", __etag: 1, staleDays: 10 });
  const s = new Settings(api);
  await s.loadShared("P");
  let heard = 0;
  s.onChange(() => heard++);
  await s.refreshShared();
  assert.equal(heard, 0);
  coll("settings").set("project-P", { id: "project-P", __etag: 2, staleDays: 10, rules: [{ id: "r", level: "*", target: "Done", requires: ["owner"], onlyBy: [] }] });
  await s.refreshShared();
  assert.equal(heard, 1);
  assert.equal(s.shared.rules.length, 1);
  assert.equal(s.shared.__etag, 2);
  forgetIds();
});

test("personal settings: a conflict says it came from the person's own other tab", async () => {
  const { api, coll } = fakeDocs();
  coll("user").set("prefs", { id: "prefs", __etag: 1 });
  const s = new Settings(api);
  await s.loadUser();
  coll("user").set("prefs", { id: "prefs", __etag: 2 });
  (api as unknown as { setDoc: typeof api.setDoc }).setDoc = async () => { throw new ApiError(409, "conflict"); };
  await assert.rejects(s.saveUser({ lastTeam: "T" }), /Your settings were changed in another tab; reload\./);
});

test("stored rules: damaged ones are left out or repaired, so no move breaks", () => {
  assert.equal(cleanRule(null), null);
  assert.equal(cleanRule("x"), null);
  assert.equal(cleanRule({ level: "*", requires: [] }), null, "no column or state");
  assert.equal(cleanRule({ level: "everything", target: "Done" }), null, "no known level");
  const r = cleanRule({ id: "r1", level: "requirement", target: " Done ", requires: "owner", onlyBy: [5, "ann@x.example", ""], fields: "x", from: 3, note: 7, breaks: "yes", extra: "kept" }, 2)!;
  assert.deepEqual(r, { id: "r1", level: "requirement", target: "Done", requires: [], onlyBy: ["ann@x.example"], fields: [], extra: "kept" });
  const known = cleanRule({ level: "task", target: "Closed", requires: ["owner", "flying", 3], onlyBy: null }, 4)!;
  assert.deepEqual(known.requires, ["owner"], "a requirement this version does not know is left out");
  assert.deepEqual(known.onlyBy, []);
  assert.equal(known.id, "rule-5");
  const good = { id: "g", level: "*", target: "Done", from: "Review", requires: ["owner"], onlyBy: ["bo@x.example"], note: "n", breaks: true, fields: ["System.Title"] };
  assert.deepEqual(cleanRule(good), good, "a good rule stays as it is");
  const s = cleanShared({ rules: [good, { target: 1 }, null, { level: "*", target: "Ready" }] as never }, "x");
  assert.deepEqual(s.rules.map((x) => x.target), ["Done", "Ready"]);
  assert.deepEqual(s.rules[1].requires, []);
  assert.deepEqual(s.rules[1].onlyBy, []);
});

test("the ids for storage: from the host when it shows this team, else from the team list, else the last ones kept", async () => {
  let teamsAsked = 0;
  const api = {
    async teams() { teamsAsked++; return [{ id: TID, name: "T", projectId: PID }]; },
    async projects() { return [{ id: PID, name: "P" }]; },
  };
  const host = { project: { id: PID, name: "P" }, team: { id: TID, name: "T" } };
  assert.deepEqual(await storageIds(api, host, "P", "T"), { projectId: PID, teamId: TID });
  assert.equal(teamsAsked, 0, "the host knew");
  assert.deepEqual(await storageIds(api, host, "P", "Other"), {}, "another team of the project is not in the list");
  assert.deepEqual(await storageIds(api, null, "P", "T"), { projectId: PID, teamId: TID });
  let kept: { projectId: string; teamId: string } | undefined;
  const cache = { get: () => kept, set: (v: { projectId: string; teamId: string }) => { kept = v; } };
  await storageIds(api, null, "P", "T", undefined, cache);
  assert.deepEqual(kept, { projectId: PID, teamId: TID });
  const down = { async teams(): Promise<never> { throw new Error("no answer"); }, async projects(): Promise<never> { throw new Error("no answer"); } };
  assert.deepEqual(await storageIds(down, null, "P", "T", undefined, cache), { projectId: PID, teamId: TID }, "the last ones kept");
  assert.deepEqual(await storageIds(down, null, "P", "T"), {}, "none known: by the names");
  // a team list without project ids: the project's id from the project list
  const noPid = { async teams() { return [{ id: TID, name: "T" }]; }, async projects() { return [{ id: PID, name: "P" }]; } };
  assert.deepEqual(await storageIds(noPid, null, "P", "T"), { projectId: PID, teamId: TID });
});

test("a saved team that is gone is forgotten for its project only", () => {
  const saved = { project: "P", team: "T", byProject: { P: "T", Q: "U" }, next: { project: "P", team: "T" } };
  assert.deepEqual(forgetTeam(saved, "P"), { project: "P", byProject: { Q: "U" } });
  assert.deepEqual(forgetTeam(saved, "Q"), { project: "P", team: "T", byProject: { P: "T" }, next: { project: "P", team: "T" } });
});

test("errors in a row wait longer: 30 s, 1 min, 2 min, then at most 5 min", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(retryDelay), [30_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
});
