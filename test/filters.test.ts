import { test } from "node:test";
import assert from "node:assert/strict";
import type { Person, WorkItem } from "../src/api/types.ts";
import {
  BASE_PROPS, cleanFilters, cleanPeople, countPeople, describe, fieldProps, isActive, keyOfPerson, NOBODY, passes, passesAll, personPasses, searchWords, textMatch, togglePerson, valueCounts,
} from "../src/core/filters.ts";

const item = (over: Partial<WorkItem>): WorkItem => ({
  id: 1, rev: 1, type: "User Story", title: "t", state: "Active", category: "InProgress", area: "P\\Team", iteration: "P\\Sprint 4",
  tags: [], created: "2026-09-01T10:00:00Z", changed: "2026-10-01T10:00:00Z", fields: {}, ...over,
});
const props = new Map(BASE_PROPS.map((p) => [p.id, p]));
const P = (id: string) => props.get(id)!;

test("set filters: any of, none of, empty values and tags", () => {
  const a = item({ state: "Active", tags: ["ui", "quick"] });
  const b = item({ state: "New", tags: [] });
  assert.equal(passes(a, { prop: "state", values: ["Active", "New"] }, P("state")), true);
  assert.equal(passes(a, { prop: "state", op: "none", values: ["Active"] }, P("state")), false);
  assert.equal(passes(a, { prop: "tags", values: ["quick"] }, P("tags")), true);
  assert.equal(passes(b, { prop: "tags", values: [""] }, P("tags")), true, "no tags matches (empty)");
  assert.equal(passes(b, { prop: "owner", values: [""] }, P("owner")), true, "nobody matches (empty)");
  assert.equal(passes(a, { prop: "sprint", values: ["Sprint 4"] }, P("sprint")), true);
  assert.equal(passes(a, { prop: "state", values: [] }, P("state")), true, "an unset filter lets everything pass");
});

test("number, date and yes/no filters", () => {
  const w = item({ effort: 5, closed: "2026-10-10T08:00:00Z", description: "<p>Some text</p>" });
  assert.equal(passes(w, { prop: "effort", min: 3, max: 5 }, P("effort")), true);
  assert.equal(passes(w, { prop: "effort", min: 6 }, P("effort")), false);
  assert.equal(passes(item({}), { prop: "effort", max: 3 }, P("effort")), false, "no estimate fails a range");
  assert.equal(passes(w, { prop: "closed", from: "2026-10-10", to: "2026-10-10" }, P("closed")), true, "both ends included");
  assert.equal(passes(w, { prop: "closed", to: "2026-10-09" }, P("closed")), false);
  assert.equal(passes(w, { prop: "hasDesc", is: true }, P("hasDesc")), true);
  assert.equal(passes(item({ description: "<p> </p>" }), { prop: "hasDesc", is: true }, P("hasDesc")), false);
  assert.equal(passesAll(w, [{ prop: "effort", min: 1 }, { prop: "state", values: ["New"] }], props), false);
});

test("extra fields become properties typed by their values", () => {
  const items = [
    item({ fields: { "Custom.Risk": "High", "Custom.Score": 3, "Custom.Due": "2026-11-02T00:00:00Z", "Custom.Ok": true } }),
    item({ fields: { "Custom.Risk": "Low", "Custom.Score": 8 } }),
  ];
  const fp = new Map(fieldProps(items, { "Custom.Risk": "Risk level" }).map((p) => [p.id, p]));
  assert.equal(fp.get("field:Custom.Risk")!.kind, "set");
  assert.equal(fp.get("field:Custom.Risk")!.label, "Risk level");
  assert.equal(fp.get("field:Custom.Score")!.kind, "number");
  assert.equal(fp.get("field:Custom.Due")!.kind, "date");
  assert.equal(fp.get("field:Custom.Ok")!.kind, "bool");
  assert.equal(passes(items[0], { prop: "field:Custom.Score", min: 5 }, fp.get("field:Custom.Score")), false);
  assert.equal(passes(items[1], { prop: "field:Custom.Due", from: "2026-01-01" }, fp.get("field:Custom.Due")), false, "no value fails a date range");
  assert.deepEqual(valueCounts(items, fp.get("field:Custom.Risk")!).map((x) => x.value), ["High", "Low"]);
});

