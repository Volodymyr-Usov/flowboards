import { test } from "node:test";
import assert from "node:assert/strict";
import type { RetroBoard, RetroNote } from "../src/views/retrologic.ts";
import { nextPhase, ordered, previousBoard, ranked, totalVotes, visibleNotes, vote, votesUsed } from "../src/views/retrologic.ts";

const note = (id: string, votes: Record<string, number> = {}, created = "2026-10-01T10:00:00Z", author?: string): RetroNote =>
  ({ id, kind: "note", board: "it1", column: "good", text: id, created, votes, author });

test("votes are counted per person, and none beyond the allowance", () => {
  const notes = [note("a", { "ann@x": 2, "bob@x": 1 }), note("b", { "Ann@x": 1 })];
  assert.equal(votesUsed(notes, "ann@x"), 3);
  assert.equal(totalVotes(notes[0]), 3);
  assert.equal(vote(notes[1], "ann@x", 1, 0), null, "no votes left");
  assert.deepEqual(vote(notes[1], "ann@x", 1, 2)?.votes, { "Ann@x": 2 });
  assert.deepEqual(vote(notes[1], "ann@x", -1, 2)?.votes, {});
  assert.equal(vote(note("c"), "ann@x", -1, 5), null, "cannot take back a vote never given");
});

test("order: by time while writing, by votes after", () => {
  const ns = [note("old", { a: 1 }, "2026-10-01"), note("new", { a: 3 }, "2026-10-02"), note("mid", {}, "2026-10-01T12:00")];
  assert.deepEqual(ordered(ns, "write").map((n) => n.id), ["old", "mid", "new"]);
  assert.deepEqual(ordered(ns, "vote").map((n) => n.id), ["new", "old", "mid"]);
});

test("while writing only my own notes show", () => {
  const ns = [note("a", {}, "1", "me"), note("b", {}, "1", "you"), note("c", {}, "1", "you")];
  assert.deepEqual(visibleNotes(ns, "write", (n) => n.author === "me"), { shown: [ns[0]], hidden: 2 });
  assert.equal(visibleNotes(ns, "vote", () => false).shown.length, 3);
});

test("previous board is the latest earlier sprint", () => {
  const b = (iteration: string): RetroBoard => ({ id: "board-" + iteration, kind: "board", iteration, iterationName: iteration, columns: [], phase: "closed", votesPerPerson: 5, anonymous: false, created: "2026-01-01", createdBy: "x" });
  const starts: Record<string, string> = { s1: "2026-08-01", s2: "2026-09-01", s3: "2026-10-01" };
  const all = [b("s1"), b("s2"), b("s3")];
  assert.equal(previousBoard(all, all[2], (i) => starts[i])?.iteration, "s2");
  assert.equal(previousBoard(all, all[0], (i) => starts[i]), undefined);
  // a sprint with no board: only boards of sprints before it, never later ones
  assert.equal(previousBoard(all, undefined, (i) => starts[i], "2026-09-15")?.iteration, "s2");
  assert.equal(previousBoard(all, undefined, (i) => starts[i], "2026-07-01"), undefined);
  assert.equal(nextPhase("write"), "vote");
  assert.equal(nextPhase("closed"), "closed");
});

test("ranked: one list across columns, most votes first, then oldest", () => {
  const a = { ...note("a", { x: 1 }, "2026-10-01T10:00:00Z"), column: "good" };
  const b = { ...note("b", { x: 2, y: 1 }, "2026-10-01T11:00:00Z"), column: "improve" };
  const c = { ...note("c", { y: 1 }, "2026-10-01T09:00:00Z"), column: "ideas" };
  const d = note("d", {}, "2026-10-01T08:00:00Z");
  assert.deepEqual(ranked([a, b, c, d]).map((n) => n.id), ["b", "c", "a", "d"]);
});
