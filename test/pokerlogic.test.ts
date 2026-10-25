import { test } from "node:test";
import assert from "node:assert/strict";
import type { Card, PokerPresence, PokerVote } from "../src/views/pokerlogic.ts";
import { hereId, present, result, voteId, wideSpread } from "../src/views/pokerlogic.ts";

const v = (value: Card, user = Math.random().toString()): PokerVote => ({ id: "x", kind: "vote", storyId: 1, round: 1, user, name: user, value, at: "" });

test("result: average, median, suggestion and tally", () => {
  const r = result([v("3"), v("5"), v("8"), v("?")]);
  assert.equal(r.count, 4);
  assert.deepEqual(r.numeric, [3, 5, 8]);
  assert.equal(r.median, 5);
  assert.equal(r.suggestion, 5);
  assert.equal(r.consensus, false);
  assert.equal(r.tally.length, 4);
  const even = result([v("2"), v("8")]);
  assert.equal(even.median, 5);
  assert.equal(even.suggestion, 5);
  assert.equal(result([v("13"), v("20")]).suggestion, 20, "a tie between cards picks the bigger one");
});

test("consensus needs two or more equal numbers", () => {
  assert.equal(result([v("5"), v("5")]).consensus, true);
  assert.equal(result([v("5")]).consensus, false);
  assert.equal(result([v("?"), v("?")]).consensus, false);
  assert.equal(result([]).suggestion, null);
});

test("presence keeps people seen recently, and ids are safe", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const p = (name: string, ago: number): PokerPresence => ({ id: hereId(name), kind: "here", user: name, name, seen: new Date(now - ago).toISOString() });
  assert.deepEqual(present([p("Bob", 10_000), p("Ann", 5_000), p("Old", 120_000)], now).map((x) => x.name), ["Ann", "Bob"]);
  assert.equal(voteId(7, 2, "Ann.M@x.com"), "vote-7-2-ann_m_x_com");
});

test("wide spread: three times apart, and a 0 does not make every round wide", () => {
  assert.equal(wideSpread([2, 8]), true);
  assert.equal(wideSpread([3, 8]), false);
  assert.equal(wideSpread([0, 0.5]), false);
  assert.equal(wideSpread([0, 1]), false);
  assert.equal(wideSpread([0, 0]), false);
  assert.equal(wideSpread([0, 2]), true);
  assert.equal(wideSpread([5]), false);
});
