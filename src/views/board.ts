// Board: the team's stories as cards in the team's board columns, joined by lines to their Feature
// in the list on the left, with Features grouped in Epic boxes. Drag a card to another column (its
// status), up or down (its priority) or onto a Feature (its parent); drag a Feature onto another Epic.
// Second layout, the story map: Features across the top, one row per sprint; drag a card to another row
// to move it to that sprint. Cards sort by backlog order in each column. Keys: one card in the Tab
// order, arrows move between cards, Enter opens, Shift+F10 (or right-click, or "…") opens a menu that
// moves a card without dragging.
import type { Iteration, WorkItem } from "../api/types.ts";
import type { View } from "../app/context.ts";
import { REL, relId } from "../api/api.ts";
import { byOrder, DAY, daysInState, daysSince, fmtDays, isDone, isRemoved, isUnder, orderedStates, plainText, samePerson, typeColor } from "../core/model.ts";
import type { Facts } from "../core/rules.ts";
import { fieldTitle, REQUIREMENTS, rulesForMove } from "../core/rules.ts";
import { prefs } from "../core/settings.ts";
import type { UrgencyInput } from "../core/urgency.ts";
import { explainUrgency, urgency } from "../core/urgency.ts";
import { wsjfScore, wsjfSetup } from "../core/wsjf.ts";
import { RuleError } from "../core/writes.ts";
import type { Writer, WriteResult } from "../core/writes.ts";
import { createItem } from "../ui/create.ts";
import { debounce, h, icon, rafThrottle, replace, svg } from "../ui/dom.ts";
import { filterBar, peopleStrip, processFieldNames } from "../ui/filterbar.ts";
import { askDelete } from "../ui/deleteask.ts";
import { TASK_DRAG } from "../ui/dragtypes.ts";
import { avatar, dialog, errorText, menu, personPicker, popup, segmented, select, toast } from "../ui/kit.ts";
import type { MenuItem } from "../ui/kit.ts";
import { tagChip } from "../ui/tagchip.ts";
import { pageBar } from "../ui/pagebar.ts";
import type { Sheet } from "../ui/xlsx.ts";
import { openColumnRules } from "./ruleeditor.ts";
import type { Column, ColorMode, Dir, Group, MissingMode, PrCount, PrLink, RuleGap, SprintRow } from "./boardmodel.ts";
import { defaultLayout } from "../core/workstyle.ts";
import { sprintChoices, taskboard } from "./taskboard.ts";
import type { TaskboardInput } from "./taskboard.ts";
import { burndownPanel } from "./burndownpanel.ts";
import { BOARD_KEY, columnHidden, columnShownPatch, readBoardOpts } from "./boardprefs.ts";
import { blk } from "../ui/blocks.ts";
import type { Opts } from "./boardprefs.ts";
import { DEFAULT_RULES, alreadyBetween, ruleGaps, boardColumns, readAfterUndo, capCards, cardOrder, nearestBox, CELL_CAP, FEATURE_CAP, clockClass, COLUMN_CAP, columnEnteredAt, columnOf, countOf, daysInColumn, featureGroups, groupBy, limitShowing, matches, missing, prCount, prLinks, rowOf, runLimited, sharesState, sprintRows, tint } from "./boardmodel.ts";

interface PrInfo { status: string; title: string; repo: string; url: string }
/** what arrow keys move between: cards, Features, Epics, taskboard stories and tasks */
const ITEMS = ".card, .feat:not(.orphan), .epic-head, .tb-story[data-id], .tb-task";
const ARROWS: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
/** Pull requests read so far, by repository and id, shared by every Board mount in this page (completed and abandoned ones never change). */
const prInfo = new Map<string, PrInfo>();
const prStatusOf = (l: PrLink): string | undefined => prInfo.get(l.key)?.status;
const PR_WORDS: Record<string, string> = { active: "open", draft: "draft", completed: "completed", abandoned: "abandoned", unknown: "cannot be read" };

