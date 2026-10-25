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
