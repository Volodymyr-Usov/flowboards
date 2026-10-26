// Flow: Throughput, cycle time, work in progress age and a forecast of when work will be done.
// Finished items of the period are read here (the workspace keeps only the last 30 days of them);
// open items come from the workspace, so the view stays live. All math is in core/metrics.ts.
import type { App, View } from "../app/context.ts";
import type { Level, Update, WorkItem } from "../api/types.ts";
import type { Bin, CfdCategory } from "../core/metrics.ts";
import {
  ageClass, asLocal, cfdSeries, cycleDays, dailyCounts, dayIndex, dayIso, dayOfKey, histogram, likelyAtLeast, likelyWithin, niceTicks,
  noStartDate, percentile, rollingMean, simulateHowMany, simulateWhen, stageDates, weeklySums, workAge,
} from "../core/metrics.ts";
import { DAY, daysInState, isOpen, orderedStates, statesOf } from "../core/model.ts";
import { ofTeam } from "../core/scope.ts";
import { prefs } from "../core/settings.ts";
import type { Child } from "../ui/dom.ts";
import { debounce, h, icon, replace, svg } from "../ui/dom.ts";
import { failed, help, itemLink, popup, segmented, select, spinner } from "../ui/kit.ts";
import { pageBar } from "../ui/pagebar.ts";
import { runLimited } from "./prlogic.ts";
import { prTimesCard } from "./prtimes.ts";
import type { ColumnStep } from "./boardmodel.ts";
import { boardColumns, cfdByColumn, columnOnDay, columnPath } from "./boardmodel.ts";
import type { Box, Tip } from "./chartkit.ts";
import { barPath, chartSvg, legend, linear, makeTip, nearestLayer, series, spacedIndexes, tableView, textWidth, tipHead, tipRow, xLabels, yGrid } from "./chartkit.ts";

const PERIODS = [4, 12, 26, 52];
/** A custom period is a whole number of weeks, at most this many (3 years) */
const CUSTOM_MAX = 156;
const RUNS = 10_000;
const MAX_DAYS = 3650;
/** The forecast date may be at most this many days ahead (about 3 years). */
const MAX_AHEAD = 3 * 365;
const BATCH = 400;
/** Cumulative flow by board column reads each item's history: at most this many, the newest first. */
const MAX_HISTORY = 1500;
/** History reads at once, and the pause (ms) after each, so the poll and other reads get their turn */
const HISTORY_AT_ONCE = 3;
const HISTORY_PAUSE = 40;
/** Forecast runs kept, by their inputs: a redraw with the same history does not simulate again */
const RUNS_KEPT = 8;

/** Stack order of the cumulative flow diagram, bottom to top, with words and colors. */
const CFD_LAYERS: { cat: CfdCategory; label: string; color: string }[] = [
  { cat: "Completed", label: "Done", color: series(1) },
  { cat: "Resolved", label: "Resolved", color: series(7) },
  { cat: "InProgress", label: "In progress", color: series(2) },
  { cat: "Proposed", label: "Not started", color: series(4) },
];
/** Colors of board columns, bottom (the last column) to top: the last column has Done's color. */
const COLUMN_COLORS = [1, 7, 2, 4, 3, 5, 6, 8];
/** A band of the cumulative flow: its key in the values, its words and color. */
interface Layer { key: string; label: string; color: string }
const AGE_COLOR = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)" } as const;

interface Cycle { w: WorkItem; days: number; t: number }
interface Data {
  level: Level;
  today: number;
  startDay: number;
  days: number;
  closed: WorkItem[];
  open: WorkItem[];
  wip: WorkItem[];
  cycles: Cycle[];
  p50: number;
  p85: number;
  p95: number;
  daily: number[];
  weekly: number[];
  avg: number[];
  avgWindow: number;
  cfd: Record<CfdCategory, number[]>;
  hasResolved: boolean;
  /** by board column: the columns (board order), each one's counts and each item's way across the board; null while the history is read */
  byColumn: { columns: string[]; values: Record<string, number[]>; paths: Map<number, ColumnStep[]> } | null;
}