export const boardView: View = {
  id: "board",
  title: "Board",
  icon: "board",
  group: "plan",
  about: "The team board with stories under their Features and Epics: drag a card to change its status, priority or parent. Taskboard: one sprint, its stories as rows and their tasks by state. Story map: one row per sprint; drag a card to another row to change its sprint.",
  mount(el, app) {
    const ws = app.ws;
    const o: Opts = readBoardOpts();
    // the layout: chosen here for this team (this browser), else what the team's working style opens with
    type Layout = "columns" | "map" | "taskboard";
    const layoutKey = `board.layout:${ws.project}/${ws.team}`;
    const chosenLayout = (): Layout | null => prefs.get<Layout | null>(layoutKey, null);
    const styleLayout = (): Layout => (o.layout === "map" ? "map" : defaultLayout(app.style.current().style));
    let layout: Layout = chosenLayout() ?? styleLayout();
    /** the taskboard's sprint: the current one until another is picked (not kept) */
    let sprintPath: string | null = null;
    /** the taskboard's burndown (Scrum teams): one panel, read once per sprint */
    const burn = burndownPanel(app, { heading: "h3", foldKey: "board.burndownFolded" });
    const save = (): void => prefs.set(BOARD_KEY, o);
    let selected: number | null = app.openId();
    const expanded = new Set<number>(); // stories showing their task list
    const columnSince = new Map<number, string>();
    /** the item Tab goes to (one in the Tab order; arrows move between them) */
    let rove: number | null = null;
    /** a new or just shown card, framed for a moment */
    let flashing = { id: 0, until: 0 };
    /** a number is being typed on a card: redraws wait */
    let editing = false;
    const columnSinceRev = new Map<number, number>();

    // line 2: the field (search lifts matching cards, never hides them), filters, "Pick my next"; line 3: people and switches
    const bar = pageBar(app, { search: {
      placeholder: "Search title, tag, owner, Feature, task, id…", label: "Search the board",
      title: "Cards that contain every word move to the top of their column with a yellow frame", onChange: () => draw(), pin: true,
    } });
    const wrap = h("div.board-wrap");
    const board = h("div.board");
    const lines = svg("svg", { class: "board-lines", "aria-hidden": "true" }) as SVGSVGElement;
    wrap.append(board);
    el.append(bar.el, wrap);

    // ---------- the model of one drawing ----------
    const req = ws.requirementLevel();
    const featLevel = ws.process.levels.find((l) => l.rank === req.rank - 1);
    const epicLevel = featLevel ? ws.process.levels.find((l) => l.rank === featLevel.rank - 1) : undefined;
    const taskLevel = ws.taskLevel();
    const hasAcField = req.types.some((t) => !ws.process.types[t]?.fields || ws.process.types[t].fields!.includes("Microsoft.VSTS.Common.AcceptanceCriteria"));
    const mode = (): "columns" | "states" => (app.settings.shared.boardMode === "states" || !ws.board?.columnField ? "states" : "columns");

    // ---------- filters: on any property, and per person (both hide cards; the search only lifts them) ----------
    const fb = filterBar({ key: "board.filters", items: () => ws.ofLevel(req), names: () => processFieldNames(ws.process), onChange: () => draw() });
    const people = peopleStrip({
      api: ws.api, onChange: () => draw(),
      store: { get: () => ({ only: o.onlyPeople, hidden: o.hiddenPeople }), set: (p) => { o.onlyPeople = p.only; o.hiddenPeople = p.hidden; save(); } },
      // the stories of the columns that can show, passing the other filters
      items: () => {
        const m = mode();
        const cols = boardColumns(ws.process, req, ws.board, m);
        return ws.ofLevel(req).filter((w) => { const c = columnOf(cols, w, m); return c && (c.kind !== "outgoing" || o.closed) && fb.test(w); });
      },
    });

    /** prs: every pull request of the story and its children, once each; pr: those that count under the PRs choice */
    interface Card { w: WorkItem; col: Column; feature: number; tasks: WorkItem[]; prs: PrLink[]; pr: PrCount; missing: string[]; /** what the column rules ask for that is still missing, rule by rule (the ⚠ follows the rules) */ gaps: RuleGap[]; hit: boolean }
    /** what the pull request tooltip and list need of a card, or of a task */
    type PrView = Pick<Card, "w" | "prs" | "pr">;
    const isMap = (): boolean => layout === "map";
    const isTaskboard = (): boolean => layout === "taskboard";
    /** the last pull request links of each card read in full */
    const lastPrs = new Map<number, PrLink[]>();
    const backlogPath = (): string => ws.settings.backlogIteration ?? ws.project;

    /** whether the Epic boxes were on when the Features were hidden with the eye: they come back with them */
    let epicsBeforeHide: boolean | null = null;
    /** Features just created here: shown even without stories yet (the "Empty" switch would hide them) */
    const keepFeatures = new Set<number>();

    /** What the ⚠ says: which rule (of which column) still asks for what, or the plain list for the older fixed checks. */
    function missTitle(lacks: string[], gaps: RuleGap[], colName: string): string {
      if (!gaps.length) return `Missing: ${lacks.join(", ")}`;
      const lines = gaps.map((g) => `${g.rule.target === colName ? `Rule of ${g.rule.target}` : `Rule of ${g.rule.target}, which holds in ${colName} too`}: ${g.labels.join(", ")}`);
      const extra = lacks.filter((l) => !gaps.some((g) => g.labels.includes(l)));
      return ["Not ready by the column rules:", ...lines, ...(extra.length ? [`Also asked for by the colouring rules: ${extra.join(", ")}`] : []), "Change the rules in Settings > Rules."].join("\n");
    }

    // ---- urgency: five small bars on the right edge, the mirror of the type-coloured border on the left ----
    const wsjf = wsjfSetup(ws.process);
    /** the best priority score among the stories, for the "value" part of the urgency (read once per drawing) */
    let bestValue: number | null | undefined;
    const valueShare = (w: WorkItem): number | null => {
      if (app.settings.shared.urgency.value <= 0 || !wsjf.types.size) return null;
      if (bestValue === undefined) bestValue = Math.max(0, ...ws.ofLevel(req).map((x) => wsjfScore(x, wsjf).score ?? 0)) || null;
      const s = wsjfScore(w, wsjf).score;
      return s == null || !bestValue ? null : s / bestValue;
    };
    function urgencyInput(w: WorkItem): UrgencyInput {
      const f = ws.get(w.parent);
      const featPriority = f?.priority ?? ws.get(f?.parent)?.priority;
      const now = Date.now();
      const sprint = ws.iterations.find((i) => i.path === w.iteration && i.finish);
      const left = sprint ? Math.ceil((Date.parse(sprint.finish!) + DAY - now) / DAY) : null;
      const succ = (w.relations ?? []).filter((r) => r.rel === REL.successor).map(relId).filter((x) => x > 0);
      const due = w.dueDate ?? w.targetDate;
      return {
        priority: w.priority, featurePriority: featPriority,
        daysWaiting: w.category === "Proposed" ? daysSince(w.created) : daysInState(w),
        staleDays: app.settings.shared.staleDays,
        sprintDaysLeft: left != null && left >= 0 ? left : null,
        blocks: succ.filter((id) => { const x = ws.get(id); return !x || !(isDone(x) || isRemoved(x)); }).length,
        valueShare: valueShare(w),
        deadlineDaysLeft: due ? Math.ceil((Date.parse(due) - now) / DAY) : null,
      };
    }
    /** The five bars (lit from the bottom, like a phone's charge) with the score in words as their tooltip; none for finished work or when switched off. */
    function urgencyBars(w: WorkItem): HTMLElement | null {
      if (!o.urgency || isDone(w) || w.category === "Completed") return null;
      const i = urgencyInput(w);
      const r = urgency(i, app.settings.shared.urgency);
      return h("div.urg", { role: "img", "aria-label": `Urgency ${r.bars} of 5`, title: explainUrgency(r, i), dataset: { bars: r.bars } },
        [1, 2, 3, 4, 5].map((k) => h("i", { class: [k <= r.bars ? "on" : ""] })));
    }

    /** The ⚠ marks (and the colouring by what is missing) are switched off with the button in the top bar. */
    const warnOff = (): boolean => !prefs.get<boolean>("warn.on", true);
    /** Re-draw when the top bar button switches the ⚠ marks */
    const onWarn = (): void => { draw(); };
    document.addEventListener("flowboards:warn", onWarn);

    /** The facts the rules judge, from what is loaded (no request): enough to show the ⚠ without reading anything per card. */
    function quickFacts(w: WorkItem, kids: WorkItem[], prsList: PrLink[]): Facts {
      const backlogRoot = ws.settings.backlogIteration ?? ws.project;
      const preds = (w.relations ?? []).filter((r) => r.rel === REL.predecessor).map(relId).filter((x) => x > 0);
      return {
        kind: "requirement", description: plainText(w.description), acceptance: plainText(w.acceptance),
        hasOwner: Boolean(w.assignedTo), hasParent: Boolean(w.parent), hasEffort: w.effort != null && w.effort > 0,
        inSprint: w.iteration !== backlogRoot && !isUnder(backlogRoot, w.iteration),
        children: kids.filter((k) => !isRemoved(k)).length, openChildren: kids.filter((k) => !isRemoved(k) && !isDone(k)).length,
        // only pull requests known to be open count here; the move itself reads them all
        openPrs: prsList.filter((l) => { const s = prStatusOf(l); return s === "active" || s === "draft"; }).length,
        openPredecessors: preds.filter((p) => { const x = ws.get(p); return !!x && !(isDone(x) || isRemoved(x)); }).length,
        tags: w.tags.length, me: "", values: w.fields, fieldNames: ws.process.types[w.type]?.fieldNames,
      };
    }

    /** Pull requests of a work item and of all its children (tasks, bugs…), each counted once; `pr` is what counts under the PRs choice. */
    function prsOf(w: WorkItem, kids: WorkItem[]): { prs: PrLink[]; any: PrCount; pr: PrCount } {
      let prs = prLinks(w, kids);
      // a polled copy comes without links: keep the last full count until they are read again (no flicker)
      const unread = !w.relations || kids.some((k) => !k.relations);
      const was = lastPrs.get(w.id);
      if (unread && was) prs = was;
      else if (!unread) lastPrs.set(w.id, prs);
      const any = prCount(prs, prStatusOf, "all");
      return { prs, any, pr: o.prs === "all" ? any : prCount(prs, prStatusOf, o.prs) };
    }

    /** A card, or a task (or any item) with its pull requests: for the tooltip and the list. */
    function prViewOf(id: number): PrView | null {
      const c = current.cards.find((x) => x.w.id === id);
      if (c) return c;
      const w = ws.get(id);
      return w ? { w, ...prsOf(w, ws.children(w.id)) } : null;
    }

    /** The age: a green "new" for what was created today (when the switch is on), else the days ("0d" for today). */
    const born = (days: number): Node | string => (days < 1 && o.newMark ? h("span.new-mark", { title: "Created today" }, "new") : fmtDays(days));

    function build(): { cols: Column[]; shownCols: Column[]; cards: Card[]; groups: Group[]; orphans: boolean; totals: Map<Column, number> } {
      const m = mode();
      const cols = boardColumns(ws.process, req, ws.board, m);
      const shownCols = cols.filter((c) => !columnHidden(o, c));
      const words = bar.search.words();
      const pinned = bar.search.pinned() && words.length > 0;
      const all: Card[] = [];
      bestValue = undefined;
      const totals = new Map<Column, number>(); // every card of a column, before person filters: for the limit
      for (const w of ws.ofLevel(req)) {
        const col = columnOf(cols, w, m);
        if (!col) continue;
        totals.set(col, (totals.get(col) ?? 0) + 1);
        // the taskboard has no columns and its own person rule: it takes every story that passes the filters
        if (!isTaskboard() && !shownCols.includes(col)) continue;
        if (!fb.test(w) || (!isTaskboard() && !people.test(w))) continue;
        const f = ws.get(w.parent);
        const e = f ? ws.get(f.parent) : undefined;
        const tasks = taskLevel ? ws.children(w.id).filter((c) => taskLevel.types.includes(c.type)) : [];
        // search never hides a card: matching cards go to the top of their column with a yellow frame
        const hit = words.length > 0 && matches(words, w, `${f?.title ?? ""} ${e?.title ?? ""} ${tasks.map((t) => t.title).join(" ")} ${plainText(w.description).slice(0, 400)}`);
        // Enter pinned the search: only matching cards stay on the board
        if (pinned && !hit) continue;
        const kids = ws.children(w.id);
        const { prs, any, pr } = prsOf(w, kids);
        // the ⚠ follows the rules of the card's column (and of the columns to its left); the older fixed checks are still a choice
        const ruled = o.miss === "rules" && !warnOff() && w.category !== "Completed";
        const gaps = ruled ? ruleGaps(app.settings.shared.rules, "requirement", cols, cols.indexOf(col), w.type, quickFacts(w, kids, prs)) : [];
        let lacks = o.miss === "rules" ? [...new Set(gaps.flatMap((g) => g.labels))] : missing(w, o.miss, tasks.length, any.counted.length, hasAcField, o.rules);
        if (o.miss === "rules" && ruled) {
          if (o.rules.owner && !w.assignedTo) lacks.push("Owner");
          if (o.rules.effort && w.effort == null) lacks.push("Estimate");
        }
        if (warnOff()) lacks = [];
        all.push({ w, col, feature: f && featLevel?.types.includes(f.type) ? f.id : 0, tasks, prs, pr, missing: lacks, gaps, hit });
      }
      const withCards = new Set(all.map((c) => c.feature));
      const features = featLevel ? ws.ofLevel(featLevel) : [];
      // a pinned search keeps the Features that match by themselves (or by their Epic), with or without cards
      if (pinned) for (const f of features) if (!withCards.has(f.id) && (o.closed || !isDone(f)) && matches(words, f, `${ws.get(f.parent)?.title ?? ""} ${plainText(f.description).slice(0, 400)}`)) withCards.add(f.id);
      for (const id of keepFeatures) { const f = ws.get(id); if (f && (o.closed || !isDone(f))) withCards.add(id); }
      const groups = o.features || isMap() ? featureGroups(features, (id) => (epicLevel ? ws.get(id) : undefined), withCards, { empty: o.empty && !pinned && !people.active() && !fb.active(), byEpic: o.epics && !!epicLevel, showClosed: o.closed }) : [];
      // card order: the backlog order in each column (the lines show the Features), so a drag up or down stays where it was dropped
      all.sort(cardOrder);
      return { cols, shownCols, cards: all, groups, orphans: all.some((c) => c.feature === 0), totals };
    }

    // ---------- drawing ----------
    let current = build();
    /** a big column (or story map cell) draws its first cards only: how many, by "col:<name>" or "cell:<row>|<feature>" */
    const limits = new Map<string, number>();
    const limitOf = (key: string, cap: number): number => limits.get(key) ?? cap;
    /** cards drawn now: background reads (links, pull requests, column dates) are for these */
    const drawn = new Set<number>();
    /** cards per Feature (all of them, also those not drawn) */
    let perFeature = new Map<number, number>();

    function draw(): void {
      // a redraw during a drag would replace the dragged card: draw once when the drag ends
      if (drag || editing || draftBusy()) { drawAfterDrag = true; return; }
      const active = document.activeElement as HTMLElement | null;
      const fEl = active && board.contains(active) ? active.closest<HTMLElement>(ITEMS) : null;
      const focused = Number(fEl?.dataset.id) || null;
      // when that item goes (moved to a hidden column), its neighbour takes the focus
      const sibs = fEl?.parentElement ? [...fEl.parentElement.children].filter((x): x is HTMLElement => x instanceof HTMLElement && x.matches(ITEMS)) : [];
      const k = fEl ? sibs.indexOf(fEl) : -1;
      const near = Number((sibs[k + 1] ?? sibs[k - 1])?.dataset.id) || null;
      current = build();
      const { shownCols, cards, groups, orphans } = current;
      drawn.clear();
      perFeature = new Map();
      for (const c of cards) perFeature.set(c.feature, (perFeature.get(c.feature) ?? 0) + 1);
      const scroll = { x: wrap.scrollLeft, y: wrap.scrollTop };
      // the box being typed in is replaced by a new one: its blur is not a click elsewhere
      redrawing = true;
      board.replaceChildren(lines);
      redrawing = false;
      board.classList.toggle("map", isMap());
      board.classList.toggle("tb-mode", isTaskboard());
      board.classList.toggle("ro", app.actions.readOnly); // no grab cursor when nothing can move
      if (isTaskboard()) {
        const sp = sprintNow();
        const scrum = app.style.current().style === "scrum";
        if (scrum && sp) burn.show(sp);
        board.append(taskboard({
          ...taskboardExtras(),
          app, sprint: sp, burndown: scrum && sp ? burn.el : undefined, storyOk: (w) => fb.test(w), personActive: people.active(), personOk: (w) => people.test(w), tags: o.tags,
          hit: (w, tasks) => { const words = bar.search.words(); return words.length > 0 && matches(words, w, tasks.map((t) => t.title).join(" ")); },
          onlyHits: bar.search.pinned() && bar.search.words().length > 0,
          taskHit: (t) => matches(bar.search.words(), t, ""),
        }));
      } else if (isMap()) {
        storyMap(groups, orphans, cards);
        if (!shownCols.length) board.append(h("div.board-empty", null, "Every column is hidden. Show them again in Settings > Columns."));
      } else {
        board.style.setProperty("--cols", String(shownCols.length));
        board.classList.toggle("no-rail", !o.features);
        if (o.features) board.append(rail(groups, orphans));
        const byCol = groupBy(cards, (c) => c.col);
        for (const col of shownCols) board.append(column(col, byCol.get(col) ?? []));
        if (!shownCols.length) board.append(h("div.board-empty", null, "Every column is hidden. Show them again in Settings > Columns."));
      }
      wrap.scrollLeft = scroll.x;
      wrap.scrollTop = scroll.y;
      drawToolbar();
      applySelection();
      setRove();
      // a redraw replaces the cards: the one that had the focus gets it back
      if (focused) (itemEl(focused) ?? (near ? itemEl(near) : null))?.focus({ preventScroll: true });
      focusDraft();
      requestAnimationFrame(drawLines);
      // an open pull request list shows the statuses read meanwhile
      if (prPop?.content.isConnected) { const c = prViewOf(prPop.id); if (c) prPop.fill(c); }
      // cards that show up now (columns switched on, filters cleared, "Show more", other layout…) get their links and statuses too
      const fresh = [...drawn].filter((id) => !asked.has(id) || (o.counts && !linksAsked.has(id)));
      if (fresh.length) void background(fresh);
    }

    /** "Show N more" at the end of a column or cell that draws only its first cards. */
    function moreButton(key: string, hidden: number, cap: number, noun = ""): HTMLElement {
      const n = Math.min(hidden, cap);
      const what = noun || `card${hidden === 1 ? "" : "s"}`;
      return h("button.btn.small.more-cards", { type: "button", dataset: { more: key, step: cap }, title: `${hidden.toLocaleString()} more ${what} here are not drawn yet, to keep the page fast. Search, filters, Excel and "Pick my next" include them.` },
        `Show ${n} more${noun ? ` ${noun}` : ""}`, n < hidden ? h("span.muted", null, ` of ${hidden.toLocaleString()}`) : null);
    }

    function rail(groups: Group[], orphans: boolean): HTMLElement {
      const count = (fid: number): number => perFeature.get(fid) ?? 0;
      const epicsOff = !o.epics && Boolean(epicLevel);
      const r = h("div.rail", null, h("div.rail-head", null, h("b", null, featLevel?.name ?? "Features"), h("span.muted", null, String(groups.reduce((n, g) => n + g.features.length, 0))),
        h("div.col-tail", null,
          epicsOff ? h("button.icon-btn.small.col-reveal.down", { type: "button", tabindex: -1, dataset: { showEpics: "1" }, "aria-label": `Show ${epicLevel!.name}`,
            title: `${epicLevel!.name} are hidden: the ${featLevel?.name ?? "Features"} are not grouped in boxes. Click to show them.` }, icon("chevron", 14)) : null,
          h("button.icon-btn.small.col-eye", { type: "button", tabindex: -1, dataset: { hideFeatures: "1" }, "aria-label": `Hide ${featLevel?.name ?? "Features"}`,
            title: `Hide ${featLevel?.name ?? "Features"} (and ${epicLevel?.name ?? "Epics"}). An arrow before the first column brings them back; so does Settings > Cards.` }, icon("eye", 14)))));
      if (orphans) r.append(orphanBox(count(0), `Drag a card onto a ${featLevel?.defaultType ?? "Feature"} to give it one.`));
      for (const g of groups) {
        if (g.epic) {
          const box = h("div.epic-box", { dataset: { epic: g.epic.id } },
            h("div.epic-head", { tabindex: -1, dataset: { id: g.epic.id }, title: `${g.epic.type} #${g.epic.id}: ${g.epic.title}\n${g.epic.state}` },
              h("span.e-name", null, h("span.ebadge", null, g.epic.type), g.epic.title),
              !app.actions.readOnly && featLevel ? h("button.icon-btn.small.add", { tabindex: -1, title: `New ${featLevel.defaultType} in this ${g.epic.type}`, dataset: { add: "feature", parent: g.epic.id } }, icon("plus", 12)) : null,
              h("button.icon-btn.small.col-eye", { type: "button", tabindex: -1, dataset: { hideEpics: "1" }, "aria-label": `Hide ${epicLevel?.name ?? "Epics"}`,
                title: `Hide the ${epicLevel?.name ?? "Epic"} boxes: the ${featLevel?.name ?? "Features"} stay, ungrouped. An arrow at the top of the list brings them back; so does Settings > Cards.` }, icon("eye", 14))));
          // a Feature being created under this Epic: its place is held at the top while the form is open
          if (featDraft === g.epic.id) box.append(featureGhost());
          for (const f of g.features) box.append(feature(f, count(f.id)));
          r.append(box);
        } else {
          for (const f of g.features) r.append(feature(f, count(f.id)));
        }
      }
      if (!groups.length && !orphans) r.append(h("p.muted.small", null, "No Features to show."));
      return r;
    }

    /** "No parent Feature": its count, and a + for a story without a parent. */
    function orphanBox(n: number, how: string): HTMLElement {
      const name = featLevel?.defaultType ?? "Feature";
      return h("div.feat.orphan", { dataset: { id: 0 }, title: `${req.name} without a parent ${name}. ${how}` },
        h("div.f-top", null, h("div.f-name", null, `No parent ${name}`),
          !app.actions.readOnly ? h("button.icon-btn.small.add", { title: `New ${req.defaultType} without a parent ${name}`, dataset: { add: "story", parent: 0 } }, icon("plus", 12)) : null),
        h("div.f-sub", null, countOf(n, req.name)));
    }

    /** The card's points (or effort, size): click to change; Enter or leaving saves, Esc cancels. */
    function effortButton(w: WorkItem): HTMLElement | null {
      const field = ws.process.fields.effort;
      if (!field) return null;
      const name = fieldTitle(field, ws.process.types[w.type]?.fieldNames);
      const v = w.effort;
      if (app.actions.readOnly) return v != null ? h("span.c-pts.mono", { title: `${name}: ${v}` }, String(v)) : null;
      return h(`button.c-pts.mono${v == null ? ".empty" : ""}`, { type: "button", tabindex: -1, title: v != null ? `${name}: ${v}. Click to change.` : `No ${name.toLowerCase()} yet. Click to set.`,
        dataset: { num: w.id, field, value: v ?? "", label: name } }, v != null ? String(v) : "–");
    }

    /** the Epic whose new Feature is being filled in (the form is open) */
    let featDraft: number | null = null;
    /** the new Feature's place in its Epic box: dashed, labelled, until it is created or cancelled */
    function featureGhost(): HTMLElement {
      return h("div.feat.feat-new", { "aria-hidden": "true" },
        h("div.f-top", null, h("div.f-name", null, h("span.fbadge", { style: { "--fc": typeColor(ws.process, featLevel?.defaultType ?? "Feature") } }, featLevel?.defaultType ?? "Feature"), "New, not saved yet…")),
        h("div.f-sub", null, h("span.muted", null, "Fill in the form, then Create")));
    }

    function feature(f: WorkItem, n: number): HTMLElement {
      const noDesc = !warnOff() && !isDone(f) && o.miss !== "off" && !plainText(f.description);
      return h(`div.feat${isDone(f) ? ".done" : ""}`, { tabindex: -1, dataset: { id: f.id }, title: `${f.type} #${f.id}: ${f.title}\n${f.state}${n ? ` · ${n} shown` : ""}` },
        h("div.f-top", null,
          // the label is part of the title's text: a long title wraps under it instead of leaving a gap
          h("div.f-name", null, h("span.fbadge", { style: { "--fc": typeColor(ws.process, f.type) } }, f.type), f.title),
          h("div.f-side", null,
            h("button.owner.f-owner", { tabindex: -1, dataset: { owner: f.id }, title: f.assignedTo ? `Owner: ${f.assignedTo.displayName}. Click to change.` : "Nobody owns this. Click to pick someone." }, avatar(ws.api, f.assignedTo, 22, { title: "" })),
            // the ⚠ sits left of the +, in the same row and place as on a story card
            noDesc || !app.actions.readOnly
              ? h("div.c-act", null,
                noDesc ? h("span.warn-mark", { title: `Missing: a description (a ${f.type} should say what it is for)` }, "⚠") : null,
                !app.actions.readOnly ? h("button.icon-btn.small.add", { tabindex: -1, title: `New ${req.defaultType} in this ${f.type}`, dataset: { add: "story", parent: f.id } }, icon("plus", 12)) : null)
              : null)),
        featureLine(f));
    }

    /** A Feature's bottom line: state, the stories done as a bar (like a story's tasks), and the age. */
    function featureLine(f: WorkItem): HTMLElement {
      const kids = ws.children(f.id).filter((k) => req.types.includes(k.type));
      const done = kids.filter(isDone).length;
      const life = daysSince(f.created);
      const inState = daysInState(f);
      const kidNames = [...new Set(kids.map((k) => k.type))].join(" and ").toLowerCase() || req.name.toLowerCase();
      return h("div.f-sub", null,
        app.actions.readOnly ? h("span.f-state", null, f.state)
          : h("button.f-state.tb-state", { type: "button", tabindex: -1, dataset: { stateOf: f.id }, title: `${f.state}: click to change the state` }, f.state),
        // stories done of all, as the tasks are drawn on a story: a bar and the count
        kids.length ? h("span.c-bar.f-bar", { title: `${done} of ${kids.length} ${kidNames} done` },
          h("span.bar", null, h("i", { style: { width: `${Math.round((done / kids.length) * 100)}%` } })),
          h("span.mono", null, `${done}/${kids.length}`))
          : h("span.spacer"),
        // the age, as on the stories but never coloured: since created | in its state
        h("span.clock.neutral", { title: `${fmtDays(life)} since it was created; ${fmtDays(inState)} in ${f.state}` },
          icon("clock", 11), h("span.life", null, born(life)), "|", h("b", null, fmtDays(inState))));
    }

    // ---------- story map: Features across the top, one row per sprint ----------
    let rows: SprintRow[] = [];
    /** the story map's Feature columns in order, also those not drawn */
    let mapFeatures: number[] = [];

    function storyMap(groups: Group[], orphans: boolean, cards: Card[]): void {
      rows = sprintRows(ws.iterations, backlogPath());
      const inRow = groupBy(cards, (c) => rowOf(rows, c.w.iteration).key);
      const shownRows = rows.filter((r) => r.kind !== "past" || inRow.get("past")?.length);
      const byEpic = o.epics && !!epicLevel;
      const every: { id: number; f: WorkItem | null; epic: WorkItem | null }[] = [];
      if (orphans) every.push({ id: 0, f: null, epic: null });
      for (const g of groups) for (const f of g.features) every.push({ id: f.id, f, epic: byEpic ? g.epic : null });
      // many Features: the first ones are drawn (and every one holding a search match); "Show more" adds more
      const hitFeatures = new Set(cards.filter((c) => c.hit).map((c) => c.feature));
      const fLimit = limitOf("features", FEATURE_CAP);
      const cols = every.filter((c, i) => i < fLimit || hitFeatures.has(c.id));
      const hiddenFeatures = every.length - cols.length;
      mapFeatures = every.map((c) => c.id);
      const head = byEpic ? 2 : 1;
      board.style.setProperty("--fcols", String(Math.max(1, cols.length)));
      board.classList.toggle("by-epic", byEpic);
      const at = (row: number | string, col: number | string) => ({ gridRow: String(row), gridColumn: String(col) });
      board.append(h("div.m-corner", { style: at(`1 / span ${head}`, 1) },
        h("b", null, "Sprint"), h("span.muted.small", null, `· ${featLevel?.name ?? "Features"} ${every.filter((c) => c.f).length}`),
        hiddenFeatures ? moreButton("features", hiddenFeatures, FEATURE_CAP, featLevel?.name ?? "Features") : null));
      if (byEpic) {
        // one band per run of Features under the same Epic
        for (let i = 0; i < cols.length;) {
          let j = i;
          while (j + 1 < cols.length && cols[j + 1].epic?.id === cols[i].epic?.id) j++;
          const e = cols[i].epic;
          board.append(h("div.m-epic", { style: at(1, `${i + 2} / span ${j - i + 1}`) }, e
            ? h("div.epic-head", { tabindex: -1, dataset: { id: e.id }, title: `${e.type} #${e.id}: ${e.title}\n${e.state}` }, h("span.ebadge", null, e.type), h("span.e-name", null, e.title))
            : null));
          i = j + 1;
        }
      }
      cols.forEach((c, i) => {
        const n = perFeature.get(c.id) ?? 0;
        board.append(h("div.m-fhead", { style: at(head, i + 2) }, c.f ? feature(c.f, n)
          : orphanBox(n, `Drag a card into a ${featLevel?.defaultType ?? "Feature"} column to give it one.`)));
      });
      const effort = (list: Card[]): number => list.reduce((s, c) => s + (c.w.effort ?? 0), 0);
      shownRows.forEach((r, ri) => {
        const list = inRow.get(r.key) ?? [];
        const pts = effort(list);
        const dates = r.start && r.finish ? `${shortDate(r.start)} – ${shortDate(r.finish)}` : "";
        const tip = r.kind === "past" ? "Open work still in sprints that have ended. Drag a card to a current or coming sprint."
          : r.kind === "backlog" ? `Work in no sprint of this team (${r.path}). Drag a card here to take it out of its sprint.`
            : `${r.path}${dates ? `, ${dates}` : ""}. Drag a card here to move it to this sprint.`;
        const row = head + 1 + ri;
        board.append(h(`div.m-row.k-${r.kind}`, { style: at(row, 1), title: tip },
          h("div.m-rname", null, r.name, r.kind === "current" ? h("span.m-now", null, "now") : null),
          dates ? h("div.small.muted", null, dates) : null,
          h("div.small.muted", null, `${countOf(list.length, req.name)}${pts ? ` · ${pts} pts` : ""}`)));
        const byFeature = groupBy(list, (x) => x.feature);
        cols.forEach((c, ci) => {
          const key = `cell:${r.key}|${c.id}`;
          const { shown, hidden } = capCards(byFeature.get(c.id) ?? [], limitOf(key, CELL_CAP));
          const add = r.kind !== "past" && !app.actions.readOnly
            ? h("button.icon-btn.small.add.m-add", { tabindex: -1, title: `New ${req.defaultType} in ${r.name}${c.f ? `, under ${c.f.title}` : ""}`, dataset: { add: "story", parent: c.id, iteration: r.path ?? "" } }, icon("plus", 12)) : null;
          board.append(h(`div.m-cell.k-${r.kind}`, { style: at(row, ci + 2), dataset: { row: r.key, feature: c.id } },
            shown.map(card), hidden ? moreButton(key, hidden, CELL_CAP) : null, add));
        });
      });
      if (!cols.length) board.append(h("div.board-empty", { style: at(head + 1, 2) }, "No Features to show."));
    }

    const shortDate = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

    function column(col: Column, cards: Card[]): HTMLElement {
      // the limit counts every card of the column, also those hidden by person filters
      const total = current.totals.get(col) ?? cards.length;
      const over = col.limit > 0 && total > col.limit;
      const shown = cards.length < total ? `${cards.length} shown of ${total}` : `${total} shown`;
      const rules = rulesForMove(app.settings.shared.rules, "requirement", current.cols.map((c) => c.name), "", col.name);
      // a hidden column next to this one: a gray arrow on this side pointing to it; a click brings it back
      const at = current.cols.indexOf(col);
      const peek = (hid: Column | undefined, side: "left" | "right"): HTMLElement | null => {
        if (!hid || !columnHidden(o, hid)) return null;
        const n = current.totals.get(hid) ?? 0;
        return h(`button.icon-btn.small.col-reveal.${side}`, { type: "button", tabindex: -1, dataset: { reveal: hid.name }, "aria-label": `Show the ${hid.name} column`,
          title: `${hid.name} is hidden${n ? ` (${n} ${n === 1 ? "item" : "items"})` : ""}. Click to show it ${side === "left" ? "before" : "after"} ${col.name}.` }, icon("chevron", 14));
      };
      const eye = current.shownCols.length > 1
        ? h("button.icon-btn.small.col-eye", { type: "button", tabindex: -1, dataset: { hide: col.name }, "aria-label": `Hide the ${col.name} column`,
          title: `Hide ${col.name}. An arrow next to it brings it back; so does Settings > Columns.` }, icon("eye", 14)) : null;
      const head = h("div.col-head", { dataset: { col: col.name }, title: `${col.name}: ${shown}${col.limit ? `, limit ${col.limit}` : ""}. Click for details.` },
        !o.features && current.shownCols[0] === col ? h("button.icon-btn.small.col-reveal.left", { type: "button", tabindex: -1, dataset: { showFeatures: "1" }, "aria-label": `Show ${featLevel?.name ?? "Features"}`,
          title: `${featLevel?.name ?? "Features"} are hidden. Click to show them before ${col.name}.` }, icon("chevron", 14)) : null,
        peek(current.cols[at - 1], "left"),
        h("i", { style: { background: col.color } }), h("span.c-name", { title: `Rules for moving into ${col.name}: click to see or change them` }, col.name),
        h(`span.c-count${over ? ".over" : ""}`, { title: col.limit ? `${shown}, limit ${col.limit}: click to change the limit` : `${shown}, no limit: click to set one` },
          `${cards.length < total ? `${cards.length} of ` : ""}${total}${col.limit ? `/${col.limit}` : ""}`),
        rules.length ? h("span.c-rule", { title: "This column has rules" }, "§") : null,
        h("div.col-tail", null, eye, peek(current.cols[at + 1], "right")));
      const key = `col:${col.name}`;
      const { shown: first, hidden } = capCards(cards, limitOf(key, COLUMN_CAP));
      const body = h("div.col-body", { dataset: { col: col.name } }, first.map(card), hidden ? moreButton(key, hidden, COLUMN_CAP) : null);
      return h(`div.col.k-${col.kind}`, { dataset: { col: col.name } }, head, body);
    }

    function card(c: Card): HTMLElement {
      const w = c.w;
      drawn.add(w.id);
      const days = daysInColumn(w, columnSince);
      const t = tint(o.color, days, c.missing.length, w.category, o.rules);
      const done = c.tasks.filter(isDone).length;
      // the bar: tasks done and pull requests completed, of all tasks and pull requests (abandoned ones left out)
      const any = prCount(c.prs, prStatusOf, "all");
      const total = c.tasks.length + any.counted.length;
      const fin = done + any.done;
      const f = isMap() ? undefined : ws.get(w.parent);
      // the left border is the type's colour, as in Azure DevOps (User Story blue, Bug red); the tint only colours the background
      const el = h(`div.card${t ? `.t${t}` : ""}${w.category === "Completed" ? ".closed" : ""}${c.hit ? ".hit" : ""}${flashing.id === w.id && Date.now() < flashing.until ? ".flash" : ""}`, { dataset: { id: w.id, feature: c.feature }, tabindex: -1, style: { "--col": typeColor(ws.process, w.type) } },
        h("div.c-main", null,
          // the number and the parent Feature are switches in Settings (off by default)
          o.ids || (o.parents && f)
            ? h("span.c-id", null, o.ids ? `#${w.id}` : null, o.parents && f ? h("span.c-feat", null, `${o.ids ? " · " : ""}${f.title}`) : null) : null,
          h("div.c-title", null, w.title),
          o.tags && w.tags.length ? h("div.c-tags", null, w.tags.slice(0, 4).map((x) => tagChip(x))) : null,
          h("div.c-bottom", null,
            !c.tasks.length ? noTasks(w) : o.counts && total ? h("button.c-bar", { tabindex: -1, dataset: { bar: w.id }, title: `${done}/${c.tasks.length} tasks done${any.counted.length ? `, ${any.done}/${any.counted.length} pull requests completed${any.unknown ? " (reading…)" : ""}` : ""}. Click to show the tasks.` },
              h("span.bar", null, h("i", { style: { width: `${total ? Math.round((fin / total) * 100) : 0}%` } })),
              h("span.mono", null, `${done}/${c.tasks.length}`))
              : h("span.c-bar-empty"),
            o.counts && c.pr.label ? h("button.c-pr.mono", { tabindex: -1, dataset: { prs: w.id }, title: prTip(c) }, icon("pr", 12), c.pr.label) : null,
            effortButton(w))),
        // the right side, top to bottom: owner, add a task, what is missing, then the age
        h("div.c-side", null,
          h("button.owner", { tabindex: -1, dataset: { owner: w.id }, title: w.assignedTo ? `Owner: ${w.assignedTo.displayName}. Click to change.` : "Nobody owns this. Click to pick someone." }, avatar(ws.api, w.assignedTo, 22, { title: "" })),
          // the ⚠ sits left of the +, in the same row, so it never makes the card taller
          c.missing.length || (!app.actions.readOnly && taskLevel)
            ? h("div.c-act", null,
              c.missing.length ? h("span.warn-mark", { title: missTitle(c.missing, c.gaps, c.col.name) }, "⚠") : null,
              !app.actions.readOnly && taskLevel ? h("button.icon-btn.small.add", { tabindex: -1, title: `New ${taskLevel.defaultType}`, dataset: { add: "task", parent: w.id } }, icon("plus", 12)) : null)
            : null,
          h("span.c-gap"),
          h(`span.clock.${clockClass(days, c.col.kind, w.category)}`, { title: `${fmtDays(daysSince(w.created))} since it was created; ${fmtDays(days)} in ${c.col.name}` },
            icon("clock", 12), h("span.life", null, born(daysSince(w.created))), "|", h("b", null, fmtDays(days)))),
        expanded.has(w.id) ? taskList(c) : null,
        urgencyBars(w));
      return el;
    }

    /** A story without tasks says so, grayed out; where tasks can be added, a click makes a new one (like the +). */
    function noTasks(w: WorkItem): HTMLElement {
      if (app.actions.readOnly || !taskLevel) return h("span.c-notasks", null, "No tasks");
      return h("button.c-notasks", { type: "button", tabindex: -1, title: `No tasks yet. Click to add a ${taskLevel.defaultType}.`, dataset: { add: "task", parent: w.id } }, "No tasks");
    }

    /** What Board cards show, for the Taskboard's story rows and task cards: age, colouring, ⚠, pull requests, points, the parent. */
    function taskboardExtras(): Pick<TaskboardInput, "story" | "task" | "trash"> {
      const cols = boardColumns(ws.process, req, ws.board, mode());
      const byId = new Map(current.cards.map((c) => [c.w.id, c]));
      const prButton = (v: PrView): HTMLElement | null => (o.counts && v.pr.label ? h("button.c-pr.mono", { tabindex: -1, dataset: { prs: v.w.id }, title: prTip(v) }, icon("pr", 12), v.pr.label) : null);
      const clock = (life: number, days: number, kind: Column["kind"], w: WorkItem, where: string): HTMLElement =>
        h(`span.clock.${clockClass(days, kind, w.category)}`, { title: `${fmtDays(life)} since it was created; ${fmtDays(days)} ${where}` }, icon("clock", 11), h("span.life", null, born(life)), "|", h("b", null, fmtDays(days)));
      return {
        story: (w, tasks) => {
          drawn.add(w.id); // the background reads (pull requests, column dates) cover the rows shown
          const c = byId.get(w.id);
          const v: PrView = c ?? { w, ...prsOf(w, tasks) };
          const miss = c?.missing ?? [];
          const days = daysInColumn(w, columnSince);
          const col = c?.col ?? columnOf(cols, w, mode());
          const f = ws.get(w.parent);
          const done = tasks.filter(isDone).length;
          const total = tasks.length + v.pr.counted.length;
          const fin = done + v.pr.done;
          return {
            tint: tint(o.color, days, miss.length, w.category, o.rules), missing: miss, missTitle: miss.length ? missTitle(miss, c?.gaps ?? [], c?.col.name ?? w.state) : "",
            clock: clock(daysSince(w.created), days, col?.kind ?? "outgoing", w, `in ${col?.name ?? w.state}`),
            bar: o.counts && total ? h("span.c-bar", { title: `${done}/${tasks.length} tasks done${v.pr.counted.length ? `, ${v.pr.done}/${v.pr.counted.length} pull requests completed` : ""}` },
              h("span.bar", null, h("i", { style: { width: `${Math.round((fin / total) * 100)}%` } })), h("span.mono", null, `${done}/${tasks.length}`)) : null,
            pr: prButton(v), effort: effortButton(w), urg: urgencyBars(w),
            parent: o.parents && f && featLevel?.types.includes(f.type) ? f.title : "",
          };
        },
        task: (t) => ({ clock: clock(daysSince(t.created), daysInState(t), "inProgress", t, `in ${t.state}`), pr: prButton({ w: t, ...prsOf(t, []) }) }),
        trash,
      };
    }

    /** the little bin left of a task, as in the details panel: asks, then the task goes to the Recycle Bin */
    function trash(t: WorkItem): HTMLElement | null {
      if (app.actions.readOnly) return null;
      return h("button.icon-btn.child-del", { type: "button", tabindex: -1, dataset: { delTask: t.id }, title: `Delete ${t.type.toLowerCase()} #${t.id}`, "aria-label": `Delete ${t.type} #${t.id} ${t.title}` }, icon("trash", 12));
    }

    function taskList(c: Card): HTMLElement {
      // pull requests are not listed here: the purple count on the card opens them
      const drafting = draft?.parent === c.w.id ? draftRow(c.w) : null;
      if (!c.tasks.length && !drafting) return h("div.minilist.muted.small", null, "No tasks");
      const ts = c.tasks[0] ? orderedStates(ws.process, [c.tasks[0].type]) : [];
      const doneState = ts.find((s) => s.category === "Completed")?.name;
      const openState = ts.find((s) => s.category === "Proposed")?.name;
      // the tasks sit in their own tray under the story: tinted, with the task type's colour on its edge
      return h("div.minilist.tray", { style: { "--tcol": typeColor(ws.process, c.tasks[0]?.type ?? taskLevel?.defaultType ?? "Task") } },
        h("div.tray-head", null, "Tasks", h("span.mono", null, ` ${c.tasks.filter(isDone).length}/${c.tasks.length}`)),
        drafting,
        c.tasks.map((t) => h("label.mini", { class: [movedTask?.id === t.id && movedTask.story === c.w.id ? "moved" : ""], title: `${t.type} #${t.id}: ${t.state}${t.assignedTo ? ` · ${t.assignedTo.displayName}` : ""}` },
          h("input", { type: "checkbox", checked: isDone(t), disabled: app.actions.readOnly || !doneState, dataset: { task: t.id, to: isDone(t) ? openState ?? "" : doneState ?? "" } }),
          trash(t),
          h("span.m-title", { dataset: { open: t.id } }, t.title),
          t.assignedTo && !samePerson(t.assignedTo, c.w.assignedTo) ? avatar(ws.api, t.assignedTo, 16) : null)));
    }

    // ---------- a new task typed into the story's list ----------
    /** the story whose list has a new task being typed, and the text so far */
    let draft: { parent: number; text: string } | null = null;
    let redrawing = false;
    /** someone is typing in the new task's box: a redraw would take the text and the cursor away */
    function draftBusy(): boolean {
      const i = board.querySelector<HTMLInputElement>("input.draft-task");
      return !!i && i.value !== "" && document.activeElement === i;
    }
    /** the + on a story: show its task list with an empty new task on top, the cursor in it */
    function startDraft(parent: number): void {
      if (app.actions.readOnly || !taskLevel || !ws.get(parent)) return;
      expanded.add(parent);
      draft = { parent, text: draft?.parent === parent ? draft.text : "" };
      draw();
    }
    function focusDraft(): void {
      if (!draft) return;
      const i = board.querySelector<HTMLInputElement>("input.draft-task");
      if (!i) { draft = null; return; }
      i.focus();
      i.setSelectionRange(i.value.length, i.value.length);
    }
    /** done typing (clicked elsewhere, or Enter on an empty box): what was typed is saved as a task */
    function endDraft(save: boolean): void {
      const d = draft;
      if (!d) return;
      draft = null;
      const story = ws.get(d.parent);
      if (save && story && d.text.trim()) void createTask(story, d.text.trim());
      draw();
    }
    /** a task under the story, owned by the story's owner and in its sprint; true when it was created */
    async function createTask(story: WorkItem, title: string): Promise<boolean> {
      if (!taskLevel) return false;
      const area = story.area && ws.settings.areas.some((a) => story.area === a.path || story.area.startsWith(a.path + "\\")) ? story.area : ws.defaultArea();
      const it = await app.actions.create(taskLevel.defaultType, {
        "System.Title": title,
        "System.AssignedTo": story.assignedTo?.uniqueName || undefined,
        "System.IterationPath": story.iteration,
        "System.AreaPath": area,
      }, story.id);
      if (it && alive) draw();
      return Boolean(it);
    }
    function draftRow(story: WorkItem): HTMLElement {
      const input = h("input.draft-task", { type: "text", maxlength: 255, value: draft!.text, "aria-label": `New ${taskLevel!.defaultType.toLowerCase()} for #${story.id}`,
        placeholder: `New ${taskLevel!.defaultType.toLowerCase()}: type a title, Enter adds it and starts another` }) as HTMLInputElement;
      const row = h("label.mini.draft", { title: story.assignedTo ? `Saved under #${story.id}, owned by ${story.assignedTo.displayName}` : `Saved under #${story.id}` },
        h("input", { type: "checkbox", disabled: true, tabindex: -1 }), input);
      input.addEventListener("input", () => { if (draft) draft.text = input.value; });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) { input.value = ""; endDraft(false); return; }
          // saved now; the box empties for the next one, the typed title waits below it until the list redraws
          input.value = "";
          if (draft) draft.text = "";
          const waiting = h("div.mini.waiting", null, h("span.m-title", null, text));
          row.after(waiting);
          void createTask(story, text).then((ok) => {
            if (ok) return;
            waiting.remove();
            if (draft?.parent === story.id && input.isConnected && !input.value) { input.value = text; draft.text = text; }
          });
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          input.value = "";
          if (draft) draft.text = "";
          endDraft(false);
        }
      });
      // a click anywhere else saves what is typed. No redraw here: it would replace what was pressed and swallow that click;
      // the box just leaves, and the list redraws when the new task has been created
      input.addEventListener("blur", () => {
        if (redrawing || !input.isConnected || draft?.parent !== story.id) return;
        const text = input.value.trim();
        draft = null;
        if (!text) { row.remove(); return; }
        row.replaceWith(h("div.mini.waiting", null, h("span.m-title", null, text)));
        void createTask(story, text);
      });
      return row;
    }

    // ---------- pull requests of a card: tooltip and list ----------
    const prFrom = (l: PrLink): string => (l.from ? `from ${ws.get(l.from)?.type.toLowerCase() ?? "child"} #${l.from}` : "from the story");
    const showWord = (): string => (o.prs === "open" ? "open" : o.prs === "completed" ? "completed" : "");

    function prTip(c: PrView): string {
      const head = o.prs === "all"
        ? `${c.pr.done} of ${c.pr.counted.length} pull requests completed`
        : `${c.pr.counted.length} ${showWord()} pull request${c.pr.counted.length === 1 ? "" : "s"}`;
      const lines = c.pr.counted.map((l) => {
        const i = prInfo.get(l.key);
        return `!${l.prId} ${i?.title ?? "(reading…)"} — ${i ? PR_WORDS[i.status] ?? i.status : "…"}, ${prFrom(l)}`;
      });
      const left = c.prs.length - c.pr.counted.length;
      return [head + (c.pr.unknown ? " (still reading some)" : ""), ...lines, left ? `${left} more not counted here (${o.prs === "all" ? "abandoned" : "other status or abandoned"})` : "", "Click for the list with links."].filter(Boolean).join("\n");
    }

    /** the open pull request list, filled again on each drawing */
    let prPop: { id: number; content: HTMLElement; fill: (c: PrView) => void } | null = null;

    function prPopup(anchor: HTMLElement, first: PrView): void {
      const org = ws.api.ctx.orgUrl;
      const row = (l: PrLink): HTMLElement => {
        const i = prInfo.get(l.key);
        const st = i?.status ?? "";
        const url = i?.url || `${org}${encodeURIComponent(ws.projectId || ws.project)}/_git/${encodeURIComponent(l.repoId)}/pullrequest/${l.prId}`;
        return h("li.pr-row", null,
          h(`span.pr-st.s-${st || "reading"}`, null, PR_WORDS[st] ?? "reading…"),
          h("a", { href: url, target: "_blank", rel: "noopener", title: `Open pull request !${l.prId} in Azure DevOps` }, `!${l.prId} ${i?.title ?? ""}`),
          h("span.small.muted", null, i?.repo ? `${i.repo} · ` : "",
            l.from ? h("button.linkish", { dataset: { open: l.from }, title: `Open #${l.from}` }, prFrom(l)) : prFrom(l)));
      };
      const content = h("div.col-pop.pr-pop");
      const fill = (c: PrView): void => {
        const others = c.prs.filter((l) => !c.pr.counted.includes(l));
        content.replaceChildren(
          h("h3", null, `Pull requests of #${c.w.id}`),
          h("p.small.muted", null, `Linked to the story or to any of its tasks, each counted once. ${o.prs === "all" ? `${c.pr.done} of ${c.pr.counted.length} completed.` : `${c.pr.counted.length} ${showWord()}.`}`),
          c.pr.counted.length ? h("ul.pr-list", null, c.pr.counted.map(row)) : h("p.small", null, `No ${showWord()} pull requests.`),
          others.length ? h("div", null, h("b.small", null, "Not counted under this choice:"), h("ul.pr-list.muted", null, others.map(row))) : "");
      };
      fill(first);
      // a link to a task opens it in the details panel
      content.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-open]");
        if (b) { closePr(); app.openItem(Number(b.dataset.open)); }
      });
      const closePr = popup(anchor, content, { onClose: () => { if (prPop?.content === content) prPop = null; } });
      prPop = { id: first.w.id, content, fill };
    }

    // ---------- lines between Features and cards ----------
    const drawLines = (): void => {
      lines.replaceChildren();
      if (!o.features || isMap() || isTaskboard()) return;
      const base = board.getBoundingClientRect();
      lines.setAttribute("width", String(board.scrollWidth));
      lines.setAttribute("height", String(board.scrollHeight));
      const featPos = new Map<number, { x: number; y: number }>();
      for (const f of board.querySelectorAll<HTMLElement>(".rail .feat")) {
        const r = f.getBoundingClientRect();
        featPos.set(Number(f.dataset.id), { x: r.right - base.left, y: r.top - base.top + r.height / 2 });
      }
      for (const c of board.querySelectorAll<HTMLElement>(".card")) {
        const from = featPos.get(Number(c.dataset.feature));
        if (!from) continue;
        const r = c.getBoundingClientRect();
        const to = { x: r.left - base.left, y: r.top - base.top + Math.min(26, r.height / 2) };
        const dx = Math.max(40, (to.x - from.x) * 0.45);
        lines.append(svg("path", {
          d: `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`,
          class: `wire${c.dataset.feature === "0" ? " orphan" : ""}`, dataset: { card: c.dataset.id!, feature: c.dataset.feature! },
        }));
      }
      applySelection();
    };
    const ro = new ResizeObserver(rafThrottle(drawLines));
    ro.observe(board);

    // ---------- selection and hover ----------
    function related(id: number | null): Set<string> {
      const out = new Set<string>();
      if (id == null) return out;
      const w = ws.get(id);
      if (!w) return out;
      out.add(String(id));
      if (featLevel?.types.includes(w.type)) for (const c of current.cards) { if (c.feature === id) out.add(String(c.w.id)); }
      else if (epicLevel?.types.includes(w.type)) {
        for (const c of current.cards) { const f = ws.get(c.feature); if (f?.parent === id) { out.add(String(c.w.id)); out.add(String(f.id)); } }
      } else if (w.parent) { out.add(String(current.cards.find((c) => c.w.id === id)?.feature ?? w.parent)); }
      return out;
    }

    function applySelection(hover: number | null = null): void {
      // a selected item keeps its highlight until it is deselected; hovering only highlights while nothing is selected
      const hot = related(selected ?? hover);
      board.classList.toggle("has-sel", hot.size > 0);
      for (const x of board.querySelectorAll<HTMLElement>(".card, .feat, .epic-head")) {
        x.classList.toggle("hot", hot.has(x.dataset.id ?? ""));
        x.classList.toggle("sel", x.dataset.id === String(selected));
      }
      for (const p of lines.querySelectorAll<SVGPathElement>("path")) {
        p.classList.toggle("hot", hot.has(p.dataset.card!) && hot.has(p.dataset.feature!));
      }
    }

    board.addEventListener("mouseover", (e) => {
      const t = (e.target as Element).closest<HTMLElement>(".card, .feat");
      applySelection(t ? Number(t.dataset.id) || null : null);
    });
    board.addEventListener("mouseleave", () => applySelection());

    // ---------- a task dragged from the details panel onto a story card ----------
    // the task moves under that story; the story's task list opens with all its tasks and the moved one in bold, until the
    // pointer goes elsewhere, the story closes its list or Esc is pressed (nothing is remembered)
    let movedTask: { id: number; story: number } | null = null;
    let dropOn: HTMLElement | null = null;
    const taskDrag = (e: DragEvent): boolean => !app.actions.readOnly && !!e.dataTransfer?.types.includes(TASK_DRAG);
    const clearDrop = (): void => { dropOn?.classList.remove("drop-task"); dropOn = null; };
    board.addEventListener("dragover", (e) => {
      if (!taskDrag(e)) return;
      const card = (e.target as HTMLElement).closest<HTMLElement>(".card");
      if (!card) { clearDrop(); return; }
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      if (dropOn !== card) { clearDrop(); dropOn = card; card.classList.add("drop-task"); }
    });
    board.addEventListener("dragleave", (e) => { if (!board.contains(e.relatedTarget as Node | null)) clearDrop(); });
    board.addEventListener("drop", (e) => {
      if (!taskDrag(e)) return;
      const card = (e.target as HTMLElement).closest<HTMLElement>(".card");
      clearDrop();
      if (!card) return;
      e.preventDefault();
      const taskId = Number(e.dataTransfer!.getData(TASK_DRAG));
      const story = Number(card.dataset.id);
      const t = ws.get(taskId);
      if (!t || !story || t.parent === story) return;
      expanded.add(story);
      movedTask = { id: taskId, story };
      void app.actions.reparent(taskId, story).then((ok) => { if (!ok && movedTask?.id === taskId) movedTask = null; draw(); });
    });
    const dropMoved = (e: Event): void => {
      if (!movedTask) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element).closest(`.card[data-id="${movedTask.story}"]`)) { movedTask = null; draw(); }
    };
    document.addEventListener("pointerdown", dropMoved, true);
    document.addEventListener("keydown", dropMoved, true);

    // ---------- clicks ----------
    board.addEventListener("click", (e) => {
      if (dragJustEnded) return;
      const t = e.target as HTMLElement;
      if (t.closest(".draft-task")) return; // typing a new task's title: not a click on the card
      const del = t.closest<HTMLElement>("[data-del-task]");
      if (del) { e.preventDefault(); const k = ws.get(Number(del.dataset.delTask)); if (k) void askDelete(app, k); return; }
      const add = t.closest<HTMLElement>("[data-add]");
      if (add) { addFrom(add); return; }
      if (t.closest("input.num-edit")) return;
      const num = t.closest<HTMLElement>("[data-num]");
      if (num) { editNumber(num); return; }
      const stateBtn = t.closest<HTMLElement>("[data-state-of]");
      if (stateBtn) { stateMenu(Number(stateBtn.dataset.stateOf), stateBtn); return; }
      const owner = t.closest<HTMLElement>("[data-owner]");
      if (owner) {
        if (app.actions.readOnly) return;
        const id = Number(owner.dataset.owner);
        const w = ws.get(id);
        personPicker(ws.api, owner, ws.people(), w?.assignedTo, (p) => void app.actions.assign(id, p ? p.uniqueName : null));
        return;
      }
      const prBtn = t.closest<HTMLElement>("[data-prs]");
      if (prBtn) {
        const c = prViewOf(Number(prBtn.dataset.prs));
        if (c) prPopup(prBtn, c);
        return;
      }
      const moreBtn = t.closest<HTMLElement>("[data-more]");
      if (moreBtn) {
        const key = moreBtn.dataset.more!;
        const step = Number(moreBtn.dataset.step) || COLUMN_CAP;
        limits.set(key, limitOf(key, step) + step);
        draw();
        return;
      }
      const bar = t.closest<HTMLElement>("[data-bar]");
      if (bar) {
        const id = Number(bar.dataset.bar);
        if (expanded.has(id)) { expanded.delete(id); if (movedTask?.story === id) movedTask = null; } else expanded.add(id);
        draw();
        return;
      }
      const openTask = t.closest<HTMLElement>("[data-open]");
      if (openTask) { app.openItem(Number(openTask.dataset.open)); return; }
      if (t.closest("input[data-task]")) return;
      // Features and Epics: the same choices as the switches in Settings > Cards
      if (t.closest("[data-hide-features]")) { epicsBeforeHide = o.epics; o.features = false; o.epics = false; save(); draw(); return; }
      if (t.closest("[data-hide-epics]")) { o.epics = false; save(); draw(); return; }
      if (t.closest("[data-show-features]")) { o.features = true; if (epicsBeforeHide != null) { o.epics = epicsBeforeHide; epicsBeforeHide = null; } save(); draw(); return; }
      if (t.closest("[data-show-epics]")) { o.epics = true; save(); draw(); return; }
      const hideBtn = t.closest<HTMLElement>("[data-hide]");
      if (hideBtn) { const c = current.cols.find((x) => x.name === hideBtn.dataset.hide); if (c) hideColumn(c); return; }
      const peekBtn = t.closest<HTMLElement>("[data-reveal]");
      if (peekBtn) { const c = current.cols.find((x) => x.name === peekBtn.dataset.reveal); if (c) showColumn(c); return; }
      const head = t.closest<HTMLElement>(".col-head");
      if (head) {
        // the name (and the rules mark) edits the column's rules; the numbers edit its limit; elsewhere: details
        if (t.closest(".c-name, .c-rule")) openColumnRules(app, head.dataset.col!);
        else if (t.closest(".c-count")) limitPopup(t.closest<HTMLElement>(".c-count")!, head.dataset.col!);
        else columnPopup(head);
        return;
      }
      const item = t.closest<HTMLElement>(".card, .feat:not(.orphan), .epic-head");
      if (item) {
        const id = Number(item.dataset.id);
        // a second click on the open item closes its details and keeps it selected
        if (app.openId() === id) { app.closeItem(); return; }
        selected = id;
        app.openItem(id);
        applySelection();
        return;
      }
      if (!t.closest(".rail, .col-head")) { selected = null; applySelection(); }
    });

    board.addEventListener("change", (e) => {
      const cb = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-task]");
      if (!cb) return;
      void app.actions.move(Number(cb.dataset.task), { state: cb.dataset.to });
    });

    board.addEventListener("keydown", (e) => {
      // only the item itself: buttons and boxes inside keep their own keys
      const t = e.target as HTMLElement;
      if (!t.matches(ITEMS)) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFromKeys(t); return; }
      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); itemMenu(t); return; }
      const dir = ARROWS[e.key];
      if (!dir || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      // on the taskboard left and right stay in the story's row
      const rowOfEl = (x: HTMLElement): string | undefined => (x.matches(".tb-story") ? x.dataset.id : x.closest<HTMLElement>(".tb-cell")?.dataset.row);
      const row = (dir === "left" || dir === "right") && t.matches(".tb-story, .tb-task") ? rowOfEl(t) : undefined;
      const list = [...board.querySelectorAll<HTMLElement>(ITEMS)].filter((x) => x.getClientRects().length && (row === undefined || rowOfEl(x) === row));
      const i = nearestBox(t.getBoundingClientRect(), list.map((x) => x.getBoundingClientRect()), dir);
      if (i >= 0) { list[i].focus(); list[i].scrollIntoView({ block: "nearest", inline: "nearest" }); }
    });
    // right-click, the context menu key and Shift+F10 open the item's menu (move without dragging)
    board.addEventListener("contextmenu", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(ITEMS);
      if (!t || (e.target as HTMLElement).closest("input, a")) return;
      e.preventDefault();
      t.focus({ preventScroll: true });
      itemMenu(t);
    });
    // the item focused last is the one Tab comes back to
    board.addEventListener("focusin", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(ITEMS);
      if (!t) return;
      rove = Number(t.dataset.id) || null;
      for (const x of board.querySelectorAll<HTMLElement>(`:is(${ITEMS})[tabindex="0"]`)) if (x !== t) x.tabIndex = -1;
      t.tabIndex = 0;
    });

    function openFromKeys(t: HTMLElement): void {
      const id = Number(t.dataset.id);
      if (!id) return;
      if (t.matches(".card, .feat, .epic-head")) { selected = id; applySelection(); }
      app.openItem(id);
    }

    /** One item in the Tab order: the last one focused, else the selected one, else the first card. */
    function setRove(): void {
      const list = [...board.querySelectorAll<HTMLElement>(ITEMS)];
      for (const x of list) x.tabIndex = -1;
      const pick = list.find((x) => rove != null && Number(x.dataset.id) === rove)
        ?? list.find((x) => selected != null && Number(x.dataset.id) === selected)
        ?? list.find((x) => x.matches(".card, .tb-story, .tb-task")) ?? list[0];
      if (pick) pick.tabIndex = 0;
    }

    const itemEl = (id: number): HTMLElement | null => board.querySelector<HTMLElement>(`:is(${ITEMS})[data-id="${id}"]`);

    /** The item's menu: open, move to a column, state or sprint, owner, new child… for the keyboard, right-click and "…". */
    function itemMenu(el: HTMLElement, anchor: HTMLElement = el): void {
      const id = Number(el.dataset.id);
      const w = ws.get(id);
      if (!w) return;
      const ro = app.actions.readOnly;
      // a redraw while the menu is open replaces the item: find it again by its id
      const now = (): HTMLElement => (el.isConnected ? el : itemEl(id) ?? el);
      const back = (): void => { const x = now(); if (x.isConnected) x.focus({ preventScroll: true }); };
      const edit = (): void => { const b = now().querySelector<HTMLElement>("[data-num]"); if (b) editNumber(b); };
      const items: (MenuItem | "-")[] = [{ label: "Open", hint: "Enter", onClick: () => openFromKeys(el) }];
      const owner = (): void => {
        const b = now().querySelector<HTMLElement>("[data-owner]") ?? now();
        personPicker(ws.api, b, ws.people(), w.assignedTo, (p) => { back(); void app.actions.assign(id, p ? p.uniqueName : null); });
      };
      if (el.matches(".card")) {
        const c = current.cards.find((x) => x.w.id === id);
        if (!ro && c && !isMap()) {
          items.push("-", ...current.cols.filter((col) => col !== c.col).map((col) => ({ label: `Move to ${col.name}`, onClick: () => { back(); void moveCard(w, col, 0, 0); } })));
        }
        if (!ro && c) items.push({ label: "Move to sprint…", onClick: () => sprintMenu(c, now()) });
        if (!ro) items.push("-", { label: "Owner…", onClick: owner });
        const pts = el.querySelector<HTMLElement>("[data-num]");
        if (!ro && pts) items.push({ label: `${pts.dataset.label ?? "Points"}…`, onClick: edit });
        if (!ro && taskLevel) items.push({ label: `New ${taskLevel.defaultType.toLowerCase()}`, onClick: () => addFrom(el.querySelector<HTMLElement>("[data-add]") ?? el) });
        if (c?.tasks.length) items.push({ label: expanded.has(id) ? "Hide tasks" : "Show tasks", onClick: () => { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); draw(); back(); } });
        if (c?.prs.length) items.push({ label: "Pull requests…", onClick: () => prPopup(now().querySelector(".c-pr") ?? now(), c) });
      } else if (el.matches(".tb-task")) {
        if (!ro) {
          items.push("-", ...stateItems(w, back), "-", { label: "Owner…", onClick: owner });
          if (el.querySelector("[data-num]")) items.push({ label: "Remaining hours…", onClick: edit });
        }
      } else if (!ro) {
        // a Feature, an Epic or a taskboard story
        if (el.matches(".tb-story")) items.push("-", ...stateItems(w, back));
        if (el.querySelector("[data-owner]")) items.push("-", { label: "Owner…", onClick: owner });
        const add = el.querySelector<HTMLElement>("[data-add]");
        if (add) items.push({ label: add.title || "New", onClick: () => addFrom(add) });
      }
      menu(anchor, items);
    }

    /** The states a story or task can move to, as menu items. */
    function stateItems(w: WorkItem, back: () => void): MenuItem[] {
      return orderedStates(ws.process, [w.type]).filter((s) => s.name !== w.state && s.category !== "Removed")
        .map((s) => ({ label: `Move to ${s.name}`, onClick: () => { back(); void app.actions.move(w.id, { state: s.name }); } }));
    }

    function stateMenu(id: number, anchor: HTMLElement): void {
      const w = ws.get(id);
      if (!w || app.actions.readOnly) return;
      menu(anchor, stateItems(w, () => itemEl(id)?.focus({ preventScroll: true })));
    }

    /** Move a card to a sprint without dragging: like a drop on the story map's row (its open tasks go along). */
    function sprintMenu(c: Card, el: HTMLElement): void {
      rows = sprintRows(ws.iterations, backlogPath());
      const at = rowOf(rows, c.w.iteration).key;
      const items = rows.filter((r) => r.path && r.key !== at).map((r) => ({
        label: `${r.name}${r.kind === "current" ? " (now)" : ""}`,
        onClick: () => { (el.isConnected ? el : itemEl(c.w.id))?.focus({ preventScroll: true }); void dropOnCell(c.w, r.key, c.feature); },
      }));
      menu(el, items.length ? items : [{ label: "No other sprint", disabled: true, onClick: () => {} }]);
    }

    function columnPopup(head: HTMLElement): void {
      const name = head.dataset.col!;
      const col = current.cols.find((c) => c.name === name);
      if (!col) return;
      const shownN = current.cards.filter((c) => c.col === col).length;
      const total = current.totals.get(col) ?? shownN;
      const n = shownN < total ? `${shownN} of ${total}` : String(total);
      const steps = current.cols.map((c) => c.name);
      const own = app.settings.shared.rules.filter((r) => (r.level === "requirement" || r.level === "*") && r.target === name);
      const before = rulesForMove(app.settings.shared.rules, "requirement", steps, "", name).filter((r) => !own.includes(r));
      const states = [...new Set(Object.values(col.states))].join(", ");
      let closePop = (): void => {};
      closePop = popup(head, h("div.col-pop", null,
        h("h3", null, name),
        h("p.small.muted", null, `${n} shown${col.limit ? ` · limit ${col.limit}` : ""} · state ${states}`),
        own.length ? h("div", null, h("b.small", null, `To enter ${name}:`), h("ul.small", null, own.flatMap((r) => {
          const names = ws.process.types[req.types[0]]?.fieldNames;
          const when = r.from ? ` (from ${r.from})` : "";
          return [...r.requires.map((q) => h("li", null, REQUIREMENTS.find((x) => x.id === q)?.label ?? q, when)),
            ...(r.fields ?? []).map((f) => h("li", null, `${fieldTitle(f, names)} filled${when}`)),
            ...(r.onlyBy.length ? [h("li", null, `only ${r.onlyBy.join(", ")}${when}`)] : [])];
        }))) : h("p.small", null, `${name} has no rule of its own.`),
        before.length ? h("div.muted", null, h("b.small", null, "Also checked on the way:"), h("ul.small", null, before.map((r) => h("li", null, `${r.target}: ${[...r.requires.map((q) => REQUIREMENTS.find((x) => x.id === q)?.label ?? q), ...(r.fields ?? []).map((f) => fieldTitle(f))].join(", ")}`)))) : null,
        h("p.small.muted", null, "Rules are checked when a card moves in with this dashboard."),
        h("div.col-pop-acts", null,
          h("button.btn.small", { onclick: () => { closePop(); openColumnRules(app, name); } }, "Edit rules"),
          h("button.btn.small", { onclick: () => { closePop(); limitPopup(head.querySelector<HTMLElement>(".c-count") ?? head, name); } }, "Edit limit"),
          current.shownCols.length > 1 ? h("button.btn.small", { onclick: () => { closePop(); hideColumn(col); } }, "Hide this column") : null)));
    }

    /** Change the most cards a column should hold; saved on the team's board in Azure DevOps. */
    function limitPopup(anchor: HTMLElement, name: string): void {
      const col = current.cols.find((c) => c.name === name);
      const boardCol = mode() === "columns" ? ws.board?.columns.find((c) => c.name === name) : undefined;
      if (!col) return;
      if (!boardCol || !ws.board) {
        popup(anchor, h("div.col-pop", null, h("h3", null, `Limit of ${name}`),
          h("p.small", null, "Limits belong to the team's board columns. This board shows states; switch it to board columns in Settings > Project board.")));
        return;
      }
      const board = ws.board;
      const readOnly = app.actions.readOnly;
      const input = h("input.input.limit-input", { type: "number", min: 0, max: 999, step: 1, value: col.limit ? String(col.limit) : "", placeholder: "No limit", "aria-label": `Most cards in ${name}`, disabled: readOnly }) as HTMLInputElement;
      const msg = h("p.small.warn-text", { role: "alert" });
      let close = (): void => {};
      const saveLimit = async (v: number): Promise<void> => {
        if (!Number.isInteger(v) || v < 0 || v > 999) { msg.textContent = "Give a whole number from 0 to 999 (0 = no limit)."; return; }
        msg.textContent = "Saving…";
        try {
          await app.actions.setColumnLimit(ws.project, ws.team, board.name, name, v, boardCol.itemLimit);
          boardCol.itemLimit = v;
          close();
          toast(v ? `${name} now holds at most ${v}` : `${name} has no limit now`, { kind: "ok" });
          draw();
        } catch (e) { msg.textContent = `Not saved: ${errorText(e)}`; }
      };
      // an empty box keeps the limit: only "No limit" (or 0) removes it
      const fromInput = (): void => {
        const raw = input.value.trim();
        if (input.validity.badInput || (raw === "" && col.limit)) { msg.textContent = "Give a whole number from 0 to 999 (0 = no limit), or press No limit."; return; }
        if (raw === "") { close(); return; } // no limit before, none now
        void saveLimit(Number(raw));
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !readOnly) { e.preventDefault(); fromInput(); } });
      close = popup(anchor, h("div.col-pop.limit-pop", null,
        h("h3", null, `Limit of ${name}`),
        h("p.small.muted", null, `The most cards ${name} should hold. Above it the number turns red, here and in Azure DevOps. Saved on the team's board in Azure DevOps.`),
        input,
        readOnly ? h("p.small.muted", null, "Read-only: the limit cannot be changed here.") : h("div.col-pop-acts", null,
          h("button.btn.primary.small", { onclick: fromInput }, "Save"),
          col.limit ? h("button.btn.small", { onclick: () => void saveLimit(0) }, "No limit") : null),
        msg));
      if (!readOnly) { input.focus(); input.select(); }
    }

    // ---------- drag and drop ----------
    let drag: null | {
      kind: "card" | "feat"; id: number; src: HTMLElement; ghost: HTMLElement; startX: number; startY: number; dx: number; dy: number;
      target: null | { type: "col"; col: string; before: number; after: number } | { type: "feat"; id: number } | { type: "epic"; id: number } | { type: "featOrder"; prev: number; next: number }
        | { type: "cell"; row: string; feature: number };
    } = null;
    let pending: { e: PointerEvent; el: HTMLElement } | null = null;
    let dragJustEnded = false;
    let drawAfterDrag = false;
    const marker = h("div.insert-mark");

    board.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || app.actions.readOnly) return;
      const t = e.target as HTMLElement;
      if (t.closest("button, input, a, label.mini")) return;
      // the story map moves cards only (Features keep their place across the top)
      const el = t.closest<HTMLElement>(isMap() ? ".card" : ".card, .feat:not(.orphan)");
      if (!el) return;
      pending = { e, el };
    });

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKey, true);

    /** The browser took the pointer (a touch turned into a scroll): no drop, nothing left half done. */
    function onCancel(): void {
      pending = null;
      endDrag();
    }

    function onMove(e: PointerEvent): void {
      // the button went up where this page did not hear it: the drag is over
      if ((pending || drag) && e.pointerType === "mouse" && e.buttons === 0) { onCancel(); return; }
      if (pending && !drag) {
        if (Math.hypot(e.clientX - pending.e.clientX, e.clientY - pending.e.clientY) < 6) return;
        const src = pending.el;
        const r = src.getBoundingClientRect();
        const ghost = src.cloneNode(true) as HTMLElement;
        ghost.classList.add("ghost");
        ghost.style.width = r.width + "px";
        document.body.append(ghost);
        src.classList.add("dragging");
        document.body.classList.add("is-dragging");
        drag = { kind: src.classList.contains("card") ? "card" : "feat", id: Number(src.dataset.id), src, ghost, startX: e.clientX, startY: e.clientY, dx: pending.e.clientX - r.left, dy: pending.e.clientY - r.top, target: null };
        pending = null;
      }
      if (!drag) return;
      drag.ghost.style.left = e.clientX - drag.dx + "px";
      drag.ghost.style.top = e.clientY - drag.dy + "px";
      autoScroll(e);
      findTarget(e.clientX, e.clientY);
    }

    function autoScroll(e: PointerEvent): void {
      const r = wrap.getBoundingClientRect();
      if (e.clientX > r.right - 40) wrap.scrollLeft += 18; else if (e.clientX < r.left + 40) wrap.scrollLeft -= 18;
      if (e.clientY > window.innerHeight - 40) window.scrollBy(0, 18); else if (e.clientY < 90) window.scrollBy(0, -18);
    }

    function clearMarks(): void {
      marker.remove();
      for (const x of board.querySelectorAll(".drop")) x.classList.remove("drop");
    }

    function findTarget(x: number, y: number): void {
      if (!drag) return;
      clearMarks();
      drag.target = null;
      const under = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!under || !board.contains(under)) return;
      if (drag.kind === "card" && isMap()) {
        // a cell: its row is the sprint, its column the Feature; earlier sprints take no drops
        const cell = under.closest<HTMLElement>(".m-cell");
        if (!cell || cell.dataset.row === "past") return;
        cell.classList.add("drop");
        drag.target = { type: "cell", row: cell.dataset.row!, feature: Number(cell.dataset.feature) };
        return;
      }
      if (drag.kind === "card") {
        const feat = under.closest<HTMLElement>(".rail .feat");
        if (feat) {
          feat.classList.add("drop");
          drag.target = { type: "feat", id: Number(feat.dataset.id) };
          return;
        }
        const col = under.closest<HTMLElement>(".col");
        if (!col) return;
        const body = col.querySelector<HTMLElement>(".col-body")!;
        const cards = [...body.querySelectorAll<HTMLElement>(":scope > .card")].filter((c) => c !== drag!.src);
        let before = 0;
        let after = 0;
        let ref: HTMLElement | null = null;
        for (const c of cards) {
          const r = c.getBoundingClientRect();
          if (y < r.top + r.height / 2) { ref = c; break; }
          before = Number(c.dataset.id);
        }
        after = ref ? Number(ref.dataset.id) : 0;
        col.classList.add("drop");
        if (ref) body.insertBefore(marker, ref); else body.append(marker);
        drag.target = { type: "col", col: col.dataset.col!, before, after };
      } else {
        const epic = under.closest<HTMLElement>(".epic-box");
        const feat = under.closest<HTMLElement>(".rail .feat:not(.orphan)");
        const srcEpic = ws.get(drag.id)?.parent;
        if (feat && feat !== drag.src) {
          const r = feat.getBoundingClientRect();
          const top = y < r.top + r.height / 2;
          const list = [...board.querySelectorAll<HTMLElement>(".rail .feat:not(.orphan)")].filter((f) => f !== drag!.src);
          const i = list.indexOf(feat);
          const prev = top ? list[i - 1] : feat;
          const next = top ? feat : list[i + 1];
          feat.parentElement!.insertBefore(marker, top ? feat : feat.nextSibling);
          const targetEpic = epic ? Number(epic.dataset.epic) : 0;
          if (epic && targetEpic !== srcEpic) { epic.classList.add("drop"); drag.target = { type: "epic", id: targetEpic }; return; }
          drag.target = { type: "featOrder", prev: prev ? Number(prev.dataset.id) : 0, next: next ? Number(next.dataset.id) : 0 };
          return;
        }
        if (epic && Number(epic.dataset.epic) !== srcEpic) {
          epic.classList.add("drop");
          drag.target = { type: "epic", id: Number(epic.dataset.epic) };
        }
      }
    }

    function endDrag(): void {
      if (!drag) return;
      drag.ghost.remove();
      drag.src.classList.remove("dragging");
      document.body.classList.remove("is-dragging");
      clearMarks();
      drag = null;
      dragJustEnded = true;
      setTimeout(() => { dragJustEnded = false; }, 50);
      if (drawAfterDrag) { drawAfterDrag = false; draw(); }
    }

    function onUp(): void {
      pending = null;
      if (!drag) return;
      const d = drag;
      const t = d.target;
      endDrag();
      if (!t) return;
      const w = ws.get(d.id);
      if (!w) return;
      if (d.kind === "card") {
        if (t.type === "cell") { void dropOnCell(w, t.row, t.feature); return; }
        if (t.type === "feat") {
          if (t.id === (w.parent ?? 0)) return;
          // "No parent Feature": only take away a Feature parent, never a link to another level
          if (t.id === 0) { const p = ws.get(w.parent); if (!p || !featLevel?.types.includes(p.type)) return; }
          void app.actions.reparent(d.id, t.id);
          return;
        }
        if (t.type === "col") {
          const col = current.cols.find((c) => c.name === t.col);
          if (col) void moveCard(w, col, t.before, t.after);
        }
      } else {
        if (t.type === "epic") void app.actions.reparent(d.id, t.id);
        else if (t.type === "featOrder") void app.actions.reorder(d.id, t.prev, t.next);
      }
    }

    /**
     * Move a card to a column, between two cards there (0 = none): the column, the backlog order, or both
     * with one message and one Undo. A card whose order already puts it there keeps its order.
     */
    async function moveCard(w: WorkItem, col: Column, before: number, after: number): Promise<void> {
      const from = current.cards.find((c) => c.w.id === w.id)?.col;
      const place = (before || after) && !alreadyBetween(w, ws.get(before), ws.get(after));
      if (col === from) { if (place) await app.actions.reorder(w.id, before, after); return; }
      const target = mode() === "columns" ? { column: col.name } : { state: col.states[w.type] ?? col.name };
      if (!place || app.actions.readOnly) { await app.actions.move(w.id, target); return; }
      // the move first, by itself: when a rule stops it, the usual dialog (move anyway, open), then the place
      let moved: WriteResult;
      try {
        moved = await app.actions.writer.move(w.id, target);
      } catch (e) {
        if (!(e instanceof RuleError)) { toast(errorText(e), { kind: "error" }); return; }
        if (await app.actions.move(w.id, target)) await app.actions.reorder(w.id, before, after);
        return;
      }
      const prev = ws.get(before);
      await app.actions.batch(`#${w.id} → ${col.name}, ${prev ? `after #${prev.id}` : "at the top"}`, [
        { label: `#${w.id} to ${col.name}`, run: async () => moved },
        { label: `Priority of #${w.id}`, run: async (wr) => readAfterUndo(await wr.reorder(w.id, before, after), () => ws.refresh(w.id)) },
      ]);
    }

    /** Story map drop: another row moves the story (and its open tasks in the same sprint) there; another column changes its Feature. */
    async function dropOnCell(w: WorkItem, rowKey: string, featureId: number): Promise<void> {
      const row = rows.find((r) => r.key === rowKey);
      const card = current.cards.find((c) => c.w.id === w.id);
      if (!row || !card) return;
      // "No parent Feature": only take away a Feature parent, never a link to another level
      const p = ws.get(w.parent);
      const reparent = featureId !== card.feature && (featureId !== 0 || (!!p && !!featLevel?.types.includes(p.type)));
      if (!(row.path && rowOf(rows, w.iteration).key !== row.key)) {
        if (reparent) await app.actions.reparent(w.id, featureId);
        return;
      }
      // the story, its open tasks of the same sprint and a new Feature: one message, one Undo
      const path = row.path;
      const before = w.iteration;
      const tasks = card.tasks.filter((t) => !isDone(t) && t.iteration === before);
      let storyMoved = true;
      const notMoved = (): Promise<WriteResult> => Promise.reject(new Error(`#${w.id} did not move`));
      const steps: { label: string; run: (wr: Writer) => Promise<WriteResult> }[] = [
        { label: `#${w.id} to ${row.name}`, run: (wr) => wr.setFields(w.id, [{ field: "System.IterationPath", value: path }]).catch((e: unknown) => { storyMoved = false; throw e; }) },
        ...tasks.map((t) => ({ label: `#${t.id} (task of #${w.id}) to ${row.name}`, run: (wr: Writer) => (storyMoved ? wr.setFields(t.id, [{ field: "System.IterationPath", value: path }]) : notMoved()) })),
      ];
      const f = ws.get(featureId);
      if (reparent) steps.push({ label: `#${w.id} under ${f ? `#${f.id}` : "no parent"}`, run: (wr) => (storyMoved ? wr.reparent(w.id, featureId) : notMoved()) });
      const withTasks = tasks.length ? ` with ${tasks.length} open task${tasks.length === 1 ? "" : "s"}` : "";
      const under = reparent ? `, now under ${f ? `#${f.id} ${f.title}` : "no parent"}` : "";
      await app.actions.batch(`#${w.id} moved to ${row.name}${withTasks}${under}`, steps);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Escape") return;
      if (drag) { e.stopPropagation(); endDrag(); return; }
      // Esc closes the details first (the panel does that), then a second Esc drops the selection
      if (selected == null || app.openId() != null || document.querySelector(".backdrop, .popup")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      selected = null;
      applySelection();
    }

    // ---------- the page bar ----------
    const searchCount = h("span.b-count");
    const newBtn = app.actions.readOnly ? null : blk("new", h("button.btn", {
      title: `New ${req.defaultType} without a parent ${featLevel?.defaultType ?? "Feature"}; the + on a ${featLevel?.defaultType ?? "Feature"} or a story map cell puts it there`,
      dataset: { add: "story", parent: 0 }, onclick: (e: Event) => addFrom(e.currentTarget as HTMLElement),
    }, icon("plus", 14), "New"));
    bar.line2.append(newBtn ?? "",
      blk("pick", h("button.btn", { title: "Open the story to pick up next: ready, owned by you or nobody, nothing missing", onclick: () => lucky() }, icon("sparkle", 14), "Pick my next")));
    /** the colouring choices, at the right end of the bar */
    const endTools = h("div.b-endtools");
    bar.end.append(searchCount, endTools);
    /** Board / Taskboard / Story map: after People and Filter (CSS order) */
    const layoutSlot = blk("layout", h("span.b-layout"));
    bar.el.querySelector(".pb-2")?.prepend(layoutSlot);
    /** groups that read as one each (the sprint, the hidden-columns note) */
    const group = (name: string, ...kids: (HTMLElement | null)[]): HTMLElement => (GROUP_BLOCK[name] ? (el: HTMLElement) => blk(GROUP_BLOCK[name], el) : (el: HTMLElement) => el)(h("div.pb-group", { role: "group", "aria-label": name }, ...kids));
    const GROUP_BLOCK: Record<string, string> = { Sprint: "sprint", Columns: "columns" };

    /** The cards shown, as one sheet: for the top bar's Excel and Copy. */
    function sheet(): Sheet {
      return { name: "Board", rows: [
        ["Id", "Type", "Title", "Column", "State", featLevel?.defaultType ?? "Parent", "Epic", "Owner", "Tags", "Estimate", "Sprint", "Days in column", "Tasks done", "Tasks", "Pull requests completed", "Pull requests", "Missing"],
        ...current.cards.map((c) => {
          const f = ws.get(c.feature);
          const e = f ? ws.get(f.parent) : undefined;
          return [c.w.id, c.w.type, c.w.title, c.col.name, c.w.state, f?.title ?? "", e?.title ?? "", c.w.assignedTo?.displayName ?? "", c.w.tags.join("; "), c.w.effort ?? "",
            c.w.iteration, daysInColumn(c.w, columnSince), c.tasks.filter(isDone).length, c.tasks.length, c.pr.done, c.pr.counted.length, c.missing.join(", ")];
        }),
      ] };
    }

    function drawToolbar(): void {
      people.refresh();
      const hits = current.cards.filter((c) => c.hit).length;
      searchCount.textContent = bar.search.words().length ? `${bar.search.pinned() ? "Only " : ""}${hits} match${hits === 1 ? "" : "es"}${bar.search.pinned() ? " shown" : ""}` : "";
      const layoutSel = segmented<Layout>([
        { value: "columns", label: "Board", title: "The team's board columns: limits, age, stories under their Features" },
        { value: "taskboard", label: "Taskboard", title: "One sprint: its stories as rows, their tasks in a column per state" },
        { value: "map", label: "Story map", title: "Features across the top and one row per sprint; drag a card to another row to move it to that sprint" },
      ], layout, (v) => {
        layout = v;
        prefs.set(layoutKey, v);
        o.layout = v === "map" ? "map" : "columns";
        save(); wrap.scrollLeft = 0; wrap.scrollTop = 0; draw();
      });
      const sprints = sprintChoices(ws.iterations);
      const sprintSel = isTaskboard() && sprints.length ? select<string>(sprints.map((i) => ({ value: i.path, label: `${i.name}${i === ws.currentIteration() || i.path === ws.currentIteration()?.path ? " (current)" : ""}` })),
        sprintNow()?.path ?? "", (v) => { sprintPath = v; draw(); }, { title: "The sprint on the taskboard", "aria-label": "Sprint" }) : null;
      // the right end: on the board and story map, how cards are coloured
      if (newBtn) newBtn.hidden = isTaskboard();
      if (isTaskboard()) {
        replace(endTools);
        replace(layoutSlot, layoutSel);
        replace(bar.line3, group("People", people.el), group("Filters", fb.el), sprintSel ? group("Sprint", sprintSel) : null);
        return;
      }
      replace(endTools,
        blk("colour", h("label.inline", { title: `Colour cards: by days in the column (${o.rules.ageWarn} / ${o.rules.ageBad}), by what is missing, or both. "with…" sets the rules.` }, h("span.lab", null, "Colour"),
          select<ColorMode>([{ value: "none", label: "None" }, { value: "age", label: "Age" }, { value: "missing", label: "Missing" }, { value: "both", label: "Both" }], o.color, (v) => { o.color = v; save(); draw(); }))),
        blk("colour", h("label.inline", { title: "Mark cards that miss something" }, h("span.lab", null, "⚠"),
          select<MissingMode>([{ value: "off", label: "Off" }, { value: "rules", label: "Column rules" }, { value: "desc", label: "Description" }, { value: "descAc", label: "+ criteria" }, { value: "all", label: "+ tasks" }], o.miss, (v) => { o.miss = v; save(); draw(); }))),
        blk("colour", h("button.btn.small.rules-btn", { type: "button", title: "See and set the colouring rules: when cards turn yellow or red, and what else counts as missing", onclick: (e: Event) => rulesPopup(e.currentTarget as HTMLElement) }, "with…")));
      // the switches (Epics, Features, Empty, Counts, PRs, Tags, Numbers, Parents) live in Settings > Cards (the gear in the top bar)
      replace(layoutSlot, layoutSel);
      // the story map has no column heads: a hidden column would silently leave its cards out, so say so here
      const hiddenCols = isMap() ? current.cols.filter((c) => columnHidden(o, c)) : [];
      const colsBtn = hiddenCols.length ? h("button.btn.small", { type: "button", "aria-haspopup": "menu",
        title: `Columns hidden on the Board, whose cards the story map leaves out: ${hiddenCols.map((c) => c.name).join(", ")}. Click to show one.`,
        onclick: (e: Event) => menu(e.currentTarget as HTMLElement, hiddenCols.map((c) => ({ label: `Show ${c.name}`, onClick: () => showColumn(c) }))),
      }, `${hiddenCols.length} column${hiddenCols.length === 1 ? "" : "s"} hidden`) : null;
      replace(bar.line3, group("People", people.el), group("Filters", fb.el), colsBtn ? group("Columns", colsBtn) : null);
    }

    /** The taskboard's sprint: the one picked, else the current one, else the next one. */
    function sprintNow(): Iteration | undefined {
      const list = sprintChoices(ws.iterations);
      return list.find((i) => i.path === sprintPath) ?? ws.currentIteration() ?? list.find((i) => Date.parse(i.start!) > Date.now()) ?? list[list.length - 1];
    }

    /** The colouring rules: thresholds for yellow and red, and extra things that count as missing. Kept in this browser. */
    function rulesPopup(anchor: HTMLElement): void {
      const r = o.rules;
      const apply = (): void => { save(); draw(); };
      const num = (key: "ageWarn" | "ageBad" | "missWarn" | "missBad", min: number, label: string): HTMLElement => {
        const input = h("input.input.rules-num", { type: "number", min, max: 999, step: 1, value: String(r[key]), "aria-label": label }) as HTMLInputElement;
        input.addEventListener("change", () => {
          const v = Math.round(Number(input.value));
          if (!Number.isFinite(v) || v < min) { input.value = String(r[key]); return; }
          r[key] = v;
          // red never comes before yellow
          if (r.ageBad < r.ageWarn) r.ageBad = r.ageWarn;
          if (r.missBad < r.missWarn) r.missBad = r.missWarn;
          paint();
          apply();
        });
        return input;
      };
      const check = (key: "owner" | "effort", label: string, tip: string): HTMLElement => h("label.inline", { title: tip },
        h("input", { type: "checkbox", checked: r[key], onchange: (e: Event) => { r[key] = (e.target as HTMLInputElement).checked; apply(); } }), label);
      const MISS: Record<MissingMode, string> = { off: "nothing (⚠ is off)", rules: "what the rules of the card's column ask for (Settings > Rules), also those of the columns to its left", desc: "a description", descAc: "a description and acceptance criteria", all: "a description, acceptance criteria, and tasks once work started" };
      const box = h("div.col-pop.rules-pop");
      const paint = (): void => {
        box.replaceChildren(
          h("h3", null, "Colouring rules"),
          h("p.small.muted", null, `Colour is "${o.color === "none" ? "None" : o.color === "age" ? "Age" : o.color === "missing" ? "Missing" : "Both"}": ${o.color === "none" ? "cards are not coloured." : o.color === "age" ? "by days in the column." : o.color === "missing" ? "by how many things are missing." : "by age or what is missing, whichever is worse."} Closed cards are never coloured.`),
          h("div.rules-sec", null,
            h("b", null, "⚠ Missing"),
            h("p.small.muted", null, `The ⚠ choice checks ${MISS[o.miss]}.${o.miss === "rules" && !app.settings.shared.rules.length ? " The team has no rules yet, so no ⚠ shows: add them in Settings > Rules." : ""} Also count:`),
            h("div.rules-row", null,
              check("owner", "Owner", "A card nobody owns counts as missing something"),
              check("effort", "Effort", "A card without an effort (story points or size) counts as missing something"))),
          h("div.rules-sec", null,
            h("b", null, "By what is missing"),
            h("div.rules-row", null, h("span.rules-y", null, "Yellow"), "from", num("missWarn", 1, "Yellow from this many missing"), h("span.rules-r", null, "red"), "from", num("missBad", 1, "Red from this many missing"), "missing")),
          h("div.rules-sec", null,
            h("b", null, "By age"),
            h("div.rules-row", null, h("span.rules-y", null, "Yellow"), "from", num("ageWarn", 0, "Yellow from this many days"), h("span.rules-r", null, "red"), "from", num("ageBad", 0, "Red from this many days"), "days in the column")),
          h("div.col-pop-acts", null,
            h("button.btn.small", { type: "button", title: "Back to 1 / 2 missing and 30 / 90 days, nothing extra", onclick: () => { o.rules = { ...DEFAULT_RULES }; close(); apply(); } }, "Reset to defaults")),
          h("p.small.muted", null, "Kept in this browser."));
      };
      paint();
      const close = popup(anchor, box);
    }

    /** Draw more of the column (or story map cell) holding this card when it is not drawn yet. True when it changed. */
    function reveal(id: number): boolean {
      const c = current.cards.find((x) => x.w.id === id);
      if (!c || drawn.has(id)) return false;
      if (isMap()) {
        // its Feature's column first, then its cell
        const fi = mapFeatures.indexOf(c.feature);
        if (fi >= 0) limits.set("features", limitShowing(fi, limitOf("features", FEATURE_CAP), FEATURE_CAP));
        const row = rowOf(rows, c.w.iteration).key;
        const key = `cell:${row}|${c.feature}`;
        const list = current.cards.filter((x) => x.feature === c.feature && rowOf(rows, x.w.iteration).key === row);
        limits.set(key, limitShowing(list.indexOf(c), limitOf(key, CELL_CAP), CELL_CAP));
      } else {
        const key = `col:${c.col.name}`;
        const list = current.cards.filter((x) => x.col === c.col);
        limits.set(key, limitShowing(list.indexOf(c), limitOf(key, COLUMN_CAP), COLUMN_CAP));
      }
      return true;
    }

    /** New work from a + (or New): the dialog, preset to the parent and sprint the button names; then the new card. */
    function addFrom(add: HTMLElement): void {
      const parent = Number(add.dataset.parent) || undefined;
      const iteration = add.dataset.iteration || undefined;
      const kind = add.dataset.add;
      if (kind === "task" && taskLevel && parent) startDraft(parent);
      else if (kind === "story") void createItem(app, { types: req.types, parentId: parent, iteration }).then(created);
      else if (kind === "feature" && featLevel && parent) {
        // the new Feature's place shows at the top of its Epic box while the form is open: Cancel takes it away again
        featDraft = parent;
        draw();
        board.querySelector<HTMLElement>(".feat.feat-new")?.scrollIntoView({ block: "nearest" });
        void createItem(app, { types: featLevel.types, parentId: parent }).then((w) => {
          featDraft = null;
          if (!w || !alive) { if (alive) draw(); return; }
          // the new Feature takes the ghost's place, framed for a moment (even with no stories yet)
          keepFeatures.add(w.id);
          draw();
          const el = board.querySelector<HTMLElement>(`.feat[data-id="${w.id}"]`);
          if (el) {
            el.scrollIntoView({ block: "nearest" });
            el.classList.add("flash");
            setTimeout(() => el.classList.remove("flash"), 2400);
          }
        });
      }
      else if (kind === "feature" && featLevel) void createItem(app, { types: featLevel.types, parentId: parent }).then(created);
    }

    /** After a create: the new card shows, framed; in a hidden column a message offers to show that column. */
    function created(w: WorkItem | null): void {
      if (!w || !alive) return;
      draw();
      if (isTaskboard() || !req.types.includes(w.type)) return;
      const col = isMap() ? undefined : columnOf(current.cols, w, mode());
      if (col && !current.shownCols.includes(col)) {
        toast(`Created #${w.id} in ${col.name} (hidden)`, { timeout: 10000, action: { label: "Show", run: () => { showColumn(col); flash(w.id); } } });
        return;
      }
      if (!current.cards.some((c) => c.w.id === w.id)) { toast(`#${w.id} is hidden by the filters, person chips or search`); return; }
      flash(w.id);
    }

    function showColumn(col: Column): void {
      Object.assign(o, columnShownPatch(o, col, true));
      save();
      draw();
    }

    /** The eye on a column: hide it (the arrows next to it, or Settings, bring it back). The last shown column stays. */
    function hideColumn(col: Column): void {
      if (current.shownCols.length <= 1) return;
      Object.assign(o, columnShownPatch(o, col, false));
      save();
      draw();
    }

    /** Scroll to a card and frame it for a moment (it becomes the one Tab goes to). */
    function flash(id: number): void {
      if (reveal(id)) draw();
      rove = id;
      setRove();
      const el = itemEl(id);
      if (!el) return;
      el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      // redraws meanwhile keep the frame (card() adds it)
      flashing = { id, until: Date.now() + 2400 };
      el.classList.add("flash");
      setTimeout(() => itemEl(id)?.classList.remove("flash"), 2400);
    }

    function lucky(): void {
      const m = mode();
      const cols = current.cols;
      const me = ws.api.ctx.me;
      // only cards the filters and person chips let through, in a column not hidden by hand
      // (the first column is hidden by default and opens for the pick)
      const ready = ws.ofLevel(req).filter((w) => w.category === "Proposed" && (!w.assignedTo || samePerson(w.assignedTo, me))
        && people.test(w) && fb.test(w) && !o.hiddenCols.includes(columnOf(cols, w, m)?.name ?? "")
        && !missing(w, o.miss === "off" ? "desc" : o.miss, 1, 1, hasAcField).length);
      const rank = (w: WorkItem): number => cols.indexOf(columnOf(cols, w, m)!);
      ready.sort((a, b) => rank(b) - rank(a) || byOrder(a, b));
      const pick = ready[0];
      if (!pick) {
        // say why: which not-started stories there are, and what keeps each group out
        const waiting = ws.ofLevel(req).filter((w) => w.category === "Proposed");
        const states = [...new Set(waiting.map((w) => w.state))];
        const reasons: [number, string][] = [
          [waiting.filter((w) => w.assignedTo && !samePerson(w.assignedTo, me)).length, "are owned by someone else (only stories owned by you or nobody are picked)"],
          [waiting.filter((w) => missing(w, o.miss === "off" ? "desc" : o.miss, 1, 1, hasAcField).length).length, "miss something (the ⚠ on the card: a description, and what the ⚠ choice asks for)"],
          [waiting.filter((w) => !people.test(w) || !fb.test(w)).length, "are hidden by your filters or person chips"],
          [waiting.filter((w) => o.hiddenCols.includes(columnOf(cols, w, m)?.name ?? "")).length, "sit in a column you hid"],
        ];
        void dialog("Nothing to pick", h("div", null,
          h("p", null, "Pick my next opens the free, complete story nearest to work: not started yet (", h("b", null, states.join(", ") || "a new state"), "), owned by you or nobody, nothing missing, and shown by your filters."),
          waiting.length
            ? h("div", null, h("p", null, `There ${waiting.length === 1 ? "is 1 story" : `are ${waiting.length} stories`} not started yet. Of these:`),
              h("ul", null, reasons.filter(([n]) => n).map(([n, why]) => h("li", null, `${n} ${why}`))))
            : h("p", null, `No ${req.name.toLowerCase()} on this board is in a not-started state. Stories already in progress are not picked.`)));
        return;
      }
      // the pick shows in its place: no search lifting other cards
      if (bar.search.words().length) bar.search.set("");
      const col = columnOf(cols, pick, m);
      if (col?.kind === "incoming" && !o.incoming) { o.incoming = true; save(); }
      selected = pick.id;
      draw();
      if (reveal(pick.id)) draw();
      app.openItem(pick.id);
      board.querySelector<HTMLElement>(`.card[data-id="${pick.id}"]`)?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      toast(`Next up: #${pick.id} ${pick.title}`, { kind: "ok" });
    }

    // ---------- numbers on cards: points, remaining hours ----------
    /** Click-to-edit number (the button's data-num item, data-field): Enter or leaving saves, Esc cancels. */
    function editNumber(btn: HTMLElement): void {
      if (app.actions.readOnly || editing || !btn.isConnected) return;
      const id = Number(btn.dataset.num);
      const field = btn.dataset.field!;
      const label = btn.dataset.label ?? "Number";
      const old = btn.dataset.value ?? "";
      const item = btn.closest<HTMLElement>(ITEMS);
      const input = h("input.input.num-edit", { type: "number", min: 0, step: "any", value: old, "aria-label": `${label} of #${id}` }) as HTMLInputElement;
      editing = true;
      btn.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (keep: boolean): void => {
        if (done) return;
        done = true;
        editing = false;
        const raw = input.value.trim();
        const bad = input.validity.badInput || (raw !== "" && !(Number(raw) >= 0));
        input.replaceWith(btn);
        item?.focus({ preventScroll: true });
        if (keep && !bad && raw !== old) void app.actions.setField(id, field, raw === "" ? "" : Number(raw), `${label} of #${id}: ${raw === "" ? "none" : raw}`);
        else if (keep && bad) toast(`${label}: give a number of 0 or more`, { kind: "error" });
        if (drawAfterDrag) { drawAfterDrag = false; draw(); }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener("blur", () => finish(true));
    }

    // ---------- background reads: links, pull requests, column dates ----------
    let alive = true;
    const redrawSoon = debounce(() => { if (alive) draw(); }, 300);
    /** cards sent to a background read; with Counts on, also those whose links were read */
    const asked = new Set<number>();
    const linksAsked = new Set<number>();
    /** pull requests and column histories being read now: a later read leaves them to the running one */
    const prBusy = new Set<string>();
    const colBusy = new Set<number>();

    /**
     * Read the pull requests of the shown cards (or of these cards) that are not known yet (or were open):
     * first the project's open ones in one call, then each other one, four at a time. Cards update as answers come.
     */
    async function readPrs(ids?: Set<number>): Promise<void> {
      const want = new Map<string, PrLink>();
      for (const c of current.cards) {
        if (ids && !ids.has(c.w.id)) continue;
        for (const l of c.prs) {
          const s = prStatusOf(l);
          if (s !== "completed" && s !== "abandoned" && s !== "unknown" && !prBusy.has(l.key)) want.set(l.key, l);
        }
      }
      if (!want.size) return;
      const mine = [...want.keys()];
      for (const k of mine) prBusy.add(k);
      const keep = (l: PrLink, pr: { status: string; title: string; repository: { name: string }; url: string } | null): void => {
        prInfo.set(l.key, pr ? { status: pr.status, title: pr.title, repo: pr.repository.name, url: pr.url } : { status: "unknown", title: "", repo: "", url: "" });
      };
      try {
        if (want.size > 4) {
          const open = await ws.api.pullRequests(ws.project, { status: "active", top: 1000 }).catch(() => null);
          if (!alive) return;
          for (const pr of open ?? []) {
            const key = `${pr.repository.id.toLowerCase()}/${pr.id}`;
            const l = want.get(key);
            if (l) { keep(l, pr); want.delete(key); }
          }
          if (open?.length) redrawSoon();
        }
        await runLimited([...want.values()], 4, async (l) => {
          if (!alive) return;
          const pr = await ws.api.pullRequest(l.prId).catch(() => undefined);
          if (pr === undefined) return; // failed: try again on the next read
          keep(l, pr);
          redrawSoon();
        });
      } finally {
        for (const k of mine) prBusy.delete(k);
      }
    }

    async function background(ids?: number[]): Promise<void> {
      const only = ids ? new Set(ids) : undefined;
      const cards = current.cards.filter((c) => !only || only.has(c.w.id));
      for (const c of cards) asked.add(c.w.id);
      if (o.counts && cards.length) {
        for (const c of cards) linksAsked.add(c.w.id);
        // links of the stories and all their children: the pull requests come from these
        const need = cards.flatMap((c) => [c.w.id, ...ws.children(c.w.id).map((t) => t.id)]);
        const ok = await ws.withRelations(need).then(() => true, () => false);
        if (!alive) return;
        if (ok) {
          draw(); // the numbers of "All" show now; statuses follow
          await readPrs(only);
          if (!alive) return;
        } else {
          for (const c of cards) linksAsked.delete(c.w.id); // asked again on a later drawing
        }
      }
      const field = ws.board?.columnField;
      if (mode() === "columns" && field) {
        const need = current.cards.filter((c) => drawn.has(c.w.id) && sharesState(current.cols, c.col, c.w.type) && columnSinceRev.get(c.w.id) !== c.w.rev && c.w.category !== "Completed" && !colBusy.has(c.w.id)).slice(0, 300);
        for (const c of need) colBusy.add(c.w.id);
        let changed = false;
        // four at a time, not hundreds at once
        await runLimited(need, 4, async (c) => {
          try {
            if (!alive) return;
            const ups = await ws.api.updates(c.w.project ?? ws.project, c.w.id).catch(() => null);
            if (!ups) return;
            const at = columnEnteredAt(ups, field, c.col.name);
            columnSinceRev.set(c.w.id, c.w.rev);
            if (at) { columnSince.set(c.w.id, at); changed = true; }
          } finally {
            colBusy.delete(c.w.id);
          }
        });
        if (changed && alive) draw();
      }
    }

    draw(); // also starts the background reads of the cards it shows

    return {
      update(changed, why) {
        // a new working style opens its layout, unless a layout was picked here for this team
        if (why === "style" && !chosenLayout()) layout = styleLayout();
        fb.refresh();
        draw();
        if (why === "load") void background([...drawn]);
        else if (why === "poll" || why === "write") {
          // a changed task changes its story's card: read the story's links again too
          const ids = new Set<number>();
          for (const id of changed) { ids.add(id); const p = ws.get(id)?.parent; if (p) ids.add(p); }
          void background([...ids]);
        }
      },
      select(id) {
        // the details closing (id null) keeps the selection: Esc or a click elsewhere drops it
        if (id == null) return;
        selected = id;
        if (id && reveal(id)) draw();
        applySelection();
        if (id && itemEl(id)) { rove = id; setRove(); }
        if (id) board.querySelector<HTMLElement>(`.card[data-id="${id}"], .feat[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      },
      exportSheets: () => (current.cards.length ? [sheet()] : null),
      unmount() {
        alive = false;
        document.removeEventListener("flowboards:warn", onWarn);
        document.removeEventListener("pointerdown", dropMoved, true);
        document.removeEventListener("keydown", dropMoved, true);
        burn.stop();
        // no ghost card left on the page when the page changes during a drag
        drawAfterDrag = false;
        pending = null;
        endDrag();
        ro.disconnect();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        document.removeEventListener("keydown", onKey, true);
      },
    };
  },
};
