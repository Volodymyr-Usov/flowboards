import { test } from "node:test";
import assert from "node:assert/strict";
import { REL } from "../src/api/api.ts";
import type { Api } from "../src/api/api.ts";
import type { ProcessInfo, QuerySpec, WorkItem } from "../src/api/types.ts";
import type { ChangeLog } from "../src/core/changelog.ts";
import { Workspace } from "../src/core/workspace.ts";
import { Writer } from "../src/core/writes.ts";

const S = [
  { name: "New", category: "Proposed" as const, color: "#888888" },
  { name: "Doing", category: "InProgress" as const, color: "#888888" },
  { name: "Done", category: "Completed" as const, color: "#888888" },
  { name: "Gone", category: "Removed" as const, color: "#888888" },
];
const P: ProcessInfo = {
  levels: [
    { id: "a", name: "Features", kind: "portfolio", rank: 0, types: ["Feature"], defaultType: "Feature" },
    { id: "b", name: "Stories", kind: "requirement", rank: 1, types: ["Story"], defaultType: "Story" },
  ],
  types: { Feature: { name: "Feature", color: "#000000", states: S }, Story: { name: "Story", color: "#000000", states: S } },
  fields: { order: "o", effort: "e", remaining: "r", activity: "", completed: "", original: "" },
  bugsBehavior: "off",
};
const cat = { New: "Proposed", Doing: "InProgress", Done: "Completed", Gone: "Removed" } as const;
const OLD = "2026-01-01T00:00:00Z";
function item(id: number, state: keyof typeof cat, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id, rev: 1, type: "Story", title: `Story ${id}`, state, category: cat[state], area: "P\\Team", iteration: "P", tags: [],
    created: OLD, changed: OLD, fields: {}, ...extra,
  };
}
const link = (rel: string, id: number) => ({ rel, url: `https://dev.azure.com/o/_apis/wit/workItems/${id}`, attributes: {} });

/** A server in memory: items by id, the ids "changed" since the last sync, and the ids in the team's scope. */
function fakeServer() {
  const s = {
    items: new Map<number, WorkItem>(),
    changed: [] as number[],
    scope: null as number[] | null,
    failItems: false,
    queries: 0,
    asked: [] as number[][],
    delay: 0,
  };
  const api = {
    ctx: { orgUrl: "https://dev.azure.com/o/" },
    async query(_p: string, spec: QuerySpec) {
      s.queries++;
      if (spec.changedAfter) return spec.ids ? s.changed.filter((i) => spec.ids!.includes(i)) : s.changed;
      if (spec.states) return []; // the "closed lately" half of the team query
      return s.scope ?? [...s.items.keys()];
    },
    async items(_p: string, ids: number[]) {
      s.asked.push(ids);
      if (s.delay) await new Promise((r) => setTimeout(r, s.delay));
      if (s.failItems) throw new Error("network");
      return ids.map((i) => s.items.get(i)).filter((x): x is WorkItem => !!x).map((x) => structuredClone(x));
    },
  } as unknown as Api;
  return { s, api };
}

function workspace(api: Api, held: WorkItem[]): Workspace {
  const ws = new Workspace(api, "P", "Team");
  ws.process = P;
  ws.settings = { bugsBehavior: "off", workingDays: [], areas: [{ path: "P\\Team", includeChildren: true }] };
  ws.status = "live";
  ws.lastSync = "2026-10-01T00:00:00.000Z";
  for (const it of held) ws.items.set(it.id, it);
  return ws;
}

test("a failed read keeps the last sync time, so the change is read next time", async () => {
  const { s, api } = fakeServer();
  const ws = workspace(api, [item(1, "New")]);
  s.items.set(1, item(1, "Doing", { rev: 2, changed: "2026-10-02T09:00:00.000Z" }));
  s.changed = [1];
  s.failItems = true;
  await ws.poll();
  assert.equal(ws.lastSync, "2026-10-01T00:00:00.000Z");
  assert.equal(ws.status, "error");
  s.failItems = false;
  await ws.poll();
  assert.equal(ws.get(1)?.state, "Doing");
  assert.notEqual(ws.lastSync, "2026-10-01T00:00:00.000Z");
  assert.ok(ws.lastSync <= "2026-10-02T09:00:00.000Z", "the mark is the change's time (Azure DevOps's clock), not this computer's");
  assert.equal(ws.status, "live");
});

