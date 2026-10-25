import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_PROCESS } from "../src/api/demo.ts";
import { daysSince, fmtDate, initials, leaf, orderedStates, plainText, statesOf, workingDays } from "../src/core/model.ts";

test("states by category and in workflow order", () => {
  assert.deepEqual(statesOf(DEMO_PROCESS, ["User Story"], ["Completed"]), ["Closed"]);
  assert.deepEqual(orderedStates(DEMO_PROCESS, ["User Story", "Bug"]).map((s) => s.name), ["New", "Active", "Resolved", "Closed"]);
});

test("plain text of HTML fields", () => {
  assert.equal(plainText("<div>a&nbsp;<b>b</b></div><div></div>"), "a b");
  assert.equal(plainText("<div><br></div>"), "");
});

test("plain text decodes each entity once", () => {
  // "&amp;lt;" is the text "&lt;", not "<"
  assert.equal(plainText("<p>use &amp;lt;b&amp;gt; for bold</p>"), "use &lt;b&gt; for bold");
  assert.equal(plainText("<p>R&amp;D &lt;3 &quot;x&quot; &#39;y&#39;</p>"), "R&D <3 \"x\" 'y'");
  assert.equal(plainText(undefined), "");
});

test("days since a date: whole days, never negative, and 0 for a missing or damaged date", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(daysSince("2026-10-07T13:00:00Z", now), 2);
  assert.equal(daysSince("2026-10-20T00:00:00Z", now), 0);
  assert.equal(daysSince(undefined, now), 0);
  assert.equal(daysSince("not a date", now), 0);
});

test("a date that is missing or damaged is shown as nothing, not as 'Invalid Date'", () => {
  assert.equal(fmtDate(undefined), "");
  assert.equal(fmtDate("soon"), "");
  assert.match(fmtDate("2026-10-05T12:00:00Z", { year: "numeric", timeZone: "UTC" }), /2026/);
});

test("raw numbers that are not numbers are left out of the item", async () => {
  const { normalizeItem } = await import("../src/api/normalize.ts");
  const it = normalizeItem({ id: 1, rev: 1, fields: { "System.WorkItemType": "Task", "System.State": "New", "Microsoft.VSTS.Common.Priority": "high", "System.Parent": "" } });
  assert.equal(it.priority, undefined);
  assert.equal(it.parent, undefined);
  const ok = normalizeItem({ id: 2, rev: 1, fields: { "System.WorkItemType": "Task", "System.State": "New", "Microsoft.VSTS.Common.Priority": "2", "System.Parent": 7 } });
  assert.equal(ok.priority, 2);
  assert.equal(ok.parent, 7);
});

test("initials and path leaf", () => {
  assert.equal(initials("Ava Martins"), "AM");
  assert.equal(initials("ava.martins@x.com"), "AM");
  assert.equal(leaf("P\\Team\\Sprint 4"), "Sprint 4");
});

test("working days skip weekends and days off", () => {
  // Monday 19 to Sunday 25 October 2026: five working days, one of them off
  assert.equal(workingDays("2026-10-19", "2026-10-25", [1, 2, 3, 4, 5]), 5);
  assert.equal(workingDays("2026-10-19", "2026-10-25", [1, 2, 3, 4, 5], [{ start: "2026-10-21T00:00:00Z", end: "2026-10-21T00:00:00Z" }]), 4);
});

test("a name that is not an account is split into name and address", async () => {
  const { person } = await import("../src/api/normalize.ts");
  assert.deepEqual(person({ displayName: "Ava Martins <ava@x.example>", id: null }), { id: undefined, displayName: "Ava Martins", uniqueName: "ava@x.example" });
  assert.equal(person({ displayName: "Ben", uniqueName: "ben@x.example", id: "1" })?.displayName, "Ben");
});