/** Days as shown everywhere: one decimal below 10, whole days from 10. */
const roundDays = (n: number): number => n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
const fmtD = (n: number): string => Number.isNaN(n) ? "–" : n < 10 ? `${roundDays(n).toFixed(1)}d` : `${roundDays(n)}d`;
const fmtDay = (day: number, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string =>
  new Date(day * DAY).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
const fmtLongDay = (day: number): string => fmtDay(day, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const plural = (n: number, one: string, many = one + "s"): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export const flowView: View = {
  id: "flow",
  title: "Flow",
  icon: "flow",
  group: "measure",
  about: "How fast work gets done, how long it takes, what is waiting, and when the rest may be done: throughput, cycle time, work in progress age, cumulative flow and a forecast.",
  mount(el, app) {
    const ws = app.ws;
    const levels = [ws.requirementLevel(), ...ws.portfolioLevels().reverse()];
    let weeks = prefs.get<number>("flow:weeks", 12);
    // a number of weeks that is not one of the offered ones was a custom period
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > CUSTOM_MAX) weeks = 12;
    let custom = prefs.get<boolean>("flow:custom", false) || !PERIODS.includes(weeks);
    let level = levels.find((l) => l.id === prefs.get<string>("flow:level", "")) ?? levels[0];
    // which items count: one work item type of the level, one tag (kept in this browser)
    let typeOnly = prefs.get<string>("flow:type", "");
    // the cumulative flow by state category or by the team's board columns (kept in this browser)
    let cfdBy = prefs.get<string>("flow:cfdBy", "state") === "column" ? "column" : "state";
    /** each item's updates as read for a revision (null: could not be read, or beyond MAX_HISTORY) */
    const hist = new Map<number, { rev: number; ups: Update[] | null }>();
    let histBusy = false;
    let stopped = false;
    const histNote = h("span.small.muted");
    let tagOnly = prefs.get<string>("flow:tag", "");
    /** finished items read from Azure DevOps, by level, period and first day */
    const cache = new Map<string, WorkItem[]>();
    let token = 0;
    let data: Data | null = null;
    let forecastDay: number | null = null;
    let forecastN: number | null = null;
    let charts: { box: HTMLElement; draw: (w: number) => Child }[] = [];
    /** the forecast's two charts, redrawn on their own when an answer's input changes */
    const fc = new Map<HTMLElement, { box: HTMLElement; draw: (w: number) => Child }>();
    let lastWidth = 0;
    /** forecast runs by their inputs (the daily samples and the question): a poll that changes nothing else does not run 10,000 again */
    const runsMemo = new Map<string, number[]>();
    const memoRuns = (key: string, make: () => number[]): number[] => {
      let runs = runsMemo.get(key);
      if (!runs) {
        runs = make();
        runsMemo.set(key, runs);
        if (runsMemo.size > RUNS_KEPT) runsMemo.delete(runsMemo.keys().next().value!);
      }
      return runs;
    };

    const status = h("span.muted.small", { role: "status" });
    const body = h("div.flow-body");
    // the pull request times: read once per period (the card keeps its own state while the other cards redraw)
    const prCard = prTimesCard(app, () => weeks);
    let prLoadedFor = -1;
    // whose work this page counts, said plainly
    const scopeNote = h("p.flow-scope-note", { role: "note" });
    const drawScope = (): void => {
      const areas = ws.settings.areas;
      const where = areas.length ? `its areas (${areas.map((a) => a.path + (a.includeChildren ? " and below" : "")).join("; ")})` : `the whole project ${ws.project} (the team has no area set up, so every item counts)`;
      scopeNote.replaceChildren(icon("info", 14), h("span", null,
        h("b", null, `${ws.team} only. `),
        `Every number and chart here counts the ${level.name.toLowerCase()} work of ${ws.team}: items in ${where}, finished in the last ${weeks} weeks, and the open ones that are in progress now. Other teams' work is not counted. Pull requests (the last card) are those of ${ws.project} that the team's members wrote or review, unless you switch that card to everyone.`));
    };
    const tip = makeTip(el);
    // nothing to search here: the field asks AI; level and period choose what is read
    const bar = pageBar(app);
    /** the period: the offered weeks, or "Custom" with its own number of weeks */
    const periodBox = h("span.flow-period");
    const setWeeks = (n: number, isCustom: boolean): void => { weeks = n; custom = isCustom; prefs.set("flow:weeks", weeks); prefs.set("flow:custom", custom); drawPeriod(); void load(); };
    function drawPeriod(): void {
      const seg = segmented([...PERIODS.map((p) => ({ value: String(p), label: `${p} weeks`, title: `Use the last ${p} weeks` })), { value: "custom", label: "Custom", title: "Use the last number of weeks you type" }],
        custom ? "custom" : String(weeks), (v) => { if (v === "custom") { custom = true; prefs.set("flow:custom", true); drawPeriod(); void load(); } else setWeeks(Number(v), false); });
      const box = custom ? h("input.input.flow-weeks", { type: "number", min: 1, max: CUSTOM_MAX, step: 1, value: weeks, "aria-label": "Weeks", title: `The last number of weeks to use (1 to ${CUSTOM_MAX})`,
        onchange: (e: Event) => {
          const n = Math.max(1, Math.min(CUSTOM_MAX, Math.round(Number((e.target as HTMLInputElement).value)) || weeks));
          (e.target as HTMLInputElement).value = String(n);
          if (n !== weeks) setWeeks(n, true);
        } }) : null;
      periodBox.replaceChildren(seg, ...(box ? [box, h("span.small.muted", null, "weeks")] : []));
    }
    drawPeriod();
    bar.line2.append(
      h("span.lab", null, "Level"),
      segmented(levels.map((l) => ({ value: l.id, label: l.name, title: `Show ${l.name.toLowerCase()} (${l.types.join(", ")})` })), level.id, (v) => {
        level = levels.find((l) => l.id === v) ?? levels[0];
        prefs.set("flow:level", level.id);
        forecastN = null;
        drawFilters();
        void load();
      }),
      h("span.lab", null, "Period"),
      periodBox,
      help("Finished items are those in a done state, counted on the day they closed. Cycle time runs from the day work started (activated, or created when that date is missing) to the day the item closed."));
    bar.end.append(status);
    el.prepend(bar.el);
    drawScope();
    el.append(scopeNote, body);

    /** Line 3: the type and tag filters. The tags are those of the level's items read so far. */
    function drawFilters(): void {
      const tags = new Set<string>();
      const ofLevel = (w: WorkItem): boolean => level.types.includes(w.type) && ofTeam(ws, w);
      for (const w of ws.items.values()) if (ofLevel(w)) for (const t of w.tags) tags.add(t);
      for (const [k, list] of cache) if (k.startsWith(level.id + ":")) for (const w of list) for (const t of w.tags) tags.add(t);
      if (tagOnly) tags.add(tagOnly);
      const sortedTags = [...tags].sort((a, b) => a.localeCompare(b));
      replace(bar.line3,
        level.types.length > 1 || (typeOnly && !level.types.includes(typeOnly)) ? select([{ value: "", label: "All types" }, ...level.types.map((t) => ({ value: t, label: t }))],
          level.types.includes(typeOnly) ? typeOnly : "", (v) => { typeOnly = v; prefs.set("flow:type", v); rerender(); },
          { title: "Count one work item type only", "aria-label": "Work item type" }) : null,
        sortedTags.length ? select([{ value: "", label: "All tags" }, ...sortedTags.map((t) => ({ value: t, label: t }))], tagOnly,
          (v) => { tagOnly = v; prefs.set("flow:tag", v); rerender(); }, { title: "Count only items with this tag", "aria-label": "Tag" }) : null,
        typeOnly || tagOnly ? h("button.btn.link.small", { type: "button", title: "Count every item of the level again", onclick: () => { typeOnly = ""; tagOnly = ""; prefs.set("flow:type", ""); prefs.set("flow:tag", ""); rerender(); } }, "Show all") : null);
    }
    drawFilters();
    const rerender = (): void => { drawFilters(); if (data && cache.has(currentKey())) render(); };
    /** The item passes the type and tag filters. */
    const counts = (w: WorkItem): boolean => (!typeOnly || !level.types.includes(typeOnly) || w.type === typeOnly) && (!tagOnly || w.tags.includes(tagOnly));

    const key = (startDay: number): string => `${level.id}:${weeks}:${startDay}`;
    const currentKey = (): string => key(dayIndex(Date.now()) - weeks * 7 + 1);

    async function load(): Promise<void> {
      drawScope();
      const today = dayIndex(Date.now());
      const startDay = today - weeks * 7 + 1;
      const k = key(startDay);
      const my = ++token;
      if (cache.has(k)) { render(); return; }
      if (data) body.classList.add("flow-dim");
      else body.replaceChildren(spinner("Reading finished items…"));
      status.textContent = "Reading finished items…";
      try {
        const types = level.types;
        const states = statesOf(ws.process, types, ["Completed"]);
        const areas = ws.settings.areas.length ? ws.settings.areas : undefined;
        const ids = states.length ? await app.api.query(ws.project, { types, areas, states, closedAfter: dayIso(startDay) }) : [];
        const items: WorkItem[] = [];
        for (let i = 0; i < ids.length; i += BATCH) {
          if (my !== token) return;
          status.textContent = `Reading ${Math.min(i + BATCH, ids.length).toLocaleString()} of ${ids.length.toLocaleString()} items…`;
          items.push(...await app.api.items(ws.project, ids.slice(i, i + BATCH)));
        }
        if (my !== token) return;
        cache.set(k, items);
        drawFilters();
        render();
      } catch (e) {
        if (my !== token) return;
        status.textContent = "";
        body.classList.remove("flow-dim");
        body.replaceChildren(failed(e, () => { data = null; void load(); }));
      }
    }

    /** The finished items read for the period, refreshed with the workspace's newer copies. */
    function compute(): Data {
      const today = dayIndex(Date.now());
      const days = weeks * 7;
      const startDay = today - days + 1;
      const fetched = cache.get(key(startDay)) ?? [];
      // only the team's own work: the workspace also holds parents in other teams' areas (their Features and Epics)
      const ofLevel = (w: WorkItem): boolean => level.types.includes(w.type) && counts(w) && ofTeam(ws, w);
      const byId = new Map<number, WorkItem>();
      for (const w of fetched) if (counts(w)) byId.set(w.id, w);
      for (const w of ws.items.values()) if (ofLevel(w)) byId.set(w.id, w);
      // a close date in the future (clock skew) counts as closed now, everywhere below
      const now = Date.now();
      const closed = [...byId.values()].filter((w) => w.category === "Completed" && w.closed && dayIndex(w.closed) >= startDay)
        .map((w) => Date.parse(w.closed!) > now ? { ...w, closed: new Date(now).toISOString() } : w);
      const open = [...ws.items.values()].filter((w) => ofLevel(w) && isOpen(w));
      const wip = open.filter((w) => w.category === "InProgress" || w.category === "Resolved");
      // t: the closed moment on the local day axis (days are local calendar days)
      const cycles = closed.map((w) => ({ w, days: cycleDays(w) ?? 0, t: asLocal(w.closed!) })).sort((a, b) => a.t - b.t);
      const sorted = cycles.map((c) => c.days).sort((a, b) => a - b);
      const daily = dailyCounts(closed.map((w) => dayIndex(w.closed!)), startDay, days);
      const weekly = weeklySums(daily);
      const avgWindow = weeks >= 12 ? 4 : 2;
      const hasResolved = statesOf(ws.process, level.types, ["Resolved"]).length > 0;
      return {
        byColumn: columnMode() ? columnFlow([...closed, ...open], startDay, days) : null,
        level, today, startDay, days, closed, open, wip, cycles,
        p50: percentile(sorted, 50), p85: percentile(sorted, 85), p95: percentile(sorted, 95),
        daily, weekly, avg: rollingMean(weekly, avgWindow), avgWindow,
        cfd: cfdSeries([...closed, ...open], startDay, days), hasResolved,
      };
    }

    /** Can the cumulative flow show board columns: the team's board of this level, with its columns. */
    const columnsShown = (): boolean => level.id === ws.requirementLevel().id && !!ws.board?.columnField && !!ws.board.columns.length;
    const columnMode = (): boolean => cfdBy === "column" && columnsShown();

    /** Cumulative flow by column, once every item's history is read; else starts reading it and gives null. */
    function columnFlow(items: WorkItem[], startDay: number, days: number): Data["byColumn"] {
      const missing = items.filter((w) => hist.get(w.id)?.rev !== w.rev);
      if (missing.length) { void readHistory(missing); return null; }
      const cols = boardColumns(ws.process, level, ws.board, "columns");
      // the column moves on the local day axis, like every other chart here (the board helpers count UTC days)
      const local = (p: ColumnStep[]): ColumnStep[] => p.map((s) => ({ ...s, at: new Date(asLocal(s.at)).toISOString() }));
      const paths = new Map(items.map((w) => [w.id, local(columnPath(w, hist.get(w.id)!.ups, cols, ws.board!.columnField))]));
      const columns = cols.map((c) => c.name);
      return { columns, values: cfdByColumn([...paths.values()], columns, startDay, days), paths };
    }

    /**
     * Read the updates of these items, three at a time with a short pause after each, then draw again:
     * up to 1,500 reads must not hold up the workspace's poll and the other pages' reads.
     */
    async function readHistory(items: WorkItem[]): Promise<void> {
      if (histBusy) return;
      histBusy = true;
      const newest = [...items].sort((a, b) => Date.parse(b.changed) - Date.parse(a.changed));
      // beyond the limit, an item's own dates stand in for its history
      for (const w of newest.slice(MAX_HISTORY)) hist.set(w.id, { rev: w.rev, ups: null });
      const read = newest.slice(0, MAX_HISTORY);
      histNote.textContent = `0 of ${read.length.toLocaleString()}`;
      await runLimited(read, HISTORY_AT_ONCE, async (w) => {
        const ups = await app.api.updates(w.project ?? ws.project, w.id).catch(() => null);
        hist.set(w.id, { rev: w.rev, ups });
        await new Promise((r) => setTimeout(r, HISTORY_PAUSE));
      }, (done) => { histNote.textContent = `${done.toLocaleString()} of ${read.length.toLocaleString()}`; }, () => stopped);
      histBusy = false;
      if (!stopped && data && columnMode() && cache.has(currentKey())) render();
    }

    function render(): void {
      const d = (data = compute());
      status.textContent = "";
      body.classList.remove("flow-dim");
      charts = [];
      fc.clear();
      const card = (cls: string, title: string, helpText: string, sub: Child, draw: (w: number) => Child, ...extra: Child[]): HTMLElement => {
        const box = h("div.flow-chart");
        charts.push({ box, draw });
        return h(`section.card-box.flow-card${cls}`, null,
          h("div.flow-card-head", null, h("h2", null, title), help(helpText)),
          sub ? h("p.flow-sub", null, sub) : null, box, ...extra);
      };
      const name = d.level.name.toLowerCase();
      const perWeek = d.closed.length / weeks;
      const perWeekText = perWeek.toFixed(perWeek > 0 && perWeek < 1 ? 2 : 1);
      const oldest = d.wip.reduce<WorkItem | null>((a, w) => (!a || workAge(w) > workAge(a) ? w : a), null);
      // cycle time falls back to the created date when an item has no start date: say how many
      const noStart = d.cycles.filter((c) => noStartDate(c.w)).length;

      const tiles = h("div.flow-tiles", null,
        tile(perWeekText, "Finished per week", `On average ${perWeekText} ${name} were finished per week over the last ${weeks} weeks (${d.closed.length} in all).`),
        tile(fmtD(d.p85), "Cycle time, 85%", d.cycles.length ? `85% of the ${name} finished in this period took ${fmtD(d.p85)} or less from start to done.` : "No items finished in this period."),
        tile(String(d.wip.length), "In progress", `${plural(d.wip.length, "item")} started but not done.`),
        oldest
          ? h("button.card-box.stat.flow-tile", { title: `Open the oldest item in progress: #${oldest.id} ${oldest.title}`, onclick: () => app.openItem(oldest.id) },
            h("span.n", null, fmtD(workAge(oldest))), h("span.l", null, "Oldest in progress"))
          : tile("–", "Oldest in progress", "Nothing is in progress."));

      const wipStates = orderedStates(ws.process, d.level.types).filter((s) => s.category === "InProgress" || s.category === "Resolved");
      const cfdLayers = CFD_LAYERS.filter((l) => l.cat !== "Resolved" || d.hasResolved);

      body.replaceChildren(
        tiles,
        h("div.flow-grid", null,
          card("", "Throughput", "Bars: items finished in each week (7 days, the last one ending today). Line: the average of the last weeks, to show the trend. Click a bar to see its items.",
            `${plural(d.closed.length, "item")} finished in ${weeks} weeks`, (w) => throughputChart(d, w, tip, showItems),
            legend([{ label: "Finished in the week", color: series(1) }, { label: `${d.avgWindow}-week average`, color: "var(--ink)", kind: "line" }]),
            tableView(["Week from", "Finished", `${d.avgWindow}-week average`], d.weekly.map((v, i) => [fmtDay(d.startDay + i * 7, { month: "short", day: "numeric", year: "numeric" }), v, d.avg[i].toFixed(1)]), [1, 2])),
          card("", "Cycle time", "Each dot is one finished item: when it closed (across) and how many days it took from start to done (up). The lines show the time within which 50%, 85% and 95% of the items were done. Click a dot to open the item.",
            d.cycles.length ? `50% took ${fmtD(d.p50)} or less, 85% ${fmtD(d.p85)}, 95% ${fmtD(d.p95)}` : null,
            (w) => d.cycles.length ? cycleChart(d, w, tip, app) : h("p.muted.flow-none", null, "No items finished in this period."),
            noStart ? h("p.small.muted.flow-nostart", { title: "These items never had a start date (Activated date), so their cycle time runs from the day they were created" },
              `${plural(noStart, "item")} had no start date; ${noStart === 1 ? "its" : "their"} lead time (from created to done) is used.`) : null,
            tableView(["Item", "Finished", "Days"], [...d.cycles].reverse().map((c) => [itemLink(ws, c.w, (x) => app.openItem(x.id)), fmtDay(dayIndex(c.w.closed!), { month: "short", day: "numeric", year: "numeric" }), c.days.toFixed(1)]), [2])),
          card("", "Work in progress age", "Each dot is one item that is started but not done, in the column of its state, by days since work on it started. The color compares that age with how long finished items took from start to done: up to the 50% line, up to the 85% line, or beyond. The tooltip also shows the days in the current state. Click a dot to open the item.",
            d.wip.length ? `${plural(d.wip.length, "item")} in progress` : null,
            (w) => d.wip.length ? agingChart(d, wipStates.map((s) => s.name), w, tip, app) : h("p.muted.flow-none", null, "Nothing is in progress."),
            d.cycles.length ? legend([
              { label: `Up to ${fmtD(d.p50)}`, color: AGE_COLOR.ok, kind: "dot" },
              { label: `${fmtD(d.p50)} to ${fmtD(d.p85)}`, color: AGE_COLOR.warn, kind: "dot" },
              { label: `Over ${fmtD(d.p85)}, longer than 85% of finished items took`, color: AGE_COLOR.bad, kind: "dot" },
            ]) : null,
            tableView(["Item", "State", "Days since start", "Days in state"], [...d.wip].sort((a, b) => workAge(b) - workAge(a))
              .map((w) => [itemLink(ws, w, (x) => app.openItem(x.id)), w.state, roundDays(workAge(w)), daysInState(w)]), [2, 3])),
          cfdCard(d, cfdLayers),
        ),
        forecastCard(d),
        prCard.el);
      if (prLoadedFor !== weeks) { prLoadedFor = weeks; prCard.load(); }
      lastWidth = body.clientWidth;
      paint();
      highlight(app.openId());
    }

    /** The cumulative flow card: by state category, or by board column under the switch. */
    function cfdCard(d: Data, stateLayers: typeof CFD_LAYERS): HTMLElement {
      const byCol = columnMode();
      const toggle = columnsShown() ? segmented([
        { value: "state", label: "By state", title: "Bands by state: not started, in progress, resolved, done" },
        { value: "column", label: "By board column", title: "Bands by the columns of the team's board, from each item's history of column moves" },
      ], byCol ? "column" : "state", (v) => { cfdBy = v; prefs.set("flow:cfdBy", v); render(); }) : null;
      const helpText = byCol
        ? "For each day, how many items stood in each column of the team's board, read from each item's history of column moves (where it cannot be read, its start and finish dates stand in). Done counts only items finished in this period. A band that keeps getting wider means work waits in that column. Click a band to see its items on that day."
        : "For each day, how many items were not started, in progress, resolved and done. Done counts only items finished in this period. A band that keeps getting wider means work waits there. Click a band to see its items on that day.";
      const sub = h("span.flow-cfd-sub", null, toggle, byCol ? `Items by board column on each day of the last ${weeks} weeks` : `Items by state on each day of the last ${weeks} weeks`);
      if (byCol && !d.byColumn) {
        const box = h("div.flow-chart", null, spinner("Reading each item's board history…"), histNote);
        return h("section.card-box.flow-card", null, h("div.flow-card-head", null, h("h2", null, "Cumulative flow"), help(helpText)), h("p.flow-sub", null, sub), box);
      }
      let layers: Layer[];
      let values: Record<string, number[]>;
      let itemsOn: (key: string, day: number) => WorkItem[];
      const all = [...d.closed, ...d.open];
      if (byCol && d.byColumn) {
        const bc = d.byColumn;
        layers = [...bc.columns].reverse().map((c, i) => ({ key: c, label: c, color: series(COLUMN_COLORS[i % COLUMN_COLORS.length]) }));
        values = bc.values;
        itemsOn = (key, day) => all.filter((w) => columnOnDay(bc.paths.get(w.id) ?? [], day) === key);
      } else {
        layers = stateLayers.map((l) => ({ key: l.cat, label: l.label, color: l.color }));
        values = d.cfd;
        itemsOn = (key, day) => all.filter((w) => stageOn(w, day) === key);
      }
      const box = h("div.flow-chart");
      charts.push({ box, draw: (w) => cfdChart(d.days, d.startDay, layers, values, w, tip, showItems, itemsOn) });
      return h("section.card-box.flow-card", null,
        h("div.flow-card-head", null, h("h2", null, "Cumulative flow"), help(helpText)),
        h("p.flow-sub", null, sub), box,
        legend([...layers].reverse().map((l) => ({ label: l.label, color: l.color }))),
        tableView(["Day", ...[...layers].reverse().map((l) => l.label)],
          spacedIndexes(d.days, Math.ceil(d.days / 7)).map((i) => [fmtDay(d.startDay + i, { month: "short", day: "numeric", year: "numeric" }), ...[...layers].reverse().map((l) => values[l.key][i])]),
          layers.map((_, i) => i + 1)));
    }

    /** The items behind a bar or band, in a popup next to the click; each opens the item. */
    function showItems(at: { x: number; y: number }, title: string, items: WorkItem[]): void {
      tip.hide();
      const spot = h("div.flow-spot", { style: { left: at.x + "px", top: at.y + "px" } });
      document.body.append(spot);
      const MAX = 60;
      const list = h("div.flow-items", null,
        h("div.flow-items-head", null, h("b", null, title), h("span.muted.small", null, ` ${plural(items.length, "item")}`)),
        items.length ? h("ul", null, items.slice(0, MAX).map((w) => h("li", null, itemLink(ws, w, (x) => { close(); app.openItem(x.id); })))) : h("p.muted.small", null, "No items."),
        items.length > MAX ? h("p.muted.small", null, `And ${items.length - MAX} more.`) : null);
      const close = popup(spot, list, { className: "flow-pop", onClose: () => spot.remove() });
    }

    function tile(value: string, label: string, title: string): HTMLElement {
      return h("div.card-box.stat.flow-tile", { title }, h("span.n", null, value), h("span.l", null, label));
    }

    function drawBox(c: { box: HTMLElement; draw: (w: number) => Child }): void {
      c.box.replaceChildren(h("div", null, c.draw(Math.max(260, Math.floor(c.box.clientWidth)))));
    }

    function paint(): void {
      for (const c of [...charts, ...fc.values()]) drawBox(c);
    }

    /** Answers and a chart in a forecast box: drawn now when the box is on the page, else by paint(). */
    function chartIn(out: HTMLElement, head: Child, draw: (w: number) => Child): void {
      const c = { box: h("div.flow-chart"), draw };
      fc.set(out, c);
      out.replaceChildren(h("div", null, head), c.box);
      if (out.isConnected) drawBox(c);
    }

    // ---------- forecast ----------

    function forecastCard(d: Data): HTMLElement {
      const samples = d.daily;
      const backlog = d.open.length;
      const lastDay = d.today + MAX_AHEAD;
      const dateNote = h("span.small.muted.flow-date-note");
      const dateIn = h("input.input", {
        type: "date", min: dayIso(d.today + 1), max: dayIso(lastDay), value: dayIso(Math.min(forecastDay ?? d.today + 28, lastDay)),
        title: "The date to forecast to (at most 3 years ahead)", "aria-label": "Forecast date",
        onchange: () => {
          const day = dateIn.value ? dayOfKey(dateIn.value) : null;
          dateNote.textContent = "";
          // not a real date (for example a 5-digit year): keep the last good one
          if (day !== null && !Number.isFinite(day)) { dateIn.value = dayIso(Math.min(forecastDay ?? d.today + 28, lastDay)); return; }
          if (day !== null && day > lastDay) { dateNote.textContent = "At most 3 years ahead."; dateIn.value = dayIso(lastDay); }
          forecastDay = day === null ? null : Math.min(day, lastDay);
          drawMany();
        },
      });
      const nIn = h("input.input.flow-n", {
        type: "number", min: 1, max: 5000, step: 1, value: String(forecastN ?? backlog),
        title: `How many items; the default is the open ${d.level.name.toLowerCase()} (${backlog})`, "aria-label": "Number of items",
        oninput: debounce(() => { const v = Math.min(5000, Math.floor(Number(nIn.value))); if (Number(nIn.value) > 5000) nIn.value = "5000"; forecastN = v > 0 ? v : null; drawWhen(); }, 250),
      });
      const manyOut = h("div.flow-fc-out");
      const whenOut = h("div.flow-fc-out");
      const enough = samples.some((n) => n > 0);

      function drawMany(): void {
        const day = Math.min(forecastDay ?? d.today + 28, lastDay);
        const n = day - d.today;
        if (!enough) { manyOut.replaceChildren(h("p.muted", null, "No items finished in this period, so there is nothing to forecast from.")); return; }
        if (n <= 0) { manyOut.replaceChildren(h("p.muted", null, "Pick a date after today.")); return; }
        const runs = memoRuns(`many|${n}|${samples.join(",")}`, () => simulateHowMany(samples, n, RUNS, 7));
        const at = [0.5, 0.85, 0.95].map((p) => ({ p, v: likelyAtLeast(runs, p) }));
        const bins = histogram(runs, 30);
        chartIn(manyOut,
          h("ul.flow-answers", null, at.map((a) => h("li", null, h("span.flow-p", null, `${Math.round(a.p * 100)}% likely`), h("b", null, `${a.v.toLocaleString()} or more`)))),
          (w) => histChart(bins, w, tip, at.map((a) => ({ v: a.v, label: `${Math.round(a.p * 100)}%` })), (b) => `${b.from === b.to ? b.from : `${b.from}–${b.to}`} items`,
            `Forecast of items finished by ${fmtLongDay(day)}: 85% likely ${at[1].v} or more.`));
      }

      function drawWhen(): void {
        const target = forecastN ?? backlog;
        if (!enough) { whenOut.replaceChildren(h("p.muted", null, "No items finished in this period, so there is nothing to forecast from.")); return; }
        if (target <= 0) { whenOut.replaceChildren(h("p.muted", null, "Nothing open to finish.")); return; }
        const runs = memoRuns(`when|${target}|${samples.join(",")}`, () => simulateWhen(samples, target, RUNS, 11, MAX_DAYS));
        const at = [0.5, 0.85, 0.95].map((p) => ({ p, v: likelyWithin(runs, p) }));
        if (at.some((a) => !Number.isFinite(a.v))) { whenOut.replaceChildren(h("p.muted", null, "Not enough finished items to forecast from.")); return; }
        const say = (v: number): string => v > MAX_DAYS ? "more than 10 years" : `by ${fmtLongDay(d.today + v)}`;
        const bins = histogram(runs.map((r) => Math.min(r, MAX_DAYS + 1)), 30);
        chartIn(whenOut,
          h("ul.flow-answers", null, at.map((a) => h("li", null, h("span.flow-p", null, `${Math.round(a.p * 100)}% likely`), h("b", null, say(a.v))))),
          (w) => histChart(bins, w, tip, at.map((a) => ({ v: a.v, label: `${Math.round(a.p * 100)}%` })),
            (b) => b.from > MAX_DAYS ? "More than 10 years" : "Done " + fmtDay(d.today + b.from) + (b.to > b.from ? ` – ${fmtDay(d.today + b.to)}` : ""),
            `Forecast of when ${target} items will be done: 85% likely ${say(at[1].v)}.`, (v) => fmtDay(d.today + v)));
      }

      drawMany();
      drawWhen();
      return h("section.card-box.flow-card.flow-forecast", null,
        h("div.flow-card-head", null, h("h2", null, "Forecast"), help(`A Monte Carlo forecast: ${RUNS.toLocaleString()} runs, each day drawn at random from the number of items finished on each day of the last ${weeks} weeks (weekends included). "85% likely" means 85 of 100 runs did at least that well. It assumes the team keeps working as in this period.`)),
        h("p.flow-sub", null, `From ${plural(d.closed.length, "item")} finished in the last ${weeks} weeks.${d.closed.length < 10 && enough ? " That is little history, so take the answers as rough." : ""}`),
        h("div.flow-fc", null,
          h("div.flow-fc-q", null, h("label.flow-q", null, "How many items by ", dateIn), dateNote, manyOut),
          h("div.flow-fc-q", null, h("label.flow-q", null, "When will ", nIn, ` ${d.level.name.toLowerCase()} be done`), whenOut)));
    }

    function highlight(id: number | null): void {
      for (const c of el.querySelectorAll(".flow-dot.sel")) c.classList.remove("sel");
      if (id != null) for (const c of el.querySelectorAll(`.flow-dot[data-id="${id}"]`)) c.classList.add("sel");
    }

    // work changed while a forecast box is being typed in: draw again when it is left, not under the caret
    let waiting = false;
    const redraw = debounce(() => {
      if (!(data && cache.has(currentKey()))) return;
      if (body.contains(document.activeElement) && document.activeElement?.matches("input")) { waiting = true; return; }
      waiting = false;
      render();
    }, 250);
    body.addEventListener("focusout", () => { if (waiting) redraw(); });
    const ro = new ResizeObserver(debounce(() => {
      const w = body.clientWidth;
      if (data && w && Math.abs(w - lastWidth) > 4) { lastWidth = w; paint(); }
    }, 150));
    ro.observe(body);
    void load();

    return {
      update() { redraw(); },
      select(id) { highlight(id); },
      unmount() { token++; stopped = true; ro.disconnect(); tip.hide(); prCard.stop(); },
    };
  },
};

// ---------- charts ----------

type ShowItems = (at: { x: number; y: number }, title: string, items: WorkItem[]) => void;

/** The state stage an item was in on a day, as the cumulative flow counts it (null: not created yet). */
function stageOn(w: WorkItem, day: number): CfdCategory | null {
  const s = stageDates(w);
  const known = ([["Proposed", s.proposed], ["InProgress", s.inProgress], ["Resolved", s.resolved], ["Completed", s.completed]] as [CfdCategory, string | undefined][])
    .filter((x): x is [CfdCategory, string] => !!x[1]).map(([c, d]) => [c, dayIndex(d)] as [CfdCategory, number]);
  for (let i = 1; i < known.length; i++) known[i][1] = Math.max(known[i][1], known[i - 1][1]);
  let at: CfdCategory | null = null;
  for (const [c, d] of known) if (d <= day) at = c;
  return at;
}

function bandEvents(el: SVGElement, tip: Tip, body: () => Child): void {
  el.addEventListener("pointermove", (e) => tip.show(e as PointerEvent, body()));
  el.addEventListener("pointerleave", () => tip.hide());
  el.addEventListener("focus", () => tip.show(el, body()));
  el.addEventListener("blur", () => tip.hide());
}

/** Date labels under a time axis: about one per 80px. */
function dayTicks(startDay: number, days: number, x: (day: number) => number, width: number): { x: number; text: string }[] {
  return spacedIndexes(days, Math.max(2, Math.floor(width / 80))).map((i) => ({ x: x(startDay + i), text: fmtDay(startDay + i) }));
}

function throughputChart(d: Data, width: number, tip: Tip, show: ShowItems): SVGElement {
  const H = 220;
  const box: Box = { x0: 34, x1: width - 8, y0: 14, y1: H - 22 };
  const n = d.weekly.length;
  const ticks = niceTicks(Math.max(1, ...d.weekly, ...d.avg), 4);
  const y = linear(0, ticks[ticks.length - 1], box.y1, box.y0);
  const s = chartSvg(width, H, `Items finished per week over the last ${n} weeks: ${d.weekly.join(", ")}.`);
  yGrid(s, ticks, y, box);
  const band = (box.x1 - box.x0) / n;
  const bw = Math.max(2, Math.min(24, band - 2));
  const cx = (i: number): number => box.x0 + i * band + band / 2;
  for (let i = 0; i < n; i++) {
    const p = barPath(cx(i) - bw / 2, y(d.weekly[i]), bw, y(0));
    if (p) s.append(svg("path", { d: p, style: { fill: series(1) } }));
  }
  s.append(svg("polyline", { points: d.avg.map((v, i) => `${cx(i)},${y(v)}`).join(" "), fill: "none", style: { stroke: "var(--ink)" }, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.75 }));
  // the last week's value on its cap
  const last = d.weekly[n - 1];
  s.append(svg("text", { class: "ck-val", x: cx(n - 1), y: Math.max(box.y0 - 2, y(Math.max(last, d.avg[n - 1])) - 5), "text-anchor": band < 24 ? "end" : "middle" }, String(last)));
  xLabels(s, spacedIndexes(n, Math.max(2, Math.floor((box.x1 - box.x0) / 64))).map((i) => ({ x: cx(i), text: fmtDay(d.startDay + i * 7) })), box.y1 + 6);
  for (let i = 0; i < n; i++) {
    const from = d.startDay + i * 7;
    const r = svg("rect", { class: "ck-band flow-click", x: box.x0 + i * band, y: box.y0, width: band, height: box.y1 - box.y0, tabindex: 0, role: "button", "aria-label": `Week from ${fmtDay(from)}: ${d.weekly[i]} finished. Show the items` });
    bandEvents(r, tip, () => [tipHead(`${fmtDay(from)} – ${fmtDay(from + 6)}`), tipRow(d.weekly[i], "finished", series(1)), tipRow(d.avg[i].toFixed(1), `${d.avgWindow}-week average`, "var(--ink)"), h("div.flow-tipnote", null, "Click to see the items")]);
    const open = (at: { x: number; y: number }): void => show(at, `Finished ${fmtDay(from)} – ${fmtDay(from + 6)}`,
      d.closed.filter((w) => { const k = dayIndex(w.closed!); return k >= from && k <= from + 6; }).sort((a, b) => Date.parse(b.closed!) - Date.parse(a.closed!)));
    r.addEventListener("click", (e) => open({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY }));
    r.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Enter" && (e as KeyboardEvent).key !== " ") return;
      e.preventDefault();
      const b = r.getBoundingClientRect();
      open({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
    });
    s.append(r);
  }
  return s;
}

/** A percentile line across the plot (labels are placed by the caller, apart from each other). */
function refLine(s: SVGElement, box: Box, yy: number): void {
  s.append(svg("line", { x1: box.x0, x2: box.x1, y1: Math.round(yy) + 0.5, y2: Math.round(yy) + 0.5, style: { stroke: "var(--muted)" }, "stroke-width": 1, opacity: 0.8 }));
}

/** Labels of reference lines that would overlap are moved apart a little. */
function spreadLabels(ys: number[], gap = 12): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => b.y - a.y);
  for (let k = 1; k < order.length; k++) if (order[k - 1].y - order[k].y < gap) order[k].y = order[k - 1].y - gap;
  const out = [...ys];
  for (const o of order) out[o.i] = o.y;
  return out;
}

