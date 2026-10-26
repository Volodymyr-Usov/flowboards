// The claim rules of the Scheduler (core/schedrun.ts) against the in-memory document storage (LocalDocs,
// which refuses a second create and an older version like Azure DevOps), with failures put in on purpose:
// lost answers, saves that fail, two tabs at once, a tab that sleeps, clocks that differ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalDocs } from "../src/api/localdocs.ts";
import { ApiError } from "../src/api/types.ts";
import type { ExtensionDoc } from "../src/api/api.ts";
import { ClaimWatch, hasStory, runFor, runId, runOccurrence, runsToPrune, STALE_CLAIM_MS } from "../src/core/schedrun.ts";
import type { RunDoc, RunOutcome, RunStore } from "../src/core/schedrun.ts";

const C = "schedruns-test";
const MIN = 60_000;
const TITLE = "Weekly review";

type Op = "get" | "create" | "replace" | "remove" | "make";
/** what goes wrong: "lost" = done, but the answer never comes; "down" = not done, no answer; a number = refused with that status */
type Fault = "lost" | "down" | number;

/** One organization: the storage, the stories made, and the time (each tab adds its own clock error). */
class World {
  docs = new LocalDocs(`t-${Math.random().toString(36).slice(2)}`);
  items: { id: number; title: string; by: string }[] = [];
  completed: number[] = [];
  time = Date.parse("2026-10-26T09:00:00Z");
  private next = 100;
  newId(): number { return this.next++; }
  record(id: string): Promise<RunDoc | null> { return this.docs.getDoc(C, id, "shared") as unknown as Promise<RunDoc | null>; }
}

/** One open tab: its own clock error, its own memory of claims, failures to put in, and steps to hold. */
class Tab {
  world: World;
  name: string;
  skew: number;
  watch = new ClaimWatch();
  faults: { op: Op; fault: Fault; times: number }[] = [];
  holds: { op: Op; nth: number; gate: Promise<void>; open: () => void; reached: Promise<void>; arrive: () => void }[] = [];
  counts = new Map<Op, number>();
  constructor(world: World, name: string, skew = 0) { this.world = world; this.name = name; this.skew = skew; }
  now = (): number => this.world.time + this.skew;
  fail(op: Op, fault: Fault, times = 1): this { this.faults.push({ op, fault, times }); return this; }
  /** Hold the nth call of `op` (1 = the first from now) until opened: the tab sleeps there. */
  hold(op: Op, nth: number): { reached: Promise<void>; open: () => void } {
    let open!: () => void;
    let arrive!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const reached = new Promise<void>((r) => { arrive = r; });
    this.holds.push({ op, nth: (this.counts.get(op) ?? 0) + nth, gate, open, reached, arrive });
    return { reached, open };
  }
  /** Run one step with the faults and holds that apply to it. */
  async step<T>(op: Op, job: () => Promise<T>): Promise<T> {
    const n = (this.counts.get(op) ?? 0) + 1;
    this.counts.set(op, n);
    const h = this.holds.find((x) => x.op === op && x.nth === n);
    if (h) { h.arrive(); await h.gate; }
    const f = this.faults.find((x) => x.op === op && x.times > 0);
    if (f) f.times--;
    if (f?.fault === "down") throw new ApiError(0, "Azure DevOps did not answer (network)");
    if (typeof f?.fault === "number") throw new ApiError(f.fault, `refused ${f.fault}`);
    const r = await job();
    if (f?.fault === "lost") throw new ApiError(0, "Azure DevOps did not answer (network): the change may or may not be saved");
    return r;
  }
  store(): RunStore {
    const d = this.world.docs;
    return {
      get: (id) => this.step("get", () => d.getDoc(C, id, "shared") as unknown as Promise<RunDoc | null>),
      create: (doc) => this.step("create", () => d.createDoc(C, doc as unknown as ExtensionDoc, "shared") as unknown as Promise<RunDoc>),
      replace: (doc) => this.step("replace", () => d.setDoc(C, doc as unknown as ExtensionDoc, "shared") as unknown as Promise<RunDoc>),
      remove: (id, etag) => this.step("remove", async () => {
        const cur = await d.getDoc(C, id, "shared");
        if (!cur || cur.__etag === etag) await d.deleteDoc(C, id, "shared");
      }),
    };
  }
  /** One check of the occurrence, as the engine does it every minute. */
  run(key = "2026-10-26", title = TITLE): Promise<RunOutcome<{ id: number; title: string }>> {
    const w = this.world;
    const id = runId("s-1", key);
    return runOccurrence({
      id, scheduleId: "s-1", date: key, key, by: this.name, token: `${this.name}-${Math.random().toString(36).slice(2)}`,
      store: this.store(), watch: this.watch, now: this.now, pause: async () => {},
      story: {
        make: () => this.step("make", async () => { const it = { id: w.newId(), title, by: this.name }; w.items.push(it); return { id: it.id, title }; }),
        complete: async (itemId) => { w.completed.push(itemId); },
        // a story with this title that no record names yet
        find: async () => {
          const known = new Set(((await w.docs.docs(C, "shared")) as unknown as RunDoc[]).flatMap((r) => [r.itemId ?? 0, ...(r.also ?? [])]));
          return w.items.find((it) => it.title === title && !known.has(it.id));
        },
      },
    });
  }
}

