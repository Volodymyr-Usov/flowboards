import { test } from "node:test";
import assert from "node:assert/strict";
import type { Person, PullRequest } from "../src/api/types.ts";
import {
  ageLevel, daysBetween, fmtDuration, isNoAccess, median, mergeStats, namesText, needsReviewBy, percentile, runLimited,
  shortName, shownPerson, sortKeyFor, voteKind, waitingOn, weeklyCounts, weeklyTimes, weekStart,
} from "../src/views/prlogic.ts";

const p = (n: string): Person => ({ displayName: n, uniqueName: `${n}@x.example` });
const ann = p("ann"), bob = p("bob"), cy = p("cy");

function pr(reviewers: PullRequest["reviewers"], extra: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1, title: "t", status: "active", isDraft: false, createdBy: ann, created: "2026-10-01T00:00:00Z",
    repository: { id: "r", name: "repo" }, reviewers, url: "u", ...extra,
  };
}

test("voteKind maps Azure DevOps votes", () => {
  assert.equal(voteKind(10), "approved");
  assert.equal(voteKind(5), "suggestions");
  assert.equal(voteKind(0), "none");
  assert.equal(voteKind(-5), "waiting");
  assert.equal(voteKind(-10), "rejected");
});

test("waitingOn: the author when someone asked for changes", () => {
  const w = waitingOn(pr([{ person: bob, vote: -5 }, { person: cy, vote: 0, isRequired: true }]));
  assert.equal(w.kind, "author");
  assert.deepEqual(w.people, [ann]);
  assert.equal(waitingOn(pr([{ person: bob, vote: -10 }])).kind, "author");
});

test("waitingOn: required reviewers without a vote", () => {
  const w = waitingOn(pr([{ person: bob, vote: 10 }, { person: cy, vote: 0, isRequired: true }]));
  assert.equal(w.kind, "reviewers");
  assert.deepEqual(w.people, [cy]);
});

test("waitingOn: every open reviewer when nobody approved; the author to complete once approved", () => {
  const w = waitingOn(pr([{ person: bob, vote: 0 }, { person: cy, vote: 0 }]));
  assert.equal(w.kind, "reviewers");
  assert.equal(w.people.length, 2);
  const done = waitingOn(pr([{ person: bob, vote: 5 }, { person: cy, vote: 0 }]));
  assert.equal(done.kind, "author");
  assert.equal(done.why, "complete");
  assert.deepEqual(done.people, [ann]);
  assert.equal(waitingOn(pr([])).kind, "none");
});

test("waitingOn: the author when the merge has conflicts or failed", () => {
  const w = waitingOn(pr([{ person: bob, vote: 0, isRequired: true }], { mergeStatus: "conflicts" }));
  assert.equal(w.kind, "author");
  assert.equal(w.why, "conflicts");
  assert.equal(waitingOn(pr([{ person: bob, vote: 10 }], { mergeStatus: "failure" })).why, "conflicts");
  assert.equal(waitingOn(pr([{ person: bob, vote: -5 }], { mergeStatus: "conflicts" })).why, "changes");
});

test("waitingOn: approved and set to auto-complete waits for the checks, not the author", () => {
  const w = waitingOn(pr([{ person: bob, vote: 10 }], { autoComplete: true }));
  assert.equal(w.kind, "policies");
  assert.deepEqual(w.people, []);
  // not approved yet: still the reviewers, auto-complete or not
  assert.equal(waitingOn(pr([{ person: bob, vote: 0 }], { autoComplete: true })).kind, "reviewers");
  // a required reviewer without a vote still comes first
  assert.deepEqual(waitingOn(pr([{ person: bob, vote: 10 }, { person: cy, vote: 0, isRequired: true }], { autoComplete: true })).people, [cy]);
});

