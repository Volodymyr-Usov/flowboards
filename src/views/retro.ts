// Retrospective: one board per sprint. People add notes (anonymous if the board says so, hidden from
// others until the board moves on), vote, and agree on action items that can become real tasks.
// The next retrospective opens with the last one's action items and whether they were done.
// Everything is kept in the extension's shared storage for the project and team: the boards in the
// team's collection, each board's notes, action items and votes in a collection of its own. The open
// board is read again every few seconds while the page is open, so the team sees each other's notes;
// the list of boards once a minute. Votes are kept without names (see RetroBallot).
import type { Api } from "../api/api.ts";
import type { Iteration, WorkItem } from "../api/types.ts";
import type { View } from "../app/context.ts";
import { fmtDate, isDone } from "../core/model.ts";
import { prefs } from "../core/settings.ts";
import { collectionName, every, newDocId, storageName, subCollectionName, TeamStore } from "../core/teamstore.ts";
import { h, icon } from "../ui/dom.ts";
import { avatar, empty, errorText, help, personPicker, spinner, stateMark, toast } from "../ui/kit.ts";
import { pageBar } from "../ui/pagebar.ts";
import { escapeHtml } from "./sprintlogic.ts";
import type { Phase, RetroAction, RetroBallot, RetroBoard, RetroDoc, RetroNote } from "./retrologic.ts";
import { ballotId, ballotVote, mergeRetroDocs, myVotesOn, myVotesUsed, newSalt, nextPhase, noteTotals, ordered, PHASES, previousBoard, ranked, strays, TEMPLATES, visibleNotes, vote, voterCount } from "./retrologic.ts";

const POLL_MS = 5000;
/** the list of boards (and older boards' notes) is read this often; the open board every POLL_MS */
const BOARDS_MS = 60_000;
/** the person's own salt for their vote ids, in their personal storage */
const SALT_DOC = "retro-salt";
/** said where notes are "hidden": they are hidden on screen only */
export const RETRO_PRIVACY = "Notes and votes are kept in the organization's extension storage: hidden on screen until the board moves on, but people in the organization can read them by technical means.";

const isConflict = (e: unknown): boolean => [409, 412].includes((e as { status?: number }).status ?? 0);

/** The person's salt for ballot ids (made once, kept in their own storage); `create` false: only read. */
export async function mySalt(api: Pick<Api, "getDoc" | "createDoc">, create: boolean): Promise<string> {
  const doc = await api.getDoc("user", SALT_DOC, "user");
  if (typeof doc?.salt === "string" && doc.salt) return doc.salt;
  if (!create) throw new Error("No votes of yours yet.");
  const salt = newSalt();
  try {
    await api.createDoc("user", { id: SALT_DOC, salt }, "user");
    return salt;
  } catch (e) {
    // another tab of this person made it first: theirs counts
    if (!isConflict(e)) throw e;
    const again = await api.getDoc("user", SALT_DOC, "user");
    if (typeof again?.salt === "string" && again.salt) return again.salt;
    throw e;
  }
}