test("an older revision does not replace a newer one", async () => {
  const { s, api } = fakeServer();
  const ws = workspace(api, [item(1, "Done", { rev: 5 })]);
  s.items.set(1, item(1, "Doing", { rev: 4 }));
  s.changed = [1];
  await ws.poll();
  assert.equal(ws.get(1)?.rev, 5);
  assert.equal((await ws.refresh(1))?.rev, 5);
  assert.equal(ws.get(1)?.state, "Done");
  // a newer removed revision takes it out, and an older answer cannot bring it back
  s.items.set(1, item(1, "Gone", { rev: 6 }));
  await ws.poll();
  assert.equal(ws.get(1), undefined);
  s.items.set(1, item(1, "Doing", { rev: 5 }));
  await ws.poll();
  assert.equal(ws.get(1), undefined);
});

test("a second poll does not start while one runs", async () => {
  const { s, api } = fakeServer();
  const ws = workspace(api, [item(1, "New")]);
  s.items.set(1, item(1, "Doing", { rev: 2 }));
  s.changed = [1];
  s.delay = 30;
  const first = ws.poll();
  await ws.poll();
  await first;
  assert.equal(s.asked.length, 1);
});

test("every 10th poll drops items that left the team's work, keeping parents and fresh changes", async () => {
  const { s, api } = fakeServer();
  const now = new Date().toISOString();
  const parent = item(10, "Doing", { type: "Feature", area: "Other" });
  const ws = workspace(api, [parent, item(1, "Doing", { parent: 10 }), item(2, "Doing"), item(3, "Doing", { changed: now })]);
  s.scope = [1]; // 2 left the area (or was deleted); 3 changed just now
  for (let i = 0; i < 9; i++) await ws.poll();
  assert.equal(ws.items.size, 4);
  await ws.poll();
  assert.deepEqual([...ws.items.keys()].sort((a, b) => a - b), [1, 3, 10]);
});

test("a parent that cannot be read is not asked for again", async () => {
  const { s, api } = fakeServer();
  const ws = workspace(api, [item(1, "Doing", { parent: 99 })]);
  await ws.poll();
  await ws.poll();
  assert.deepEqual(s.asked, [[99]]);
});

test("rule facts read linked children and predecessors that are not loaded", async () => {
  const { s, api } = fakeServer();
  const feature = item(1, "Doing", { type: "Feature", relations: [link(REL.child, 2), link(REL.child, 3), link(REL.child, 5), link(REL.predecessor, 4)] });
  const ws = workspace(api, [feature, item(2, "Done", { parent: 1 })]);
  s.items.set(3, item(3, "Doing", { parent: 1, area: "Other" })); // another team's area
  s.items.set(4, item(4, "Done")); // closed long ago
  s.items.set(5, item(5, "Gone", { parent: 1 })); // removed: does not count
  const log = { add: async () => {} } as unknown as ChangeLog;
  const rules = [{ id: "r", level: "*" as const, target: "Done", requires: ["childrenDone" as const, "noOpenPredecessors" as const], onlyBy: [] }];
  const w = new Writer(ws, log, () => rules, { displayName: "Me", uniqueName: "me@x.example" });
  const f = await w.facts(1);
  assert.equal(f.children, 2);
  assert.equal(f.openChildren, 1);
  assert.equal(f.openPredecessors, 0);
  assert.equal(ws.get(3), undefined, "items read for a check are not added to the team's work");
});

test("rule facts: a pull request that cannot be read counts as open; one that is gone does not", async () => {
  const { api } = fakeServer();
  const pr = (id: number, status: string) => ({ id, status });
  const answers: Record<number, () => Promise<unknown>> = {
    1: async () => pr(1, "completed"),
    2: async () => pr(2, "active"),
    3: async () => null,
    4: async () => { throw new Error("network"); },
    5: async () => pr(5, "draft"),
  };
  (api as unknown as { pullRequest: (id: number) => Promise<unknown> }).pullRequest = (id) => answers[id]();
  const art = (id: number) => ({ rel: REL.artifact, url: `vstfs:///Git/PullRequestId/p%2Fr%2F${id}`, attributes: {} });
  const ws = workspace(api, [item(1, "Doing", { relations: [1, 2, 3, 4, 5].map(art) })]);
  const log = { add: async () => {} } as unknown as ChangeLog;
  const rules = [{ id: "r", level: "*" as const, target: "Done", requires: ["prsMerged" as const], onlyBy: [] }];
  const w = new Writer(ws, log, () => rules, { displayName: "Me", uniqueName: "me@x.example" });
  assert.equal((await w.facts(1)).openPrs, 3, "active, draft and the unreadable one");
  answers[4] = async () => pr(4, "abandoned");
  assert.equal((await w.facts(1)).openPrs, 2);
});

