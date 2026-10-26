// Estimate: planning poker. The team picks a story together, everyone votes face down, all votes
// show at once, and the agreed number is written to the story's estimate field in Azure DevOps.
// Face down is on screen only: the votes are in shared storage that people of the organization can read.
// The session, the votes and who is here live in the extension's shared storage for the team and
// are read again every few seconds while the page is open.
import type { WorkItem } from "../api/types.ts";
import type { View } from "../app/context.ts";
import { byOrder, isOpen, leaf, personKey } from "../core/model.ts";
import { fieldTitle } from "../core/rules.ts";
import { prefs } from "../core/settings.ts";
import { collectionName, every, TeamStore } from "../core/teamstore.ts";
import { h, icon } from "../ui/dom.ts";
import { avatar, confirm, empty, errorText, help, segmented, spinner, stateMark, toast } from "../ui/kit.ts";
import { pageBar } from "../ui/pagebar.ts";
import { sanitize } from "../ui/sanitize.ts";
import type { Card, PokerDoc, PokerPresence, PokerSession, PokerVote } from "./pokerlogic.ts";
import { CARD_LABEL, DECK, hereId, present, result, voteId, wideSpread } from "./pokerlogic.ts";

const POLL_MS = 2500;
/** said where votes are "secret": face down on screen only */
const POKER_PRIVACY = "Votes are kept in the organization's extension storage: face down on screen until shown, but people in the organization can read them by technical means.";
const HERE_MS = 15000;
type Filter = "unestimated" | "sprint" | "all";