const later = (w: World, ms: number): void => { w.time += ms; };

test("one tab: claims, makes one story, records it, done", async () => {
  const w = new World();
  const a = new Tab(w, "A");
  const out = await a.run();
  assert.equal(out.kind, "made");
  const rec = (await w.record(runId("s-1", "2026-10-26")))!;
  assert.equal(rec.state, "done");
  assert.equal(rec.itemId, w.items[0].id);
  assert.deepEqual(w.completed, [w.items[0].id]);
  assert.deepEqual((await a.run()).kind, "skip"); // the next minute: nothing
  assert.equal(w.items.length, 1);
});

test("two tabs at the same moment: one story", async () => {
  const w = new World();
  const outs = await Promise.all([new Tab(w, "A").run(), new Tab(w, "B").run(), new Tab(w, "C").run()]);
  assert.equal(outs.filter((o) => o.kind === "made").length, 1);
  assert.equal(w.items.length, 1);
});

test("the claim is saved but its answer is lost: the tab still knows it is its own", async () => {
  const w = new World();
  const a = new Tab(w, "A").fail("create", "lost");
  assert.equal((await a.run()).kind, "made");
  assert.equal(w.items.length, 1);
});

test("the story is saved but its answer is lost: kept as unsure, found later, never made twice", async () => {
  const w = new World();
  const a = new Tab(w, "A").fail("make", "lost");
  const b = new Tab(w, "B");
  const first = await a.run();
  assert.equal(first.kind, "unsure");
  const rec = (await w.record(runId("s-1", "2026-10-26")))!;
  assert.equal(rec.state, "unsure"); // not deleted
  assert.equal(w.items.length, 1);
  // every minute for 10 minutes: both tabs wait
  for (let m = 0; m < 10; m++) {
    assert.equal((await a.run()).kind, "skip");
    assert.equal((await b.run()).kind, "skip");
    later(w, MIN - 1);
  }
  later(w, 10);
  const taken = await b.run();
  assert.equal(taken.kind, "found");
  assert.equal(w.items.length, 1);
  const done = (await w.record(runId("s-1", "2026-10-26")))!;
  assert.equal(done.state, "done");
  assert.equal(done.itemId, w.items[0].id);
  assert.deepEqual(w.completed, [w.items[0].id]); // its tasks are added by the tab that found it
  assert.equal((await a.run()).kind, "skip");
});

test("no answer and nothing saved: after 10 minutes it is made (not lost)", async () => {
  const w = new World();
  const a = new Tab(w, "A").fail("make", "down");
  assert.equal((await a.run()).kind, "unsure");
  assert.equal(w.items.length, 0);
  assert.equal((await a.run()).kind, "skip"); // the first look starts the 10 minutes
  later(w, STALE_CLAIM_MS);
  assert.equal((await a.run()).kind, "made");
  assert.equal(w.items.length, 1);
});

test("a definite refusal gives the claim back; the next try makes it", async () => {
  const w = new World();
  const a = new Tab(w, "A").fail("make", 400);
  const out = await a.run();
  assert.equal(out.kind, "refused");
  assert.equal(await w.record(runId("s-1", "2026-10-26")), null);
  assert.equal((await new Tab(w, "B").run()).kind, "made");
  assert.equal(w.items.length, 1);
});