/** A writer on the fake server, with its own change log in memory. */
function writer(api: Api, ws: Workspace) {
  const entries: { action: string; ok: boolean; error?: string; itemId: number }[] = [];
  const log = { add: async (e: { action: string; ok: boolean; error?: string; itemId: number }) => { entries.push(e); } } as unknown as ChangeLog;
  return { w: new Writer(ws, log, () => [], { displayName: "Me", uniqueName: "me@x.example" }), entries };
}

test("a priority change keeps the revision it knows; the next read replaces the copy whatever its revision", async () => {
  const { s, api } = fakeServer();
  // this server does not count a priority change as a new revision
  (api as unknown as { reorder: () => Promise<{ id: number; order: number }[]> }).reorder = async () => [{ id: 1, order: 5 }];
  const ws = workspace(api, [item(1, "New", { rev: 3, order: 10 }), item(2, "New", { order: 1 })]);
  s.items.set(1, item(1, "New", { rev: 3, order: 5 }));
  const { w } = writer(api, ws);
  const r = await w.reorder(1, 0, 2);
  assert.equal(r.item.rev, 3, "no guessed revision");
  assert.equal(r.item.order, 5);
  // the read after the change (same revision) replaces the guessed copy
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(ws.get(1)?.stale, undefined);
  assert.equal(ws.get(1)?.rev, 3);
});

test("a copy marked as a guess is replaced by a poll even with the same or an older revision", async () => {
  const { s, api } = fakeServer();
  const ws = workspace(api, [item(1, "New", { rev: 4 })]);
  ws.markStale(1);
  s.items.set(1, item(1, "Doing", { rev: 4 }));
  s.changed = [1];
  await ws.poll();
  assert.equal(ws.get(1)?.state, "Doing");
  ws.markStale(1);
  s.items.set(1, item(1, "Done", { rev: 2 }));
  assert.equal((await ws.refresh(1))?.state, "Done");
});

test("re-parenting: never under itself, and the old parent link is removed from a fresh read", async () => {
  const { s, api } = fakeServer();
  const sent: unknown[][] = [];
  (api as unknown as { update: (p: string, id: number, ops: unknown[], o: { rev?: number }) => Promise<WorkItem> }).update = async (_p, id, ops, o) => {
    sent.push(ops);
    assert.equal(o.rev, 2, "sent with the revision just read");
    return item(id, "New", { rev: 3, parent: 11 });
  };
  // the workspace thinks #1 has no links; Azure DevOps has its parent link at place 1
  const ws = workspace(api, [item(1, "New", { parent: 10, relations: [] }), item(10, "New", { type: "Feature" }), item(11, "New", { type: "Feature" })]);
  s.items.set(1, item(1, "New", { rev: 2, parent: 10, relations: [link(REL.related, 5), link(REL.parent, 10)] }));
  const { w } = writer(api, ws);
  await assert.rejects(w.reparent(1, 1), /under itself/);
  await w.reparent(1, 11);
  assert.deepEqual((sent[0] as { op: string; path: string }[]).map((o) => `${o.op} ${o.path}`), ["remove /relations/1", "add /relations/-"]);
});

test("a failed comment is written to the change log; so are changes that are not work items", async () => {
  const { api } = fakeServer();
  (api as unknown as { addComment: () => Promise<never> }).addComment = async () => { throw new Error("refused"); };
  (api as unknown as { renameTag: () => Promise<void> }).renameTag = async () => {};
  const ws = workspace(api, [item(1, "New")]);
  const { w, entries } = writer(api, ws);
  await assert.rejects(w.comment(1, "<p>hi</p>"), /refused/);
  await w.renameTag("P", "t1", "ux", "ui");
  assert.deepEqual(entries.map((e) => [e.action, e.ok]), [["Comment: hi", false], ["Tag renamed: ui → ux", true]]);
  assert.equal(entries[0].error, "refused");
  assert.equal(entries[1].itemId, 0);
});

test("a poll that fails lets the next poll run", async () => {
  const { s, api } = fakeServer();
  const ws = workspace(api, [item(1, "New")]);
  s.failItems = true;
  s.changed = [1];
  await ws.poll();
  s.failItems = false;
  s.items.set(1, item(1, "Doing", { rev: 2 }));
  await ws.poll();
  assert.equal(ws.get(1)?.state, "Doing");
});

