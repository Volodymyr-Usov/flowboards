import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO, DemoApi } from "../src/api/demo.ts";
import { missingFieldName, RestApi, safeToRepeat } from "../src/api/rest.ts";
import { matchesNothing, toWiql } from "../src/api/wiql.ts";

test("an empty list of ids, parents, types or states matches nothing", async () => {
  for (const spec of [{ ids: [] }, { parents: [] }, { types: [] }, { states: [] }]) {
    assert.equal(matchesNothing(spec), true);
    assert.match(toWiql(spec, "P"), /\[System\.Id\] < 0/);
  }
  assert.equal(matchesNothing({ notStates: [], types: ["Bug"] }), false);
  assert.doesNotMatch(toWiql({ types: ["Bug"] }, "P"), /< 0/);
  const demo = new DemoApi({ latencyMs: 0 });
  assert.deepEqual(await demo.query(DEMO.project, { ids: [] }), []);
  assert.deepEqual(await demo.query(DEMO.project, { types: ["User Story"], states: [] }), []);
  assert.ok((await demo.query(DEMO.project, { types: ["User Story"] })).length > 0);
});

test("only reads are repeated after a lost answer", () => {
  const org = "https://dev.azure.com/o/";
  assert.equal(safeToRepeat("GET", `${org}P/_apis/wit/workitems/1?api-version=7.1`), true);
  assert.equal(safeToRepeat("POST", `${org}P/_apis/wit/wiql?$top=5&api-version=7.1`), true);
  assert.equal(safeToRepeat("POST", `${org}_apis/wit/wiql?api-version=7.1`), true);
  assert.equal(safeToRepeat("POST", `${org}P/_apis/wit/workitemsbatch?api-version=7.1`), true);
  assert.equal(safeToRepeat("POST", `${org}P/_apis/git/repositories/r1/FileDiffs?api-version=7.1`), true);
  assert.equal(safeToRepeat("POST", `${org}P/_apis/wit/workitems/$Bug?api-version=7.1`), false);
  assert.equal(safeToRepeat("POST", `${org}P/_apis/wit/workItems/5/comments?api-version=7.1-preview.4`), false);
  assert.equal(safeToRepeat("PATCH", `${org}P/_apis/wit/workitems/5?api-version=7.1`), false);
  assert.equal(safeToRepeat("PUT", `${org}P/_apis/work/boards/b/columns?api-version=7.1`), false);
});

test("the missing field name has no full stop or quote", () => {
  assert.equal(missingFieldName("TF51535: Cannot find field Custom.Size."), "Custom.Size");
  assert.equal(missingFieldName("TF51535: Cannot find field 'Custom.Size'."), "Custom.Size");
  assert.equal(missingFieldName("Something else"), undefined);
});

type Call = { method: string; url: string; body?: string };
function withFetch(answer: (c: Call, n: number) => Response | Error): { calls: Call[]; restore: () => void } {
  const g = globalThis as unknown as { fetch: typeof fetch };
  const old = g.fetch;
  const calls: Call[] = [];
  g.fetch = (async (url: string, init: { method: string; body?: string }) => {
    const c = { method: init.method, url, body: init.body };
    calls.push(c);
    const a = answer(c, calls.length);
    if (a instanceof Error) throw a;
    return a;
  }) as unknown as typeof fetch;
  return { calls, restore: () => { g.fetch = old; } };
}

const ctx = { orgName: "o", orgUrl: "https://dev.azure.com/o/", me: { displayName: "Me", uniqueName: "me@x.example" }, demo: false };
const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

test("a write is not sent again when the network fails; a read is", async () => {
  const f = withFetch((c, n) => (n === 1 ? new Error("offline") : json({ id: 1, text: "x", createdBy: null })));
  try {
    const api = new RestApi(ctx, async () => "t");
    await assert.rejects(api.addComment("P", 1, "hi"), /may or may not be saved/);
    assert.equal(f.calls.length, 1);
    f.calls.length = 0;
    const r = await api.req("GET", "https://dev.azure.com/o/_apis/projects?api-version=7.1");
    assert.equal(r.id, 1);
    assert.equal(f.calls.length, 2);
  } finally { f.restore(); }
});

test("a missing field is dropped and asked again; no progress gives the error", async () => {
  const f = withFetch((c) => {
    const body = JSON.parse(c.body ?? "{}");
    if (body.fields?.includes("Custom.Gone")) return json({ message: "TF51535: Cannot find field Custom.Gone." }, 400);
    return json({ value: [] });
  });
  try {
    const api = new RestApi(ctx, async () => "t");
    assert.deepEqual(await api.items("P", [1], { fields: ["Custom.Gone"] }), []);
    assert.equal(f.calls.length, 2);
    // known missing now: not sent at all
    await api.items("P", [1], { fields: ["Custom.Gone"] });
    assert.equal(f.calls.length, 3);
    // another project still asks for it
    await api.items("Q", [1], { fields: ["Custom.Gone"] });
    assert.equal(f.calls.length, 5);
  } finally { f.restore(); }
  const g = withFetch(() => json({ message: "TF51535: Cannot find field Custom.NotAsked." }, 400));
  try {
    const api = new RestApi(ctx, async () => "t");
    await assert.rejects(api.items("P", [1]), /Custom\.NotAsked/);
    assert.equal(g.calls.length, 1);
  } finally { g.restore(); }
});
