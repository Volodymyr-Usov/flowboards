import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate, iterPath, RestApi, serviceUrl } from "../src/api/rest.ts";

type Call = { method: string; url: string; body?: string };
function withFetch(answer: (c: Call, n: number) => Response | Promise<Response>): { calls: Call[]; restore: () => void } {
  const g = globalThis as unknown as { fetch: typeof fetch };
  const old = g.fetch;
  const calls: Call[] = [];
  g.fetch = (async (url: string, init: { method: string; body?: string }) => {
    const c = { method: init.method, url, body: init.body };
    calls.push(c);
    return answer(c, calls.length);
  }) as unknown as typeof fetch;
  return { calls, restore: () => { g.fetch = old; } };
}

const ctx = { orgName: "o", orgUrl: "https://dev.azure.com/o/", me: { displayName: "Me", uniqueName: "me@x.example" }, demo: false };
const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("the request gate never runs more jobs than it allows, also when a new job arrives as one ends", async () => {
  // a new job asks for a place a few steps after one ended: before the waiting job has started
  for (let hops = 0; hops < 8; hops++) {
    const gate = new Gate(2);
    let running = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const job = (): Promise<void> => gate.run(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((r) => releases.push(r));
      running--;
    });
    const first = [job(), job(), job()];
    await tick();
    assert.equal(running, 2);
    releases.shift()!();
    for (let i = 0; i < hops; i++) await null;
    const late = job();
    await tick();
    assert.equal(most, 2, `never three at once (${hops})`);
    assert.equal(running, 2);
    while (releases.length) { releases.shift()!(); await tick(); }
    await Promise.all([...first, late]);
    assert.equal(running, 0);
    // the gate is free again afterwards
    const again = [job(), job()];
    await tick();
    assert.equal(running, 2);
    while (releases.length) { releases.shift()!(); await tick(); }
    await Promise.all(again);
  }
});

test("a job that fails gives its place back", async () => {
  const gate = new Gate(1);
  await assert.rejects(gate.run(async () => { throw new Error("no"); }), /no/);
  assert.equal(await gate.run(async () => 7), 7);
});

test("iteration paths start with the project, whichever way Azure DevOps sends them", () => {
  assert.equal(iterPath("Proj", { path: "Proj\\Sprint 1", name: "Sprint 1" }), "Proj\\Sprint 1");
  assert.equal(iterPath("Proj", { path: "\\Proj\\Sprint 1", name: "Sprint 1" }), "Proj\\Sprint 1");
  assert.equal(iterPath("Proj", { path: "Proj", name: "Proj" }), "Proj", "the root itself");
  assert.equal(iterPath("Proj", { path: "\\Proj", name: "Proj" }), "Proj");
  assert.equal(iterPath("Proj", { path: "Sprint 1", name: "Sprint 1" }), "Proj\\Sprint 1", "no project in front");
  assert.equal(iterPath("Proj", { path: "\\Sprint 1", name: "Sprint 1" }), "Proj\\Sprint 1");
  assert.equal(iterPath("Proj", { name: "Sprint 2" }), "Proj\\Sprint 2");
  // a project whose name starts another path is not mistaken for the same project
  assert.equal(iterPath("Proj", { path: "Proj2\\S", name: "S" }), "Proj\\Proj2\\S");
});

test("requests that need a token at the same time ask the host once", async () => {
  const f = withFetch(() => json({ value: [] }));
  try {
    let asked = 0;
    const api = new RestApi(ctx, async () => { asked++; await tick(5); return "t"; });
    await Promise.all([1, 2, 3, 4].map((i) => api.req("GET", `https://dev.azure.com/o/_apis/projects?x=${i}&api-version=7.1`)));
    assert.equal(asked, 1);
    assert.equal(f.calls.length, 4);
  } finally { f.restore(); }
});