function cycleChart(d: Data, width: number, tip: Tip, app: App): SVGElement {
  const H = 260;
  const box: Box = { x0: 34, x1: width - 70, y0: 10, y1: H - 22 };
  const x = linear(d.startDay * DAY, (d.today + 1) * DAY, box.x0, box.x1);
  const xd = (day: number): number => x(day * DAY);
  const ticks = niceTicks(Math.max(1, ...d.cycles.map((c) => c.days)), 4);
  const y = linear(0, ticks[ticks.length - 1], box.y1, box.y0);
  const s = chartSvg(width, H, `Cycle time of ${d.cycles.length} finished items. 50% took ${fmtD(d.p50)} or less, 85% ${fmtD(d.p85)}, 95% ${fmtD(d.p95)}.`);
  yGrid(s, ticks, y, box, (v) => `${v}d`);
  xLabels(s, dayTicks(d.startDay, d.days, xd, box.x1 - box.x0), box.y1 + 6);
  const ps = [d.p50, d.p85, d.p95];
  const labelY = spreadLabels(ps.map((p) => y(p)));
  ps.forEach((p, i) => {
    refLine(s, box, y(p));
    s.append(svg("text", { class: "ck-lab", x: box.x1 + 6, y: labelY[i], "dominant-baseline": "middle" }, `${[50, 85, 95][i]}% ${fmtD(p)}`));
  });
  const pts = d.cycles.map((c) => ({ x: x(c.t), y: y(c.days) }));
  const dots = d.cycles.map((c, i) => {
    const dot = svg("circle", { class: "flow-dot", cx: pts[i].x, cy: pts[i].y, r: 5, dataset: { id: c.w.id }, style: { fill: series(1) } });
    s.append(dot);
    return dot;
  });
  let on = -1;
  nearestLayer(s, box, pts, {
    hover: (i, e) => {
      if (on >= 0) dots[on].classList.remove("on");
      on = i;
      if (i < 0) { tip.hide(); return; }
      dots[i].classList.add("on");
      const c = d.cycles[i];
      tip.show(e, [tipHead(`#${c.w.id} ${c.w.title}`), tipRow(fmtD(c.days), "from start to done", series(1)), tipRow(fmtDay(dayIndex(c.w.closed!), { month: "short", day: "numeric", year: "numeric" }), "finished"), c.w.assignedTo ? tipRow(c.w.assignedTo.displayName, "") : null]);
    },
    click: (i) => app.openItem(d.cycles[i].w.id),
  });
  return s;
}

