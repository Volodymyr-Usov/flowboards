// Saves never overwrite a teammate's newer change unseen; Undo does not either; tags are changed one by one;
// a move by state passes the rules of the board column it lands in; the poll keeps Azure DevOps's time.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api } from "../src/api/api.ts";
import type { BoardInfo, PatchOp, ProcessInfo, QuerySpec, WorkItem } from "../src/api/types.ts";
import type { ChangeLog } from "../src/core/changelog.ts";
import type { Rule } from "../src/core/rules.ts";
import { syncMark, SYNC_OVERLAP, Workspace } from "../src/core/workspace.ts";
import { applyTags, ConflictError, sameValue, Writer } from "../src/core/writes.ts";
import { failedSteps } from "../src/ui/actions.ts";

const S = [
  { name: "New", category: "Proposed" as const, color: "#888888" },
  { name: "Doing", category: "InProgress" as const, color: "#888888" },
  { name: "Done", category: "Completed" as const, color: "#888888" },
];
const P: ProcessInfo = {
  levels: [{ id: "b", name: "Stories", kind: "requirement", rank: 1, types: ["Story"], defaultType: "Story" }],
  types: { Story: { name: "Story", color: "#000000", states: S } },
  fields: { order: "o", effort: "e", remaining: "r", activity: "", completed: "", original: "" },
  bugsBehavior: "off",
};
const CAT: Record<string, "Proposed" | "InProgress" | "Completed"> = { New: "Proposed", Doing: "InProgress", Done: "Completed" };
const DESC = "System.Description";

function item(id: number, rev: number, fields: Record<string, unknown> = {}, extra: Partial<WorkItem> = {}): WorkItem {
  const state = String(fields["System.State"] ?? "New");
  const tags = fields["System.Tags"] ? String(fields["System.Tags"]).split(/;\s*/).filter(Boolean) : [];
  return {
    id, rev, type: "Story", title: String(fields["System.Title"] ?? `Story ${id}`), state, category: CAT[state], area: "P\\Team", iteration: "P",
    tags, created: "2026-01-01T00:00:00Z", changed: "2026-01-01T00:00:00Z", boardColumn: fields["Custom.Column"] as string | undefined,
    fields: { "System.Title": `Story ${id}`, "System.State": state, ...fields }, ...extra,
  };
}

/**
 * Azure DevOps in memory: items by id; an update sent with an older revision is refused (412), as the
 * real one does; every update sent is kept (revision and operations).
 */
function server() {
  const s = { items: new Map<number, WorkItem>(), sent: [] as { rev?: number; ops: PatchOp[] }[], changed: [] as number[], asked: [] as QuerySpec[] };
  const api = {
    ctx: { orgUrl: "https://dev.azure.com/o/" },
    async query(_p: string, spec: QuerySpec) { s.asked.push(spec); return spec.changedAfter ? s.changed : [...s.items.keys()]; },
    async items(_p: string, ids: number[]) { return ids.map((i) => s.items.get(i)).filter((x): x is WorkItem => !!x).map((x) => structuredClone(x)); },
    async item(_p: string, id: number) { return structuredClone(s.items.get(id)!); },
    async update(_p: string, id: number, ops: PatchOp[], o: { rev?: number }) {
      s.sent.push({ rev: o.rev, ops });
      const cur = s.items.get(id)!;
      if (o.rev !== undefined && o.rev !== cur.rev) throw Object.assign(new Error("changed"), { status: 412 });
      const fields = { ...cur.fields };
      for (const op of ops) { const f = op.path.replace("/fields/", ""); if (op.op === "remove") delete fields[f]; else fields[f] = op.value; }
      const next = item(id, cur.rev + 1, fields);
      s.items.set(id, next);
      return structuredClone(next);
    },
  } as unknown as Api;
  /** a teammate saves: Azure DevOps has a new revision; our workspace does not know it yet */
  const teammate = (id: number, change: Record<string, unknown>): WorkItem => {
    const cur = s.items.get(id)!;
    const next = item(id, cur.rev + 1, { ...cur.fields, ...change });
    s.items.set(id, next);
    return next;
  };
  return { s, api, teammate };
}