export const retroView: View = {
  id: "retro",
  title: "Retro",
  icon: "retro",
  group: "plan",
  about: "Sprint retrospectives: notes (anonymous if you like), votes, and action items that become tasks. Shared with everyone in the team.",
  mount(el, app, params) {
    const ws = app.ws;
    const me = ws.api.ctx.me;
    const meKey = me.uniqueName.toLowerCase();
    const store = new TeamStore<RetroDoc>(ws.api, collectionName("retro", ws.project, ws.team));
    /** a board's own collection: its notes, action items and ballots */
    const ownStores = new Map<string, TeamStore<RetroDoc>>();
    const own = (iteration: string): TeamStore<RetroDoc> => {
      let s = ownStores.get(iteration);
      if (!s) { s = new TeamStore<RetroDoc>(ws.api, subCollectionName(store.collection, iteration)); ownStores.set(iteration, s); }
      return s;
    };
    /** where a board's notes and action items are: its own collection, or (an older board not split yet) the team's */
    const home = (iteration: string): TeamStore<RetroDoc> => (boards().some((b) => b.iteration === iteration && b.notesApart) ? own(iteration) : store);
    // An answer that overlaps a change of ours, or comes after a newer read, may be older than the screen
    // (an optimistic note or vote would flicker away): it is dropped, and the next read has the truth.
    let loadSeq = 0;
    let writing = 0;
    let writeMark = 0;
    const tracked = <R>(job: () => Promise<R>): Promise<R> => { writing++; writeMark++; return job().finally(() => { writing--; writeMark++; }); };
    type Part = RetroNote | RetroAction;
    const writes = {
      putBoard: (d: RetroBoard) => tracked(() => store.put(d)),
      updateBoard: (id: string, change: (d: RetroDoc) => RetroDoc | null) => tracked(() => store.update(id, change)),
      put: (d: Part) => tracked(() => home(d.board).put(d)),
      update: (d: { id: string; board: string }, change: (d: RetroDoc) => RetroDoc | null) => tracked(() => home(d.board).update(d.id, change)),
      remove: (d: { id: string; board: string }) => tracked(async () => {
        await home(d.board).remove(d.id);
        // a split board's note may still have its old copy in the team's collection: it goes too, or it would come back
        if (home(d.board) !== store && mainDocs.some((x) => x.id === d.id)) await store.remove(d.id);
      }),
      ballot: (iteration: string, id: string, change: (d: RetroDoc | null) => RetroDoc | null) => tracked(() => own(iteration).upsert(id, change)),
    };
    const partOf = (id: string): Part | undefined => docs.find((d): d is Part => d.id === id && (d.kind === "note" || d.kind === "action"));
    const myNotesKey = `retroMine:${store.collection}`;
    // the list under the collection's older name (before storage went by the team's id) still counts
    const oldNotesKey = `retroMine:${storageName(["retro", ws.project, ws.team])}`;
    const mineIds = new Set([...prefs.get<string[]>(myNotesKey, []), ...(oldNotesKey !== myNotesKey ? prefs.get<string[]>(oldNotesKey, []) : [])]);
    const remember = (id: string): void => { mineIds.add(id); prefs.set(myNotesKey, [...mineIds].slice(-500)); };
    // notes and action items typed but not added yet: per sprint and column, kept in this browser tab
    const draftKey = (sprint: string, col: string): string => `fb.retroDraft:${store.collection}:${sprint}:${col}`;
    const draftGet = (sprint: string, col: string): string => { try { return sessionStorage.getItem(draftKey(sprint, col)) ?? ""; } catch { return ""; } };
    const draftSet = (sprint: string, col: string, text: string): void => {
      try { if (text.trim()) sessionStorage.setItem(draftKey(sprint, col), text); else sessionStorage.removeItem(draftKey(sprint, col)); } catch { /* not kept */ }
    };
    const ACTION_COL = "__action";
    let actionBox: HTMLInputElement | null = null;
    /** a note or action item being changed in place; saved about a second after typing stops */
    let editing: { id: string; text: string; orig: string; saved: string; timer?: ReturnType<typeof setTimeout> } | null = null;
    let colsOpen = false; // Discuss: the notes by column, folded under the ranked list
    const pending = new Set<string>(); // notes being turned into an action, actions getting a task (no double clicks)
    const madeTasks = new Map<string, number>(); // action id -> task created but not yet linked: a retry only links

    const sprints = [...ws.iterations].filter((i) => i.start).sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
    if (!sprints.length) {
      el.append(empty("No sprints", "Retrospectives are kept per sprint. Add sprints to this team in Azure DevOps: Project settings, Team configuration, Iterations."));
      return {};
    }
    // default: the sprint that just ended, unless the current one is close to its end
    const now = Date.now();
    const ended = sprints.filter((s) => s.finish && Date.parse(s.finish) < now);
    const cur = ws.currentIteration();
    let iter: Iteration = sprints.find((s) => s.id === params.it)
      ?? (cur && cur.finish && Date.parse(cur.finish) - now < 3 * 86_400_000 ? cur : ended[ended.length - 1] ?? cur ?? sprints[0]);

    /** what the page shows: mergeRetroDocs of the two below (changed at once by our own changes) */
    let docs: RetroDoc[] = [];
    /** the team's collection: the boards (and older boards' notes and actions) */
    let mainDocs: RetroDoc[] = [];
    let mainAt = 0;
    /** sprint (iteration id) -> its board's own collection as last read */
    const ownDocs = new Map<string, RetroDoc[]>();
    let loaded = false;
    let loadError = "";
    let lastJson = "";
    const extraItems = new Map<number, WorkItem>(); // linked tasks not in the workspace
    // votes: my ballot's id per board (a hash with my own salt; see RetroBallot)
    let saltJob: Promise<string> | undefined;
    const salt = (): Promise<string> => (saltJob ??= mySalt(ws.api, !app.actions.readOnly).catch((e) => { saltJob = undefined; throw e; }));
    const ballotIds = new Map<string, string>();
    async function myBallotId(b: RetroBoard): Promise<string> {
      const known = ballotIds.get(b.id);
      if (known) return known;
      const id = await ballotId(b.id, me.uniqueName, await salt());
      ballotIds.set(b.id, id);
      return id;
    }
    const ballotsOf = (b: RetroBoard | undefined): RetroBallot[] => (b ? docs.filter((d): d is RetroBallot => d.kind === "ballot" && d.board === b.iteration) : []);
    const myBallot = (b: RetroBoard | undefined): RetroBallot | undefined => {
      const id = b ? ballotIds.get(b.id) : undefined;
      return id ? ballotsOf(b).find((x) => x.id === id) : undefined;
    };
    /** boards whose notes are being moved to their own collection (or could not be, this visit) */
    const moving = new Set<string>();

    // line 2: the field (nothing to search: it asks AI) and the sprint; the sprint's dates at its end
    const bar = pageBar(app);
    const nav = h("div.retro-nav");
    const dates = h("span");
    bar.line2.append(nav);
    bar.end.append(dates);
    const root = h("div.retro");
    el.append(bar.el, root);

    const boards = (): RetroBoard[] => docs.filter((d): d is RetroBoard => d.kind === "board");
    const board = (): RetroBoard | undefined => boards().find((b) => b.iteration === iter.id);
    const notesOf = (b: RetroBoard | undefined): RetroNote[] => (b ? docs.filter((d): d is RetroNote => d.kind === "note" && d.board === b.iteration) : []);
    const actionsOf = (b: RetroBoard | undefined): RetroAction[] => (b ? docs.filter((d): d is RetroAction => d.kind === "action" && d.board === b.iteration).sort((a, c) => a.created.localeCompare(c.created)) : []);
    const isMine = (n: RetroNote): boolean => mineIds.has(n.id) || (!!n.author && n.author.toLowerCase() === meKey);

    const boardIn = (list: RetroDoc[], iteration: string): RetroBoard | undefined => list.find((d): d is RetroBoard => d.kind === "board" && d.iteration === iteration);

    /**
     * Read what the page shows. Every time: the open sprint's board (its id is fixed, so a new board or a
     * phase change shows at once) and its own collection. The list of boards once a minute (or `withBoards`),
     * and every time while the open board is an older one whose notes are still in the team's collection.
     */
    async function load(force = false, withBoards = false): Promise<void> {
      const mark = writeMark;
      const seq = ++loadSeq;
      let error = "";
      let main = mainDocs;
      const got = new Map<string, RetroDoc[]>();
      const sprint = iter;
      const boardId = `board-${sprint.id}`;
      const shown = boardIn(main, sprint.id);
      const listDue = withBoards || !mainAt || Date.now() - mainAt >= BOARDS_MS || (!!shown && !shown.notesApart);
      try {
        if (listDue) main = await store.all();
        else {
          const bd = await store.get(boardId);
          main = [...main.filter((d) => d.id !== boardId), ...(bd ? [bd] : [])];
        }
        const b = boardIn(main, sprint.id);
        if (b) got.set(b.iteration, await own(b.iteration).all());
        // the board before: its action items show at the top
        const prev = previousBoard(main.filter((d): d is RetroBoard => d.kind === "board"), b, (id) => sprints.find((s) => s.id === id)?.start, sprint.start);
        if (prev?.notesApart && (listDue || !ownDocs.has(prev.iteration))) got.set(prev.iteration, await own(prev.iteration).all());
      } catch (e) { error = errorText(e); }
      if (seq !== loadSeq || writing || mark !== writeMark) return;
      if (!error) {
        mainDocs = main;
        if (listDue) mainAt = Date.now();
        for (const [k, v] of got) ownDocs.set(k, v);
        docs = mergeRetroDocs(mainDocs, ownDocs);
        loaded = true;
      }
      loadError = error;
      const json = JSON.stringify(docs) + loadError;
      if (force || json !== lastJson) { lastJson = json; draw(); }
      void fetchLinked();
      const b = board();
      if (b && !ballotIds.has(b.id)) void myBallotId(b).then(() => draw(), () => {});
      if (b && !app.actions.readOnly && !error) {
        // an older board opened where changes can be made: its notes move to its own collection, once a visit;
        // a note another page wrote to the old place just before (seen with the list of boards) is moved too
        if (!b.notesApart) { if (!moving.has("split:" + b.id)) void moveNotes(b, true); }
        else if (listDue && !moving.has("heal:" + b.id) && strays(mainDocs, ownDocs.get(b.iteration) ?? [], b.iteration).length) void moveNotes(b, false);
      }
    }

    /** Copy a board's notes and action items from the team's collection to its own (never over one there), then mark the board. */
    async function moveNotes(b: RetroBoard, mark: boolean): Promise<void> {
      const key = (mark ? "split:" : "heal:") + b.id;
      moving.add(key);
      let ok = false;
      try {
        await tracked(async () => {
          const target = own(b.iteration);
          const [main, here] = await Promise.all([store.all(), target.all()]);
          await Promise.all(strays(main, here, b.iteration).map(async (d) => {
            const { __etag: _etag, ...body } = d as Part & { __etag?: number };
            try { await target.create(body as RetroDoc); } catch (e) { if (!isConflict(e)) throw e; }
          }));
          if (mark) await store.update(b.id, (d) => ({ ...d, notesApart: true } as RetroDoc));
        });
        ok = true;
      } catch (e) {
        // tried again on the next visit; until then the board keeps working where its notes are
        console.warn("Retrospective notes not moved to the board's own place", e);
      }
      // a split is tried once a visit; copying a few strays again later is fine
      if (ok && !mark) moving.delete(key);
      await load(true, true);
    }

    async function fetchLinked(): Promise<void> {
      const ids = docs.filter((d): d is RetroAction => d.kind === "action" && !!d.workItemId).map((a) => a.workItemId!)
        .filter((id) => !ws.get(id) && !extraItems.has(id));
      if (!ids.length) return;
      const got = await ws.api.items(ws.project, ids).catch(() => [] as WorkItem[]);
      for (const g of got) extraItems.set(g.id, g);
      if (got.length) draw();
    }

    const itemOf = (id: number | undefined): WorkItem | undefined => (id ? ws.get(id) ?? extraItems.get(id) : undefined);

    // ---------- drawing ----------
    function draw(): void {
      // keep what someone is typing, and where the cursor is
      const active = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
      const activeCol = active?.dataset?.retroCol;
      const caret = activeCol ? active!.selectionStart : null;
      if (actionBox?.isConnected && actionBox.dataset.sprint) draftSet(actionBox.dataset.sprint, ACTION_COL, actionBox.value);
      drawHead();
      root.replaceChildren(loadError ? h("div.retro-error", null, `Could not read the retrospective: ${loadError}. Trying again.`) : "", body());
      if (activeCol) {
        const box = root.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-retro-col="${activeCol}"]`);
        if (box) { box.focus(); if (caret != null) box.setSelectionRange(caret, caret); }
      }
    }

    function drawHead(): void {
      const idx = sprints.findIndex((s) => s.id === iter.id);
      const pick = h("select.input", {
        title: "The sprint this retrospective is about", "aria-label": "Sprint",
        onchange: (e: Event) => { const s = sprints.find((x) => x.id === (e.target as HTMLSelectElement).value); if (s) go(s); },
      }, sprints.map((s) => h("option", { value: s.id, selected: s.id === iter.id }, `${s.name}${s.timeFrame === "current" ? " (current)" : ""}`)));
      // the sprint list keeps focus while someone is choosing
      const focused = nav.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.nav : undefined;
      pick.dataset.nav = "pick";
      nav.replaceChildren(
        h("button.icon-btn", { title: "Previous sprint", "aria-label": "Previous sprint", disabled: idx <= 0, dataset: { nav: "prev" }, onclick: () => go(sprints[idx - 1]) }, icon("chevron", 16, "flip")),
        pick,
        h("button.icon-btn", { title: "Next sprint", "aria-label": "Next sprint", disabled: idx >= sprints.length - 1, dataset: { nav: "next" }, onclick: () => go(sprints[idx + 1]) }, icon("chevron", 16)));
      if (focused) nav.querySelector<HTMLElement>(`[data-nav="${focused}"]`)?.focus();
      dates.textContent = iter.start ? `${iter.name}: ${fmtDate(iter.start, { day: "numeric", month: "short", timeZone: "UTC" })} – ${fmtDate(iter.finish, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}` : "";
      dates.title = `Notes, votes and action items are shared with everyone in ${ws.team}`;
    }

    function go(s: Iteration): void {
      iter = s;
      try { history.replaceState(null, "", `#retro?it=${encodeURIComponent(s.id)}`); } catch { /* not allowed in this frame */ }
      draw();
      void load(true);
    }

    function body(): HTMLElement {
      if (!loaded) return spinner("Reading the retrospective…");
      const b = board();
      if (b?.notesApart && !ownDocs.has(b.iteration)) return spinner("Reading the retrospective…");
      // no board yet: the latest board before this sprint's start (not a later sprint's)
      const prev = previousBoard(boards(), b, (id) => sprints.find((s) => s.id === id)?.start, iter.start);
      return h("div", null, previousActions(prev), b ? boardView(b) : startCard());
    }

    function previousActions(prev: RetroBoard | undefined): HTMLElement | string {
      const acts = actionsOf(prev);
      if (!prev || !acts.length) return "";
      const doneCount = acts.filter((a) => actionDone(a)).length;
      return h("section.card-box.retro-prev", null,
        h("h3", null, `Action items from ${prev.iterationName}`, h("span.muted", null, ` ${doneCount} of ${acts.length} done`)),
        h("ul.retro-actions", null, acts.map((a) => actionRow(a, false))));
    }

    function actionDone(a: RetroAction): boolean {
      const w = itemOf(a.workItemId);
      return w ? isDone(w) : Boolean(a.done);
    }

    function startCard(): HTMLElement {
      let template = TEMPLATES[0].id;
      const tpl = h("select.input", { "aria-label": "Columns", title: "The columns of the board", onchange: (e: Event) => { template = (e.target as HTMLSelectElement).value; } },
        TEMPLATES.map((t) => h("option", { value: t.id }, t.label)));
      const anon = h("input", { type: "checkbox", checked: true, title: "Notes do not record who wrote them" }) as HTMLInputElement;
      const votes = h("input.input", { type: "number", min: 1, max: 20, value: 5, title: "How many votes each person may spend", style: { width: "70px" } }) as HTMLInputElement;
      const startBtn = h("button.btn.primary", {
        title: "Create the retrospective board for this sprint",
        onclick: async () => {
          startBtn.disabled = true;
          const t = TEMPLATES.find((x) => x.id === template) ?? TEMPLATES[0];
          const doc: RetroBoard = {
            id: `board-${iter.id}`, kind: "board", iteration: iter.id, iterationName: iter.name, start: iter.start,
            columns: t.columns, phase: "write", votesPerPerson: Math.max(1, Math.min(20, Math.floor(Number(votes.value)) || 5)),
            anonymous: anon.checked, created: new Date().toISOString(), createdBy: me.displayName, notesApart: true,
          };
          try { await writes.putBoard(doc); await load(true); } catch (e) { toast(errorText(e), { kind: "error" }); startBtn.disabled = false; }
        },
      }, "Start the retrospective");
      if (app.actions.readOnly) { startBtn.disabled = true; startBtn.title = "Read-only: this page cannot change anything"; }
      return h("section.card-box.retro-start", null,
        h("h3", null, `No retrospective for ${iter.name} yet`),
        h("p.muted", null, "Start one: the team adds notes, votes on what to talk about, and agrees on action items."),
        h("div.retro-form", null,
          h("label", null, h("span", null, "Columns"), tpl),
          h("label.inline", null, anon, h("span", null, "Anonymous notes"), help("Notes do not record who wrote them. Each person still sees their own notes as theirs on their own computer.")),
          h("label.inline", null, h("span", null, "Votes per person"), votes)),
        startBtn,
        h("p.small.muted.retro-privacy", null, RETRO_PRIVACY));
    }

    /** votes per note on this board: on the notes (older) and in everyone's ballots */
    let totals = new Map<string, number>();
    const votesFor = (n: RetroNote): number => totals.get(n.id) ?? 0;

    function boardView(b: RetroBoard): HTMLElement {
      const notes = notesOf(b);
      const ballots = ballotsOf(b);
      totals = noteTotals(notes, ballots);
      const used = myVotesUsed(notes, myBallot(b), me.uniqueName);
      const left = Math.max(0, b.votesPerPerson - used);
      const phaseIdx = PHASES.findIndex((p) => p.id === b.phase);
      const steps = h("div.retro-steps", { role: "list" }, PHASES.map((p, i) => h(`span.retro-step${i === phaseIdx ? ".now" : i < phaseIdx ? ".past" : ""}`, { role: "listitem", title: p.help }, `${i + 1}. ${p.label}`)));
      const voted = voterCount(notes, ballots);
      const bar = h("div.retro-bar", null, steps,
        h("span.spacer"),
        b.phase === "vote" ? h("span.retro-votes", { title: "Votes you can still spend on this board" }, `${left} of ${b.votesPerPerson} votes left`) : null,
        h("span.muted.small", null, `${notes.length} note${notes.length === 1 ? "" : "s"}${voted ? ` · ${voted} voted` : ""}${b.anonymous ? " · anonymous" : ""}`),
        b.phase !== "closed" && !app.actions.readOnly ? h("button.btn.primary.small", {
          title: `Move the whole board to "${PHASES[phaseIdx + 1]?.label}": ${PHASES[phaseIdx + 1]?.help}`,
          onclick: () => void setPhase(b, nextPhase(b.phase)),
        }, `Next: ${PHASES[phaseIdx + 1]?.label}`, icon("chevron", 14)) : null,
        phaseIdx > 0 && !app.actions.readOnly ? h("button.btn.small", { title: `Go back to "${PHASES[phaseIdx - 1].label}"`, onclick: () => void setPhase(b, PHASES[phaseIdx - 1].id) }, "Back") : null);
      const cols = h("div.retro-cols", { style: { "--n": String(b.columns.length) } }, b.columns.map((c) => column(b, c, notes.filter((n) => n.column === c.id), left)));
      const discuss = b.phase === "act" || b.phase === "closed";
      return h("div", null, bar, h("p.small.muted.retro-phase-help", null, PHASES[phaseIdx].help),
        b.phase === "write" || b.phase === "vote" ? h("p.small.muted.retro-privacy", null, RETRO_PRIVACY) : null, unsentNotes(b),
        discuss ? [rankedList(b, notes), h("details.retro-bycol", { open: colsOpen, ontoggle: (e: Event) => { colsOpen = (e.currentTarget as HTMLDetailsElement).open; } },
          h("summary", null, "Notes by column"), cols)] : cols,
        discuss ? actionsPanel(b) : "");
    }

    /** Notes typed but not added when the board moved on to Discuss: add them now or throw them away. */
    function unsentNotes(b: RetroBoard): HTMLElement | null {
      if (b.phase === "write" || b.phase === "vote") return null; // the column boxes still hold them
      const open = b.phase !== "closed" && !app.actions.readOnly;
      const rows = b.columns.map((c) => ({ c, text: draftGet(b.iteration, c.id) })).filter((x) => x.text.trim());
      if (!rows.length) return null;
      return h("div.retro-unsent", { role: "status" }, rows.map(({ c, text }) => h("div.retro-unsent-row", null,
        icon("warn", 14), h("b", null, "Unsent note"), h("span.muted", null, ` in "${c.title}":`), h("span.retro-unsent-text", { title: text }, text),
        open ? h("button.btn.small.primary", { type: "button", title: `Add it to "${c.title}" now`, onclick: () => void addNote(b, c.id, text) }, "Add") : null,
        h("button.btn.small", { type: "button", title: "Throw the typed note away", onclick: () => { draftSet(b.iteration, c.id, ""); draw(); } }, "Discard"))));
    }

    /** Discuss: every note of the board in one list, the most votes first. */
    function rankedList(b: RetroBoard, notes: RetroNote[]): HTMLElement {
      const list = ranked(notes, votesFor);
      return h("section.card-box.retro-ranked", null,
        h("h3", null, "To discuss, most votes first", h("span.muted", null, ` ${list.length}`),
          help("All notes of the board in one list, across the columns. Talk about them from the top; \"Action\" makes an action item from a note.")),
        list.length ? h("ol.retro-rank", null, list.map((n) => {
          const c = b.columns.find((x) => x.id === n.column);
          return h("li", { style: { "--c": c?.color ?? "var(--accent)" } }, noteCard(b, n, 0, c?.title));
        })) : h("p.muted.small", null, "No notes on this board."));
    }

    function column(b: RetroBoard, c: RetroBoard["columns"][0], notes: RetroNote[], left: number): HTMLElement {
      const { shown, hidden } = visibleNotes(notes, b.phase, isMine);
      const canWrite = (b.phase === "write" || b.phase === "vote") && !app.actions.readOnly;
      const box = h("textarea.input", {
        rows: 2, placeholder: `Add to "${c.title}"… (Enter adds, Shift+Enter new line)`, "aria-label": `New note in ${c.title}`,
        dataset: { retroCol: c.id }, value: draftGet(b.iteration, c.id),
      }) as HTMLTextAreaElement;
      box.addEventListener("input", () => draftSet(b.iteration, c.id, box.value));
      const add = async (): Promise<void> => {
        const text = box.value;
        box.value = "";
        await addNote(b, c.id, text);
      };
      box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void add(); } });
      return h("section.retro-col", { style: { "--c": c.color } },
        h("h3.retro-col-head", null, c.title, h("span.muted", { title: b.phase === "write" && hidden ? `${shown.length} yours, ${hidden} hidden` : "" }, ` ${shown.length}${b.phase === "write" && hidden ? ` + ${hidden}` : ""}`)),
        canWrite ? h("div.retro-add", null, box, h("button.btn.small", { title: "Add the note", onclick: () => void add() }, icon("plus", 12), "Add")) : null,
        h("div.retro-notes", null,
          ordered(shown, b.phase, votesFor).map((n) => noteCard(b, n, left)),
          hidden ? h("div.retro-hidden", { title: "Other people's notes show when the board moves on to voting" }, `${hidden} note${hidden === 1 ? "" : "s"} from others, hidden while writing`) : null));
    }

    function noteCard(b: RetroBoard, n: RetroNote, left: number, columnTitle?: string): HTMLElement {
      const mine = isMine(n);
      const myVotes = myVotesOn(n, myBallot(b), me.uniqueName);
      const total = votesFor(n);
      const ro = app.actions.readOnly;
      // your own note can be changed or deleted while notes are written and voted on
      const own = mine && (b.phase === "write" || b.phase === "vote") && !ro;
      return h(`div.retro-note${mine ? ".mine" : ""}`, null,
        editing?.id === n.id ? editor(n.id, true, "Your note") : editableText("div.retro-text", n.id, n.text, own, "Click to change your note"),
        h("div.retro-meta", null,
          columnTitle ? h("span.retro-colname.small", null, columnTitle) : null,
          n.authorName ? h("span.small.muted", null, n.authorName) : mine ? h("span.small.muted", null, "You") : h("span.small.muted", null, "Anonymous"),
          h("span.spacer"),
          b.phase !== "write" ? h("span.retro-count", { title: `${total} vote${total === 1 ? "" : "s"}${myVotes ? `, ${myVotes} from you` : ""}` }, `▲ ${total}`) : null,
          b.phase === "vote" && !ro ? h("button.icon-btn.small", { title: myVotes ? "Take back one of your votes" : "You have not voted for this note", "aria-label": "Take back a vote", disabled: !myVotes, onclick: () => void castVote(n, -1) }, "−") : null,
          b.phase === "vote" && !ro ? h("button.btn.small.retro-vote", { title: left ? "Give this note one of your votes" : "You have used all your votes", disabled: !left, onclick: () => void castVote(n, 1) }, "+1") : null,
          b.phase === "act" && !ro ? (actionsOf(b).some((a) => a.noteId === n.id) ? h("span.small.ok", { title: "An action item was made from this note" }, "✓ action")
            : h("button.btn.small", { title: "Make an action item from this note", disabled: pending.has(n.id), onclick: () => { pending.add(n.id); void addAction(b, n.text, n.id).finally(() => pending.delete(n.id)); } }, "Action")) : null,
          own ? h("button.icon-btn.small", { title: total ? `Delete your note (its ${total} vote${total === 1 ? "" : "s"} go too)` : "Delete your note", "aria-label": "Delete note", onclick: () => void removeNote(n) }, icon("close", 12)) : null));
    }

    /** Text that turns into a box on click (or Enter) when it may be changed. */
    function editableText(tag: string, id: string, text: string, can: boolean, title: string): HTMLElement {
      if (!can) return h(tag, null, text);
      return h(`${tag}.retro-editable`, {
        role: "button", tabindex: 0, title,
        onclick: () => startEdit(id, text),
        onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); startEdit(id, text); } },
      }, text);
    }

    function startEdit(id: string, text: string): void {
      if (editing?.id === id) return;
      if (editing) void finishEdit();
      editing = { id, text, orig: text, saved: text };
      draw();
      const box = root.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-retro-col="edit:${id}"]`);
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }

    /** The box of the note or action item being changed: saves as you type, Esc puts the old text back. */
    function editor(id: string, multiline: boolean, label: string): HTMLElement {
      const e = editing!;
      const box = (multiline
        ? h("textarea.input.retro-edit", { rows: 3 })
        : h("input.input.retro-edit", { type: "text" })) as HTMLTextAreaElement | HTMLInputElement;
      box.value = e.text;
      box.dataset.retroCol = `edit:${id}`;
      box.setAttribute("aria-label", label);
      box.title = "Saved as you type. Enter or a click elsewhere ends; Esc puts back the text as it was.";
      box.addEventListener("input", () => {
        e.text = box.value;
        clearTimeout(e.timer);
        e.timer = setTimeout(() => void saveEdit(e), 1000);
      });
      box.addEventListener("keydown", (ev) => {
        const k = ev as KeyboardEvent;
        if (k.key === "Escape") { k.preventDefault(); k.stopPropagation(); void cancelEdit(); }
        else if (k.key === "Enter" && !k.shiftKey) { k.preventDefault(); void finishEdit(); }
      });
      // a redraw takes the box off the page and focuses a new one: that is not the end of the edit
      box.addEventListener("blur", () => setTimeout(() => {
        const now = root.querySelector(`[data-retro-col="edit:${id}"]`);
        if (editing === e && (!now || document.activeElement !== now)) void finishEdit();
      }));
      return box;
    }

    async function writeText(id: string, text: string): Promise<boolean> {
      docs = docs.map((d) => (d.id === id ? { ...d, text } as RetroDoc : d));
      const part = partOf(id);
      if (!part) return false;
      try { await writes.update(part, (d) => ({ ...d, text } as RetroDoc)); return true; } catch (err) { toast(errorText(err), { kind: "error" }); return false; }
    }

    async function saveEdit(e: NonNullable<typeof editing>): Promise<void> {
      clearTimeout(e.timer);
      const text = e.text.trim();
      if (!text || text === e.saved) return;
      const before = e.saved;
      e.saved = text;
      if (!(await writeText(e.id, text))) e.saved = before;
    }

    async function finishEdit(): Promise<void> {
      const e = editing;
      if (!e) return;
      editing = null;
      if (!e.text.trim()) e.text = e.orig; // emptied: keep the text as it was
      if (e.text.trim() === e.orig && e.saved !== e.orig) { clearTimeout(e.timer); e.saved = e.orig; await writeText(e.id, e.orig); }
      else await saveEdit(e);
      draw();
    }

    async function cancelEdit(): Promise<void> {
      const e = editing;
      if (!e) return;
      editing = null;
      clearTimeout(e.timer);
      if (e.saved !== e.orig) await writeText(e.id, e.orig);
      draw();
    }

    function actionsPanel(b: RetroBoard): HTMLElement {
      const acts = actionsOf(b);
      const input = h("input.input", { type: "text", placeholder: "New action item: who does what by when", "aria-label": "New action item", value: draftGet(b.iteration, ACTION_COL), dataset: { retroCol: ACTION_COL, sprint: b.iteration } }) as HTMLInputElement;
      actionBox = input;
      input.addEventListener("input", () => { draftSet(b.iteration, ACTION_COL, input.value); });
      const add = (): void => { const t = input.value.trim(); if (t) { input.value = ""; draftSet(b.iteration, ACTION_COL, ""); void addAction(b, t).then(() => root.querySelector<HTMLInputElement>(`[data-retro-col="${ACTION_COL}"]`)?.focus()); } };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
      return h("section.card-box.retro-actions-box", null,
        h("h3", null, "Action items", h("span.muted", null, ` ${acts.length}`), help("Agree on a few concrete actions. \"Create task\" makes a task in Azure DevOps in the current sprint, so the work is tracked. The next retrospective starts with this list.")),
        acts.length ? h("ul.retro-actions", null, acts.map((a) => actionRow(a, b.phase !== "closed"))) : h("p.muted.small", null, "No action items yet."),
        b.phase === "act" && !app.actions.readOnly ? h("div.retro-add-action", null, input, h("button.btn.small", { title: "Add the action item", onclick: add }, icon("plus", 12), "Add")) : null);
    }

    function actionRow(a: RetroAction, editable: boolean): HTMLElement {
      const w = itemOf(a.workItemId);
      const ro = app.actions.readOnly;
      const owner = a.owner ? ws.people().find((p) => p.uniqueName.toLowerCase() === a.owner!.toLowerCase()) ?? { displayName: a.ownerName ?? a.owner, uniqueName: a.owner } : undefined;
      return h(`li${actionDone(a) ? ".done" : ""}`, null,
        w ? h("span.retro-state", null, stateMark(ws, w)) : h("input", {
          type: "checkbox", checked: Boolean(a.done), disabled: ro, title: a.done ? "Mark as not done" : "Mark as done",
          onchange: (e: Event) => {
            const done = (e.target as HTMLInputElement).checked;
            // a refused save puts the box back as the board has it
            void writes.update(a, (d) => ({ ...d, done } as RetroDoc)).catch((err) => toast(errorText(err), { kind: "error" })).then(() => load(true));
          },
        }),
        editing?.id === a.id ? editor(a.id, false, "Action item") : editableText("span.retro-action-text", a.id, a.text, editable && !ro, "Click to change the action item"),
        h("button.retro-owner", {
          type: "button",
          title: owner ? `Owner: ${owner.displayName}. Click to change${a.workItemId ? ` (task #${a.workItemId} is assigned too)` : ""}.` : "Nobody owns this action. Click to pick someone.", disabled: ro || !editable,
          onclick: (e: Event) => personPicker(ws.api, e.currentTarget as Element, ws.people(), owner, (p) => void setOwner(a, p)),
        }, avatar(ws.api, owner, 20, { title: "" }), h("span.retro-owner-name", null, owner ? owner.displayName.split(" ")[0] : "Owner")),
        w ? h("a.mono.small", { href: ws.itemUrl(w.id), target: "_blank", rel: "noopener", title: `Task #${w.id}: ${w.title}`, onclick: (e: MouseEvent) => { if (ws.get(w.id)) { e.preventDefault(); app.openItem(w.id); } } }, `#${w.id}`)
          : a.workItemId ? h("span.mono.small", null, `#${a.workItemId}`)
            : editable && !ro ? h("button.btn.small", {
              title: madeTasks.has(a.id) ? `Task #${madeTasks.get(a.id)} was created; link it to this action` : "Create a task for this action in the current sprint",
              disabled: pending.has(a.id), onclick: () => void makeTask(a),
            }, madeTasks.has(a.id) ? `Link task #${madeTasks.get(a.id)}` : "Create task") : null,
        editable && !ro ? h("button.icon-btn.small", { title: "Remove this action item (Undo puts it back)", "aria-label": "Remove action item", onclick: () => void removeAction(a) }, icon("close", 12)) : null);
    }

    /** A new owner for the action, and for its task when one was made. */
    async function setOwner(a: RetroAction, p: { uniqueName: string; displayName: string } | null): Promise<void> {
      try { await writes.update(a, (d) => ({ ...d, owner: p?.uniqueName, ownerName: p?.displayName } as RetroDoc)); } catch (e) { toast(errorText(e), { kind: "error" }); return; }
      await load(true);
      if (!a.workItemId) return;
      if (ws.get(a.workItemId)) await app.actions.assign(a.workItemId, p?.uniqueName ?? null);
      else toast(`Task #${a.workItemId} is not loaded here: change its owner in Azure DevOps.`);
    }

    // ---------- changes ----------
    async function setPhase(b: RetroBoard, phase: Phase): Promise<void> {
      try { await writes.updateBoard(b.id, (d) => ({ ...d, phase } as RetroDoc)); await load(true); } catch (e) { toast(errorText(e), { kind: "error" }); }
    }

    /**
     * Give (+1) or take back (-1) a vote. A vote goes into my ballot on this board (no name: see
     * RetroBallot); taking one back takes it from my ballot, or else from an older vote on the note itself.
     */
    async function castVote(n: RetroNote, delta: 1 | -1): Promise<void> {
      const b = board();
      if (!b) return;
      let id: string;
      try { id = await myBallotId(b); } catch (e) { toast(`Your votes could not be read: ${errorText(e)}`, { kind: "error" }); return; }
      const mine = myBallot(b);
      const inBallot = delta > 0 || (mine?.votes?.[n.id] ?? 0) > 0;
      const leftWith = (ballot: RetroBallot | undefined): number => b.votesPerPerson - myVotesUsed(notesOf(b), ballot, me.uniqueName);
      if (inBallot) {
        const local = ballotVote(mine ?? null, id, b.iteration, n.id, delta, leftWith(mine));
        if (!local) return;
        docs = [...docs.filter((d) => d.id !== id), local];
      } else {
        const local = vote(n, me.uniqueName, -1, 0);
        if (!local) return;
        docs = docs.map((d) => (d.id === n.id ? local : d));
      }
      draw();
      try {
        // checked again on the newest copy of my ballot (another tab of mine may have voted)
        if (inBallot) await writes.ballot(b.iteration, id, (d) => ballotVote(d as RetroBallot | null, id, b.iteration, n.id, delta, leftWith((d as RetroBallot | null) ?? undefined)));
        else await writes.update(n, (d) => vote(d as RetroNote, me.uniqueName, -1, 0));
      } catch (e) { toast(errorText(e), { kind: "error" }); }
      await load(true);
    }

    /** Add a note to a column; the typed draft goes. */
    async function addNote(b: RetroBoard, column: string, typed: string): Promise<void> {
      const text = typed.trim();
      if (!text) return;
      draftSet(b.iteration, column, "");
      const note: RetroNote = {
        id: newDocId(`note-${b.iteration}`), kind: "note", board: b.iteration, column, text, created: new Date().toISOString(), votes: {},
        ...(b.anonymous ? {} : { author: me.uniqueName, authorName: me.displayName }),
      };
      remember(note.id);
      docs = [...docs, note];
      draw();
      try { await writes.put(note); } catch (e) { toast(errorText(e), { kind: "error" }); draftSet(b.iteration, column, typed); }
    }

    async function removeNote(n: RetroNote): Promise<void> {
      const cur = docs.find((d) => d.id === n.id) ?? n;
      docs = docs.filter((d) => d.id !== n.id);
      draw();
      try { await writes.remove(n); } catch (e) { toast(errorText(e), { kind: "error" }); await load(true); return; }
      toast("Note deleted", { kind: "ok", undo: async () => { await writes.put(cur as Part); await load(true); } });
    }

    async function addAction(b: RetroBoard, text: string, noteId?: string): Promise<void> {
      const a: RetroAction = { id: newDocId(`action-${b.iteration}`), kind: "action", board: b.iteration, text, created: new Date().toISOString(), noteId };
      docs = [...docs, a];
      draw();
      try { await writes.put(a); } catch (e) { toast(errorText(e), { kind: "error" }); }
    }

    async function removeAction(a: RetroAction): Promise<void> {
      const cur = docs.find((d) => d.id === a.id) ?? a;
      docs = docs.filter((d) => d.id !== a.id);
      draw();
      try { await writes.remove(a); } catch (e) { toast(errorText(e), { kind: "error" }); await load(true); return; }
      toast(a.workItemId ? `Action item removed; task #${a.workItemId} stays in Azure DevOps` : "Action item removed",
        { kind: "ok", undo: async () => { await writes.put(cur as Part); await load(true); } });
    }

    async function makeTask(a: RetroAction): Promise<void> {
      if (pending.has(a.id)) return;
      pending.add(a.id);
      draw();
      try {
        let id = madeTasks.get(a.id);
        if (id == null) {
          const task = ws.taskLevel();
          const sprint = ws.currentIteration() ?? iter;
          const created = await app.actions.create(task?.defaultType ?? "Task", {
            "System.Title": a.text.slice(0, 250),
            "System.IterationPath": sprint.path,
            "System.AssignedTo": a.owner,
            "System.Tags": "Retrospective",
            "System.Description": `<div>Action item from the ${escapeHtml(iter.name)} retrospective.</div>`,
          });
          if (!created) { pending.delete(a.id); draw(); return; }
          id = created.id;
          madeTasks.set(a.id, id);
        }
        const taskId = id;
        try {
          await writes.update(a, (d) => ({ ...d, workItemId: taskId } as RetroDoc));
          madeTasks.delete(a.id);
        } catch (e) { toast(`Task #${taskId} was created but not linked: ${errorText(e)}. Press "Link task" to try again.`, { kind: "error" }); }
      } finally {
        pending.delete(a.id);
      }
      await load(true);
    }

    draw();
    void load(true, true);
    const stop = every(POLL_MS, () => load());

    return {
      update() { draw(); },
      unmount() {
        stop();
        // an edit in progress is saved on the way out
        const e = editing;
        editing = null;
        if (e) void saveEdit(e);
      },
    };
  },
};
