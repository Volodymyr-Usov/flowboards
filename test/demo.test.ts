import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO, DemoApi } from "../src/api/demo.ts";

test("the demo answers like Azure DevOps and keeps writes", async () => {
  const api = new DemoApi({ latencyMs: 0 });
  const ids = await api.query(DEMO.project, { types: ["User Story"], notStates: ["Removed"] });
  assert.ok(ids.length > 30);
  const [s] = await api.items(DEMO.project, [ids[0]]);
  assert.equal(s.type, "User Story");
  const moved = await api.update(DEMO.project, s.id, [{ op: "add", path: "/fields/System.State", value: "Active" }], { rev: s.rev });
  assert.equal(moved.state, "Active");
  assert.equal(moved.category, "InProgress");
  await assert.rejects(api.update(DEMO.project, s.id, [{ op: "add", path: "/fields/System.Title", value: "x" }], { rev: s.rev }), /changed by someone else/);
  assert.equal((await api.query(DEMO.project, { states: ["Removed"] })).length, 1);
});

test("re-parenting moves the child link", async () => {
  const api = new DemoApi({ latencyMs: 0 });
  const feats = await api.query(DEMO.project, { types: ["Feature"] });
  const kids = await api.query(DEMO.project, { types: ["User Story"], parents: [feats[0]] });
  const [story] = await api.items(DEMO.project, kids.slice(0, 1), { relations: true });
  const idx = story.relations!.findIndex((r) => r.rel.endsWith("Hierarchy-Reverse"));
  const after = await api.update(DEMO.project, story.id, [
    { op: "remove", path: `/relations/${idx}` },
    { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${api.ctx.orgUrl}_apis/wit/workItems/${feats[1]}` } },
  ]);
  assert.equal(after.parent, feats[1]);
  assert.ok((await api.query(DEMO.project, { parents: [feats[1]] })).includes(story.id));
});

test("the demo answers a list read with the fields asked for only, like Azure DevOps", async () => {
  const api = new DemoApi({ latencyMs: 0 });
  const F = "Microsoft.VSTS.Common.BusinessValue";
  const ids = await api.query(DEMO.project, { types: ["Feature"] });
  const [plain] = await api.items(DEMO.project, ids.slice(0, 1));
  assert.equal(F in plain.fields, false);
  assert.ok(plain.fieldsRead?.includes("System.Title"));
  const [asked] = await api.items(DEMO.project, ids.slice(0, 1), { fields: [F] });
  assert.ok(asked.fields[F] != null);
  const [full] = await api.items(DEMO.project, ids.slice(0, 1), { relations: true });
  assert.equal(full.fieldsRead, undefined);
  assert.ok(full.fields[F] != null);
});

test("a priority change in the demo is a new revision in the history, as in Azure DevOps", async () => {
  const api = new DemoApi({ latencyMs: 0 });
  const ids = await api.query(DEMO.project, { types: ["User Story"], notStates: ["Removed"] });
  const [before] = await api.items(DEMO.project, [ids[0]]);
  await api.reorder(DEMO.project, DEMO.team, [ids[0]], 0, ids[1]);
  const [after] = await api.items(DEMO.project, [ids[0]]);
  assert.equal(after.rev, before.rev + 1);
  const ups = await api.updates(DEMO.project, ids[0]);
  assert.ok(ups[ups.length - 1].changes.some((c) => c.field === "Microsoft.VSTS.Common.StackRank"));
});

test("demo storage checks versions: an older save and a second create are refused", async () => {
  const api = new DemoApi({ latencyMs: 0 });
  const a = await api.createDoc("c", { id: "x", n: 1 }, "shared");
  await assert.rejects(api.createDoc("c", { id: "x", n: 2 }, "shared"), (e: { status?: number }) => e.status === 409);
  const b = await api.setDoc("c", { ...a, n: 3 }, "shared");
  await assert.rejects(api.setDoc("c", { ...a, n: 4 }, "shared"), (e: { status?: number }) => e.status === 409);
  assert.equal((await api.getDoc("c", "x", "shared"))?.n, 3);
  await api.setDoc("c", { id: "x", __etag: -1, n: 5 }, "shared");
  assert.equal((await api.getDoc("c", "x", "shared"))?.__etag, (b.__etag ?? 0) + 1);
});