test("chip text", () => {
  assert.equal(describe({ prop: "state", values: ["Active", "New"] }, P("state")), "State: Active, New");
  assert.equal(describe({ prop: "state", op: "none", values: ["Closed"] }, P("state")), "State is not Closed");
  assert.equal(describe({ prop: "owner", values: ["", "A", "B", "C"] }, P("owner")), "Owner: (empty), A and 2 more");
  assert.equal(describe({ prop: "effort", min: 3 }, P("effort")), "Effort: 3 or more");
  assert.equal(describe({ prop: "hasAc", is: false }, P("hasAc")), "Has acceptance criteria: no");
});

test("saved filters: damaged entries are left out, damaged parts dropped", () => {
  const got = cleanFilters([
    null, 3, "state", [], { values: ["x"] }, { prop: "" },
    { prop: "state", op: "bad", values: ["Active", 4, null] },
    { prop: "effort", min: "3", max: 8, from: "yesterday", to: "2026-10-31", is: "yes" },
    { prop: "hasDesc", is: false },
  ]);
  assert.deepEqual(got, [
    { prop: "state", values: ["Active"] },
    { prop: "effort", max: 8, to: "2026-10-31" },
    { prop: "hasDesc", is: false },
  ]);
  assert.deepEqual(cleanFilters({ prop: "state" }), [], "not a list");
  assert.deepEqual(cleanFilters(undefined), []);
  // a cleaned filter with values that are not text cannot break the check
  assert.equal(passes(item({}), cleanFilters([{ prop: "state", values: "Active" }])[0], P("state")), true);
  assert.equal(isActive(cleanFilters([{ prop: "state", values: "Active" }])[0], P("state")), false);
});

const ann: Person = { displayName: "Ann Lee", uniqueName: "ann@example.com" };
const bob: Person = { displayName: "Bob Ray", uniqueName: "bob@example.com" };
const cy: Person = { displayName: "Cy Moe", uniqueName: "cy@example.com" };

test("person filters: only, hide, nobody, and saved values", () => {
  const a = keyOfPerson(ann);
  const b = keyOfPerson(bob);
  assert.equal(keyOfPerson(undefined), NOBODY);
  let pick = { only: [] as string[], hidden: [] as string[] };
  assert.equal(personPasses(a, pick), true, "no filter lets everyone pass");
  pick = togglePerson(pick, a, "only");
  assert.deepEqual(pick, { only: [a], hidden: [] });
  assert.equal(personPasses(b, pick), false);
  assert.equal(personPasses(NOBODY, pick), false);
  pick = togglePerson(pick, b, "hide");
  pick = togglePerson(pick, a, "hide");
  assert.deepEqual(pick, { only: [], hidden: [b, a] }, "hiding takes a person out of only");
  assert.equal(personPasses(a, pick), false);
  assert.equal(personPasses(NOBODY, pick), true);
  pick = togglePerson(pick, b, "only");
  assert.deepEqual(pick, { only: [b], hidden: [a] }, "only shows a hidden person again");
  pick = togglePerson(pick, b, "only");
  assert.deepEqual(pick, { only: [], hidden: [a] }, "a second click stops it");
  assert.deepEqual(cleanPeople({ only: ["x", 3, ""], hidden: "y" }), { only: ["x"], hidden: [] });
  assert.deepEqual(cleanPeople(null), { only: [], hidden: [] });
  assert.deepEqual(cleanPeople([1, 2]), { only: [], hidden: [] });
});