test("waitingOn: a reviewer who declined is not waited on (unless required)", () => {
  const w = waitingOn(pr([{ person: bob, vote: 0, hasDeclined: true }, { person: cy, vote: 0 }]));
  assert.deepEqual(w.people, [cy]);
  assert.equal(waitingOn(pr([{ person: bob, vote: 0, hasDeclined: true }])).kind, "none");
  assert.equal(waitingOn(pr([{ person: bob, vote: 10 }, { person: cy, vote: 0, hasDeclined: true }])).why, "complete");
  assert.deepEqual(waitingOn(pr([{ person: bob, vote: 0, hasDeclined: true, isRequired: true }])).people, [bob]);
  assert.equal(needsReviewBy(pr([{ person: bob, vote: 0, hasDeclined: true }]), bob), false);
  assert.equal(needsReviewBy(pr([{ person: bob, vote: 0 }]), bob), true);
});

test("shortName, shownPerson and namesText", () => {
  assert.equal(shortName("[Fabrikam]\\Web Team"), "Web Team");
  assert.equal(shortName("Ann Lee"), "Ann Lee");
  assert.equal(shownPerson({ displayName: "[P]\\Reviewers", uniqueName: "x" }).displayName, "Reviewers");
  assert.equal(shownPerson(bob), bob);
  assert.equal(namesText(["Ann"]), "Ann");
  assert.equal(namesText(["Ann", "Bob"]), "Ann, Bob");
  assert.equal(namesText(["Ann", "Bob", "Cy", "Di"]), "Ann, Bob +2");
});

test("needsReviewBy: a reviewer who has not voted", () => {
  assert.equal(needsReviewBy(pr([{ person: bob, vote: 0 }]), bob), true);
  assert.equal(needsReviewBy(pr([{ person: bob, vote: 10 }]), bob), false);
  assert.equal(needsReviewBy(pr([{ person: cy, vote: 0 }]), bob), false);
});

test("median and percentile", () => {
  assert.ok(Number.isNaN(median([])));
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  assert.equal(percentile([0, 10], 85), 8.5);
});

test("ageLevel thresholds 3 and 7 days", () => {
  assert.equal(ageLevel(2.9), "ok");
  assert.equal(ageLevel(3), "warn");
  assert.equal(ageLevel(6.9), "warn");
  assert.equal(ageLevel(7), "bad");
});

test("daysBetween and fmtDuration", () => {
  assert.equal(daysBetween("2026-10-01T00:00:00Z", "2026-10-03T12:00:00Z"), 2.5);
  assert.equal(daysBetween("2026-10-03T00:00:00Z", "2026-10-01T00:00:00Z"), 0);
  assert.equal(fmtDuration(0.01), "14m");
  assert.equal(fmtDuration(0.25), "6h");
  assert.equal(fmtDuration(2.34), "2.3d");
  assert.equal(fmtDuration(12.6), "13d");
  assert.equal(fmtDuration(NaN), "–");
});

test("weekStart is a Monday; weeklyCounts puts dates in weeks", () => {
  const now = Date.parse("2026-10-21T10:00:00Z"); // a Wednesday
  assert.equal(new Date(weekStart(now)).toISOString(), "2026-10-19T00:00:00.000Z");
  const w = weeklyCounts(["2026-10-20T08:00:00Z", "2026-10-19T00:00:00Z", "2026-10-18T23:00:00Z", "2026-01-01T00:00:00Z"], 3, now);
  assert.equal(w.length, 3);
  assert.deepEqual(w.map((x) => x.count), [0, 1, 2]);
  assert.equal(w[2].start, Date.parse("2026-10-19T00:00:00Z"));
  assert.equal(w[0].start, Date.parse("2026-10-05T00:00:00Z"));
});

test("mergeStats groups and sorts by count", () => {
  const s = mergeStats([{ r: "a", d: 1 }, { r: "b", d: 2 }, { r: "b", d: 4 }], (x) => x.r, (x) => x.d);
  assert.deepEqual(s.map((x) => [x.key, x.count, x.median]), [["b", 2, 3], ["a", 1, 1]]);
});

