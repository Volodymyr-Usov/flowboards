import { test } from "node:test";
import assert from "node:assert/strict";
import { relId, REL } from "../src/api/api.ts";
import { DEMO_PROCESS } from "../src/api/demo.ts";
import { categoryOf, normalizePr, normalizeUpdate, person, processFields, splitTags } from "../src/api/normalize.ts";
import type { Relation, WorkItem } from "../src/api/types.ts";
import { passesAll } from "../src/core/filters.ts";
import type { Prop } from "../src/core/filters.ts";
import { findingKey, runCustomChecks } from "../src/core/health.ts";
import type { CustomCheck } from "../src/core/health.ts";
import {
  byOrder, childLevel, daysInState, fmtDays, hasText, isClosed, isDone, isOpen, isRemoved, isUnder, levelOf, parentLevel, personKey, samePerson,
} from "../src/core/model.ts";
import { fieldTitle, isEmptyValue } from "../src/core/rules.ts";
import { pool } from "../src/core/teamplans.ts";
import { styleLabel } from "../src/core/workstyle.ts";
import { textToHtml } from "../src/ui/sanitize.ts";

const item = (id: number, extra: Partial<WorkItem> = {}): WorkItem => ({
  id, rev: 1, type: "User Story", title: `T${id}`, state: "Active", category: "InProgress", area: "P", iteration: "P", tags: [],
  created: "2026-01-01T00:00:00Z", changed: "2026-01-02T00:00:00Z", fields: {}, ...extra,
});

test("state groups: done means resolved or closed, open means not closed and not removed", () => {
  const cat = (category: WorkItem["category"]) => item(1, { category });
  assert.deepEqual((["Proposed", "InProgress", "Resolved", "Completed", "Removed"] as const).map((c) => [isDone(cat(c)), isClosed(cat(c)), isOpen(cat(c)), isRemoved(cat(c))]), [
    [false, false, true, false], [false, false, true, false], [true, false, true, false], [true, true, false, false], [false, false, false, true],
  ]);
});

test("backlog order: by the order field, items without one last, then by number", () => {
  const list = [item(3), item(1, { order: 20 }), item(2, { order: 10 }), item(4, { order: 10 })];
  assert.deepEqual(list.sort(byOrder).map((w) => w.id), [2, 4, 1, 3]);
});

test("the level above and below, and the level of a type", () => {
  const story = levelOf(DEMO_PROCESS, "User Story")!;
  assert.equal(story.kind, "requirement");
  assert.equal(parentLevel(DEMO_PROCESS, story)?.kind, "portfolio");
  assert.equal(childLevel(DEMO_PROCESS, story)?.kind, "task");
  assert.equal(parentLevel(DEMO_PROCESS, DEMO_PROCESS.levels[0]), undefined, "nothing above the top");
  assert.equal(childLevel(DEMO_PROCESS, DEMO_PROCESS.levels[DEMO_PROCESS.levels.length - 1]), undefined, "nothing below the tasks");
  assert.equal(levelOf(DEMO_PROCESS, "Nope"), undefined);
});

test("people: the same by account without case, or by id; nobody is nobody", () => {
  assert.equal(samePerson({ displayName: "A", uniqueName: "Ann@X.example" }, { displayName: "Ann", uniqueName: "ann@x.example" }), true);
  assert.equal(samePerson({ id: "1", displayName: "A", uniqueName: "" }, { id: "1", displayName: "B", uniqueName: "" }), true);
  assert.equal(samePerson({ displayName: "A", uniqueName: "" }, { displayName: "A", uniqueName: "" }), false, "no account and no id: not told apart");
  assert.equal(samePerson(undefined, { displayName: "A", uniqueName: "a" }), false);
  assert.equal(personKey({ displayName: "Ann", uniqueName: "" }), "ann");
  assert.equal(personKey({ displayName: "Ann", uniqueName: "Ann@X.example" }), "ann@x.example");
  assert.equal(personKey(undefined), "");
});

