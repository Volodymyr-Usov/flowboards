import { test } from "node:test";
import assert from "node:assert/strict";
import { prArtifactUrl, prFromArtifact } from "../src/api/api.ts";
import type { LevelKind, LinkedItem, StoryRef } from "../src/views/prlogic.ts";
import { branchNumbers, mentionedIds, missingParents, newPrUrl, prCandidates, storyLinks, titleWords, wordOverlap } from "../src/views/prlogic.ts";

// a small process: Epic > Feature > User Story / Bug > Task
const KIND: Record<string, LevelKind> = { Epic: "portfolio", Feature: "portfolio", "User Story": "requirement", Bug: "requirement", Task: "task" };
const kindOf = (t: string): LevelKind | undefined => KIND[t];
const items = new Map<number, LinkedItem>([
  [1, { id: 1, type: "Feature" }],
  [10, { id: 10, type: "User Story", parent: 1 }],
  [11, { id: 11, type: "Task", parent: 10 }],
  [12, { id: 12, type: "Task", parent: 10 }],
  [20, { id: 20, type: "Bug", parent: 1 }],
  [21, { id: 21, type: "Task", parent: 20 }],
  [30, { id: 30, type: "Task" }], // a task without a parent
  [40, { id: 40, type: "Task", parent: 99 }], // its parent is not read yet
]);
const get = (id: number): LinkedItem | undefined => items.get(id);

test("storyLinks shows a linked task as its story, with the task as 'via'", () => {
  assert.deepEqual(storyLinks([11], get, kindOf), [{ id: 10, direct: false, via: [11] }]);
});

test("storyLinks joins a story linked directly and through its tasks", () => {
  assert.deepEqual(storyLinks([11, 10, 12], get, kindOf), [{ id: 10, direct: true, via: [11, 12] }]);
});

test("storyLinks keeps other items as they are, in order", () => {
  assert.deepEqual(storyLinks([1, 21, 30, 40, 777], get, kindOf), [
    { id: 1, direct: true, via: [] },
    { id: 20, direct: false, via: [21] }, // a Bug at the requirement level counts as the story
    { id: 30, direct: true, via: [] }, // no parent: the task itself
    { id: 40, direct: true, via: [] }, // parent unknown: the task itself
    { id: 777, direct: true, via: [] }, // not read: the number itself
  ]);
});

test("missingParents names the parents to read before tasks can show as stories", () => {
  assert.deepEqual(missingParents([11, 40, 30, 10], get, kindOf), [99]);
  assert.deepEqual(missingParents([11], get, kindOf), []);
});

test("storyLinks survives a parent loop", () => {
  const loop = new Map<number, LinkedItem>([[1, { id: 1, type: "Task", parent: 2 }], [2, { id: 2, type: "Task", parent: 1 }]]);
  assert.deepEqual(storyLinks([1], (id) => loop.get(id), kindOf), [{ id: 1, direct: true, via: [] }]);
  assert.deepEqual(missingParents([1], (id) => loop.get(id), kindOf), []);
});

test("mentionedIds reads numbers from the branch, title and description", () => {
  assert.deepEqual(mentionedIds({ title: "Fix login", sourceBranch: "feature/123-login-page" }), [{ id: 123, where: "branch" }]);
  assert.deepEqual(mentionedIds({ title: "Fix login", sourceBranch: "refs/heads/users/ann/4567" }), [{ id: 4567, where: "branch" }]);
  assert.deepEqual(mentionedIds({ title: "Fix login", sourceBranch: "bug_88" }), [{ id: 88, where: "branch" }]);
  assert.deepEqual(mentionedIds({ title: "AB#55 Small fixes", sourceBranch: "fix/stuff" }), [{ id: 55, where: "title" }]);
  assert.deepEqual(mentionedIds({ title: "Fixes #77 and #78", sourceBranch: "x" }), [{ id: 77, where: "title" }, { id: 78, where: "title" }]);
  assert.deepEqual(mentionedIds({ title: "321: Faster search" }), [{ id: 321, where: "title" }]);
  assert.deepEqual(mentionedIds({ title: "Tidy", description: "Part of #9. See AB#12." }), [{ id: 9, where: "description" }, { id: 12, where: "description" }]);
});

