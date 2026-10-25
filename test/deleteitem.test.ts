import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO, DemoApi } from "../src/api/demo.ts";
import { readOnlyApi } from "../src/api/readonly.ts";
import type { ChangeLog } from "../src/core/changelog.ts";
import { Workspace } from "../src/core/workspace.ts";
import { Writer } from "../src/core/writes.ts";

async function setup() {
  const api = new DemoApi({ latencyMs: 0 });
  const ws = new Workspace(api, DEMO.project, DEMO.team);
  await ws.load();
  const actions: string[] = [];
  const log = { add: async (e: { action: string; ok: boolean }) => { actions.push(`${e.action}:${e.ok}`); } } as unknown as ChangeLog;
  const w = new Writer(ws, log, () => [], { displayName: "Me", uniqueName: "me@x.example" });
  const task = [...ws.items.values()].find((i) => i.type === "Task" && i.parent && ws.get(i.parent))!;
  return { api, ws, w, task, actions };
}

test("deleting a task: gone from the team's work and its parent's children at once; Undo brings it back", async () => {
  const { api, ws, w, task, actions } = await setup();
  const parent = task.parent!;
  const changed: number[][] = [];
  ws.onChange((c) => changed.push([...c]));
  const r = await w.deleteItem(task.id);
  assert.equal(ws.get(task.id), undefined);
  assert.ok(!ws.children(parent).some((k) => k.id === task.id));
  assert.ok(changed.some((c) => c.includes(task.id) && c.includes(parent)), "the parent redraws too");
  assert.deepEqual(await api.items(DEMO.project, [task.id]), [], "not readable while in the Recycle Bin");
  await r.undo!();
  assert.equal(ws.get(task.id)?.title, task.title);
  assert.ok(ws.children(parent).some((k) => k.id === task.id));
  assert.deepEqual(actions, ["Deleted Task:true", "Restored Task:true"]);
});

test("a refused delete keeps the task and is logged as failed", async () => {
  const { ws, w, task, actions } = await setup();
  (ws.api as unknown as { deleteItem: () => Promise<void> }).deleteItem = async () => { throw Object.assign(new Error("no permission"), { status: 403 }); };
  await assert.rejects(w.deleteItem(task.id), /no permission/);
  assert.equal(ws.get(task.id)?.id, task.id);
  assert.deepEqual(actions, ["Deleted Task:false"]);
});

test("read-only mode refuses deleting and restoring", async () => {
  const ro = readOnlyApi(new DemoApi({ latencyMs: 0 }));
  await assert.rejects(ro.deleteItem(DEMO.project, 1), /Read-only/);
  await assert.rejects(ro.restoreItem(DEMO.project, 1), /Read-only/);
});

test("Recycle Bin: lists deleted items newest first, with who and when; restore brings one back, Undo deletes it again", async () => {
  const { api, ws, w, task } = await setup();
  const before = await api.deletedItems(DEMO.project);
  assert.ok(before.length >= 1, "the demo starts with a few deleted tasks");
  await w.deleteItem(task.id);
  const bin = await api.deletedItems(DEMO.project);
  assert.equal(bin[0].id, task.id, "newest first");
  assert.equal(bin[0].title, task.title);
  assert.equal(bin[0].deletedBy?.displayName, api.ctx.me.displayName);
  assert.ok(bin.every((d, i) => i === 0 || d.deletedDate <= bin[i - 1].deletedDate));
  const r = await w.restoreDeleted(bin[0]);
  assert.ok(!(await api.deletedItems(DEMO.project)).some((d) => d.id === task.id));
  await ws.refresh(task.id);
  assert.equal(ws.get(task.id)?.title, task.title);
  await r.undo();
  assert.equal(ws.get(task.id), undefined);
  assert.ok((await api.deletedItems(DEMO.project)).some((d) => d.id === task.id));
});

test("Recycle Bin search: every word must match the id, title, type or who deleted it", async () => {
  const { binMatch } = await import("../src/views/recyclebin.ts");
  const d = { id: 412, title: "Write release notes", type: "Task", deletedBy: { displayName: "Ann Lee", uniqueName: "ann@x.example" }, deletedDate: "2026-10-20T10:00:00Z" };
  assert.ok(binMatch(d, ""));
  assert.ok(binMatch(d, "release task"));
  assert.ok(binMatch(d, "#412"));
  assert.ok(binMatch(d, "ann"));
  assert.ok(!binMatch(d, "release bug"));
});

test("Recycle Bin: the team filter follows the team's areas (children only when included); no areas known means everything", async () => {
  const { inTeamAreas } = await import("../src/views/recyclebin.ts");
  const areas = [{ path: "P\\A", includeChildren: true }, { path: "P\\B", includeChildren: false }];
  assert.ok(inTeamAreas("P\\A", areas));
  assert.ok(inTeamAreas("P\\A\\Sub", areas));
  assert.ok(inTeamAreas("P\\B", areas));
  assert.ok(!inTeamAreas("P\\B\\Sub", areas));
  assert.ok(!inTeamAreas("P\\AB", areas));
  assert.ok(inTeamAreas("Q", []));
});

test("the demo Recycle Bin gives each deleted item's area", async () => {
  const api = new DemoApi({ latencyMs: 0 });
  const list = await api.deletedItems(DEMO.project);
  assert.ok(list.length > 0);
  assert.equal(typeof (await api.deletedArea(DEMO.project, list[0].id)), "string");
});

test("inTeamAreas lives in core/model and is the one the Recycle Bin, Health and Tags use", async () => {
  const { inTeamAreas } = await import("../src/core/model.ts");
  assert.ok(inTeamAreas("P\\A\\x", [{ path: "P\\A", includeChildren: true }]));
  assert.ok(!inTeamAreas("P\\C", [{ path: "P\\A", includeChildren: true }]));
});