function jitter(id: number): number {
  return (((id * 2654435761) >>> 0) % 1000) / 1000 - 0.5;
}

function agingChart(d: Data, states: string[], width: number, tip: Tip, app: App): SVGElement {
  const H = 260;
  const box: Box = { x0: 34, x1: width - (d.cycles.length ? 70 : 8), y0: 10, y1: H - 22 };
  const cols = states.filter((st) => d.wip.some((w) => w.state === st));
  for (const w of d.wip) if (!cols.includes(w.state)) cols.push(w.state);
  const band = (box.x1 - box.x0) / Math.max(1, cols.length);
  // age since work started, as the cycle times it is compared with
  const ages = d.wip.map((w) => workAge(w));
  const ticks = niceTicks(Math.max(1, ...ages, d.cycles.length ? d.p85 : 0), 4);
  const y = linear(0, ticks[ticks.length - 1], box.y1, box.y0);
  const s = chartSvg(width, H, `${d.wip.length} items in progress by days since work started. Oldest: ${fmtD(Math.max(...ages))}.`);
  yGrid(s, ticks, y, box, (v) => `${v}d`);
  xLabels(s, cols.map((c, i) => {
    const count = d.wip.filter((w) => w.state === c).length;
    let text = `${c} (${count})`;
    if (textWidth(text) > band - 4) text = textWidth(c) > band - 4 ? c.slice(0, Math.max(1, Math.floor((band - 8) / 6.4))) + "…" : c;
    return { x: box.x0 + band * i + band / 2, text };
  }), box.y1 + 6);
  if (d.cycles.length) {
    const ly = spreadLabels([y(d.p50), y(d.p85)]);
    refLine(s, box, y(d.p50));
    refLine(s, box, y(d.p85));
    s.append(svg("text", { class: "ck-lab", x: box.x1 + 6, y: ly[0], "dominant-baseline": "middle" }, `50% ${fmtD(d.p50)}`));
    s.append(svg("text", { class: "ck-lab", x: box.x1 + 6, y: ly[1], "dominant-baseline": "middle" }, `85% ${fmtD(d.p85)}`));
  }
  const spread = Math.min(band * 0.6, 70);
  const pts = d.wip.map((w, i) => ({ x: box.x0 + band * cols.indexOf(w.state) + band / 2 + jitter(w.id) * spread, y: y(ages[i]) }));
  const dots = d.wip.map((w, i) => {
    const cls = ageClass(ages[i], d.p50, d.p85);
    const dot = svg("circle", { class: "flow-dot", cx: pts[i].x, cy: pts[i].y, r: 5, dataset: { id: w.id }, style: { fill: AGE_COLOR[cls] } });
    s.append(dot);
    return dot;
  });
  let on = -1;
  nearestLayer(s, box, pts, {
    hover: (i, e) => {
      if (on >= 0) dots[on].classList.remove("on");
      on = i;
      if (i < 0) { tip.hide(); return; }
      dots[i].classList.add("on");
      const w = d.wip[i];
      const cls = ageClass(ages[i], d.p50, d.p85);
      tip.show(e, [tipHead(`#${w.id} ${w.title}`), tipRow(fmtD(ages[i]), "since work started", AGE_COLOR[cls]), tipRow(`${daysInState(w)}d`, `in ${w.state}`),
        w.assignedTo ? tipRow(w.assignedTo.displayName, "") : null,
        cls === "bad" ? h("div.flow-tipnote", null, "Longer than 85% of finished items took in total") : null]);
    },
    click: (i) => app.openItem(d.wip[i].id),
  });
  return s;
}