export const pokerView: View = {
  id: "poker",
  title: "Estimate",
  icon: "poker",
  group: "plan",
  about: "Planning poker: pick a story for everyone, vote face down, show the votes at once, then save the agreed estimate to the story.",
  mount(el, app) {
    const ws = app.ws;
    const me = ws.api.ctx.me;
    const req = ws.requirementLevel();
    const effortField = ws.process.fields.effort;
    const effortName = fieldTitle(effortField, ws.process.types[req.defaultType]?.fieldNames);
    const store = new TeamStore<PokerDoc>(ws.api, collectionName("poker", ws.project, ws.team));
    // An answer that overlaps a change of ours, or comes after a newer read, may be older than the screen
    // (an optimistic note or vote would flicker away): it is dropped, and the next read has the truth.
    let loadSeq = 0;
    let writing = 0;
    let writeMark = 0;
    const tracked = <R>(job: () => Promise<R>): Promise<R> => { writing++; writeMark++; return job().finally(() => { writing--; writeMark++; }); };
    const writes = {
      put: (d: PokerDoc) => tracked(() => store.put(d)),
      update: (id: string, change: (d: PokerDoc) => PokerDoc | null) => tracked(() => store.update(id, change)),
      remove: (id: string) => tracked(() => store.remove(id)),
    };
    let docs: PokerDoc[] = [];
    let loaded = false;
    let loadError = "";
    let lastJson = "";
    let filter = prefs.get<Filter>("poker.filter", "unestimated");
    let acOpen = false; // keep the acceptance criteria open across redraws
    let ownDraft: { story: number; value: string } | null = null; // the number being typed, kept across redraws
    const readOnly = app.actions.readOnly; // read-only: watch the session, never write to it

    // line 2: search the stories to estimate; line 3: which stories the list offers
    const bar = pageBar(app, { search: { placeholder: "Find a story by title or number", title: "Show only the stories whose title or number contains this text", label: "Find a story", onChange: () => draw() } });
    const setFilter = (v: Filter): void => { filter = v; prefs.set("poker.filter", v); drawFilter(); draw(); };
    const drawFilter = (): void => {
      bar.line3.replaceChildren(segmented<Filter>([
        { value: "unestimated", label: "No estimate", title: `Open ${req.name.toLowerCase()} with no ${effortName}` },
        { value: "sprint", label: "This and next sprint", title: "Open stories in the current and the next sprint" },
        { value: "all", label: "All open", title: "Every open story, in backlog order" },
      ], filter, (v) => setFilter(v)));
    };
    drawFilter();
    const root = h("div.poker");
    el.append(bar.el, root);

    const session = (): PokerSession | undefined => docs.find((d): d is PokerSession => d.kind === "session");
    const votesNow = (): PokerVote[] => {
      const s = session();
      return s && s.storyId ? docs.filter((d): d is PokerVote => d.kind === "vote" && d.storyId === s.storyId && d.round === s.round) : [];
    };
    const myVote = (): PokerVote | undefined => votesNow().find((v) => v.user.toLowerCase() === me.uniqueName.toLowerCase());

    async function load(force = false): Promise<void> {
      const mark = writeMark;
      const seq = ++loadSeq;
      let next: PokerDoc[] | null = null;
      let error = "";
      try { next = await store.all(); } catch (e) { error = errorText(e); }
      if (seq !== loadSeq || writing || mark !== writeMark) return;
      if (next) { docs = next; loaded = true; }
      loadError = error;
      const json = JSON.stringify(docs.filter((d) => d.kind !== "here")) + JSON.stringify(present(docs.filter((d): d is PokerPresence => d.kind === "here")).map((p) => p.user)) + loadError;
      if (force || json !== lastJson) { lastJson = json; draw(); }
    }

    async function beHere(): Promise<void> {
      if (readOnly) return;
      await store.put({ id: hereId(me.uniqueName), kind: "here", user: me.uniqueName, name: me.displayName, seen: new Date().toISOString() }).catch(() => {});
    }

    // ---------- drawing ----------
    function draw(): void {
      const listScroll = root.querySelector(".poker-queue-list")?.scrollTop ?? 0;
      const typing = document.activeElement?.classList.contains("poker-own") ?? false;
      root.replaceChildren(
        loadError ? h("p.poker-error", null, `Could not read the session: ${loadError}. Trying again.`) : "",
        !loaded ? spinner("Reading the session…") : h("div.poker-grid", null, queue(), stage()));
      const list = root.querySelector(".poker-queue-list");
      if (list) list.scrollTop = listScroll;
      if (typing) root.querySelector<HTMLInputElement>(".poker-own")?.focus();
    }

    function candidates(): WorkItem[] {
      const cur = ws.currentIteration();
      const next = ws.iterations.filter((i) => i.timeFrame === "future").sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""))[0];
      const q = bar.search.query();
      return ws.ofLevel(req).filter(isOpen).filter((w) => {
        if (filter === "unestimated" && w.effort != null && w.effort > 0) return false;
        if (filter === "sprint" && w.iteration !== cur?.path && w.iteration !== next?.path) return false;
        return !q || w.title.toLowerCase().includes(q) || String(w.id).startsWith(q);
      }).sort(byOrder);
    }

    function queue(): HTMLElement {
      const s = session();
      const list = candidates();
      return h("section.card-box.poker-queue", null,
        h("div.poker-queue-list", null,
          list.length ? list.slice(0, 300).map((w) => h(`button.poker-story${s?.storyId === w.id ? ".on" : ""}`, {
            title: `Estimate #${w.id} with the team (everyone's page switches to it)`,
            disabled: app.actions.readOnly,
            onclick: () => void pickAsked(w.id),
          }, h("span.mono.muted", null, `#${w.id}`), h("span.t", null, w.title),
            w.effort != null ? h("span.poker-est", { title: `${effortName}: ${w.effort}` }, String(w.effort)) : null))
            : h("div.muted.small", null, bar.search.query() ? "No stories match the search. " : filter === "unestimated" ? "Every open story has an estimate. " : "No stories match. ",
              filter !== "all" ? h("button.btn.link", { title: "Show every open story, to estimate again", onclick: () => setFilter("all") }, "Show all open") : null)));
    }

    function stage(): HTMLElement {
      const s = session();
      const story = s?.storyId ? ws.get(s.storyId) : undefined;
      const people = present(docs.filter((d): d is PokerPresence => d.kind === "here"));
      const here = h("div.poker-here", { title: "People who have this page open now" },
        h("span.small.muted", null, `Here now (${people.length}):`), people.map((p) => avatar(ws.api, ws.people().find((x) => personKey(x) === p.user.toLowerCase()) ?? { displayName: p.name, uniqueName: p.user }, 22)));
      if (!s || !s.storyId) {
        return h("section.poker-stage", null, here, empty("No story on the table", "Pick a story on the left. Everyone with this page open sees it and can vote."));
      }
      if (!story) return h("section.poker-stage", null, here, empty(`Story #${s.storyId} is not loaded`, "It may be closed or belong to another team. Pick another story."));
      const votes = votesNow();
      const mine = myVote();
      const res = result(votes);
      const voters = new Map(votes.map((v) => [v.user.toLowerCase(), v]));
      const everyone = [...new Map([...people.map((p) => [p.user.toLowerCase(), p.name] as const), ...votes.map((v) => [v.user.toLowerCase(), v.name] as const)]).entries()];
      const ro = app.actions.readOnly;

      const table = h("div.poker-table", null, everyone.map(([key, name]) => {
        const v = voters.get(key);
        const person = ws.people().find((x) => personKey(x) === key) ?? { displayName: name, uniqueName: key };
        return h("div.poker-seat", { title: v ? (s.revealed ? `${name}: ${label(v.value)}` : `${name} has voted`) : `${name} has not voted yet` },
          h(`div.poker-card.small${v ? (s.revealed ? ".face" : ".back") : ".empty"}`, null, v && s.revealed ? label(v.value) : ""),
          avatar(ws.api, person, 22, { title: "" }), h("span.small", null, name.split(" ")[0]));
      }));

      const deck = h("div.poker-deck", { role: "group", "aria-label": "Your card" }, DECK.map((c) => h(`button.poker-card${mine?.value === c ? ".chosen" : ""}`, {
        title: mine?.value === c ? "Your vote. Click again to take it back" : `${c === "?" ? "Not sure" : c === "coffee" ? "I need a break" : `Vote ${c}`}${keyOf(c) ? ` (key ${keyOf(c)})` : ""}`,
        "aria-pressed": String(mine?.value === c),
        disabled: s.revealed || ro,
        onclick: () => void (mine?.value === c ? withdraw() : castVote(c)),
      }, label(c))));

      const outcome = s.revealed ? h("div.poker-result", null,
        res.count ? h("div.poker-stats", null,
          stat("Votes", String(res.count)),
          stat("Average", res.average == null ? "–" : (Math.round(res.average * 10) / 10).toString()),
          stat("Median", res.median == null ? "–" : String(res.median)),
          h("div.poker-tally", null, res.tally.map((t) => h("span.tag", null, `${label(t.value)} × ${t.n}`))),
          res.consensus ? h("span.poker-consensus", null, "Everyone agrees") : wideSpread(res.numeric) ? h("span.poker-spread", { title: "The highest vote is at least three times the lowest (0 counts as ½): ask the highest and the lowest voter to explain" }, "Wide spread: talk first") : null)
          : h("p.muted", null, "Nobody voted in this round."),
        !ro ? h("div.poker-save", null,
          h("span.small.muted", null, `Save as ${effortName}:`),
          ...[...new Set([res.suggestion, ...res.numeric].filter((n): n is number => n != null))].sort((a, b) => a - b).map((n) =>
            h(`button.btn${n === res.suggestion ? ".primary" : ""}`, { title: `Write ${n} to ${effortName} of #${story.id}${n === res.suggestion ? " (the card nearest the median)" : ""}`, onclick: () => void save(story, n) }, String(n))),
          ownNumber(story, res.suggestion),
          h("button.btn", { title: "Clear the votes and vote again on the same story", onclick: () => void revote() }, icon("refresh", 14), "Vote again")) : null)
        // before the votes show, the team may still agree on a number by talking
        : !ro ? h("div.poker-save.poker-save-early", null, h("span.small.muted", null, `Agreed already? Save as ${effortName}:`), ownNumber(story, story.effort ?? null)) : "";

      return h("section.poker-stage", null, here,
        h("div.card-box.poker-story-box", null,
          h("div.poker-story-head", null, h("span.mono.muted", null, `${story.type} #${story.id}`), stateMark(ws, story),
            h("span.small.muted", null, leaf(story.iteration)),
            story.effort != null ? h("span.tag", { title: `Current ${effortName}` }, `${effortName}: ${story.effort}`) : null,
            h("span.spacer"),
            h("button.btn.small", { title: "Open the story's details", onclick: () => app.openItem(story.id) }, "Details")),
          h("h2", null, story.title),
          story.description ? h("div.rich.poker-desc", null, sanitize(story.description)) : h("p.muted.small", null, "No description."),
          story.acceptance ? h("details.poker-ac", { open: acOpen, ontoggle: (e: Event) => { acOpen = (e.currentTarget as HTMLDetailsElement).open; } }, h("summary", null, "Acceptance criteria"), h("div.rich", null, sanitize(story.acceptance))) : null),
        h("div.poker-round", null,
          h("span.small.muted", null, `Round ${s.round}: ${votes.length} of ${everyone.length || 1} voted`),
          !s.revealed && !ro ? h("button.btn.primary", { title: "Show every vote at once", disabled: !votes.length, onclick: () => void reveal() }, "Show votes") : null,
          help("Votes stay face down until someone clicks \"Show votes\". Then everyone sees them at the same moment. Talk about the highest and lowest, vote again if needed, and save the agreed number.")),
        !s.revealed ? h("p.small.muted.poker-privacy", null, POKER_PRIVACY) : null,
        table, deck, outcome);
    }

    const stat = (l: string, v: string) => h("div.stat", null, h("span.n", null, v), h("span.l", null, l));

    /** Any number the team agrees on, also one nobody voted (or when all voted "?"). */
    function ownNumber(story: WorkItem, suggestion: number | null): HTMLElement {
      const input = h("input.input.poker-own", {
        type: "number", min: 0, step: "any", value: ownDraft?.story === story.id ? ownDraft.value : suggestion == null ? "" : String(suggestion),
        "aria-label": `Agreed ${effortName}`, title: `Type the number the team agreed on; Enter or Save writes it to ${effortName} of #${story.id}`,
      }) as HTMLInputElement;
      const go = (): void => {
        const n = Number(input.value);
        if (input.value.trim() === "" || !Number.isFinite(n) || n < 0) { input.focus(); toast("Type a number of 0 or more.", { kind: "error" }); return; }
        void save(story, n);
      };
      input.addEventListener("input", () => { ownDraft = { story: story.id, value: input.value }; });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
      return h("span.poker-own-box", null, input, h("button.btn", { type: "button", title: `Write the typed number to ${effortName} of #${story.id}`, onclick: go }, "Save"));
    }
    const label = (c: Card | string): string => CARD_LABEL[c] ?? c;
    /** the key that votes a card: its number (13 = 1 then 3), or ? */
    const keyOf = (c: Card): string => (/^\d+$/.test(c) || c === "?" ? c : "");

    // ---------- changes ----------
    /** Another story: ask first when this round has votes, as everyone's votes go. */
    async function pickAsked(storyId: number): Promise<void> {
      const s = session();
      if (readOnly || s?.storyId === storyId) return;
      const n = votesNow().length;
      if (s?.storyId && n && !(await confirm("Switch story?", `${n} vote${n === 1 ? "" : "s"} on #${s.storyId} will be discarded, for everyone.`, "Switch"))) return;
      await pick(storyId);
    }

    async function pick(storyId: number): Promise<void> {
      if (readOnly) return;
      const s: PokerSession = { id: "session", kind: "session", storyId, round: 1, revealed: false, startedBy: me.displayName, updated: new Date().toISOString() };
      const old = session();
      if (old?.storyId === storyId) return;
      docs = [...docs.filter((d) => d.kind !== "session"), s];
      draw();
      try {
        await writes.put(s);
        await clearVotes(storyId);
      } catch (e) { toast(errorText(e), { kind: "error" }); }
      await load(true);
    }

    /** Votes only matter for the story on the table and its current round: clear them all. */
    async function clearVotes(_storyId?: number): Promise<void> {
      const old = docs.filter((d): d is PokerVote => d.kind === "vote");
      await Promise.all(old.map((v) => writes.remove(v.id).catch(() => {})));
    }

    async function castVote(c: Card): Promise<void> {
      const s = session();
      if (readOnly || !s?.storyId || s.revealed) return;
      const v: PokerVote = { id: voteId(s.storyId, s.round, me.uniqueName), kind: "vote", storyId: s.storyId, round: s.round, user: me.uniqueName, name: me.displayName, value: c, at: new Date().toISOString() };
      docs = [...docs.filter((d) => d.id !== v.id), v];
      draw();
      try { await writes.put(v); } catch (e) { toast(errorText(e), { kind: "error" }); }
    }

    /** Take back your vote (click your chosen card again). */
    async function withdraw(): Promise<void> {
      const s = session();
      const v = myVote();
      if (readOnly || !s?.storyId || s.revealed || !v) return;
      docs = docs.filter((d) => d.id !== v.id);
      draw();
      try { await writes.remove(v.id); } catch (e) { toast(errorText(e), { kind: "error" }); await load(true); }
    }

    // number keys vote: 1, 2, 3, 5, 8, 13 (typed quickly), 0, ? (not while typing in a field)
    let keyBuf = "";
    let keyAt = 0;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']")) return;
      if (document.querySelector(".backdrop, .popup") || !el.isConnected) return;
      const s = session();
      if (readOnly || !s?.storyId || s.revealed) return;
      const k = e.key;
      if (k === "?") { e.preventDefault(); void castVote("?"); return; }
      if (!/^\d$/.test(k)) return;
      const now = Date.now();
      const joined = now - keyAt < 800 ? keyBuf + k : k;
      keyBuf = DECK.some((c) => c.startsWith(joined)) ? joined : k;
      keyAt = now;
      const card = DECK.find((c) => c === keyBuf);
      if (card) { e.preventDefault(); void castVote(card); }
    };
    document.addEventListener("keydown", onKey);

    async function reveal(): Promise<void> {
      if (readOnly) return;
      try { await writes.update("session", (d) => ({ ...d, revealed: true, updated: new Date().toISOString() } as PokerDoc)); } catch (e) { toast(errorText(e), { kind: "error" }); }
      await load(true);
    }

    async function revote(): Promise<void> {
      if (readOnly) return;
      try {
        await clearVotes();
        await writes.update("session", (d) => ({ ...d, revealed: false, round: ((d as PokerSession).round ?? 1) + 1, updated: new Date().toISOString() } as PokerDoc));
      } catch (e) { toast(errorText(e), { kind: "error" }); }
      await load(true);
    }

    async function save(story: WorkItem, n: number): Promise<void> {
      if (readOnly) return;
      const before = candidates(); // the list as it was: the saved story may leave it
      const done = await app.actions.setField(story.id, effortField, n, `#${story.id} ${effortName}: ${n}`);
      if (!done) return;
      ownDraft = null;
      // move on: the story after this one in the list (then from the top), if any is still there
      const still = new Set(candidates().map((w) => w.id));
      const at = before.findIndex((w) => w.id === story.id);
      const order = at < 0 ? before : [...before.slice(at + 1), ...before.slice(0, at)];
      const next = order.find((w) => w.id !== story.id && still.has(w.id));
      if (next) await pick(next.id);
      else {
        try { await writes.put({ id: "session", kind: "session", storyId: null, round: 1, revealed: false, startedBy: me.displayName, updated: new Date().toISOString() }); await clearVotes(); } catch { /* shown on next read */ }
        await load(true);
      }
    }

    draw();
    void beHere().then(() => load(true));
    const stopPoll = every(POLL_MS, () => load());
    const stopHere = readOnly ? () => {} : every(HERE_MS, () => beHere());

    return {
      update() { draw(); },
      unmount() {
        stopPoll();
        stopHere();
        document.removeEventListener("keydown", onKey);
        // leave: others stop counting this person as here
        if (!readOnly) void store.remove(hereId(me.uniqueName)).catch(() => {});
      },
    };
  },
};