test("Undo of a field change sends back exactly what was there: old values, removed fields removed, people by account", async () => {
  const { api } = fakeServer();
  const sent: { op: string; path: string; value?: unknown }[][] = [];
  const ann = { id: "u1", displayName: "Ann", uniqueName: "ann@x.example" };
  const start = item(1, "New", { rev: 1, fields: { "System.Title": "Old", "System.Tags": "a; b", "System.AssignedTo": ann, "Microsoft.VSTS.Scheduling.StoryPoints": 0 } });
  // the server applies the change and answers with the item as it is now
  let fields: Record<string, unknown> = { ...start.fields };
  let rev = 1;
  (api as unknown as { update: (p: string, id: number, ops: { op: string; path: string; value?: unknown }[]) => Promise<WorkItem> }).update = async (_p, id, ops) => {
    sent.push(ops);
    fields = { ...fields };
    for (const o of ops) {
      const f = o.path.replace("/fields/", "");
      if (o.op === "remove") delete fields[f]; else fields[f] = f === "System.AssignedTo" ? { id: "u2", displayName: "Bo", uniqueName: o.value } : o.value;
    }
    return item(id, "New", { rev: ++rev, fields });
  };
  const ws = workspace(api, [start]);
  const { w } = writer(api, ws);
  const r = await w.setFields(1, [
    { field: "System.Title", value: "New" },
    { field: "System.Tags", value: "" },
    { field: "System.AssignedTo", value: "bo@x.example" },
    { field: "Microsoft.VSTS.Scheduling.StoryPoints", value: 5 },
    { field: "Custom.Notes", value: "hello" },
    { field: "Custom.Empty", value: "" },
  ]);
  assert.deepEqual(sent[0].map((o) => `${o.op} ${o.path}`), [
    "add /fields/System.Title", "remove /fields/System.Tags", "add /fields/System.AssignedTo",
    "add /fields/Microsoft.VSTS.Scheduling.StoryPoints", "add /fields/Custom.Notes",
  ], "a field that was empty and stays empty is not sent");
  await r.undo!();
  assert.deepEqual(sent[1], [
    { op: "add", path: "/fields/System.Title", value: "Old" },
    { op: "add", path: "/fields/System.Tags", value: "a; b" },
    { op: "add", path: "/fields/System.AssignedTo", value: "ann@x.example" },
    { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.StoryPoints", value: 0 },
    { op: "remove", path: "/fields/Custom.Notes" },
  ], "zero stays zero, a field that did not exist is removed again");
});

test("moving to a board column sets the column and the state it maps to; Undo goes back to both; a rule can stop it", async () => {
  const { api } = fakeServer();
  const sent: { op: string; path: string; value?: unknown }[][] = [];
  const revs: number[] = [];
  let cur = item(1, "New", { rev: 1, boardColumn: "Ready", fields: { "System.BoardColumn": "Ready" } });
  (api as unknown as { update: (p: string, id: number, ops: { op: string; path: string; value?: unknown }[], o: { rev?: number }) => Promise<WorkItem> }).update = async (_p, id, ops, o) => {
    sent.push(ops);
    revs.push(o.rev ?? 0);
    const col = ops.find((x) => x.path === "/fields/Custom.Column")?.value as string | undefined;
    const state = (ops.find((x) => x.path === "/fields/System.State")?.value as keyof typeof cat | undefined) ?? (cur.state as keyof typeof cat);
    cur = item(id, state, { rev: cur.rev + 1, boardColumn: col ?? cur.boardColumn, fields: { "System.BoardColumn": col ?? cur.boardColumn } });
    return cur;
  };
  const ws = workspace(api, [cur]);
  ws.board = {
    name: "Stories", columnField: "Custom.Column", rows: [],
    columns: [
      { id: "1", name: "Ready", itemLimit: 0, stateMappings: { Story: "New" }, isSplit: false, columnType: "incoming" },
      { id: "2", name: "Working", itemLimit: 0, stateMappings: { Story: "Doing" }, isSplit: false, columnType: "inProgress" },
    ],
  };
  const { w } = writer(api, ws);
  const r = await w.move(1, { column: "Working" });
  assert.deepEqual(sent[0], [{ op: "add", path: "/fields/System.State", value: "Doing" }, { op: "add", path: "/fields/Custom.Column", value: "Working" }]);
  assert.equal(revs[0], 1, "sent with the revision the page saw");
  await r.undo!();
  assert.deepEqual(sent[1], [{ op: "add", path: "/fields/System.State", value: "New" }, { op: "add", path: "/fields/Custom.Column", value: "Ready" }]);
  assert.equal(ws.get(1)?.state, "New");
  assert.equal(ws.get(1)?.boardColumn, "Ready");
  sent.length = 0;
  // a rule that is not met stops the move; "move anyway" sends it, a rule on who may move cannot be skipped
  const rules = [{ id: "r1", level: "*" as const, target: "Working", requires: ["owner" as const], onlyBy: [] }, { id: "r2", level: "*" as const, target: "Working", requires: [] as never[], onlyBy: ["boss@x.example"] }];
  const strict = new Writer(ws, { add: async () => {} } as unknown as ChangeLog, () => rules, { displayName: "Me", uniqueName: "me@x.example" });
  await assert.rejects(strict.move(1, { column: "Working" }), (e: Error) => e.name === "Error" && /owner|Only/.test(e.message));
  await assert.rejects(strict.move(1, { column: "Working" }, { force: true }), /Only boss@x\.example/);
  assert.equal(sent.length, 0, "nothing was sent");
  const lenient = new Writer(ws, { add: async () => {} } as unknown as ChangeLog, () => rules.slice(0, 1), { displayName: "Me", uniqueName: "me@x.example" });
  await assert.rejects(lenient.move(1, { column: "Working" }), /Owner/);
  const forced = await lenient.move(1, { column: "Working" }, { force: true });
  assert.equal(forced.item.boardColumn, "Working");
  assert.equal(sent.length, 1);
});

test("a change sent for an old revision is refused and the copy is marked to be read again", async () => {
  const { s, api } = fakeServer();
  (api as unknown as { update: () => Promise<never> }).update = async () => { throw Object.assign(new Error("changed"), { status: 412 }); };
  const ws = workspace(api, [item(1, "New", { rev: 1 })]);
  s.items.set(1, item(1, "Doing", { rev: 4 }));
  const { w, entries } = writer(api, ws);
  await assert.rejects(w.setFields(1, [{ field: "System.Title", value: "Mine" }]), /changed/);
  assert.equal(entries[0].ok, false);
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(ws.get(1)?.rev, 4, "what Azure DevOps has now replaces our copy");
  assert.equal(ws.get(1)?.state, "Doing");
});

test("a link to an item outside the team's work does not bring that item into the workspace", async () => {
  const { s, api } = fakeServer();
  const update = (api as unknown as { update: (p: string, id: number) => Promise<WorkItem> });
  update.update = async (_p, id) => item(id, "New", { rev: 3, relations: [link(REL.predecessor, 99)] });
  const ws = workspace(api, [item(1, "New", { rev: 2, relations: [] })]);
  s.items.set(99, item(99, "Doing", { area: "Other" }));
  const { w } = writer(api, ws);
  const added = await w.addLink(1, REL.predecessor, 99);
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(ws.get(99), undefined, "the other end is not the team's");
  assert.deepEqual(s.asked.flat().filter((i) => i === 99), [], "and is not even read");
  // removing it: the same
  await w.removeLink(1, REL.predecessor, 99);
  await added.undo?.();
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(ws.get(99), undefined);
  // an item that is part of the work is still read again after a link
  s.items.set(2, item(2, "New", { rev: 5 }));
  ws.items.set(2, item(2, "New", { rev: 1 }));
  await w.addLink(1, REL.related, 2);
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(ws.get(2)?.rev, 5);
});

test("a write right after a priority change reads the guessed copy first, so its revision is current", async () => {
  const { s, api } = fakeServer();
  const sent: (number | undefined)[] = [];
  // this server counts the priority change as a new revision (3 -> 4)
  (api as unknown as { reorder: () => Promise<{ id: number; order: number }[]> }).reorder = async () => {
    s.items.set(1, item(1, "New", { rev: 4, order: 5 }));
    return [{ id: 1, order: 5 }];
  };
  (api as unknown as { update: (p: string, id: number, ops: unknown[], o: { rev?: number }) => Promise<WorkItem> }).update = async (_p, id, _ops, o) => {
    sent.push(o.rev);
    const cur = s.items.get(id)!;
    if (o.rev !== undefined && o.rev !== cur.rev) throw Object.assign(new Error("changed"), { status: 412 });
    const next = { ...cur, rev: cur.rev + 1, state: "Doing" };
    s.items.set(id, next);
    return structuredClone(next);
  };
  const ws = workspace(api, [item(1, "New", { rev: 3, order: 10 }), item(2, "New", { order: 1 })]);
  s.items.set(1, item(1, "New", { rev: 3, order: 10 }));
  const { w } = writer(api, ws);
  s.delay = 30; // reads are slow, as on a real network
  await w.reorder(1, 0, 2);
  // no waiting for the background read: the next write must not send revision 3
  const r = await w.setFields(1, [{ field: "System.State", value: "Doing" }]);
  assert.deepEqual(sent, [4]);
  assert.equal(r.item.rev, 5);
});