function cfdChart(n: number, startDay: number, layers: Layer[], values: Record<string, number[]>, width: number, tip: Tip, show: ShowItems, itemsOn: (key: string, day: number) => WorkItem[]): SVGElement {
  const H = 260;
  const box: Box = { x0: 34, x1: width - 8, y0: 10, y1: H - 22 };
  const totals = Array.from({ length: n }, (_, i) => layers.reduce((a, l) => a + values[l.key][i], 0));
  const ticks = niceTicks(Math.max(1, ...totals), 4);
  const y = linear(0, ticks[ticks.length - 1], box.y1, box.y0);
  const x = linear(0, Math.max(1, n - 1), box.x0, box.x1);
  const s = chartSvg(width, H, `Cumulative flow over ${n} days. Today: ${[...layers].reverse().map((l) => `${l.label} ${values[l.key][n - 1]}`).join(", ")}.`);
  yGrid(s, ticks, y, box);
  const lower = new Array<number>(n).fill(0);
  for (const l of layers) {
    const upper = lower.map((v, i) => v + values[l.key][i]);
    const top = upper.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const bottom = lower.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse();
    s.append(svg("path", { d: `M${top.join("L")}L${bottom.join("L")}Z`, style: { fill: l.color, stroke: "var(--panel)" }, "fill-opacity": 0.85, "stroke-width": 1, "stroke-linejoin": "round" }));
    for (let i = 0; i < n; i++) lower[i] = upper[i];
  }
  xLabels(s, dayTicks(startDay, n, (day) => x(day - startDay), box.x1 - box.x0), box.y1 + 6);
  const cross = svg("line", { y1: box.y0, y2: box.y1, style: { stroke: "var(--ink)" }, "stroke-width": 1, opacity: 0, "pointer-events": "none" });
  s.append(cross);
  const hit = svg("rect", { class: "ck-hit flow-click", x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 });
  const dayAt = (e: MouseEvent): number => {
    const r = (s as unknown as SVGSVGElement).getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - box.x0) / (box.x1 - box.x0)) * (n - 1))));
  };
  // the band under the pointer on that day (bottom to top, as stacked)
  const layerAt = (e: MouseEvent, i: number): Layer | undefined => {
    const r = (s as unknown as SVGSVGElement).getBoundingClientRect();
    const py = e.clientY - r.top;
    let lo = 0;
    for (const l of layers) {
      const hi = lo + values[l.key][i];
      if (py <= y(lo) && py >= y(hi)) return l;
      lo = hi;
    }
    return undefined;
  };
  hit.addEventListener("click", (e) => {
    const i = dayAt(e);
    const l = layerAt(e, i);
    if (!l) return;
    const day = startDay + i;
    show({ x: e.clientX, y: e.clientY }, `${l.label} on ${fmtDay(day, { weekday: "short", month: "short", day: "numeric" })}`, itemsOn(l.key, day));
  });
  hit.addEventListener("pointermove", (e) => {
    const i = dayAt(e);
    cross.setAttribute("x1", String(x(i)));
    cross.setAttribute("x2", String(x(i)));
    cross.setAttribute("opacity", "0.5");
    tip.show(e, [tipHead(fmtDay(startDay + i, { weekday: "short", month: "short", day: "numeric" })),
      ...[...layers].reverse().map((l) => tipRow(values[l.key][i], l.label, l.color)), tipRow(totals[i], "in all"), h("div.flow-tipnote", null, "Click a band to see its items")]);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("opacity", "0"); tip.hide(); });
  s.append(hit);
  return s;
}

