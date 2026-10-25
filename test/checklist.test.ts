import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, ExtensionDoc } from "../src/api/api.ts";
import { ApiError } from "../src/api/types.ts";
import { Checklists, cleanList, fromList, moveItem, newCheckItem, progress, tick } from "../src/core/checklist.ts";
import type { Facts, Rule } from "../src/core/rules.ts";
import { checklistProblem, missing } from "../src/core/rules.ts";

const facts = (p: Partial<Facts> = {}): Facts => ({
  kind: "requirement", description: "", acceptance: "", hasOwner: false, hasParent: false, hasEffort: false, inSprint: false,
  children: 0, openChildren: 0, openPrs: 0, openPredecessors: 0, tags: 0, me: "me@x.com", ...p,
});
/**
 * Extension storage in memory that checks versions like Azure DevOps: a save with an older __etag is
 * refused (409), -1 overwrites, createDoc refuses an id that exists. Every call waits a moment, so
 * two people's calls interleave.
 */
function storage(data = new Map<string, Map<string, ExtensionDoc>>()): Api {
  const coll = (c: string): Map<string, ExtensionDoc> => { if (!data.has(c)) data.set(c, new Map()); return data.get(c)!; };
  const tick = () => new Promise((r) => setTimeout(r, 1));
  return {
    async docs(c: string) { await tick(); return [...coll(c).values()].map((d) => structuredClone(d)); },
    async getDoc(c: string, id: string) { await tick(); const d = coll(c).get(id); return d ? structuredClone(d) : null; },
    async setDoc(c: string, doc: ExtensionDoc) {
      await tick();
      const cur = coll(c).get(doc.id);
      if (cur && doc.__etag !== -1 && doc.__etag !== cur.__etag) throw new ApiError(409, "conflict");
      const saved = { ...doc, __etag: (cur?.__etag ?? 0) + 1 };
      coll(c).set(doc.id, saved);
      return structuredClone(saved);
    },
    async createDoc(c: string, doc: ExtensionDoc) {
      await tick();
      if (coll(c).has(doc.id)) throw new ApiError(409, "exists");
      const saved = { ...doc, __etag: 1 };
      coll(c).set(doc.id, saved);
      return structuredClone(saved);
    },
    async deleteDoc(c: string, id: string) { await tick(); coll(c).delete(id); },
  } as unknown as Api;
}

const rule: Rule = { id: "r", level: "requirement", target: "Closed", requires: ["checklistDone"], onlyBy: [] };

test("checklist done: every item ticked", () => {
  assert.deepEqual(missing(rule, facts({ checklist: { done: 3, total: 3 } })), []);
  assert.deepEqual(missing(rule, facts({ checklist: { done: 1, total: 3 }, checklistDefault: 2 })), ["Checklist done (2 of 3 not ticked)"]);
});

test("no checklist passes, unless the team has a list for the type", () => {
  assert.equal(checklistProblem({}), null, "not looked at");
  assert.equal(checklistProblem({ checklist: { done: 0, total: 0 } }), null);
  assert.equal(checklistProblem({ checklist: { done: 0, total: 0 }, checklistDefault: 0 }), null);
  assert.match(checklistProblem({ checklist: { done: 0, total: 0 }, checklistDefault: 4 }) ?? "", /no checklist yet/);
  assert.match(checklistProblem({ checklistDefault: 4 }) ?? "", /no checklist yet/);
  assert.equal(checklistProblem({ checklist: { done: 2, total: 2 }, checklistDefault: 4 }), null, "the item's own list counts, not the team's");
});

test("a checklist that could not be read is not done", () => {
  assert.equal(checklistProblem({ checklist: null }), "could not be read");
  assert.deepEqual(missing(rule, facts({ checklist: null })), ["Checklist done (could not be read)"]);
});

test("lists are trimmed, without empty or repeated items", () => {
  assert.deepEqual(cleanList(["  Tests pass ", "", "tests  PASS", "Docs  updated", "   "]), ["Tests pass", "Docs updated"]);
  assert.deepEqual(cleanList(undefined), []);
  const items = fromList(["A", "B", "a"]);
  assert.deepEqual(items.map((i) => [i.text, i.done]), [["A", false], ["B", false]]);
  assert.notEqual(items[0].id, items[1].id);
});

test("tick, untick, move and count", () => {
  let items = fromList(["A", "B", "C"]);
  const [a, b, c] = items.map((i) => i.id);
  items = tick(items, b, true, "me@x.com", "2026-10-22T10:00:00Z");
  assert.deepEqual(items[1], { id: b, text: "B", done: true, by: "me@x.com", at: "2026-10-22T10:00:00Z" });
  assert.deepEqual(progress(items), { done: 1, total: 3 });
  items = tick(items, b, false, "me@x.com");
  assert.deepEqual(items[1], { id: b, text: "B", done: false }, "unticking forgets who ticked");
  assert.deepEqual(moveItem(items, c, -1).map((i) => i.id), [a, c, b]);
  assert.deepEqual(moveItem(items, a, -1).map((i) => i.id), [a, b, c], "the first cannot move up");
  assert.deepEqual(moveItem(items, c, 1).map((i) => i.id), [a, b, c], "the last cannot move down");
  assert.deepEqual(progress(undefined), { done: 0, total: 0 });
});

test("checklists are kept per work item in one collection per project; an empty one is removed", async () => {
  const data = new Map<string, Map<string, ExtensionDoc>>();
  const coll = (c: string): Map<string, ExtensionDoc> => { if (!data.has(c)) data.set(c, new Map()); return data.get(c)!; };
  const api = storage(data);
  const lists = new Checklists(api, "My Project");
  assert.deepEqual(await lists.get(7), []);
  const one = newCheckItem("Tests pass");
  await lists.change(7, (xs) => [...xs, one], "me@x.com");
  assert.deepEqual([...data.keys()], ["checklist-My_0020Project"]);
  assert.deepEqual((await lists.get(7)).map((x) => x.text), ["Tests pass"]);
  assert.deepEqual(lists.cached(7)?.map((x) => x.text), ["Tests pass"]);
  await lists.change(7, (xs) => tick(xs, one.id, true, "me@x.com"), "me@x.com");
  assert.equal(coll("checklist-My_0020Project").get("7")?.changedBy, "me@x.com");
  assert.deepEqual(progress(await lists.get(7)), { done: 1, total: 1 });
  await lists.change(7, () => [], "me@x.com");
  assert.equal(coll("checklist-My_0020Project").has("7"), false);
  assert.deepEqual(await lists.get(7), []);
});

test("two people starting a checklist at once: both items are kept", async () => {
  const api = storage();
  const a = new Checklists(api, "P");
  const b = new Checklists(api, "P");
  await Promise.all([
    a.change(7, (xs) => [...xs, newCheckItem("Tests pass")], "ann@x.com"),
    b.change(7, (xs) => [...xs, newCheckItem("Docs updated")], "bob@x.com"),
  ]);
  assert.deepEqual((await a.get(7)).map((x) => x.text).sort(), ["Docs updated", "Tests pass"]);
});

test("emptying a checklist while someone adds to it keeps the added item", async () => {
  const api = storage();
  const a = new Checklists(api, "P");
  const b = new Checklists(api, "P");
  const one = newCheckItem("Old");
  await a.change(7, () => [one], "ann@x.com");
  await Promise.all([
    a.change(7, (xs) => xs.filter((x) => x.id !== one.id), "ann@x.com"),
    b.change(7, (xs) => [...xs, newCheckItem("New")], "bob@x.com"),
  ]);
  assert.deepEqual((await a.get(7)).map((x) => x.text), ["New"]);
});
