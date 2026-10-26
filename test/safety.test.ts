import { test } from "node:test";
import assert from "node:assert/strict";
import { prFromArtifact } from "../src/api/api.ts";
import { RestApi } from "../src/api/rest.ts";
import { undoAll } from "../src/ui/actions.ts";
import { sprintChoices } from "../src/ui/create.ts";
import { once } from "../src/ui/dom.ts";
import { imageAllowed } from "../src/ui/sanitize.ts";

test("a damaged pull request link is not a pull request (and does not throw)", () => {
  assert.equal(prFromArtifact("vstfs:///Git/PullRequestId/abc%2Fdef%2"), null);
  assert.equal(prFromArtifact("vstfs:///Git/PullRequestId/%E0%A4%A"), null);
  assert.equal(prFromArtifact("vstfs:///Git/PullRequestId/p%2Fr%2Fx"), null, "not a number");
  assert.deepEqual(prFromArtifact("vstfs:///Git/PullRequestId/p%2Fr%2F7"), { projectId: "p", repoId: "r", prId: 7 });
});

test("pictures: from Azure DevOps and inside the text yes, from other sites no", () => {
  assert.equal(imageAllowed("https://dev.azure.com/org/p/_apis/wit/attachments/1?fileName=a.png"), true);
  assert.equal(imageAllowed("https://org.visualstudio.com/_apis/wit/attachments/1"), true);
  assert.equal(imageAllowed("data:image/png;base64,AAAA"), true);
  assert.equal(imageAllowed("https://tracker.example/pixel.gif"), false);
  assert.equal(imageAllowed("https://dev.azure.com.evil.example/x.png"), false);
  assert.equal(imageAllowed("https://tfs.contoso.local/tfs/_apis/x.png", ["tfs.contoso.local"]), true, "the organization's own server");
  assert.equal(imageAllowed("javascript:alert(1)"), false);
});

test("Undo of several changes: last first, the list stays as it was, and it runs once", async () => {
  const done: number[] = [];
  const undos = [1, 2, 3].map((n) => async () => { done.push(n); });
  const undo = undoAll(undos)!;
  await Promise.all([undo(), undo()]);
  assert.deepEqual(done, [3, 2, 1]);
  assert.equal(undos.length, 3);
  assert.equal(undoAll([]), undefined);
  let n = 0;
  const one = once(async () => ++n);
  assert.equal(await one(), 1);
  assert.equal(await one(), 1);
});

test("Undo of several changes: one that fails does not leave the others changed, and its error is reported", async () => {
  const done: number[] = [];
  const ok = (n: number) => async () => { done.push(n); };
  const bad = (n: number) => async () => { done.push(n); throw new Error(`step ${n}`); };
  const undo = undoAll([ok(1), bad(2), ok(3), bad(4)])!;
  await assert.rejects(undo(), /step 4/, "the first failure, in the order undone");
  assert.deepEqual(done, [4, 3, 2, 1], "every step was tried");
  await assert.rejects(undo(), /step 4/, "and a second click does not run them again");
  assert.deepEqual(done, [4, 3, 2, 1]);
});

test("a new item's sprint list keeps a given sprint that has ended", () => {
  const iters = [
    { id: "1", name: "S1", path: "P\\S1", timeFrame: "past" as const },
    { id: "2", name: "S2", path: "P\\S2", timeFrame: "current" as const },
    { id: "3", name: "S3", path: "P\\S3", timeFrame: "future" as const },
  ];
  assert.deepEqual(sprintChoices("P", iters).map((c) => c.path), ["P", "P\\S2", "P\\S3"]);
  const withPast = sprintChoices("P", iters, "P\\S1");
  assert.deepEqual(withPast.map((c) => c.path), ["P", "P\\S1", "P\\S2", "P\\S3"]);
  assert.equal(withPast[1].label, "S1 (ended)");
  assert.equal(sprintChoices("P", iters, "P").length, 3, "the backlog once");
});

test("a read that gets no answer is given up after the time limit; a write only after its longer one", async () => {
  const real = globalThis.fetch;
  let seen: AbortSignal | undefined;
  globalThis.fetch = ((_url: string, init: RequestInit) => new Promise((_ok, fail) => {
    seen = init.signal ?? undefined;
    init.signal?.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  try {
    const api = new RestApi({ orgName: "o", orgUrl: "https://dev.azure.com/o/", me: { displayName: "Me", uniqueName: "me" }, demo: false }, async () => "token");
    api.timeoutMs = 20;
    await assert.rejects(api.req("GET", "https://dev.azure.com/o/_apis/projects"), /did not answer within/);
    await assert.rejects(api.req("POST", "https://dev.azure.com/o/p/_apis/wit/wiql?api-version=7.1", { query: "x" }), /did not answer within/);
    api.writeTimeoutMs = 60;
    const write = api.req("PATCH", "https://dev.azure.com/o/p/_apis/wit/workitems/1", []);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seen?.aborted, false, "a write waits longer than a read");
    await assert.rejects(write, /may or may not be saved/);
  } finally {
    globalThis.fetch = real;
  }
});