function setup(start: WorkItem, rules: Rule[] = [], board: BoardInfo | null = null) {
  const { s, api, teammate } = server();
  s.items.set(start.id, structuredClone(start));
  const ws = new Workspace(api, "P", "Team");
  ws.process = P;
  ws.settings = { bugsBehavior: "off", workingDays: [], areas: [{ path: "P\\Team", includeChildren: true }] };
  ws.status = "live";
  ws.lastSync = "2026-10-01T00:00:00.000Z";
  ws.board = board;
  ws.items.set(start.id, structuredClone(start));
  const log = { add: async () => {} } as unknown as ChangeLog;
  const w = new Writer(ws, log, () => rules, { displayName: "Me", uniqueName: "me@x.example" });
  /** the poll brings the teammate's save into the workspace */
  const poll = (id: number): void => { ws.items.set(id, structuredClone(s.items.get(id)!)); };
  return { s, ws, w, teammate, poll };
}

test("an edit box saves only over the text it was opened with: a teammate's newer text is never overwritten", async () => {
  const { s, ws, w, teammate, poll } = setup(item(1, 1, { [DESC]: "<p>first</p>" }));
  // the box was opened on "first"; meanwhile a teammate saved other text and the poll brought it in
  teammate(1, { [DESC]: "<p>theirs</p>" });
  poll(1);
  await assert.rejects(w.setFields(1, [{ field: DESC, value: "<p>mine</p>" }], { expect: { [DESC]: "<p>first</p>" } }),
    (e: Error) => e instanceof ConflictError && /changed by someone else meanwhile/.test(e.message) && e.fields[0] === DESC);
  assert.equal(s.sent.length, 0, "nothing was sent");
  assert.equal(s.items.get(1)!.fields[DESC], "<p>theirs</p>");
  // a teammate's change of another field is no conflict: the save goes through over the newest revision
  teammate(1, { "System.Title": "Renamed" });
  poll(1);
  const r = await w.setFields(1, [{ field: DESC, value: "<p>mine</p>" }], { expect: { [DESC]: "<p>theirs</p>" } });
  assert.equal(s.sent[0].rev, 3);
  assert.equal(r.item.fields[DESC], "<p>mine</p>");
  assert.equal(r.item.title, "Renamed", "their title stays");
  assert.equal(ws.get(1)?.rev, 4);
});

test("when our copy is behind, Azure DevOps refuses; the item is read again and the save goes on only if the text is untouched", async () => {
  const { s, w, teammate } = setup(item(1, 1, { [DESC]: "<p>first</p>" }));
  // the teammate changed only the title, and the poll has not run yet
  teammate(1, { "System.Title": "Renamed" });
  const r = await w.setFields(1, [{ field: DESC, value: "<p>mine</p>" }], { expect: { [DESC]: "<p>first</p>" } });
  assert.deepEqual(s.sent.map((x) => x.rev), [1, 2], "refused once, then sent again over the fresh revision");
  assert.equal(r.item.fields[DESC], "<p>mine</p>");
  assert.equal(r.item.title, "Renamed");
  // now the teammate changes the text itself, again unseen: the second try finds it and stops
  teammate(1, { [DESC]: "<p>theirs</p>" });
  s.sent.length = 0;
  await assert.rejects(w.setFields(1, [{ field: DESC, value: "<p>mine again</p>" }], { expect: { [DESC]: "<p>mine</p>" } }), ConflictError);
  assert.equal(s.sent.length, 1, "only the refused try was sent");
  assert.equal(s.items.get(1)!.fields[DESC], "<p>theirs</p>");
});

test("a change without a starting value keeps working as before (sent over the newest copy we have)", async () => {
  const { s, w } = setup(item(1, 1, { [DESC]: "<p>first</p>" }));
  await w.setFields(1, [{ field: DESC, value: "<p>new</p>" }]);
  assert.deepEqual(s.sent.map((x) => x.rev), [1]);
});

test("Undo does not overwrite a newer change by someone else, but works when they changed another field", async () => {
  const { s, w, teammate, poll } = setup(item(1, 1, { "System.Title": "Old" }));
  const r = await w.setFields(1, [{ field: "System.Title", value: "Mine" }]);
  teammate(1, { "System.Title": "Theirs" });
  poll(1);
  await assert.rejects(r.undo!(), ConflictError);
  assert.equal(s.items.get(1)!.title, "Theirs", "their title stays");
  // another change, then a teammate changes a different field: Undo still puts the old value back
  const r2 = await w.setFields(1, [{ field: "System.Title", value: "Mine" }], { expect: { "System.Title": "Theirs" } });
  teammate(1, { [DESC]: "<p>notes</p>" });
  await r2.undo!();
  assert.equal(s.items.get(1)!.title, "Theirs");
  assert.equal(s.items.get(1)!.fields[DESC], "<p>notes</p>");
});