test("runLimited keeps order, limits concurrency and records errors", async () => {
  let running = 0, peak = 0;
  const seen: number[] = [];
  const out = await runLimited([1, 2, 3, 4, 5, 6], 2, async (x) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5 * (7 - x)));
    running--;
    if (x === 3) throw Object.assign(new Error("no"), { status: 403 });
    return x * 10;
  }, (done) => seen.push(done));
  assert.equal(peak, 2);
  assert.deepEqual(out.map((o) => o.value), [10, 20, undefined, 40, 50, 60]);
  assert.ok(isNoAccess(out[2].error));
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(await runLimited([], 4, async () => 1), []);
  const stopped = await runLimited([1, 2, 3], 1, async (x) => x, undefined, () => true);
  assert.deepEqual(stopped.filter(Boolean), []);
});

test("weeklyTimes: average days to first approval and to merge, per week of completion", () => {
  const now = Date.parse("2026-10-22T12:00:00Z"); // a Thursday; weeks start on Monday
  const w = weeklyTimes([
    { created: "2026-10-19T00:00:00Z", closed: "2026-10-21T00:00:00Z", approved: "2026-10-20T00:00:00Z" }, // this week: 1 and 2 days
    { created: "2026-10-18T00:00:00Z", closed: "2026-10-22T00:00:00Z", approved: "2026-10-21T00:00:00Z" }, // this week: 3 and 4 days
    { created: "2026-10-10T00:00:00Z", closed: "2026-10-13T00:00:00Z", approved: null }, // last week: 3 days, never approved
    { created: "2026-09-01T00:00:00Z", closed: "2026-09-02T00:00:00Z" }, // outside the weeks
  ], 2, now, "mean");
  assert.equal(w.length, 2);
  assert.deepEqual(w[1], { start: Date.parse("2026-10-19T00:00:00Z"), approval: 2, merge: 3, merged: 2, approvedCount: 2 });
  assert.deepEqual(w[0], { start: Date.parse("2026-10-12T00:00:00Z"), approval: null, merge: 3, merged: 1, approvedCount: 0 });
});

test("a sort kept from another tab falls back to the tab's own column", () => {
  assert.equal(sortKeyFor("open", "age"), "age");
  assert.equal(sortKeyFor("open", "closed"), "age");
  assert.equal(sortKeyFor("open", "merge"), "age");
  assert.equal(sortKeyFor("open", "title"), "title");
  assert.equal(sortKeyFor("completed", "age"), "closed");
  assert.equal(sortKeyFor("completed", "merge"), "merge");
  assert.equal(sortKeyFor("abandoned", "repo"), "closed");
  assert.equal(sortKeyFor("abandoned", "nonsense"), "closed");
});

test("weeklyTimes takes the median by default, so one stuck pull request does not bend the week; timeSummary gives the whole period", async () => {
  const { timeSummary } = await import("../src/views/prlogic.ts");
  const now = Date.parse("2026-10-22T12:00:00Z");
  const prs = [
    { created: "2026-10-19T00:00:00Z", closed: "2026-10-20T00:00:00Z", approved: "2026-10-19T12:00:00Z" }, // 1 day, approved after 0.5
    { created: "2026-10-19T00:00:00Z", closed: "2026-10-21T00:00:00Z", approved: "2026-10-20T00:00:00Z" }, // 2 days, approved after 1
    { created: "2026-10-01T00:00:00Z", closed: "2026-10-22T00:00:00Z", approved: null }, // 21 days, never approved: the stuck one
  ];
  const w = weeklyTimes(prs, 1, now);
  assert.equal(w[0].merge, 2); // the mean would be 8
  assert.equal(w[0].approval, 0.75);
  const s = timeSummary(prs);
  assert.equal(s.merged, 3);
  assert.equal(s.approved, 2);
  assert.equal(s.mergeMedian, 2);
  assert.ok((s.mergeP85 ?? 0) >= 2);
  assert.equal(timeSummary([]).mergeMedian, null);
});