test("marking it done fails: the record is never deleted, and the story is found, not made again", async () => {
  const w = new World();
  const a = new Tab(w, "A").fail("replace", "down", 20);
  const out = await a.run();
  assert.equal(out.kind, "made");
  assert.equal(w.items.length, 1);
  const rec = (await w.record(runId("s-1", "2026-10-26")))!;
  assert.equal(rec.state, "claiming"); // the story id could not be written, but the claim stays
  const b = new Tab(w, "B");
  assert.equal((await b.run()).kind, "skip");
  later(w, STALE_CLAIM_MS);
  assert.equal((await b.run()).kind, "found");
  assert.equal(w.items.length, 1);
  assert.equal((await w.record(runId("s-1", "2026-10-26")))!.itemId, w.items[0].id);
});

test("writing the story id loses its answer: read back, it counts", async () => {
  const w = new World();
  const a = new Tab(w, "A").fail("replace", "lost");
  assert.equal((await a.run()).kind, "made");
  const rec = (await w.record(runId("s-1", "2026-10-26")))!;
  assert.equal(rec.itemId, w.items[0].id);
  assert.equal(rec.state, "done");
});

test("a tab sleeps after its claim: another takes over after 10 minutes; the sleeper wakes and stops", async () => {
  const w = new World();
  const a = new Tab(w, "A");
  const b = new Tab(w, "B");
  const sleep = a.hold("get", 2); // the check just before making the story
  const sleeping = a.run();
  await sleep.reached;
  assert.equal((await b.run()).kind, "skip");
  later(w, STALE_CLAIM_MS);
  assert.equal((await b.run()).kind, "made");
  sleep.open();
  assert.deepEqual((await sleeping), { kind: "skip", why: "lost" });
  assert.equal(w.items.length, 1);
});

test("a tab sleeps after making its story: the other finds that story, nothing is made twice", async () => {
  const w = new World();
  const a = new Tab(w, "A");
  const b = new Tab(w, "B");
  const sleep = a.hold("replace", 1); // writing the story id
  const sleeping = a.run();
  await sleep.reached;
  await b.run();
  later(w, STALE_CLAIM_MS);
  assert.equal((await b.run()).kind, "found");
  sleep.open();
  const out = await sleeping;
  assert.equal(out.kind, "made");
  assert.equal(out.kind === "made" && out.double, false);
  assert.equal(w.items.length, 1);
  assert.equal((await w.record(runId("s-1", "2026-10-26")))!.state, "done");
  assert.deepEqual(w.completed, [w.items[0].id]); // its tasks once, by the tab that found it
});

test("a sleeper whose story was not found by its title: the double is listed on the record", async () => {
  const w = new World();
  const a = new Tab(w, "A");
  const b = new Tab(w, "B");
  const sleep = a.hold("make", 1); // frozen just as it creates the story
  const sleeping = a.run();
  await sleep.reached;
  await b.run();
  later(w, STALE_CLAIM_MS);
  assert.equal((await b.run()).kind, "made");
  sleep.open(); // the create was already on its way
  const out = await sleeping;
  assert.equal(out.kind === "made" && out.double, true);
  const rec = (await w.record(runId("s-1", "2026-10-26")))!;
  assert.equal(rec.itemId, w.items[0].id); // B's, made first
  assert.deepEqual(rec.also, [w.items[1].id]);
});

test("a taker that has not made its story yet stops when the first tab records one", async () => {
  const w = new World();
  const a = new Tab(w, "A");
  const b = new Tab(w, "B");
  const slow = a.hold("replace", 1); // A made its story; its answer to record it is slow
  const first = a.run();
  await slow.reached;
  await b.run();
  later(w, STALE_CLAIM_MS);
  // B's find runs before A's story is there (titles differ until A is done): B takes the claim, then sleeps before its check
  w.items[0].title = "renamed meanwhile";
  const bSleep = b.hold("get", 2);
  const taker = b.run();
  await bSleep.reached;
  w.items[0].title = TITLE;
  slow.open();
  assert.equal((await first).kind, "made");
  bSleep.open();
  assert.deepEqual(await taker, { kind: "skip", why: "lost" });
  assert.equal(w.items.length, 1);
  assert.equal((await w.record(runId("s-1", "2026-10-26")))!.itemId, w.items[0].id);
});