test("Undo of a move does not move back an item someone else moved meanwhile", async () => {
  const { s, w, teammate, poll } = setup(item(1, 1));
  const r = await w.move(1, { state: "Doing" });
  assert.equal(s.items.get(1)!.state, "Doing");
  teammate(1, { "System.State": "Done" });
  poll(1);
  await assert.rejects(r.undo!(), (e: Error) => e instanceof ConflictError && /State of #1/.test(e.message));
  assert.equal(s.items.get(1)!.state, "Done");
  // when nobody moved it, Undo moves it back
  const r2 = await w.move(1, { state: "New" });
  await r2.undo!();
  assert.equal(s.items.get(1)!.state, "Done");
});

test("several changes of one item undone together: each Undo finds what the later one put back", async () => {
  const { s, w } = setup(item(1, 1, { "System.Title": "A" }));
  const a = await w.setFields(1, [{ field: "System.Title", value: "B" }]);
  const b = await w.setFields(1, [{ field: "System.Title", value: "C" }]);
  await b.undo!();
  await a.undo!();
  assert.equal(s.items.get(1)!.title, "A");
});

test("tags: only the ones added or removed are sent, applied to the newest tags", async () => {
  const { s, w, teammate } = setup(item(1, 1, { "System.Tags": "a; old" }));
  // a teammate added "b" and removed "old"; our copy still has "a; old"
  teammate(1, { "System.Tags": "a; b" });
  const r = await w.changeTags(1, ["c"], []);
  assert.deepEqual(s.sent.map((x) => x.rev), [1, 2], "refused once, then applied to the fresh tags");
  assert.deepEqual(r.item.tags, ["a", "b", "c"], "their b stays, their removal of old stays");
  await r.undo!();
  assert.deepEqual(s.items.get(1)!.tags, ["a", "b"], "Undo takes away only c");
  const r2 = await w.changeTags(1, [], ["A"]);
  assert.deepEqual(r2.item.tags, ["b"], "case does not matter");
  await r2.undo!();
  assert.deepEqual(s.items.get(1)!.tags, ["b", "a"]);
});

test("applyTags and sameValue", () => {
  assert.deepEqual(applyTags(["a", "B"], ["b", " c ", "C", ""], ["A"]), { tags: ["B", "c"], added: ["c"], removed: ["a"] });
  assert.deepEqual(applyTags([], [], []), { tags: [], added: [], removed: [] });
  assert.equal(sameValue(undefined, ""), true);
  assert.equal(sameValue(null, undefined), true);
  assert.equal(sameValue({ displayName: "Ann", uniqueName: "Ann@x.example" }, { displayName: "Ann B", uniqueName: "ann@x.example" }), true);
  assert.equal(sameValue(3, "3"), true);
  assert.equal(sameValue("<p>a</p>", "<p>b</p>"), false);
});

const BOARD: BoardInfo = {
  name: "Stories", columnField: "Custom.Column", rows: [],
  columns: [
    { id: "1", name: "Ready", itemLimit: 0, stateMappings: { Story: "New" }, isSplit: false, columnType: "incoming" },
    { id: "2", name: "Building", itemLimit: 0, stateMappings: { Story: "Doing" }, isSplit: false, columnType: "inProgress" },
    { id: "3", name: "Review", itemLimit: 0, stateMappings: { Story: "Doing" }, isSplit: false, columnType: "inProgress" },
    { id: "4", name: "Closed", itemLimit: 0, stateMappings: { Story: "Done" }, isSplit: false, columnType: "outgoing" },
  ],
};

test("a move by state passes the rules of the board column it lands in; 'only these people' cannot be skipped", async () => {
  const rules: Rule[] = [{ id: "r1", level: "requirement", target: "Building", requires: ["owner"], onlyBy: [] }];
  const { s, w } = setup(item(1, 1, { "Custom.Column": "Ready" }), rules, BOARD);
  await assert.rejects(w.move(1, { state: "Doing" }), /Owner/);
  assert.equal(s.sent.length, 0);
  const forced = await w.move(1, { state: "Doing" }, { force: true });
  assert.equal(forced.item.state, "Doing");
  // a column rule on who may make the move holds for a move by state too, even when forced
  const people: Rule[] = [{ id: "r2", level: "requirement", target: "Closed", requires: [], onlyBy: ["boss@x.example"] }];
  const b = setup(item(1, 1, { "Custom.Column": "Review", "System.State": "Doing" }), people, BOARD);
  await assert.rejects(b.w.move(1, { state: "Done" }, { force: true }), /Only boss@x\.example/);
  assert.equal(b.s.sent.length, 0);
});

test("the column a state lands in: the item's own column when it stands for the state, else the first one", () => {
  const { w } = setup(item(1, 1, { "Custom.Column": "Review", "System.State": "Doing" }), [], BOARD);
  const it = item(1, 1, { "Custom.Column": "Review", "System.State": "Doing" });
  assert.equal(w.columnForState(it, "Doing"), "Review");
  assert.equal(w.columnForState(it, "Done"), "Closed");
  assert.equal(w.columnForState(item(1, 1, { "Custom.Column": "Ready" }), "Doing"), "Building");
  assert.equal(w.columnForState(it, "Gone"), null);
});

test("a move by state checks the column it lands in, not later columns of the same state", async () => {
  const rules: Rule[] = [{ id: "r", level: "requirement", target: "Review", requires: ["owner"], onlyBy: [] }];
  const c = setup(item(1, 1, { "Custom.Column": "Ready" }), rules, BOARD);
  const r = await c.w.move(1, { state: "Doing" });
  assert.equal(r.item.state, "Doing", "it lands in Building; Review's rule is for later");
  assert.deepEqual(c.s.sent[0].ops, [{ op: "add", path: "/fields/System.State", value: "Doing" }], "only the state is sent; Azure DevOps places the card");
});

test("sync mark: Azure DevOps's newest change less the time the reads took, never going back", () => {
  const items = [{ changed: "2026-10-05T10:00:00.000Z" }, { changed: "2026-10-05T09:00:00.000Z" }];
  assert.equal(syncMark("2026-10-01T00:00:00.000Z", items, 5000), "2026-10-05T09:59:55.000Z");
  assert.equal(syncMark("2026-10-06T00:00:00.000Z", items, 0), "2026-10-06T00:00:00.000Z", "never back");
  assert.equal(syncMark("2026-10-06T00:00:00.000Z", [], 0), "2026-10-06T00:00:00.000Z");
  assert.equal(syncMark("", [], 0), "");
  assert.equal(syncMark("", [{ changed: "" }], 0), "");
});

test("the poll asks from a little before the mark and moves the mark by what it read, not by this computer's clock", async () => {
  const { s, ws } = setup(item(1, 1));
  s.items.set(1, item(1, 2, {}, { changed: "2026-10-03T12:00:00.000Z" }));
  s.changed = [1];
  await ws.poll();
  assert.equal(s.asked[0].changedAfter, new Date(Date.parse("2026-10-01T00:00:00.000Z") - SYNC_OVERLAP).toISOString());
  assert.equal(ws.get(1)?.rev, 2);
  const mark = ws.lastSync;
  assert.ok(mark <= "2026-10-03T12:00:00.000Z" && mark > "2026-10-03T11:59:00.000Z", mark);
  // an older change read again (the overlap) does not move the mark back
  s.items.set(1, item(1, 2, {}, { changed: "2026-10-02T00:00:00.000Z" }));
  await ws.poll();
  assert.equal(ws.lastSync, mark);
  assert.equal(s.asked[s.asked.length - 1].changedAfter, new Date(Date.parse(mark) - SYNC_OVERLAP).toISOString());
});

test("a batch's failed steps are named: the first three with why, then how many more", () => {
  const f = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `#${i + 1}`, error: "refused" }));
  assert.equal(failedSteps(f(1)), "#1 (refused)");
  assert.equal(failedSteps(f(3)), "#1 (refused); #2 (refused); #3 (refused)");
  assert.equal(failedSteps(f(5)), "#1 (refused); #2 (refused); #3 (refused); and 2 more");
});