test("mentionedIds leaves out what is not a work item number", () => {
  assert.deepEqual(mentionedIds({ title: "Release 2026.10", sourceBranch: "release/2026.10" }), []);
  assert.deepEqual(mentionedIds({ title: "Upgrade to v2", sourceBranch: "chore/v2-upgrade" }), []);
  assert.deepEqual(mentionedIds({ title: "Fix 2 bugs", sourceBranch: "fix/2-bugs" }), []); // one digit alone in a branch
  assert.deepEqual(mentionedIds({ title: "Revert !412", description: "&#123; in html" }), []); // a pull request, an html entity
  // the same number once, where it was seen first
  assert.deepEqual(mentionedIds({ title: "#123 again", sourceBranch: "feature/123" }), [{ id: 123, where: "branch" }]);
});

test("titleWords keeps meaningful words and drops plural s", () => {
  assert.deepEqual([...titleWords("Fix the Payments page for users")], ["payment", "page"]);
  assert.deepEqual([...titleWords("feature/login-page_v2")], ["login", "page"]);
});

test("wordOverlap scores by the shorter title", () => {
  const r = wordOverlap(titleWords("Export orders to CSV"), titleWords("Orders export to CSV for admins"));
  assert.deepEqual(r.shared.sort(), ["csv", "export", "order"]);
  assert.equal(r.score, 1);
  assert.equal(wordOverlap(new Set(), new Set(["a"])).score, 0);
});

const stories: StoryRef[] = [
  { id: 10, title: "Export orders to CSV", open: true },
  { id: 20, title: "Retry failed payments", open: true },
  { id: 50, title: "Export invoices to PDF", open: true },
  { id: 60, title: "Export orders to CSV for admins", open: false },
];
// what the page can link: stories of the team, and tasks give their story
const resolve = (id: number): { story: number; task?: number } | undefined =>
  id === 10 || id === 20 || id === 50 ? { story: id } : id === 11 ? { story: 10, task: 11 } : undefined;

test("prCandidates puts mentioned stories first, with the reason", () => {
  const c = prCandidates({ title: "Small fixes", sourceBranch: "feature/20-retry" }, stories, resolve);
  assert.deepEqual(c.map((x) => [x.id, x.reason]), [[20, "branch mentions #20"]]);
});

test("prCandidates turns a mentioned task into its story", () => {
  const c = prCandidates({ title: "Add tests", sourceBranch: "bugfix/11-tests" }, stories, resolve);
  assert.deepEqual(c.map((x) => [x.id, x.reason]), [[10, "branch mentions task #11"]]);
});

test("prCandidates finds open stories with a similar title", () => {
  const c = prCandidates({ title: "CSV export of orders", sourceBranch: "feature/improvements" }, stories, resolve);
  assert.deepEqual(c.map((x) => [x.id, x.reason]), [[10, "title matches"]]); // 60 is closed, 50 shares one word only
  assert.deepEqual(c[0].words?.sort(), ["csv", "export", "order"]);
});

test("prCandidates ignores unknown numbers, weak matches, and gives at most 3", () => {
  assert.deepEqual(prCandidates({ title: "Bump dependencies", sourceBranch: "chore/999-deps" }, stories, resolve), []);
  assert.deepEqual(prCandidates({ title: "Export logs", sourceBranch: "x" }, stories, resolve), []);
  const many = prCandidates({ title: "#10 #20 #50", description: "#11" }, stories, resolve);
  assert.equal(many.length, 3);
  assert.deepEqual(many.map((x) => x.id), [10, 20, 50]);
});