test("clocks that differ: a fresh claim is never taken for an old one", async () => {
  const w = new World();
  const a = new Tab(w, "A", -3 * 3600_000); // 3 hours behind: its claim looks old to everyone else
  const b = new Tab(w, "B", 2 * 3600_000); // 2 hours ahead
  const hold = a.hold("make", 1);
  const slowA = a.run();
  await hold.reached;
  for (let m = 0; m < 9; m++) { assert.equal((await b.run()).kind, "skip"); later(w, MIN); }
  hold.open();
  assert.equal((await slowA).kind, "made");
  assert.equal(w.items.length, 1);
});

test("a clock set back starts the 10 minutes again", () => {
  const watch = new ClaimWatch();
  const doc: RunDoc = { id: "r", scheduleId: "s", date: "2026-10-26", state: "claiming", by: "A", at: "x", __etag: 1 };
  assert.equal(watch.stale(doc, 1_000_000), false);
  assert.equal(watch.stale(doc, 1_000_000 - 5 * MIN), false);
  assert.equal(watch.stale(doc, 1_000_000 + 4 * MIN), false); // 9 minutes since the clock went back
  assert.equal(watch.stale(doc, 1_000_000 - 5 * MIN + STALE_CLAIM_MS), true);
  assert.equal(watch.stale({ ...doc, __etag: 2 }, 1_000_000 + STALE_CLAIM_MS * 3), false); // saved meanwhile: a new count
});

test("records under the older key still count; a claim without a story does not", () => {
  const runs: RunDoc[] = [
    { id: runId("s", "2026-10-19"), scheduleId: "s", date: "2026-10-19", state: "done", by: "", at: "", itemId: 7 },
    { id: runId("s", "2026-11-02"), scheduleId: "s", date: "2026-11-02", state: "claiming", by: "", at: "" },
  ];
  assert.equal(runFor(runs, "s", { key: "sprint-2-start", legacyKey: "2026-10-19" })?.itemId, 7);
  assert.equal(runFor(runs, "s", { key: "sprint-3-start", legacyKey: "2026-11-02" }), undefined);
  assert.equal(runFor(runs, "s", { key: "2026-10-19" })?.itemId, 7);
  assert.equal(hasStory({ ...runs[1], state: "made", itemId: 9 }), true);
});

test("clean-up: old records, a deleted schedule's records and old marks go; the newest for the turn stays", () => {
  const r = (id: string, scheduleId: string, date: string, assignee?: string): RunDoc => ({ id, scheduleId, date, state: "done", by: "", at: date, itemId: 1, assignee });
  const runs = [
    r("r-a-2026-08-01", "a", "2026-08-01", "x@x"),
    r("r-a-2026-08-08", "a", "2026-08-08", "y@x"),
    r("r-a-2026-10-20", "a", "2026-10-20"),
    r("r-b-2026-06-01", "b", "2026-06-01", "x@x"), // monthly: its only record is old but keeps the turn
    r("r-gone-2026-10-20", "gone", "2026-10-20"),
    r("prune-2026-10-24", "", "2026-10-24"),
    r("prune-2026-10-26", "", "2026-10-26"),
  ];
  assert.deepEqual(runsToPrune(runs, new Set(["a", "b"]), "2026-10-26").sort(), ["prune-2026-10-24", "r-a-2026-08-01", "r-gone-2026-10-20"]);
});

test("clean-up keeps an outlook's record until its target date is old, so a long lead never makes it twice", () => {
  const made: RunDoc = { id: "r-o-2027-03-01", scheduleId: "o", key: "2027-03-01", date: "2026-12-31", state: "done", by: "", at: "", itemId: 5 };
  const newer: RunDoc = { id: "r-o-2027-06-01", scheduleId: "o", key: "2027-06-01", date: "2027-04-02", state: "done", by: "", at: "", itemId: 6 };
  // 2027-02-10: the first story was made 41 days ago, but its target is ahead: kept
  assert.deepEqual(runsToPrune([made, newer], new Set(["o"]), "2027-02-10"), []);
  // a month after the target date it may go (the newest record stays for the turn)
  assert.deepEqual(runsToPrune([made, newer], new Set(["o"]), "2027-04-05"), ["r-o-2027-03-01"]);
  // the key read from the id when the record has none
  const { key: _k, ...noKey } = made;
  assert.deepEqual(runsToPrune([noKey, newer], new Set(["o"]), "2027-02-10"), []);
});