test("people counts: nobody first, then the most, then by name; extra people with 0", () => {
  const items = [item({ id: 1, assignedTo: bob }), item({ id: 2, assignedTo: ann }), item({ id: 3, assignedTo: bob }), item({ id: 4 }), item({ id: 5, assignedTo: { ...ann, displayName: "Ann L." } })];
  const got = countPeople(items, undefined, [cy, bob]);
  assert.deepEqual(got.map((c) => [c.key, c.n]), [[NOBODY, 1], [keyOfPerson(ann), 2], [keyOfPerson(bob), 2], [keyOfPerson(cy), 0]]);
  assert.equal(got[3].person, cy);
  const byCreator = countPeople([item({ createdBy: cy })], (w) => w.createdBy);
  assert.deepEqual(byCreator.map((c) => c.key), [keyOfPerson(cy)]);
});

test("search: every word, in id, title, tags, owner, state, sprint or extra text", () => {
  const w = item({ id: 42, title: "Consent banner", tags: ["Legal"], assignedTo: ann, state: "Active" });
  assert.deepEqual(searchWords("  Consent   #42 "), ["consent", "#42"]);
  assert.equal(textMatch(searchWords("consent #42"), w), true);
  assert.equal(textMatch(searchWords("legal ann active sprint 4"), w), true);
  assert.equal(textMatch(searchWords("banner cookie"), w), false, "every word must match");
  assert.equal(textMatch(searchWords("cookie"), w, "Cookie feature"), true, "extra text counts");
  assert.equal(textMatch([], w), true);
});

test("an extra field is offered only when every item was read with it", () => {
  const listRead = ["System.Title", "Custom.Score"];
  const items = [
    item({ id: 1, fields: { "Custom.Score": 3 }, fieldsRead: listRead }),
    item({ id: 2, fields: {}, fieldsRead: listRead }), // read with the field, no value: really empty
    item({ id: 3, fields: { "Custom.Score": 5, "Custom.Risk": "High" } }), // read in full (the panel, after a save)
  ];
  const fp = new Map(fieldProps(items).map((p) => [p.id, p]));
  assert.ok(fp.has("field:Custom.Score"));
  assert.equal(fp.has("field:Custom.Risk"), false, "only item 3 was read with it: the others would wrongly count as empty");
  // every item read in full: offered
  assert.ok(fieldProps([item({ fields: { "Custom.Risk": "High" } }), item({ fields: {} })]).some((p) => p.id === "field:Custom.Risk"));
});

import { goneLabel, sameValue, teamKey, upgradeFilters, valueLabels } from "../src/core/filters.ts";

test("people match by sign-in (two people can share a name); filters saved with names still match", () => {
  const ann2: Person = { displayName: "Ann Lee", uniqueName: "ann.lee@other.example" };
  const a = item({ id: 1, assignedTo: ann, createdBy: bob, changedBy: cy });
  const b = item({ id: 2, assignedTo: ann2 });
  const k = keyOfPerson(ann);
  assert.equal(passes(a, { prop: "owner", values: [k] }, P("owner")), true);
  assert.equal(passes(b, { prop: "owner", values: [k] }, P("owner")), false, "the other Ann Lee is someone else");
  assert.equal(passes(a, { prop: "createdBy", values: [keyOfPerson(bob)] }, P("createdBy")), true);
  assert.equal(passes(a, { prop: "changedBy", op: "none", values: [keyOfPerson(cy)] }, P("changedBy")), false);
  // an older filter holds the name: it keeps working
  assert.equal(passes(a, { prop: "owner", values: ["Ann Lee"] }, P("owner")), true);
  assert.equal(passes(item({}), { prop: "owner", values: [""] }, P("owner")), true, "nobody is still (empty)");
  // the list shows names, the values are sign-ins
  const counts = valueCounts([a, b, item({ id: 3 })], P("owner"));
  assert.deepEqual(counts.map((c) => [c.value, c.label]), [["", ""], [k, "Ann Lee"], ["ann.lee@other.example", "Ann Lee"]]);
  assert.equal(describe({ prop: "owner", values: [k] }, P("owner"), (v) => valueLabels([a], P("owner")).get(v) ?? v), "Owner: Ann Lee");
});