test("newPrUrl opens Azure DevOps's create page, with branches when chosen", () => {
  const org = "https://dev.azure.com/contoso/";
  assert.equal(newPrUrl(org, "My Project", "web app"), "https://dev.azure.com/contoso/My%20Project/_git/web%20app/pullrequestcreate");
  assert.equal(newPrUrl(org, "P", "r", "refs/heads/feature/x", "main"), "https://dev.azure.com/contoso/P/_git/r/pullrequestcreate?sourceRef=feature%2Fx&targetRef=main");
  assert.equal(newPrUrl(org, "P", "r", undefined, "main"), "https://dev.azure.com/contoso/P/_git/r/pullrequestcreate?targetRef=main");
});

test("prArtifactUrl makes the link Azure DevOps reads back", () => {
  const url = prArtifactUrl("proj-guid", "repo-guid", 42);
  assert.equal(url, "vstfs:///Git/PullRequestId/proj-guid%2Frepo-guid%2F42");
  assert.deepEqual(prFromArtifact(url), { projectId: "proj-guid", repoId: "repo-guid", prId: 42 });
});

test("the demo has pull requests linked to tasks, unlinked ones that mention a story, and links them back", async () => {
  const { DEMO, DemoApi } = await import("../src/api/demo.ts");
  const api = new DemoApi({ latencyMs: 0 });
  const prs = await api.pullRequests(DEMO.project, { status: "all", top: 2000 });
  let viaTask = 0;
  const unlinked: typeof prs = [];
  for (const pr of prs) {
    const ids = await api.pullRequestWorkItems(DEMO.project, pr.repository.id, pr.id);
    if (!ids.length) { unlinked.push(pr); continue; }
    const [it] = await api.items(DEMO.project, ids.slice(0, 1));
    if (it.type === "Task") viaTask++;
  }
  assert.ok(viaTask >= 3, "some pull requests are linked to tasks");
  assert.ok(unlinked.length >= 4, "some pull requests are not linked");
  assert.ok(unlinked.filter((pr) => mentionedIds(pr).length).length >= 3, "unlinked ones mention work item numbers");
  // linking on the work item makes the pull request list it, as in Azure DevOps
  const pr = unlinked[0];
  const [story] = await api.items(DEMO.project, [mentionedIds(pr)[0].id]);
  await api.update(DEMO.project, story.id, [{ op: "add", path: "/relations/-", value: { rel: "ArtifactLink", url: prArtifactUrl(pr.repository.projectId!, pr.repository.id, pr.id), attributes: { name: "Pull Request" } } }]);
  assert.deepEqual(await api.pullRequestWorkItems(DEMO.project, pr.repository.id, pr.id), [story.id]);
});

test("branch numbers that are dates or versions are not work item numbers", () => {
  assert.deepEqual(mentionedIds({ title: "Login", sourceBranch: "feature/login-2026-10-22" }), []);
  assert.deepEqual(mentionedIds({ title: "Login", sourceBranch: "feature/login_20261022" }), []);
  assert.deepEqual(mentionedIds({ title: "Release", sourceBranch: "release/1.2.3" }), []);
  assert.deepEqual(mentionedIds({ title: "Release", sourceBranch: "release/10-12-3" }), []);
  assert.deepEqual(mentionedIds({ title: "Report", sourceBranch: "feature/report-2026-10" }), []);
  assert.deepEqual(mentionedIds({ title: "Report", sourceBranch: "feature/report-10_2026" }), []);
  // a date next to a real number: the number still counts
  assert.deepEqual(mentionedIds({ title: "Login", sourceBranch: "feature/123-login-2026-10-22" }), [{ id: 123, where: "branch" }]);
  assert.deepEqual(branchNumbers("users/ann/4567"), ["4567"]);
  assert.deepEqual(branchNumbers("bug_88"), ["88"]);
  assert.deepEqual(branchNumbers("feature/abc123-456"), ["456"]); // 123 is part of a word
  assert.deepEqual(branchNumbers("feature/123-456"), ["123", "456"]); // no year: two numbers
  assert.deepEqual(branchNumbers("fix/12345678"), ["12345678"]); // 8 digits that are no date
  assert.deepEqual(branchNumbers("v1.2-hotfix"), []);
});
