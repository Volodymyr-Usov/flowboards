import { test } from "node:test";
import assert from "node:assert/strict";
import { findCycles, layoutGraph, linkProblem, reach, sccs } from "../src/views/graphlayout.ts";

const E = (pairs: [number, number][]) => pairs.map(([from, to]) => ({ from, to }));

test("a chain goes left to right", () => {
  const l = layoutGraph([1, 2, 3], E([[1, 2], [2, 3]]));
  assert.deepEqual([1, 2, 3].map((n) => l.pos.get(n)!.col), [0, 1, 2]);
  assert.equal(l.cols, 3);
  assert.equal(l.back.size, 0);
});

test("a node goes to the column of its longest path", () => {
  const l = layoutGraph([1, 2, 3], E([[1, 2], [2, 3], [1, 3]]));
  assert.equal(l.pos.get(3)!.col, 2);
});

test("nodes in one column never share a row", () => {
  const l = layoutGraph([1, 2, 3, 4], E([[1, 2], [1, 3], [1, 4]]));
  const rows = [2, 3, 4].map((n) => l.pos.get(n)!.row);
  assert.equal(new Set(rows).size, 3);
  assert.ok([2, 3, 4].every((n) => l.pos.get(n)!.col === 1));
});

test("separate groups are stacked, largest first", () => {
  const l = layoutGraph([10, 11, 1, 2, 3], E([[10, 11], [1, 2], [2, 3]]));
  assert.equal(l.pos.get(1)!.row, 0);
  assert.ok(l.pos.get(10)!.row >= 1);
  assert.equal(l.rows, 2);
});

test("barycenter ordering removes a simple crossing", () => {
  // 1→4, 2→3: column 1 should be ordered 4, 3 to follow 1, 2
  const l = layoutGraph([1, 2, 3, 4], E([[1, 4], [2, 3], [1, 3]]));
  const r = (n: number) => l.pos.get(n)!.row;
  assert.ok(r(1) < r(2));
  assert.ok(r(4) <= r(3));
});

test("a loop is laid out and reported", () => {
  const nodes = [1, 2, 3, 4];
  const edges = E([[1, 2], [2, 3], [3, 1], [3, 4]]);
  const l = layoutGraph(nodes, edges);
  assert.equal(l.pos.size, 4);
  assert.equal(l.back.size, 1);
  const cycles = findCycles(nodes, edges);
  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0]].sort(), [1, 2, 3]);
  assert.equal(cycles[0][0], 1);
  assert.deepEqual(cycles[0], [1, 2, 3]);
});

test("strongly connected groups", () => {
  const g = sccs([1, 2, 3, 4, 5], E([[1, 2], [2, 1], [3, 4], [4, 5], [5, 3]]));
  const big = g.filter((c) => c.length > 1).map((c) => [...c].sort());
  assert.equal(big.length, 2);
  assert.deepEqual(big.sort((a, b) => a[0] - b[0]), [[1, 2], [3, 4, 5]]);
});

test("a self link is a loop", () => {
  assert.deepEqual(findCycles([1, 2], E([[1, 1], [1, 2]])), [[1]]);
});

test("no loops in a DAG", () => {
  assert.deepEqual(findCycles([1, 2, 3], E([[1, 2], [1, 3], [2, 3]])), []);
});

test("reach follows the chain", () => {
  const adj = new Map([[1, [2]], [2, [3]], [3, []], [4, [1]]]);
  assert.deepEqual([...reach(1, adj)].sort(), [2, 3]);
  assert.deepEqual([...reach(4, adj)].sort(), [1, 2, 3]);
});

test("edges to unknown nodes are ignored", () => {
  const l = layoutGraph([1, 2], E([[1, 2], [2, 99]]));
  assert.equal(l.pos.size, 2);
});

test("a new dependency is refused when it is there already, on itself, or makes a loop", () => {
  const edges = E([[1, 2], [2, 3]]);
  assert.equal(linkProblem(1, 4, edges), "");
  assert.match(linkProblem(1, 2, edges), /already waits/);
  assert.match(linkProblem(5, 5, edges), /itself/);
  assert.match(linkProblem(3, 1, edges), /loop/);
  assert.match(linkProblem(2, 1, edges), /loop/);
});
