import { test } from "node:test";
import assert from "node:assert/strict";
import type { RetroBallot, RetroBoard, RetroDoc, RetroNote } from "../src/views/retrologic.ts";
import { ballotId, ballotVote, mergeRetroDocs, myVotesOn, myVotesUsed, newSalt, nextPhase, noteTotals, ordered, previousBoard, ranked, strays, totalVotes, visibleNotes, vote, voterCount, votesUsed } from "../src/views/retrologic.ts";
import { mySalt } from "../src/views/retro.ts";

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

test("ballots: votes without names, counted with the older votes on the notes", async () => {
  const ann = await ballotId("board-it1", "Ann@x.example", "salt-a");
  assert.match(ann, /^ballot-[0-9a-f]{40}$/);
  assert.equal(await ballotId("board-it1", "ann@x.example", "salt-a"), ann, "the same person, board and salt: the same ballot");
  assert.notEqual(await ballotId("board-it2", "ann@x.example", "salt-a"), ann, "another board: another id");
  assert.notEqual(await ballotId("board-it1", "bob@x.example", "salt-a"), ann);
  assert.notEqual(await ballotId("board-it1", "ann@x.example", "salt-b"), ann, "without the salt nobody can make it");
  assert.doesNotMatch(ann, /ann/i);
  assert.match(newSalt(), /^[0-9a-f]{64}$/);
  assert.notEqual(newSalt(), newSalt());

  const notes = [note("a", { "ann@x": 1 }), note("b")];
  const mine: RetroBallot = { id: ann, kind: "ballot", board: "it1", votes: { a: 1, b: 2, gone: 4 } };
  const other: RetroBallot = { id: "ballot-2", kind: "ballot", board: "it1", votes: { b: 1 } };
  const totals = noteTotals(notes, [mine, other]);
  assert.deepEqual([...totals], [["a", 2], ["b", 3]], "a vote on a deleted note does not count");
  assert.equal(myVotesOn(notes[0], mine, "ANN@x"), 2, "older and new votes of mine");
  assert.equal(myVotesUsed(notes, mine, "ann@x"), 4, "a vote on a deleted note is free again");
  assert.equal(voterCount(notes, [mine, other, { id: "ballot-3", kind: "ballot", board: "it1", votes: { gone: 1 } }]), 3, "one name on a note, two ballots with votes");
  assert.deepEqual(ranked(notes, (n) => totals.get(n.id) ?? 0).map((n) => n.id), ["b", "a"]);
  assert.deepEqual(ordered(notes, "vote", (n) => totals.get(n.id) ?? 0).map((n) => n.id), ["b", "a"]);
});

test("ballots: a vote is added while votes are left, and only my own ballot votes are taken back", () => {
  const made = ballotVote(null, "ballot-x", "it1", "a", 1, 1)!;
  assert.deepEqual(made, { id: "ballot-x", kind: "ballot", board: "it1", votes: { a: 1 } });
  assert.equal(ballotVote(made, "ballot-x", "it1", "a", 1, 0), null, "no votes left");
  assert.deepEqual(ballotVote(made, "ballot-x", "it1", "a", -1, 0)?.votes, {});
  assert.equal(ballotVote(made, "ballot-x", "it1", "b", -1, 5), null, "no vote of mine on b in the ballot");
  assert.deepEqual(made.votes, { a: 1 }, "the ballot given is not changed");
});

test("retro storage: a split board's notes come from its own collection; older boards' from the team's", () => {
  const board = (iteration: string, apart: boolean): RetroBoard => ({ id: "board-" + iteration, kind: "board", iteration, iterationName: iteration, columns: [], phase: "write", votesPerPerson: 5, anonymous: true, created: "2026-01-01", createdBy: "x", notesApart: apart || undefined });
  const main: RetroDoc[] = [board("s1", false), board("s2", true), { ...note("old1"), board: "s1" }, { ...note("old2"), board: "s2", text: "old copy" }];
  const own = new Map<string, RetroDoc[]>([["s2", [{ ...note("old2"), board: "s2", text: "moved" }, { ...note("new"), board: "s2" }]], ["s1", [{ id: "ballot-1", kind: "ballot", board: "s1", votes: {} }]]]);
  const docs = mergeRetroDocs(main, own);
  assert.deepEqual(docs.map((d) => d.id).sort(), ["ballot-1", "board-s1", "board-s2", "new", "old1", "old2"]);
  assert.equal((docs.find((d) => d.id === "old2") as RetroNote).text, "moved", "the old copy of a split board's note is not used");
  // a note written to the team's collection just before the split is found to copy over
  const late: RetroNote = { ...note("late"), board: "s2" };
  assert.deepEqual(strays([...main, late], own.get("s2")!, "s2").map((d) => d.id), ["late"]);
  assert.deepEqual(strays(main, own.get("s2")!, "s2"), []);
});

test("the person's salt for vote ids: made once in their own storage, read after; never made when only reading", async () => {
  const kept = new Map<string, Record<string, unknown>>();
  const api = {
    async getDoc(_c: string, id: string) { const d = kept.get(id); return d ? { ...d, id } : null; },
    async createDoc(_c: string, doc: { id: string }) { if (kept.has(doc.id)) throw Object.assign(new Error("exists"), { status: 409 }); kept.set(doc.id, { ...doc }); return { ...doc, __etag: 1 }; },
  } as unknown as Parameters<typeof mySalt>[0];
  await assert.rejects(mySalt(api, false), /No votes of yours/);
  assert.equal(kept.size, 0);
  const s = await mySalt(api, true);
  assert.match(s, /^[0-9a-f]{64}$/);
  assert.equal(await mySalt(api, true), s, "the same salt next time");
  assert.equal(await mySalt(api, false), s);
});