test("sprints match by their full path and show their name; tags match whatever their case", () => {
  const a = item({ iteration: "P\\Team A\\Sprint 4" });
  const b = item({ iteration: "P\\Team B\\Sprint 4" });
  assert.equal(passes(a, { prop: "sprint", values: ["P\\Team A\\Sprint 4"] }, P("sprint")), true);
  assert.equal(passes(b, { prop: "sprint", values: ["P\\Team A\\Sprint 4"] }, P("sprint")), false, "another team's Sprint 4");
  assert.equal(passes(b, { prop: "sprint", values: ["Sprint 4"] }, P("sprint")), true, "a filter saved with the name still matches");
  assert.equal(valueCounts([a], P("sprint"))[0].label, "Sprint 4");
  const t = item({ tags: ["UI", "Quick"] });
  assert.equal(passes(t, { prop: "tags", values: ["ui"] }, P("tags")), true);
  assert.equal(passes(t, { prop: "tags", op: "none", values: ["quick"] }, P("tags")), false);
  assert.equal(sameValue(P("tags"), "UI", "ui"), true);
  assert.equal(sameValue(P("state"), "Active", "active"), false);
  const counts = valueCounts([t, item({ tags: ["ui"] })], P("tags"));
  assert.deepEqual(counts.map((c) => [c.value, c.n]), [["UI", 2], ["Quick", 1]], "one value for both spellings");
});

test("filters saved with names become sign-ins and paths; a gone field says so", () => {
  const items = [item({ id: 1, assignedTo: ann, iteration: "P\\A\\Sprint 4" }), item({ id: 2, iteration: "P\\B\\Sprint 4" })];
  const old = [{ prop: "owner", values: ["Ann Lee", "Nobody here", ""] }, { prop: "sprint", values: ["Sprint 4"] }, { prop: "state", values: ["Active"] }];
  const got = upgradeFilters(old, props, items);
  assert.deepEqual(got[0].values, [keyOfPerson(ann), "Nobody here", ""], "a name nobody has now stays as it is");
  assert.deepEqual(got[1].values, ["P\\A\\Sprint 4", "P\\B\\Sprint 4"], "a name stands for every sprint of that name");
  assert.equal(got[2], old[2]);
  assert.equal(upgradeFilters(got, props, items), got, "nothing more to change: the same list");
  assert.equal(goneLabel("field:Custom.Risk"), "Custom.Risk: (field no longer available)");
});

test("each team keeps its own filters; the old page key moves to the first team once", () => {
  const m = new Map<string, unknown>([["board.filters", [{ prop: "state", values: ["Active"] }]]]);
  const store = { get: (k: string) => m.get(k), set: (k: string, v: unknown) => { m.set(k, v); } };
  const empty = (v: unknown): boolean => cleanFilters(v).length === 0;
  const a = teamKey(store, "board.filters", "Org/P/Team A", [], empty);
  assert.equal(a, "board.filters@Org/P/Team A");
  assert.deepEqual(m.get(a), [{ prop: "state", values: ["Active"] }], "moved to the first team");
  assert.deepEqual(m.get("board.filters"), [], "and taken from the old key");
  const b = teamKey(store, "board.filters", "Org/P/Team B", [], empty);
  assert.equal(m.get(b), undefined, "another team starts with none");
  m.set(a, [{ prop: "state", values: ["New"] }]);
  assert.equal(teamKey(store, "board.filters", "Org/P/Team A", [], empty), a);
  assert.deepEqual(m.get(a), [{ prop: "state", values: ["New"] }], "a team's own choice stays");
  assert.equal(teamKey(store, "board.filters", "", [], empty), "board.filters", "no team known: the page key");
});

test("date filters: a target date is the day the person picked; created is the local day", async () => {
  const { BASE_PROPS } = await import("../src/core/filters.ts");
  const target = BASE_PROPS.find((p) => p.id === "target")!;
  const created = BASE_PROPS.find((p) => p.id === "created")!;
  const w = { targetDate: "2026-10-20T22:00:00Z", created: new Date(2026, 9, 21, 0, 30).toISOString() } as unknown as Parameters<typeof target.get>[0];
  assert.equal(target.get(w), "2026-10-21"); // Berlin midnight of 21 October
  assert.equal(created.get(w), "2026-10-21"); // 00:30 local time
});
