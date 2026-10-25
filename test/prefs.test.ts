import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, ExtensionDoc } from "../src/api/api.ts";
import { LocalDocs } from "../src/api/localdocs.ts";
import { prefs, resetPrefs, syncPrefs } from "../src/core/settings.ts";

/** A browser storage in memory; `full` makes every write fail (blocked or out of room). */
function fakeStorage() {
  const data = new Map<string, string>();
  const st = {
    full: false,
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { if (st.full) throw new Error("QuotaExceededError"); data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    data,
  };
  return st;
}
function useStorage(st: ReturnType<typeof fakeStorage> | undefined): () => void {
  const g = globalThis as unknown as { localStorage?: unknown };
  const old = g.localStorage;
  if (st) g.localStorage = st; else delete g.localStorage;
  return () => { if (old === undefined) delete g.localStorage; else g.localStorage = old; };
}

/** Per-person extension storage in memory; `slow` holds the first save back. */
function fakeCloud(stored?: Record<string, unknown>) {
  const saves: Record<string, unknown>[] = [];
  const state = { values: stored, release: undefined as (() => void) | undefined, slowFirst: false };
  const api = {
    async getDoc() { return state.values ? ({ id: "screen", values: state.values } as ExtensionDoc) : null; },
    async setDoc(_c: string, doc: ExtensionDoc) {
      if (state.slowFirst && !saves.length) await new Promise<void>((r) => { state.release = r; });
      saves.push(doc.values as Record<string, unknown>);
      return doc;
    },
  } as unknown as Api;
  return { api, saves, state };
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("screen choices are kept for the page when the browser will not keep them", () => {
  const restore = useStorage(undefined);
  try {
    assert.equal(prefs.get("k.blocked", "fallback"), "fallback");
    prefs.set("k.blocked", { a: [1, 2] });
    assert.deepEqual(prefs.get("k.blocked", null), { a: [1, 2] });
    // what is read back is a copy
    prefs.get<{ a: number[] }>("k.blocked", { a: [] }).a.push(3);
    assert.deepEqual(prefs.get("k.blocked", null), { a: [1, 2] });
    prefs.set("k.blocked", null);
    assert.equal(prefs.get("k.blocked", "fallback"), null);
  } finally { restore(); }
});

test("screen choices: storage that fills up keeps the newest value, and works again afterwards", () => {
  const st = fakeStorage();
  const restore = useStorage(st);
  try {
    prefs.set("k.full", 1);
    assert.equal(prefs.get("k.full", 0), 1);
    st.full = true;
    prefs.set("k.full", 2);
    assert.equal(prefs.get("k.full", 0), 2, "not the older stored value");
    st.full = false;
    prefs.set("k.full", 3);
    assert.equal(prefs.get("k.full", 0), 3);
    assert.equal(st.data.get("ado-dashboard:k.full"), "3");
  } finally { restore(); }
});

test("the cloud copy of the screen choices is never replaced by an empty one when the browser keeps nothing", async () => {
  const restore = useStorage(undefined);
  try {
    const cloud = fakeCloud({ view: "tree", "cols:a": [100, 200] });
    await syncPrefs(cloud.api, 5);
    // the stored choices count for this page although the browser cannot keep them
    assert.equal(prefs.get("view", "board"), "tree");
    prefs.set("flow.range", 30);
    await wait(40);
    assert.equal(cloud.saves.length, 1);
    const mine = Object.fromEntries(Object.entries(cloud.saves[0]).filter(([k]) => !k.startsWith("k."))); // the first tests' keys stay held
    assert.deepEqual(mine, { view: "tree", "cols:a": [100, 200], "flow.range": 30 });
  } finally { restore(); }
});

test("screen choices go to the cloud one save at a time, the newest last", async () => {
  const st = fakeStorage();
  const restore = useStorage(st);
  try {
    const cloud = fakeCloud({});
    cloud.state.slowFirst = true;
    await syncPrefs(cloud.api, 5);
    prefs.set("a", 1);
    await wait(30); // the first save starts and waits
    prefs.set("a", 2);
    await wait(30); // the second would start now, but must wait for the first
    assert.equal(cloud.saves.length, 0);
    cloud.state.release!();
    await wait(30);
    assert.deepEqual(cloud.saves.map((v) => v.a), [1, 2], "the older save lands first");
  } finally { restore(); }
});

test("local documents: a damaged one is left out of the list, not the whole list", async () => {
  const st = fakeStorage();
  const restore = useStorage(st);
  try {
    const docs = new LocalDocs("t1");
    await docs.setDoc("c", { id: "a", n: 1 }, "shared");
    await docs.setDoc("c", { id: "b", n: 2 }, "shared");
    st.data.set("t1:shared:c:broken", "{not json");
    assert.deepEqual((await docs.docs("c", "shared")).map((d) => d.id).sort(), ["a", "b"]);
    assert.equal((await docs.getDoc("c", "a", "shared"))?.n, 1);
  } finally { restore(); }
});

test("local documents: one the browser could not store is still there, and gone once deleted", async () => {
  const st = fakeStorage();
  const restore = useStorage(st);
  try {
    const docs = new LocalDocs("t2");
    await docs.setDoc("c", { id: "a", n: 1 }, "shared");
    st.full = true;
    const saved = await docs.setDoc("c", { id: "a", n: 2, __etag: 1 }, "shared");
    assert.equal(saved.__etag, 2);
    assert.equal((await docs.getDoc("c", "a", "shared"))?.n, 2, "the newest version, not the stored one");
    assert.deepEqual((await docs.docs("c", "shared")).map((d) => d.n), [2]);
    await assert.rejects(docs.setDoc("c", { id: "a", n: 3, __etag: 1 }, "shared"), /first/);
    await assert.rejects(docs.createDoc("c", { id: "a" }, "shared"), /exists/);
    st.full = false;
    await docs.deleteDoc("c", "a", "shared");
    assert.equal(await docs.getDoc("c", "a", "shared"), null);
    assert.deepEqual(await docs.docs("c", "shared"), []);
  } finally { restore(); }
});

test("local documents: nothing at all stored (blocked storage) still works in memory", async () => {
  const restore = useStorage(undefined);
  try {
    const docs = new LocalDocs("t3");
    await docs.createDoc("c", { id: "x", n: 1 }, "user");
    assert.equal((await docs.getDoc("c", "x", "user"))?.n, 1);
    assert.deepEqual((await docs.docs("c", "user")).map((d) => d.id), ["x"]);
    assert.deepEqual(await docs.docs("c", "shared"), [], "another scope");
    await docs.deleteDoc("c", "x", "user");
    assert.equal(await docs.getDoc("c", "x", "user"), null);
  } finally { restore(); }
});

test("reset: screen choices are forgotten, the picked team and the documents stay", async () => {
  const st = fakeStorage();
  const restore = useStorage(st);
  try {
    prefs.set("board", { epics: false });
    prefs.set("blocks.off", ["excel"]);
    prefs.set("team:Fabrikam", { project: "P", team: "T" });
    st.setItem("ado-dashboard:doc:shared:settings:x", "{}");
    await resetPrefs();
    assert.equal(prefs.get("board", "default"), "default");
    assert.deepEqual(prefs.get("blocks.off", []), []);
    assert.deepEqual(prefs.get("team:Fabrikam", null), { project: "P", team: "T" });
    assert.equal(st.getItem("ado-dashboard:doc:shared:settings:x"), "{}");
  } finally { restore(); }
});