test("texts: text counts, empty tags do not; days in a state; durations; paths", () => {
  assert.equal(hasText("<div><br></div>"), false);
  assert.equal(hasText("<p>abc</p>", 4), false);
  assert.equal(hasText("<p>abc</p>", 3), true);
  const now = Date.parse("2026-02-01T12:00:00Z");
  assert.equal(daysInState(item(1, { stateChanged: "2026-01-30T00:00:00Z" }), now), 2);
  assert.equal(daysInState(item(1, { stateChanged: undefined, changed: "2026-01-31T00:00:00Z" }), now), 1);
  assert.deepEqual([0, 0.5, 5, 59, 60, 400, 729, 730, 1000].map(fmtDays), ["0d", "0d", "5d", "59d", "2mo", "13mo", "24mo", "2.0y", "2.7y"]);
  assert.equal(isUnder("P\\Team\\S1", "P\\Team"), true);
  assert.equal(isUnder("P\\Team", "P\\Team"), true);
  assert.equal(isUnder("P\\TeamB", "P\\Team"), false, "a longer name is not a child");
});

test("a value is empty when it is nothing, blank, or HTML with no text; numbers and people are not", () => {
  for (const v of [undefined, null, "", "  ", "<div> </div>", "<p>&nbsp;</p>", {}]) assert.equal(isEmptyValue(v), true, JSON.stringify(v));
  for (const v of [0, false, true, "x", "<b>x</b>", { displayName: "Ann" }, { a: 1 }]) assert.equal(isEmptyValue(v), false, JSON.stringify(v));
  assert.equal(fieldTitle("Custom.RiskLevel"), "Risk Level");
  assert.equal(fieldTitle("Custom.RiskLevel", { "Custom.RiskLevel": "Risk" }), "Risk");
});

test("the team's own health checks: every condition must hold, a check with none finds nothing", () => {
  const props = new Map<string, Prop>([["state", { id: "state", label: "State", kind: "set", get: (w) => [w.state] }], ["tags", { id: "tags", label: "Tags", kind: "set", get: (w) => (w.tags.length ? w.tags : [""]) }]]);
  const check = (id: string, when: CustomCheck["when"]): CustomCheck => ({ id, title: `Check ${id}`, message: id === "a" ? "" : "Say so", severity: "low", when, fix: { kind: "open" } });
  const items = [item(1, { state: "Active", tags: ["x"] }), item(2, { state: "Active" }), item(3, { state: "New" })];
  const out = runCustomChecks(items, [
    check("a", [{ prop: "state", op: "any", values: ["Active"] }, { prop: "tags", op: "none", values: [""] }]),
    check("b", []),
    check("c", [{ prop: "state", op: "any", values: ["New"] }]),
  ], props);
  assert.deepEqual(out.map((f) => [f.checkId, f.itemId, f.message]), [["c:a", 1, "Check a"], ["c:c", 3, "Say so"]]);
  assert.equal(findingKey(out[0]), "c:a:1");
  assert.equal(passesAll(items[0], [], props), true);
});

test("link and pull request addresses", () => {
  const r = (url: string): Relation => ({ rel: REL.related, url, attributes: {} });
  assert.equal(relId(r("https://dev.azure.com/o/_apis/wit/workItems/42")), 42);
  assert.equal(relId(r("https://dev.azure.com/o/_apis/wit/workitems/7")), 7);
  assert.equal(relId(r("vstfs:///Git/PullRequestId/p%2Fr%2F7")), 0, "not a work item");
  assert.equal(relId(r("https://dev.azure.com/o/_apis/wit/workItems/42/x")), 0);
});

test("raw pull requests: drafts, branch names, and an address with the names encoded", () => {
  const raw = {
    pullRequestId: 12, title: "Fix", status: "active", isDraft: true, creationDate: "2026-01-01T00:00:00Z",
    createdBy: { displayName: "Ann", uniqueName: "ann@x.example", id: "u1" },
    repository: { id: "r1", name: "web app", project: { id: "p1", name: "R&D" } },
    sourceRefName: "refs/heads/feature/x", targetRefName: "refs/heads/main",
    reviewers: [{ displayName: "Bo", uniqueName: "bo@x.example", vote: 10, isRequired: true }, { displayName: "Team", uniqueName: "t", isContainer: true }],
    workItemRefs: [{ id: "5" }],
  };
  const pr = normalizePr(raw, "https://dev.azure.com/o/");
  assert.equal(pr.status, "draft");
  assert.equal(pr.sourceBranch, "feature/x");
  assert.equal(pr.targetBranch, "main");
  assert.equal(pr.url, "https://dev.azure.com/o/R%26D/_git/web%20app/pullrequest/12");
  assert.deepEqual(pr.reviewers.map((v) => v.vote), [10, 0]);
  assert.deepEqual(pr.workItemIds, [5]);
  assert.equal(normalizePr({ ...raw, isDraft: true, status: "completed" }, "https://dev.azure.com/o/").status, "completed", "a completed draft is completed");
  assert.equal(normalizePr({ pullRequestId: 1 }, "https://dev.azure.com/o/").url, "https://dev.azure.com/o//_git//pullrequest/1");
});