test("a refused token is asked for again once, and a failing host gives its error to every waiting request", async () => {
  const f = withFetch((_c, n) => (n === 1 ? new Response("", { status: 401 }) : json({ ok: true })));
  try {
    let asked = 0;
    const api = new RestApi(ctx, async () => `t${++asked}`);
    assert.deepEqual(await api.req("GET", "https://dev.azure.com/o/_apis/projects?api-version=7.1"), { ok: true });
    assert.equal(asked, 2);
  } finally { f.restore(); }
  const g = withFetch(() => json({}));
  try {
    const api = new RestApi(ctx, async () => { throw new Error("no sign-in"); });
    const all = await Promise.allSettled([api.req("GET", "https://dev.azure.com/o/a"), api.req("GET", "https://dev.azure.com/o/b")]);
    assert.deepEqual(all.map((r) => r.status), ["rejected", "rejected"]);
    assert.equal(g.calls.length, 0);
  } finally { g.restore(); }
});

test("pull requests since a day: completed and abandoned by their closing day, the others by their creation day", async () => {
  const f = withFetch(() => json({ value: [] }));
  try {
    const api = new RestApi(ctx, async () => "t");
    const since = "2026-01-01T00:00:00Z";
    for (const status of ["active", "completed", "abandoned", "all"] as const) await api.pullRequests("P", { status, minTime: since });
    const range = f.calls.map((c) => /queryTimeRangeType=(\w+)/.exec(c.url)?.[1]);
    assert.deepEqual(range, ["created", "closed", "closed", "created"]);
    assert.match(f.calls[0].url, /minTime=2026-01-01T00%3A00%3A00Z/);
  } finally { f.restore(); }
});

test("pull requests are read in pages of at most 200 until the wanted number is there", async () => {
  const page = (n: number) => json({ value: Array.from({ length: n }, (_, i) => ({ pullRequestId: i, title: "t", status: "active", repository: { name: "r", project: { name: "P" } } })) });
  const f = withFetch((c) => (/\$skip=0/.test(c.url) ? page(200) : /\$skip=200/.test(c.url) ? page(50) : page(0)));
  try {
    const api = new RestApi(ctx, async () => "t");
    const prs = await api.pullRequests("P", { status: "active", top: 500 });
    assert.equal(prs.length, 250);
    assert.equal(f.calls.length, 2);
    assert.match(f.calls[0].url, /\$top=200/);
    f.calls.length = 0;
    await api.pullRequests("P", { status: "active", top: 10 });
    assert.match(f.calls[0].url, /\$top=10&/);
  } finally { f.restore(); }
});

test("work items are read at most 200 ids per request, each id once", async () => {
  const f = withFetch((c) => json({ value: (JSON.parse(c.body ?? "{}").ids as number[]).map((id) => ({ id, rev: 1, fields: { "System.Title": `t${id}` } })) }));
  try {
    const api = new RestApi(ctx, async () => "t");
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    const items = await api.items("P", [...ids, 1, 2, 3]);
    assert.equal(items.length, 450);
    assert.deepEqual(f.calls.map((c) => (JSON.parse(c.body!).ids as number[]).length), [200, 200, 50]);
    assert.deepEqual(items.map((i) => i.id), ids, "in the order asked");
  } finally { f.restore(); }
});

test("a change is sent with the revision it started from, and a refused revision is a conflict (412)", async () => {
  const f = withFetch(() => json({ message: "VS403351: The tests of the operation failed" }, 400));
  try {
    const api = new RestApi(ctx, async () => "t");
    await assert.rejects(api.update("P", 5, [{ op: "add", path: "/fields/System.Title", value: "x" }], { rev: 7 }), (e: { status?: number }) => e.status === 412);
    const body = JSON.parse(f.calls[0].body!);
    assert.deepEqual(body[0], { op: "test", path: "/rev", value: 7 });
    assert.equal(f.calls.length, 1, "a write is not repeated");
  } finally { f.restore(); }
});

test("names of projects, teams and ids are encoded in the address", async () => {
  const f = withFetch(() => json({ value: [] }));
  try {
    const api = new RestApi(ctx, async () => "t");
    await api.teams("R&D / West");
    await api.branches("R&D", "a/b");
    await api.capacity("My Project", "Team #1", "id with space");
    assert.match(f.calls[0].url, /projects\/R%26D%20%2F%20West\/teams/);
    assert.match(f.calls[1].url, /\/R%26D\/_apis\/git\/repositories\/a%2Fb\/refs/);
    assert.match(f.calls[2].url, /\/My%20Project\/Team%20%231\/_apis\/work\/teamsettings\/iterations\/id%20with%20space\/capacities/);
  } finally { f.restore(); }
});

