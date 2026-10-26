import { test } from "node:test";
import assert from "node:assert/strict";
import { blockOff, blocksOff, CROSS_ARM_MS, crossArmed, resetBlocks, setBlockShown, tabOff } from "../src/ui/blocks.ts";

test("a cross hides its block only after a mouse has been on it (never on a plain tap)", () => {
  const el = {} as Element;
  const other = {} as Element;
  assert.equal(crossArmed(null, el, 1000), false, "a touch is no hover");
  assert.equal(crossArmed({ el, since: 1000 }, el, 1000 + CROSS_ARM_MS - 1), false, "just arrived");
  assert.equal(crossArmed({ el, since: 1000 }, el, 1000 + CROSS_ARM_MS), true);
  assert.equal(crossArmed({ el: other, since: 0 }, el, 5000), false, "the mouse is on another block");
});

test("every block shows until it is switched off, and Show everything undoes it", () => {
  // no document in the tests: only the choice itself is checked
  const g = globalThis as unknown as { document?: unknown };
  g.document = { querySelectorAll: () => [] };
  try {
    resetBlocks();
    assert.equal(blocksOff().size, 0);
    setBlockShown("excel", false);
    setBlockShown("tab:flow", false);
    assert.equal(blockOff("excel"), true);
    assert.equal(tabOff("flow"), true);
    assert.equal(tabOff("board"), false);
    setBlockShown("excel", true);
    assert.equal(blockOff("excel"), false);
    resetBlocks();
    assert.equal(blocksOff().size, 0);
  } finally { delete g.document; }
});

import { columnHidden, columnShownPatch, DEFAULTS } from "../src/views/boardprefs.ts";

test("hiding and showing a board column", () => {
  const o = { ...DEFAULTS, hiddenCols: [] as string[] };
  const apply = (c: { name: string; kind: string }, shown: boolean): void => { Object.assign(o, columnShownPatch(o, c, shown)); };
  const nw = { name: "New", kind: "incoming" }, act = { name: "Active", kind: "inProgress" }, done = { name: "Closed", kind: "outgoing" };
  // New and Closed start hidden, the others shown
  assert.deepEqual([nw, act, done].map((c) => columnHidden(o, c)), [true, false, true]);
  apply(nw, true); apply(done, true); apply(act, false);
  assert.deepEqual([nw, act, done].map((c) => columnHidden(o, c)), [false, true, false]);
  apply(act, true); apply(nw, false);
  assert.deepEqual([nw, act, done].map((c) => columnHidden(o, c)), [true, false, false]);
  assert.deepEqual(o.hiddenCols, []);
});

import { BLOCK_GROUPS } from "../src/ui/blocks.ts";

test("every block id is listed once, and none is the Settings gear", () => {
  const ids = BLOCK_GROUPS.flatMap((g) => g.blocks.map((b) => b.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes("settings"));
  // People and Filter lead the page bar
  const bar = BLOCK_GROUPS.find((g) => g.name === "Page bar")!.blocks.map((b) => b.id);
  assert.deepEqual(bar.slice(0, 2), ["people", "filters"]);
});