test("raw updates: the bookkeeping fields are left out, the date is the change date", () => {
  const u = normalizeUpdate({
    id: 3, rev: 3, revisedBy: { displayName: "Ann", uniqueName: "ann@x.example" }, revisedDate: "9999-01-01T00:00:00Z",
    fields: {
      "System.Rev": { newValue: 3 }, "System.ChangedDate": { newValue: "2026-03-01T10:00:00Z" }, "System.ChangedBy": { newValue: "x" },
      "System.State": { oldValue: "New", newValue: "Active" },
    },
    relations: { added: [{ rel: REL.parent, url: "u" }] },
  });
  assert.deepEqual(u.changes, [{ field: "System.State", oldValue: "New", newValue: "Active" }]);
  assert.equal(u.date, "2026-03-01T10:00:00Z");
  assert.equal(u.relationsAdded?.[0].rel, REL.parent);
  assert.equal(u.relationsRemoved, undefined);
  assert.equal(normalizeUpdate({ id: 1, rev: 1, revisedDate: "2026-01-01T00:00:00Z" }).by.displayName, "");
});

test("state group of a state: from the process, else from its usual name", () => {
  assert.equal(categoryOf(DEMO_PROCESS, "User Story", "Active"), "InProgress");
  assert.equal(categoryOf(undefined, "Whatever", "Closed"), "Completed");
  assert.equal(categoryOf(undefined, "Whatever", "REMOVED"), "Removed");
  assert.equal(categoryOf(undefined, "Whatever", "Resolved"), "Resolved");
  assert.equal(categoryOf(undefined, "Whatever", "To Do"), "Proposed");
  assert.equal(categoryOf(undefined, "Whatever", "Reviewing"), "InProgress");
  assert.deepEqual(processFields({ ...DEMO_PROCESS, fields: { order: "o", effort: "e", remaining: "", activity: "a", completed: "c", original: "g" } }), ["o", "e", "c", "g", "a"], "empty names are left out");
  assert.deepEqual(splitTags(" a; b ;;c "), ["a", "b", "c"]);
  assert.deepEqual(splitTags(undefined), []);
  assert.equal(person(null), undefined);
  assert.deepEqual(person("Ann <ann@x.example>"), { displayName: "Ann", uniqueName: "ann@x.example" });
});

test("every style has a name", () => {
  assert.deepEqual((["scrum", "kanban", "scrumban"] as const).map(styleLabel), ["Scrum", "Kanban", "Scrumban"]);
});

test("running jobs a few at a time keeps every result in its place", async () => {
  let running = 0;
  let most = 0;
  const out = await pool([5, 1, 4, 2, 3, 0], 2, async (n) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, n));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30, 0]);
  assert.equal(most, 2);
  assert.deepEqual(await pool([], 3, async () => 1), []);
  assert.deepEqual(await pool([1, 2], 0, async (n) => n), [1, 2], "at least one at a time");
});

test("plain text becomes safe paragraphs: markup is shown as text, lines starting with - make a list", () => {
  assert.equal(textToHtml("a <script>x</script> & b"), "<div>a &lt;script&gt;x&lt;/script&gt; &amp; b</div>");
  assert.equal(textToHtml("**bold** and <b>no</b>"), "<div><b>bold</b> and &lt;b&gt;no&lt;/b&gt;</div>");
  assert.equal(textToHtml("- one\n* two <i>\n\ntext"), "<ul><li>one</li><li>two &lt;i&gt;</li></ul><div>text</div>");
  assert.equal(textToHtml("  \n "), "");
});