function histChart(bins: Bin[], width: number, tip: Tip, marks: { v: number; label: string }[], binText: (b: Bin) => string, label: string, tickText: (v: number) => string = String): SVGElement {
  const H = 170;
  const box: Box = { x0: 34, x1: width - 8, y0: 18, y1: H - 22 };
  const s = chartSvg(width, H, label);
  if (!bins.length) return s;
  const total = bins.reduce((a, b) => a + b.count, 0) || 1;
  const pct = bins.map((b) => (b.count / total) * 100);
  const ticks = niceTicks(Math.max(1, ...pct), 3);
  const y = linear(0, ticks[ticks.length - 1], box.y1, box.y0);
  yGrid(s, ticks, y, box, (v) => `${v}%`);
  const band = (box.x1 - box.x0) / bins.length;
  const bw = Math.max(2, Math.min(24, band - 2));
  const cx = (i: number): number => box.x0 + i * band + band / 2;
  bins.forEach((_, i) => {
    const p = barPath(cx(i) - bw / 2, y(pct[i]), bw, y(0));
    if (p) s.append(svg("path", { d: p, style: { fill: series(1) } }));
  });
  const width0 = bins[0].to - bins[0].from + 1;
  const binOf = (v: number): number => Math.max(0, Math.min(bins.length - 1, Math.floor((v - bins[0].from) / width0)));
  const placed: number[] = [];
  for (const m of marks) {
    if (Number.isNaN(m.v)) continue;
    const xx = Math.round(cx(binOf(m.v))) + 0.5;
    s.append(svg("line", { x1: xx, x2: xx, y1: box.y0, y2: box.y1, style: { stroke: "var(--ink)" }, "stroke-width": 1, opacity: 0.6, "pointer-events": "none" }));
    if (placed.some((p) => Math.abs(p - xx) < 26)) continue; // same bin as a mark already labeled
    placed.push(xx);
    s.append(svg("text", { class: "ck-lab", x: xx, y: box.y0 - 6, "text-anchor": "middle" }, m.label));
  }
  xLabels(s, spacedIndexes(bins.length, Math.max(2, Math.floor((box.x1 - box.x0) / 70))).map((i) => ({ x: cx(i), text: tickText(bins[i].from) })), box.y1 + 6);
  bins.forEach((b, i) => {
    const r = svg("rect", { class: "ck-band", x: box.x0 + i * band, y: box.y0, width: band, height: box.y1 - box.y0, tabindex: -1, "aria-label": `${binText(b)}: ${pct[i].toFixed(1)}% of runs` });
    bandEvents(r, tip, () => [tipHead(binText(b)), tipRow(`${pct[i].toFixed(1)}%`, `of runs (${b.count.toLocaleString()})`, series(1))]);
    s.append(r);
  });
  return s;
}