test("people that Azure DevOps leaves out (a deleted account) do not break comments, capacity, reviewers or team lists", async () => {
  const f = withFetch((c) => {
    if (/\/comments/.test(c.url)) return json({ comments: [{ id: 1, text: "<p>x</p>", createdDate: "2026-01-01T00:00:00Z" }] });
    if (/capacities/.test(c.url)) return json({ teamMembers: [{ activities: [], daysOff: [] }] });
    if (/\/members/.test(c.url)) return json({ value: [{ identity: { displayName: "Ann", uniqueName: "ann@x.example", id: "1" } }, {}, { identity: { displayName: "[P]\\Team", uniqueName: "[P]\\Team" } }] });
    return json({ value: [] });
  });
  try {
    const api = new RestApi(ctx, async () => "t");
    const cs = await api.comments("P", 1);
    assert.equal(cs[0].createdBy.displayName, "");
    const cap = await api.capacity("P", "T", "i1");
    assert.equal(cap.members[0].person.displayName, "");
    assert.deepEqual((await api.teamMembers("P", "T")).map((p) => p.displayName), ["Ann"], "groups and empty entries are left out");
  } finally { f.restore(); }
});

test("a person's picture: asked of the Graph service by the account's descriptor, once; a generated one is left to our initials", async () => {
  const f = withFetch((c) => (/aad\.gen/.test(c.url) ? json({ value: "AAAA", isAutoGenerated: true }) : json({ value: "iVBORw0KGgo=", isAutoGenerated: false })));
  try {
    const api = new RestApi(ctx, async () => "t");
    const ann = { displayName: "Ann", uniqueName: "ann@x.example", descriptor: "aad.abc", imageUrl: "https://dev.azure.com/o/_apis/GraphProfile/MemberAvatars/aad.abc" };
    assert.equal(await api.avatar(ann), "data:image/png;base64,iVBORw0KGgo=");
    assert.equal(await api.avatar({ ...ann }), "data:image/png;base64,iVBORw0KGgo=");
    assert.equal(f.calls.length, 1, "asked once");
    assert.equal(f.calls[0].url, "https://vssps.dev.azure.com/o/_apis/graph/Subjects/aad.abc/avatars?size=small&format=png&api-version=7.1-preview.1");
    // no descriptor on the person: it is the end of the picture link
    const bo = { displayName: "Bo", uniqueName: "bo@x.example", imageUrl: "https://dev.azure.com/o/_apis/GraphProfile/MemberAvatars/aad.bo%zz?x=1" };
    assert.equal(await api.avatar(bo), "data:image/png;base64,iVBORw0KGgo=");
    assert.match(f.calls[1].url, /Subjects\/aad\.bo%25zz\/avatars/, "a damaged % in the link does not throw");
    assert.equal(await api.avatar({ displayName: "Gen", uniqueName: "g", descriptor: "aad.gen" }), null);
    assert.equal(await api.avatar({ displayName: "Gen", uniqueName: "g", descriptor: "aad.gen" }), null);
    assert.equal(f.calls.length, 3, "the generated one is not asked again either");
    assert.equal(await api.avatar({ displayName: "None", uniqueName: "n" }), null, "nothing to ask with");
  } finally { f.restore(); }
});

test("service addresses of the same organization", () => {
  assert.equal(serviceUrl("https://dev.azure.com/contoso/", "vssps"), "https://vssps.dev.azure.com/contoso/");
  assert.equal(serviceUrl("https://dev.azure.com/contoso/", "extmgmt"), "https://extmgmt.dev.azure.com/contoso/");
  assert.equal(serviceUrl("https://contoso.visualstudio.com/", "vssps"), "https://contoso.vssps.visualstudio.com/");
  assert.equal(serviceUrl("https://tfs.example.com/tfs/Coll/", "vssps"), "https://tfs.example.com/tfs/Coll/");
});
