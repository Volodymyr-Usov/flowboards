// Roadmap: Epics and Features on a time line by start and target dates or sprints; drag to reschedule.
// Rows follow the portfolio levels of the team's process (top level with its children nested); a bar
// spans start → target, or the sprints of the item's children when dates are missing. Drag a bar to
// move it, drag its ends to change one date; Esc cancels. Dependencies are drawn as arrows.
// Other teams (of this project or others) can be added as row groups below, read-only, so dependencies
// between teams and their conflicts show; they are read by core/teamplans.ts.
import type { Iteration, Level, Project, Team, WorkItem } from "../api/types.ts";
import type { View } from "../app/context.ts";
import { textMatch } from "../core/filters.ts";
import { dailyThroughput, queueForecast, riskOf } from "../core/forecast.ts";
import type { ItemForecast } from "../core/forecast.ts";
import { typeHasField } from "../core/health.ts";
import { byOrder, isClosed, isDone, levelOf, statesOf, typeColor } from "../core/model.ts";
import { prefs } from "../core/settings.ts";
import { PLAN_TTL, teamPlans } from "../core/teamplans.ts";
import type { TeamPlan } from "../core/teamplans.ts";
import { h, icon, svg } from "../ui/dom.ts";
import { filterBar, peopleStrip, processFieldNames } from "../ui/filterbar.ts";
import { pageBar } from "../ui/pagebar.ts";
import { avatar, closePopup, empty, errorText, help, itemPicker, menu, popup, segmented, toast, toggle, typeMark } from "../ui/kit.ts";
import type { MenuItem } from "../ui/kit.ts";
import { addDependencyChecked, removeDependencyAny } from "./deps.ts";
import { ChildCounts } from "./childcounts.ts";
import { cleanTeams, conflictCounts, dependencies, dependencyPairs, dragsFor, teamKey } from "./roadmaplogic.ts";
import type { Dependency, TeamRef } from "./roadmaplogic.ts";
import type { Day, Span } from "../core/timeaxis.ts";
import {
  addMonths, dragDays, dragSpan, fmtDay, fmtSpan, monthStart, parts, planDay, planIso, quarterStart, ticks, todayDay, union, weekday,
} from "../core/timeaxis.ts";

const START = "Microsoft.VSTS.Scheduling.StartDate";
const TARGET = "Microsoft.VSTS.Scheduling.TargetDate";

type Zoom = "weeks" | "months" | "quarters";
const PX_PER_DAY: Record<Zoom, number> = { weeks: 18, months: 5, quarters: 1.7 };
/** length of a bar dropped from the Unscheduled list */
const DROP_DAYS: Record<Zoom, number> = { weeks: 14, months: 28, quarters: 90 };
/** the name column's width at first; drag its edge (in the corner) to change it, kept in this browser */
const NAME_W = 300;
const NAME_KEY = "roadmap.nameW";
const ROW_H = 34;

interface Bar extends Span {
  /** dates: both dates set; partial: one date set, the other from sprints; sprints: no dates */
  kind: "dates" | "partial" | "sprints";
}
interface Row {
  /** missing on a team's heading row */
  item?: WorkItem; depth: number; kids: number;
  /** shown only because something under it matches the search or the filters */
  ctx?: boolean;
  /** key of the other team the row belongs to (read-only); missing for this team */
  team?: string;
  /** a team's heading row, shown when other teams are on the roadmap; ref missing for this team */
  head?: { label: string; ref?: TeamRef };
}
/** the most other teams on the roadmap */
const MAX_TEAMS = 12;
interface Drag {
  id: number;
  bar: HTMLElement;
  mode: "move" | "start" | "end";
  x0: number;
  pointerId: number;
  from: Bar;
  now: Span;
  moved: boolean;
}

export const roadmapView: View = {
  id: "roadmap",
  title: "Roadmap",
  icon: "roadmap",
  group: "plan",
  about: "Epics and Features on a time line by start and target dates or sprints. Drag a bar to move it, drag its ends to change a date, click it to open.",
  mount(el, app) {
    const ws = app.ws;
    const st = {
      zoom: prefs.get<Zoom>("roadmap:zoom", "months"),
      stories: prefs.get<boolean>("roadmap:stories", false),
      deps: prefs.get<boolean>("roadmap:deps", true),
      forecast: prefs.get<boolean>("roadmap:forecast", true),
      collapsed: new Set<number>(prefs.get<number[]>("roadmap:collapsed", [])),
    };
    if (!(st.zoom in PX_PER_DAY)) st.zoom = "months";
    const saveCollapsed = (): void => prefs.set("roadmap:collapsed", [...st.collapsed].slice(-500));

    let selected: number | null = null;
    let drag: Drag | null = null;
    let redrawAfterDrag = false;
    let firstDraw = true;
    let linkToken = 0;
    let alive = true;
    // progress counts of the children that are not loaded (closed long ago, other teams' areas), read for the bars drawn
    const childCounts = new ChildCounts(ws, () => draw());
    const countIds = new Set<number>();

    // other teams on the roadmap: chosen in the Teams popup, kept per team in this browser
    const me: TeamRef = { project: ws.project, team: ws.team };
    const teamsPref = `roadmap:teams:${teamKey(me)}`;
    let teams: TeamRef[] = cleanTeams(prefs.get<unknown>(teamsPref, []), me, MAX_TEAMS);
    const plans = new Map<string, TeamPlan | Error>();
    let planToken = 0;
    // the other teams' items by id, with their team
    let ext = new Map<number, { item: WorkItem; team: string; plan: TeamPlan }>();
    const kidsCache = new WeakMap<TeamPlan, Map<number, WorkItem[]>>();

    // what the last draw laid out
    let rows: Row[] = [];
    const rowOf = new Map<number, number>();
    let bars = new Map<number, Bar | null>();
    let from: Day = 0;
    let to: Day = 0;
    let ppd = PX_PER_DAY[st.zoom];
    const x = (d: Day): number => (d - from) * ppd;
    const today = (): Day => todayDay();

    // ---------- page ----------
    // "N conflicts": a button with the list; a click on one shows its two bars
    const conflicts = h("button.rm-conflicts", { type: "button", hidden: true, "aria-haspopup": "dialog", onclick: () => openConflicts() });
    /** the dependencies the last drawLinks drew */
    let drawnDeps: Dependency[] = [];
    const fcNote = h("span.rm-fcnote.small.muted", { hidden: !st.forecast });
    // "likely done by": days from today, per item, at 50, 85 and 95 out of 100 simulated futures
    let forecast = new Map<number, ItemForecast>();
    let fcInfo = "";
    let fcLoading = false;
    let fcLoaded = false;
    let fcFailed = false; // the last load failed: wait for "Try again" instead of asking on every draw
    let fcDirty = false; // work changed while the pace was being read: read again when done
    const ro = app.actions.readOnly;
    el.classList.toggle("ro", ro);
    const teamsBtn = h("button.btn.small", {
      title: "Add other teams (of this project or other projects) as row groups, read-only, to see the dependencies between teams and their conflicts",
      "aria-haspopup": "dialog", onclick: () => void openTeams(),
    });
    const teamsLabel = (): void => teamsBtn.replaceChildren(icon("people", 14), teams.length ? `Teams (${teams.length + 1})` : "Teams");
    teamsLabel();
    let nameW = Math.min(800, Math.max(140, prefs.get<number>(NAME_KEY, NAME_W)));
    const scroll = h("div.rm-scroll", { style: { "--name-w": nameW + "px", "--row-h": ROW_H + "px" } });
    const unsched = h("section.rm-unsched");
    const legend = h("div.rm-legend");
    // search and filters: matching rows show with the rows above them (faded) for context
    const bar = pageBar(app, { search: { placeholder: "Search title, tag, owner, id…", title: "Show only the rows that contain every word, with the rows above them", label: "Search the roadmap", onChange: () => draw() } });
    const search = bar.search;
    const fb = filterBar({
      key: "roadmap.filters", names: () => processFieldNames(ws.process), onChange: () => draw(),
      items: () => [...[...ws.items.values()].filter((w) => { const k = ws.levelOf(w)?.kind; return k === "portfolio" || k === "requirement"; }), ...[...ext.values()].map((e) => e.item)],
    });
    // person chips, as on the Backlog: the owners of the rows the roadmap can show
    const people = peopleStrip({
      api: ws.api, key: "roadmap.people", onChange: () => draw(),
      items: () => [...[...ws.items.values()].filter((w) => { const k = ws.levelOf(w)?.kind; return !isClosed(w) && (k === "portfolio" || (st.stories && k === "requirement")); }), ...[...ext.values()].map((e) => e.item)],
    });
    const filtering = (): boolean => fb.active() || people.active() || search.words().length > 0;
    const hits = (it: WorkItem): boolean => fb.test(it) && people.test(it) && textMatch(search.words(), it);
    const found = h("span.small.muted.filter-count");
    // line 2: filters and buttons, then found, conflicts and the forecast note at the end
    bar.line2.append(fb.el,
      h("button.btn.small", { title: "Scroll to today", onclick: () => scrollToDay(today(), 1 / 3, true) }, icon("clock", 14), "Today"),
      teamsBtn,
      h("button.btn.small", { title: "Show every row's children", onclick: () => { st.collapsed.clear(); saveCollapsed(); draw(); } }, "Expand all"),
      h("button.btn.small", {
        title: "Show only the top level",
        onclick: () => { for (const r of rows) if (r.kids && r.item) st.collapsed.add(r.item.id); saveCollapsed(); draw(); },
      }, "Collapse all"));
    bar.end.append(found, conflicts, fcNote);
    // line 3: how it shows, and the legend on the right
    legend.style.marginLeft = "auto";
    bar.line3.append(people.el,
      segmented<Zoom>([
        { value: "weeks", label: "Weeks", title: "Show days and weeks" },
        { value: "months", label: "Months", title: "Show months" },
        { value: "quarters", label: "Quarters", title: "Show quarters: the long view" },
      ], st.zoom, (z) => { st.zoom = z; prefs.set("roadmap:zoom", z); draw(); }),
      toggle("Stories", st.stories, (v) => { st.stories = v; prefs.set("roadmap:stories", v); draw(); }, "Also show the stories under each item"),
      toggle("Likely done", st.forecast, (v) => { st.forecast = v; prefs.set("roadmap:forecast", v); fcNote.hidden = !v; if (v && !fcLoaded) { fcFailed = false; void loadForecast(); } else draw(); }, "Show when each open Feature and Epic will likely be done, from the team's recent pace"),
      toggle("Dependencies", st.deps, (v) => { st.deps = v; prefs.set("roadmap:deps", v); drawLinks(); void loadLinks(); }, "Show arrows from each item to the items that wait for it"),
      legend);
    el.append(
      bar.el,
      scroll,
      unsched);

    // ---------- data ----------
    function levels(): { portfolio: Level[]; req: Level } {
      return { portfolio: ws.portfolioLevels().slice().sort((a, b) => a.rank - b.rank), req: ws.requirementLevel() };
    }
    const kindOf = (it: WorkItem): Level["kind"] | undefined => {
      const e = ext.get(it.id);
      return e && e.item === it ? levelOf(e.plan.process, it.type)?.kind : ws.levelOf(it)?.kind;
    };

    /** An other team's items by parent. */
    function kidsOf(p: TeamPlan): Map<number, WorkItem[]> {
      let m = kidsCache.get(p);
      if (m) return m;
      m = new Map();
      for (const it of p.items) {
        if (!it.parent) continue;
        let list = m.get(it.parent);
        if (!list) m.set(it.parent, (list = []));
        list.push(it);
      }
      for (const list of m.values()) list.sort(byOrder);
      kidsCache.set(p, m);
      return m;
    }

    /** Which planning date fields a type of this team's process has (a type whose fields are not known: both). */
    const dateFields = (type: string): { start: boolean; target: boolean } =>
      ({ start: typeHasField(ws.process, type, START), target: typeHasField(ws.process, type, TARGET) });

    /** Is an item in this team's area paths? */
    const inMyAreas = (it: WorkItem): boolean => {
      const a = ws.settings.areas;
      return !a.length || a.some((x) => it.area === x.path || (x.includeChildren && it.area.startsWith(x.path + "\\")));
    };

    function barsFor(children: (id: number) => WorkItem[] = (id) => ws.children(id), iterations: Iteration[] = ws.iterations): (it: WorkItem) => Bar | null {
      const memo = new Map<number, Bar | null>();
      const busy = new Set<number>();
      const iterBy = new Map<string, Iteration>(iterations.map((i) => [i.path, i]));
      const iterSpan = (path: string): Span | null => {
        const i = iterBy.get(path);
        const s = planDay(i?.start);
        const e = planDay(i?.finish);
        return s != null && e != null ? { start: Math.min(s, e), end: Math.max(s, e) } : null;
      };
      const barOf = (it: WorkItem): Bar | null => {
        if (memo.has(it.id)) return memo.get(it.id)!;
        if (busy.has(it.id)) return null;
        busy.add(it.id);
        const s = planDay(it.startDate);
        const t = planDay(it.targetDate);
        let out: Bar | null;
        if (s != null && t != null) out = { start: Math.min(s, t), end: Math.max(s, t), kind: "dates" };
        else {
          const d = union(children(it.id).map(barOf)) ?? iterSpan(it.iteration);
          if (s != null) out = { start: s, end: d && d.end >= s ? d.end : s + 13, kind: "partial" };
          else if (t != null) out = { start: d && d.start <= t ? d.start : t - 13, end: t, kind: "partial" };
          else out = d ? { ...d, kind: "sprints" } : null;
        }
        busy.delete(it.id);
        memo.set(it.id, out);
        return out;
      };
      return barOf;
    }

    /** Done and all items at the requirement level under an item (tasks for a story). */
    function progress(it: WorkItem): { done: number; total: number } {
      const e = ext.get(it.id);
      if (e && e.item === it) {
        // another team: only its Epics and Features are read, so count the items one level down
        const kids = kidsOf(e.plan).get(it.id) ?? [];
        return kids.length ? { done: kids.filter(isDone).length, total: kids.length } : { done: isDone(it) ? 1 : 0, total: 1 };
      }
      const kind = kindOf(it);
      let done = 0;
      let total = 0;
      if (kind === "requirement") {
        for (const k of ws.children(it.id)) { total++; if (isDone(k)) done++; }
      } else {
        const walk = (id: number, depth: number): void => {
          if (depth > 10) return;
          for (const k of ws.children(id)) {
            const kk = kindOf(k);
            if (kk === "portfolio") walk(k.id, depth + 1);
            else if (kk === "requirement") { total++; if (isDone(k)) done++; }
          }
        };
        walk(it.id, 0);
      }
      // and the children that are not loaded (closed long ago, other teams' areas), once read
      if (kind === "requirement" || kind === "portfolio") {
        const x = childCounts.extra(it.id);
        done += x.done;
        total += x.total;
        countIds.add(it.id);
      }
      if (!total) return { done: isDone(it) ? 1 : 0, total: 1 };
      return { done, total };
    }

    function buildRows(): Row[] {
      const { portfolio, req } = levels();
      const out: Row[] = [];
      const up: number[] = []; // the row above each row (its parent row, or its team's heading), -1 at the top
      const filter = filtering();
      // every item shown in a group so far (also those under a closed row): a later team leaves them out
      const placed = new Set<number>();
      const heading = (head: Row["head"], team?: string): number => { up.push(-1); return out.push({ depth: 0, kids: 0, team, head }) - 1; };
      const tree = (tops: WorkItem[], children: (id: number) => WorkItem[], shown: (w: WorkItem) => boolean, skip: (w: WorkItem) => boolean, team: string | undefined, root: number): void => {
        const kidsOf = (id: number): WorkItem[] => children(id).filter((k) => shown(k) && !skip(k));
        const markSeen = (it: WorkItem): void => {
          if (placed.has(it.id)) return;
          placed.add(it.id);
          for (const k of kidsOf(it.id)) markSeen(k);
        };
        const visit = (it: WorkItem, depth: number, parent: number): void => {
          if (placed.has(it.id)) return;
          placed.add(it.id);
          const kids = kidsOf(it.id);
          const at = out.push({ item: it, depth, kids: kids.length, team }) - 1;
          up.push(parent);
          // while filtering every row opens, so each match shows
          if (st.collapsed.has(it.id) && !filter) { for (const k of kids) markSeen(k); return; }
          for (const k of kids) visit(k, depth + 1, at);
        };
        for (const it of tops) if (!skip(it)) visit(it, 0, root);
      };
      // this team: the top level with its children, then lower portfolio items whose parent is not shown;
      // an item read for another team and outside this team's areas shows in that team's rows only
      const mine = teams.length ? heading({ label: ws.team }) : -1;
      const shownMine = (k: WorkItem): boolean => {
        const kind = kindOf(k);
        return kind === "portfolio" || (st.stories && kind === "requirement" && req.types.includes(k.type));
      };
      tree(portfolio.flatMap((l) => ws.ofLevel(l)), (id) => ws.children(id), shownMine, (w) => ext.has(w.id) && !inMyAreas(w), undefined, mine);
      // other teams, read-only, each under its heading
      for (const r of teams) {
        const key = teamKey(r);
        const at = heading({ label: r.team, ref: r }, key);
        const p = plans.get(key);
        if (!p || p instanceof Error) continue;
        const pl = p.process.levels.filter((l) => l.kind === "portfolio").sort((a, b) => a.rank - b.rank);
        const types = new Set(pl.flatMap((l) => l.types));
        const kids = kidsOf(p);
        const tops = pl.flatMap((l) => p.items.filter((w) => l.types.includes(w.type)).sort(byOrder));
        tree(tops, (id) => kids.get(id) ?? [], (w) => types.has(w.type), (w) => placed.has(w.id), key, at);
      }
      if (!filter) return out;
      // keep the matches and the rows above them; those show faded. Team headings always stay.
      const keep = new Set<number>();
      out.forEach((r, i) => {
        if (r.head) { keep.add(i); return; }
        if (!r.item || !hits(r.item)) return;
        keep.add(i);
        for (let p = up[i]; p >= 0 && !keep.has(p); p = up[p]) { keep.add(p); out[p].ctx = true; }
      });
      return out.filter((_, i) => keep.has(i));
    }

    // ---------- drawing ----------
    function draw(): void {
      if (drag) { redrawAfterDrag = true; return; }
      const { portfolio, req } = levels();
      if (!portfolio.length) {
        scroll.replaceChildren(empty("No Epics or Features", "This team's process has no portfolio levels, so there is nothing to put on a time line."));
        unsched.replaceChildren();
        return;
      }
      // keep the day in the middle of the screen when the scale or the range changes
      const keepDay = firstDraw ? today() : from + (scroll.scrollLeft + (scroll.clientWidth - nameW) / 2) / ppd;
      const keepTop = scroll.scrollTop;
      ppd = PX_PER_DAY[st.zoom];

      const barOf = barsFor();
      // other teams: bars from their own sprints and their own children
      const extBars = new Map<string, (it: WorkItem) => Bar | null>();
      for (const r of teams) {
        const p = plans.get(teamKey(r));
        if (p && !(p instanceof Error)) { const kids = kidsOf(p); extBars.set(teamKey(r), barsFor((id) => kids.get(id) ?? [], p.iterations)); }
      }
      rows = buildRows();
      people.refresh();
      const matched = rows.filter((r) => r.item && !r.ctx).length;
      found.textContent = filtering() ? `${matched} found` : "";
      rowOf.clear();
      rows.forEach((r, i) => { if (r.item) rowOf.set(r.item.id, i); });
      bars = new Map(rows.filter((r) => r.item).map((r) => [r.item!.id, r.team ? extBars.get(r.team)?.(r.item!) ?? null : barOf(r.item!)]));

      const all = union([...bars.values()]);
      const t = today();
      const lo = Math.min(all?.start ?? t, t - 30) - 14;
      const hi = Math.max(all?.end ?? t, t + 90) + 21;
      const startOf = st.zoom === "quarters" ? quarterStart : monthStart;
      from = startOf(lo);
      to = addMonths(hi, st.zoom === "quarters" ? 3 - (parts(hi).m % 3) : 1) - 1;
      const W = Math.round((to - from + 1) * ppd);

      countIds.clear();
      const canvas = h("div.rm-canvas", { style: { width: nameW + W + "px" } }, header(W), body(W));
      childCounts.want(countIds);
      scroll.replaceChildren(canvas);
      drawLegend(portfolio, req);
      drawUnscheduled(barOf);
      drawLinks();
      void loadLinks();
      if (st.forecast && !fcLoaded && !fcLoading && !fcFailed) void loadForecast();
      scrollToDay(keepDay, 1 / 2);
      if (firstDraw) scrollToDay(t, 1 / 3);
      else scroll.scrollTop = keepTop;
      firstDraw = false;
    }

    /** The edge of the name column: drag to widen or narrow it, double-click for the first width. */
    function nameGrip(): HTMLElement {
      const grip = h("span.col-grip.rm-name-grip", { title: "Drag to change the width of the names; double-click for the first width", "aria-hidden": "true" });
      const set = (w: number): void => { nameW = Math.min(800, Math.max(140, Math.round(w))); scroll.style.setProperty("--name-w", nameW + "px"); };
      grip.addEventListener("dblclick", (e) => { e.stopPropagation(); set(NAME_W); prefs.set(NAME_KEY, nameW); draw(); });
      grip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const x0 = e.clientX;
        const w0 = nameW;
        grip.setPointerCapture(e.pointerId);
        grip.classList.add("on");
        const move = (ev: PointerEvent): void => set(w0 + ev.clientX - x0);
        const up = (): void => { grip.removeEventListener("pointermove", move); grip.classList.remove("on"); prefs.set(NAME_KEY, nameW); draw(); };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up, { once: true });
        grip.addEventListener("pointercancel", up, { once: true });
      });
      return grip;
    }

    function header(W: number): HTMLElement {
      const trackRow = (cls: string, kids: (Node | null)[]): HTMLElement => h(`div.rm-hrow.${cls}`, { style: { width: W + "px" } }, kids);
      const unit = st.zoom === "quarters" ? "quarter" : "month";
      const periods = ticks(from, to, unit).map((p) => {
        const w = (p.end - p.start + 1) * ppd;
        const pp = parts(p.start);
        const label = unit === "quarter" ? `Q${Math.floor(pp.m / 3) + 1} ${pp.y}` : fmtDay(p.start, w > 80 ? { month: "long", year: "numeric" } : { month: "short" });
        return h("div.rm-tick", { style: { left: x(p.start) + "px", width: w + "px" }, title: unit === "quarter" ? `${label}: ${fmtSpan(p)}` : fmtDay(p.start, { month: "long", year: "numeric" }) }, label);
      });
      const rowsEls: HTMLElement[] = [trackRow("periods", periods)];
      if (st.zoom === "weeks") {
        rowsEls.push(trackRow("weeks", ticks(from, to, "week", firstDow()).map((p) =>
          h("div.rm-tick", { style: { left: x(p.start) + "px", width: (p.end - p.start + 1) * ppd + "px" }, title: `Week of ${fmtDay(p.start)}` }, fmtDay(p.start, { day: "numeric", month: "short" })))));
      }
      const cur = ws.currentIteration();
      const sprints: HTMLElement[] = [];
      for (const it of ws.iterations) {
        const s = planDay(it.start);
        const e = planDay(it.finish);
        if (s == null || e == null || e < from || s > to) continue;
        const a = Math.max(s, from);
        const b = Math.min(e, to);
        sprints.push(h("div.rm-sprint", {
          class: it.id === cur?.id ? "current" : undefined,
          style: { left: x(a) + "px", width: Math.max(2, (b - a + 1) * ppd - 2) + "px" },
          title: `${it.name}: ${fmtSpan({ start: s, end: e })}${it.id === cur?.id ? " (current sprint)" : ""}`,
        }, (b - a + 1) * ppd > 40 ? it.name : ""));
      }
      const t = today();
      if (t >= from && t <= to) sprints.push(h("div.rm-today-mark", { style: { left: x(t) + ppd / 2 + "px" }, title: `Today, ${fmtDay(t)}` }));
      rowsEls.push(trackRow("sprints", sprints));
      return h("div.rm-head", null,
        h("div.rm-corner", null, h("span", null, `${itemRows()} ${itemRows() === 1 ? "row" : "rows"}`), h("span.muted", null, "Sprints"), nameGrip()),
        h("div.rm-tracks", null, rowsEls));
    }

    const itemRows = (): number => rows.filter((r) => r.item).length;

    function firstDow(): number {
      const wd = ws.settings.workingDays ?? [1, 2, 3, 4, 5];
      return wd.includes(0) && !wd.includes(6) ? 0 : 1;
    }

    function body(W: number): HTMLElement {
      const H = Math.max(rows.length * ROW_H, ROW_H);
      // grid lines, days off and today, under the bars
      const grid = h("div.rm-grid", { style: { width: W + "px", height: H + "px" } });
      if (st.zoom === "weeks") {
        const wd = ws.settings.workingDays ?? [1, 2, 3, 4, 5];
        for (let d = from; d <= to; d++) if (!wd.includes(weekday(d))) grid.append(h("div.rm-off", { style: { left: x(d) + "px", width: ppd + "px" } }));
        for (const p of ticks(from, to, "week", firstDow())) grid.append(h("div.rm-vline", { style: { left: x(p.start) + "px" } }));
        for (const p of ticks(from, to, "month")) grid.append(h("div.rm-vline.major", { style: { left: x(p.start) + "px" } }));
      } else {
        for (const p of ticks(from, to, "month")) grid.append(h("div.rm-vline", { class: st.zoom === "months" || parts(p.start).m % 3 === 0 ? "major" : undefined, style: { left: x(p.start) + "px" } }));
      }
      const t = today();
      const overlay = h("div.rm-over", { style: { width: W + "px", height: H + "px" } });
      if (t >= from && t <= to) overlay.append(h("div.rm-today", { style: { left: x(t) + ppd / 2 + "px" }, title: `Today, ${fmtDay(t)}` }));
      const drop = h("div.rm-drop", { hidden: true });
      overlay.append(drop);

      const links = svg("svg", { class: "rm-links", width: W, height: H, "aria-hidden": "true" });
      const rowEls = rows.map((r) => rowEl(r, W));
      const b = h("div.rm-body", { style: { height: H + "px" } }, grid, links, overlay, rowEls.length ? rowEls : h("div.rm-none", null, filtering() ? "Nothing matches the search and the filters." : "No Epics or Features yet."));

      // drop an unscheduled item on the time line to give it dates
      const dayAt = (clientX: number): Day => from + Math.floor((clientX - grid.getBoundingClientRect().left) / ppd);
      b.addEventListener("dragover", (e) => {
        if (ro || !e.dataTransfer?.types.includes("application/x-roadmap-item")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const d = dayAt(e.clientX);
        drop.hidden = false;
        drop.style.left = x(d) + "px";
        drop.style.width = DROP_DAYS[st.zoom] * ppd + "px";
        drop.dataset.label = `${fmtSpan({ start: d, end: d + DROP_DAYS[st.zoom] - 1 })}`;
      });
      b.addEventListener("dragleave", (e) => { if (!b.contains(e.relatedTarget as Node | null)) drop.hidden = true; });
      b.addEventListener("drop", (e) => {
        const id = Number(e.dataTransfer?.getData("application/x-roadmap-item"));
        drop.hidden = true;
        if (!id) return;
        e.preventDefault();
        const d = dayAt(e.clientX);
        void schedule(id, { start: d, end: d + DROP_DAYS[st.zoom] - 1 }, true);
      });
      b.addEventListener("pointerdown", onPointerDown);
      return b;
    }

    function rowEl(r: Row, W: number): HTMLElement {
      if (!r.item) return headEl(r, W);
      const it = r.item;
      const open = !st.collapsed.has(it.id) || filtering();
      const kind = kindOf(it);
      const name = h("div.rm-name", { style: { "--depth": String(r.depth) } },
        r.kids ? h("button.rm-caret", {
          class: open ? "open" : undefined, "aria-expanded": String(open),
          title: open ? "Hide the items under this one" : `Show the ${r.kids} items under this one`,
          onclick: () => { if (open) st.collapsed.add(it.id); else st.collapsed.delete(it.id); saveCollapsed(); draw(); },
        }, icon("chevron", 14)) : h("span.rm-caret-gap"),
        typeMark(ws, it.type),
        h("button.rm-title", { class: isDone(it) ? "done" : undefined, title: `${it.type} #${it.id}: ${it.title} (${it.state}).${r.team ? ` ${teamNote(r.team)}.` : ""} Click to open.`, onclick: () => openRow(r) }, it.title),
        h("span.rm-id.mono", null, String(it.id)),
        h("button.icon-btn.small.rm-more", { type: "button", title: r.team ? "Open" : "Open, or add and remove dependencies", "aria-label": `More for #${it.id}`, onclick: (e: Event) => void itemMenu(r, e.currentTarget as Element) }, icon("more", 14)));
      const lane = h("div.rm-lane", { style: { width: W + "px" } });
      const b = bars.get(it.id);
      const fc = st.forecast ? forecast.get(it.id) : undefined;
      if (fc && !isClosed(it) && !r.team) lane.append(forecastEl(it, fc, b));
      if (b) lane.append(barEl(it, b, r));
      else lane.append(h("span.rm-nodate", { style: { left: Math.max(8, x(today()) - 60) + "px" }, title: r.team ? "No start or target date and no sprint." : "No start or target date and no sprint. Drag it from the Unscheduled list below onto the time line." }, "No dates"));
      return h("div.rm-row", { class: [r.depth === 0 && "top", kind === "requirement" && "story", selected === it.id && "sel", r.ctx && "ctx", r.team && "ext"], dataset: { id: it.id } }, name, lane);
    }

    /** Words for another team's row: whose it is, and that it is read-only. */
    function teamNote(key: string): string {
      const r = teams.find((t) => teamKey(t) === key);
      return r ? `${r.team}${r.project !== ws.project ? ` (${r.project})` : ""}, read-only` : "read-only";
    }

    /** Open a row's item: this project's in the details panel, another project's in Azure DevOps. */
    function openRow(r: Row): void {
      const it = r.item;
      if (!it) return;
      const project = r.team ? ext.get(it.id)?.plan.project ?? ws.project : ws.project;
      if (project === ws.project) app.openItem(it.id);
      else window.open(ws.api.itemUrl(project, it.id), "_blank", "noopener");
    }

    /** A team's heading row: its name, where it comes from, and whether it was read. */
    function headEl(r: Row, W: number): HTMLElement {
      const ref = r.head?.ref;
      const p = ref ? plans.get(teamKey(ref)) : undefined;
      const other = ref && ref.project !== ws.project ? ref.project : "";
      const status: (Node | string)[] = !ref
        ? [ro ? "This team" : "This team: drag bars to change dates"]
        : !p ? ["Reading this team's Epics and Features…"]
        : p instanceof Error ? [h("span.err", { title: errorText(p) }, "Could not be read. "), h("button.btn.link.small", { title: "Read this team again", onclick: () => void loadPlans(true) }, "Try again")]
        : [`Read-only · ${p.items.length ? `${p.items.length} ${p.items.length === 1 ? "item" : "items"}` : "no open Epics or Features in its area paths"} · read at ${new Date(p.readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} `,
          h("button.btn.link.small", { title: "Read this team's Epics and Features again", onclick: () => void loadPlans(true) }, "Read again")];
      return h("div.rm-row.rm-team", { class: !ref ? "mine" : undefined, dataset: { team: r.team ?? "" } },
        h("div.rm-name", null,
          icon("people", 14),
          h("b.rm-team-name", { title: ref ? `${ref.team} in ${ref.project}` : `${ws.team} (this team)` }, r.head?.label ?? ""),
          other ? h("span.small.muted.rm-team-proj", { title: `Project ${other}` }, other) : null,
          ref ? h("button.icon-btn.small.rm-team-x", { title: `Take ${ref.team} off the roadmap`, "aria-label": `Take ${ref.team} off the roadmap`, onclick: () => setTeams(teams.filter((t) => teamKey(t) !== teamKey(ref))) }, icon("close", 12)) : null),
        h("div.rm-lane", { style: { width: W + "px" } }, h("span.rm-team-status.small.muted", null, status)));
    }

    function barEl(it: WorkItem, b: Bar, r: Row): HTMLElement {
      const df = dateFields(it.type);
      const drags = dragsFor(df);
      // read-only, another team's, or a type without date fields: no dragging, a click opens
      const fixed = ro || !!r.team || (!drags.start && !drags.end);
      const canMove = drags.move;
      const dragHow = fixed
        ? (!ro && !r.team ? `${it.type} has no start or target date field, so its bar cannot be dragged. Click to open.` : "Click to open.")
        : canMove ? "Drag to move, drag an end to change one date, click to open."
          : df.target ? `Drag the right end to change the target date (${it.type} has no start date field), click to open.`
            : `Drag the left end to change the start date (${it.type} has no target date field), click to open.`;
      const p = progress(it);
      const pct = Math.round((p.done / p.total) * 100);
      const done = isDone(it);
      const late = !done && b.end < today();
      const left = x(b.start);
      const width = Math.max(4, (b.end - b.start + 1) * ppd);
      const how = b.kind === "dates" ? "" : b.kind === "partial" ? "\nOne date is missing: the other end comes from the sprints." : "\nNo dates: the bar shows the sprints of its work.";
      const tip = `${it.type} #${it.id}: ${it.title}${r.team ? `\n${teamNote(r.team)}` : ""}\n${fmtSpan(b)} · ${it.state} · ${p.total > 1 || kindOf(it) !== "requirement" ? `${p.done} of ${p.total} done` : done ? "done" : "open"}`
        + `${late ? "\nLate: the target date has passed." : ""}${how}\n${dragHow}`;
      return h("div.rm-bar", {
        role: "button", tabindex: 0,
        class: [b.kind !== "dates" && "est", late && "late", done && "done", width < 90 && "narrow", selected === it.id && "sel", r.team && "ext"],
        dataset: { id: it.id, tip, ...(r.team ? { ext: "1" } : {}) },
        style: { left: left + "px", width: width + "px", "--c": typeColor(r.team ? ext.get(it.id)?.plan.process ?? ws.process : ws.process, it.type) },
        title: tip,
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRow(r); }
          else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); void itemMenu(r, e.currentTarget as Element); }
        },
        // no dragging, so a plain click opens; a bar that only one end of moves opens on a click off that end
        onclick: fixed ? () => openRow(r) : !canMove ? (e: MouseEvent) => { if (!(e.target as Element).closest(".rm-h")) openRow(r); } : undefined,
      },
      h("div.rm-track", null, h("div.rm-fill", { style: { width: pct + "%" } })),
      fixed || !df.start ? null : h("div.rm-h.l", { title: "Drag to change the start date" }),
      it.assignedTo ? avatar(app.api, it.assignedTo, 18) : null,
      h("span.rm-bt", null, it.title),
      fixed || !df.target ? null : h("div.rm-h.r", { title: "Drag to change the target date" }));
    }

    /** The diamond at the day the item will likely be done (85 of 100 futures), red when after its target. */
    function forecastEl(it: WorkItem, fc: ItemForecast, b: Bar | null | undefined): HTMLElement {
      const t = today();
      const d85 = t + fc.p85;
      const target = it.targetDate ? planDay(it.targetDate) : b && b.kind !== "sprints" ? b.end : null;
      const risk = riskOf(d85, target ?? null);
      const capped = fc.p85 >= 3650;
      const label = capped ? "not within 10 years" : fmtDay(d85);
      const title = `Likely done by ${label} (85 of 100 simulated futures)\n50 of 100: ${fmtDay(t + fc.p50)} · 95 of 100: ${fmtDay(t + fc.p95)}`
        + (target != null ? `\nTarget: ${fmtDay(target)}${risk === "late" ? " — will probably be missed" : " — on track"}` : "\nNo target date")
        + "\nBased on the team's pace and the order of the Backlog tab (Epics in order, Features in order within each): the stories of every Feature above it come first.";
      return h(`div.rm-fc.${risk}`, { style: { left: x(Math.min(d85, to)) + "px" }, title, dataset: { id: it.id } },
        h("i"), h("span", null, `≈ ${capped ? "?" : fmtDay(d85, { day: "numeric", month: "short" })}`));
    }

    /** Read the team's pace (stories closed per day, last 12 weeks) and forecast every open Feature and Epic. */
    async function loadForecast(): Promise<void> {
      if (fcLoading) return;
      fcLoading = true;
      fcFailed = false;
      fcNote.textContent = "Working out likely dates…";
      try {
        const req = ws.requirementLevel();
        const portfolio = ws.portfolioLevels().slice().sort((a, b) => a.rank - b.rank);
        const featLevel = portfolio[portfolio.length - 1];
        const DAYS = 84;
        const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
        const ids = await ws.api.query(ws.project, { types: req.types, areas: ws.settings.areas.length ? ws.settings.areas : undefined, states: statesOf(ws.process, req.types, ["Completed"]), closedAfter: since });
        const closed = (await ws.api.items(ws.project, ids)).map((w) => w.closed).filter((c): c is string => !!c);
        const samples = dailyThroughput(closed, DAYS);
        const perWeek = closed.length / (DAYS / 7);
        const isReq = (w: WorkItem): boolean => req.types.includes(w.type);
        const openStories = (id: number): number => ws.children(id).filter((k) => isReq(k) && !isDone(k)).length;
        const epicRank = new Map<number, number>();
        const topLevels = portfolio.slice(0, -1);
        topLevels.forEach((lvl) => ws.ofLevel(lvl).forEach((e, i) => { if (!epicRank.has(e.id)) epicRank.set(e.id, i); }));
        const rankOf = (f: WorkItem): number => { const p = ws.get(f.parent); return p && epicRank.has(p.id) ? epicRank.get(p.id)! : Number.MAX_SAFE_INTEGER; };
        const queue = (featLevel ? ws.ofLevel(featLevel) : []).filter((f) => !isClosed(f)).sort((a, b) => rankOf(a) - rankOf(b) || byOrder(a, b))
          .map((f) => ({ id: f.id, remaining: openStories(f.id) })).filter((q) => q.remaining > 0);
        const result = queueForecast(queue, samples);
        forecast = new Map(result.map((r) => [r.id, r]));
        // an Epic is done when its last Feature is
        for (const lvl of portfolio.slice(0, -1)) {
          for (const e of ws.ofLevel(lvl)) {
            if (isClosed(e)) continue;
            const under: ItemForecast[] = [];
            const walk = (id: number, depth: number): void => { if (depth > 6) return; for (const k of ws.children(id)) { const fk = forecast.get(k.id); if (fk) under.push(fk); walk(k.id, depth + 1); } };
            walk(e.id, 0);
            if (under.length) forecast.set(e.id, { id: e.id, p50: Math.max(...under.map((u) => u.p50)), p85: Math.max(...under.map((u) => u.p85)), p95: Math.max(...under.map((u) => u.p95)) });
          }
        }
        fcInfo = result.length ? `Likely dates from ${closed.length} stories done in the last 12 weeks (about ${(Math.round(perWeek * 10) / 10).toLocaleString()} a week)` : "No stories were finished in the last 12 weeks, so there is no pace to forecast from.";
        fcLoaded = true;
      } catch (e) {
        fcInfo = `Likely dates could not be read: ${errorText(e)}`;
        fcFailed = true;
      }
      fcLoading = false;
      if (!alive) return;
      if (fcDirty) { fcDirty = false; fcLoaded = false; }
      fcNote.replaceChildren(fcInfo, ...(fcFailed
        ? [" ", h("button.btn.link.small", { title: "Read the team's pace again", onclick: () => { fcFailed = false; void loadForecast(); } }, "Try again")]
        : []));
      draw();
    }

    function drawLegend(portfolio: Level[], req: Level): void {
      const types = [...portfolio.flatMap((l) => l.types), ...(st.stories ? req.types : [])];
      legend.replaceChildren(
        ...types.map((t) => h("span.rm-key", { title: `${t} bars` }, h("i", { style: { "--c": typeColor(ws.process, t) } }), t)),
        st.forecast ? h("span.rm-key", { title: "Likely done by: 85 of 100 simulated futures finish by this day. Red: after the target date." }, h("i.rm-fc-key"), "Likely done") : "",
        help("Diamond: the day it will likely be done (85 of 100 futures), from the team's pace over the last 12 weeks and the backlog order; red when that is after the target date. Filled part: share of the stories under it that are done. Dashed bar: a date is missing, so the bar uses the sprints of its work. Red right edge: the target date has passed and it is not done. Red arrow: an item starts before the item it waits for ends."));
    }

    function drawUnscheduled(barOf: (it: WorkItem) => Bar | null): void {
      const { portfolio, req } = levels();
      const types = new Set([...portfolio.flatMap((l) => l.types), ...(st.stories ? req.types : [])]);
      const list = [...ws.items.values()].filter((it) => types.has(it.type) && !isDone(it) && !barOf(it) && (!filtering() || hits(it)))
        .sort((a, b) => (ws.levelOf(a)?.rank ?? 9) - (ws.levelOf(b)?.rank ?? 9) || (a.order ?? 0) - (b.order ?? 0));
      if (!list.length) { unsched.replaceChildren(); return; }
      unsched.replaceChildren(
        h("h3", null, `Unscheduled (${list.length})`, " ", help("No start or target date, and nothing under it is in a sprint. Drag one onto the time line to give it dates.")),
        h("div.rm-chips", null, list.map((it) => { const df = dateFields(it.type); const can = !ro && (df.start || df.target); return h("div.rm-chip", {
          draggable: can ? "true" : undefined, tabindex: 0, role: "button",
          title: !can ? `${it.type} #${it.id}: ${it.title}.${ro ? "" : ` ${it.type} has no start or target date field, so it cannot get dates here.`} Click to open.` : `${it.type} #${it.id}: ${it.title}. Drag onto the time line to give it dates; click to open.`,
          ondragstart: (e: DragEvent) => { e.dataTransfer?.setData("application/x-roadmap-item", String(it.id)); e.dataTransfer?.setData("text/plain", `#${it.id} ${it.title}`); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; },
          onclick: () => app.openItem(it.id),
          onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") app.openItem(it.id); },
        }, typeMark(ws, it.type), h("span", null, it.title), h("span.mono.muted", null, String(it.id))); })));
    }

    // ---------- dependencies ----------
    async function loadLinks(): Promise<void> {
      if (!st.deps) return;
      // other teams' items come with their links
      const ids = rows.filter((r) => r.item && !r.team).map((r) => r.item!.id).filter((id) => !ws.get(id)?.relations);
      if (!ids.length) return;
      const token = ++linkToken;
      try { await ws.withRelations(ids); } catch { return; }
      if (token === linkToken) drawLinks();
    }

    function drawLinks(): void {
      const layer = scroll.querySelector<SVGSVGElement>("svg.rm-links");
      if (!layer) return;
      const marker = (id: string, cls: string): SVGElement => svg("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" },
        svg("path", { d: "M0 0L10 5L0 10z", class: `rm-ah ${cls}` }));
      layer.replaceChildren(svg("defs", null, marker("rm-ah-ok", ""), marker("rm-ah-bad", "bad")));
      const late = new Map<number, string[]>(); // item that waits -> why it conflicts
      if (st.deps) {
        const shown = rows.filter((r) => r.item).map((r) => r.item!);
        const spanOf = (id: number): Span | null | undefined => (rowOf.has(id) ? (drag?.id === id ? drag.now : bars.get(id)) : null);
        const deps = dependencies(dependencyPairs(shown), spanOf, (id) => rows[rowOf.get(id) ?? -1]?.team ?? "");
        const title = (id: number): string => { const r = rows[rowOf.get(id) ?? -1]; return `#${id} ${r?.item?.title ?? ""}${r?.team ? ` (${teamNote(r.team).replace(/, read-only$/, "")})` : ""}`; };
        for (const dep of deps) {
          const a = spanOf(dep.pred)!;
          const b = spanOf(dep.succ)!;
          const x1 = x(a.end + 1);
          const y1 = rowOf.get(dep.pred)! * ROW_H + ROW_H / 2;
          const x2 = x(b.start);
          const y2 = rowOf.get(dep.succ)! * ROW_H + ROW_H / 2;
          const dx = Math.max(28, Math.abs(x2 - x1) / 2);
          const d = `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2 - 1} ${y2}`;
          // the click area stops short of both bars, so their ends still drag
          const hit = `M${x1 + 7} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2 - 9} ${y2}`;
          const what = dep.conflict ? `Conflict${dep.cross ? " between teams" : ""}: ${title(dep.succ)} starts before ${title(dep.pred)} ends` : `${title(dep.succ)} waits for ${title(dep.pred)}`;
          if (dep.conflict) late.set(dep.succ, [...(late.get(dep.succ) ?? []), `starts before ${title(dep.pred)} ends`]);
          const data = { pred: dep.pred, succ: dep.succ };
          layer.append(svg("path", { d, class: ["rm-link", dep.conflict && "bad", dep.cross && "cross"].filter(Boolean).join(" "), "marker-end": `url(#rm-ah-${dep.conflict ? "bad" : "ok"})`, dataset: data }),
            svg("path", { d: hit, class: "rm-link-hit", dataset: data }, svg("title", null, `${what}. Click to open or remove.`)));
        }
        drawnDeps = deps;
        const n = conflictCounts(deps);
        conflicts.hidden = !n.all;
        conflicts.textContent = n.all ? `${n.all} ${n.all === 1 ? "conflict" : "conflicts"}${n.cross ? `, ${n.cross} between teams` : ""}` : "";
        conflicts.title = "Items that start before an item they wait for ends (red arrows and a red mark on the bar). Click for the list.";
      } else { conflicts.hidden = true; drawnDeps = []; }
      // a red mark on each bar that starts too early
      for (const bar of scroll.querySelectorAll<HTMLElement>(".rm-bar")) {
        const why = late.get(Number(bar.dataset.id));
        bar.classList.toggle("conflict", !!why);
        bar.title = (bar.dataset.tip ?? "") + (why ? `\nConflict: ${why.join("; ")}.` : "");
      }
    }

    /** "#12 Title" of a shown row, for menus and lists. */
    const rowName = (id: number): string => {
      const it = rows[rowOf.get(id) ?? -1]?.item ?? ws.get(id);
      return `#${id}${it ? ` ${it.title.length > 48 ? it.title.slice(0, 46) + "…" : it.title}` : ""}`;
    };

    /** A row's menu (its "…", a right-click on its bar, or the menu key): open, and this team's dependencies. */
    async function itemMenu(r: Row, anchor: Element): Promise<void> {
      const it = r.item;
      if (!it) return;
      const items: (MenuItem | "-")[] = [{ label: "Open", icon: "external", onClick: () => openRow(r) }];
      if (!r.team && !ro && ws.items.has(it.id)) {
        if (!ws.get(it.id)?.relations) await ws.withRelations([it.id]).catch(() => undefined);
        if (!alive || !anchor.isConnected) return;
        const pairs = dependencyPairs([ws.get(it.id) ?? it]);
        const waitsFor = pairs.filter(([, s]) => s === it.id).map(([p]) => p);
        const blocks = pairs.filter(([p]) => p === it.id).map(([, s]) => s);
        items.push("-", { label: "Waits for…", icon: "deps", hint: "Pick an item this one waits for", onClick: () => pickPred(it, anchor) });
        for (const p of waitsFor.slice(0, 8)) items.push({ label: `No longer waits for ${rowName(p)}`, icon: "close", onClick: () => void removeDependencyAny(app, p, it.id) });
        for (const s of blocks.slice(0, 8)) items.push({ label: `${rowName(s)} no longer waits for this`, icon: "close", onClick: () => void removeDependencyAny(app, it.id, s) });
      }
      menu(anchor, items);
    }

    /** Pick what an item waits for, then add the dependency (same checks as the Dependencies page). */
    function pickPred(it: WorkItem, anchor: Element): void {
      itemPicker(ws, anchor, (w) => {
        const k = ws.levelOf(w)?.kind;
        return w.id !== it.id && !isClosed(w) && (k === "portfolio" || k === "requirement");
      }, (w) => {
        if (!w) return;
        void addDependencyChecked(app, w.id, it.id).then((ok) => { if (ok && !st.deps) toast("Turn on Dependencies to see the arrows.", { kind: "info" }); });
      }, { placeholder: `#${it.id} waits for: find by title or number` });
    }

    /** The list behind "N conflicts". */
    function openConflicts(): void {
      const list = drawnDeps.filter((d) => d.conflict);
      if (!list.length) return;
      popup(conflicts, h("div.rm-conf", null,
        h("p.small.muted", null, "Each starts before the item it waits for ends. Click one to see both bars."),
        h("ul", null, list.map((d) => h("li", null, h("button.rm-conf-item", { type: "button", onclick: () => { closePopup(); showPair(d); } },
          h("b", null, rowName(d.succ)), h("span.muted", null, " starts before "), h("span", null, rowName(d.pred)), h("span.muted", null, " ends"), d.cross ? h("span.small.muted", null, " (between teams)") : null))))),
      { align: "right", className: "roadmap-conf" });
    }

    /** Scroll to the two bars of a dependency and make them blink. */
    function showPair(d: Dependency): void {
      const ra = rowOf.get(d.pred);
      const rb = rowOf.get(d.succ);
      if (ra == null || rb == null) return;
      const top = Math.min(ra, rb) * ROW_H;
      const span = (Math.max(ra, rb) + 1) * ROW_H - top;
      const room = scroll.clientHeight - (scroll.querySelector<HTMLElement>(".rm-head")?.offsetHeight ?? 0);
      const b = bars.get(d.succ);
      const visible = Math.max(100, scroll.clientWidth - nameW);
      scroll.scrollTo({
        top: Math.max(0, span <= room ? top - (room - span) / 2 : top - 8),
        left: b ? Math.max(0, x(b.start) - visible / 3) : scroll.scrollLeft,
        behavior: "smooth",
      });
      scroll.scrollIntoView({ block: "nearest" });
      for (const el of scroll.querySelectorAll<Element>(`.rm-bar[data-id="${d.pred}"], .rm-bar[data-id="${d.succ}"], .rm-link[data-pred="${d.pred}"][data-succ="${d.succ}"]`)) {
        el.classList.remove("flash");
        void (el as HTMLElement).offsetWidth;
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 2600);
      }
      scroll.querySelector<HTMLElement>(`.rm-bar[data-id="${d.succ}"]`)?.focus({ preventScroll: true });
    }

    // a click on an arrow: open either end, or remove the dependency
    scroll.addEventListener("click", (e) => {
      const hit = (e.target as Element).closest<SVGElement>(".rm-link-hit");
      if (!hit) return;
      const pred = Number(hit.dataset.pred);
      const succ = Number(hit.dataset.succ);
      const ours = ws.items.has(succ) || ws.items.has(pred);
      const open = (id: number): void => { const r = rows[rowOf.get(id) ?? -1]; if (r) openRow(r); };
      menu(hit, [
        { label: `Open ${rowName(succ)} (waits)`, icon: "external", onClick: () => open(succ) },
        { label: `Open ${rowName(pred)} (first)`, icon: "external", onClick: () => open(pred) },
        "-",
        { label: "Remove dependency", icon: "close", danger: true, disabled: ro || !ours, hint: ours ? undefined : "Both items belong to other teams", onClick: () => void removeDependencyAny(app, pred, succ) },
      ]);
    });
    // a right-click on a bar or a name: the row's menu
    scroll.addEventListener("contextmenu", (e) => {
      const t = e.target as Element;
      const el = t.closest<HTMLElement>(".rm-bar") ?? t.closest<HTMLElement>(".rm-row[data-id]");
      const r = el ? rows[rowOf.get(Number(el.dataset.id)) ?? -1] : undefined;
      if (!el || !r?.item || drag) return;
      e.preventDefault();
      void itemMenu(r, el.classList.contains("rm-bar") ? el : el.querySelector(".rm-more") ?? el);
    });

    // ---------- scrolling ----------
    function scrollToDay(d: Day, at: number, smooth = false): void {
      const visible = Math.max(100, scroll.clientWidth - nameW);
      const left = Math.max(0, x(d) - visible * at);
      if (smooth) scroll.scrollTo({ left, behavior: "smooth" });
      else scroll.scrollLeft = left;
    }

    // ---------- dragging bars ----------
    const tip = h("div.roadmap-tip", { hidden: true, role: "status" });
    document.body.append(tip);

    function onPointerDown(e: PointerEvent): void {
      if (e.button !== 0 || drag || ro) return; // read-only: no dragging, a click opens
      const target = e.target as HTMLElement;
      const bar = target.closest<HTMLElement>(".rm-bar");
      if (!bar || bar.dataset.ext) return; // another team's bar: read-only, a click opens
      const id = Number(bar.dataset.id);
      const b = bars.get(id);
      if (!b) return;
      e.preventDefault();
      bar.focus({ preventScroll: true });
      const mode = target.closest(".rm-h.l") ? "start" : target.closest(".rm-h.r") ? "end" : "move";
      // only the dates the type has can be dragged (a click opens the item instead)
      if (!dragsFor(dateFields(ws.get(id)?.type ?? ""))[mode]) return;
      drag = { id, bar, mode, x0: e.clientX, pointerId: e.pointerId, from: b, now: { start: b.start, end: b.end }, moved: false };
      bar.setPointerCapture(e.pointerId);
      bar.addEventListener("pointermove", onPointerMove);
      bar.addEventListener("pointerup", onPointerUp);
      bar.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    }

    function onPointerMove(e: PointerEvent): void {
      if (!drag) return;
      const dx = e.clientX - drag.x0;
      if (!drag.moved && Math.abs(dx) < 4) return;
      if (!drag.moved) { drag.moved = true; drag.bar.classList.add("dragging"); tip.hidden = false; }
      drag.now = dragSpan(drag.from, drag.mode, dragDays(dx, ppd));
      place(drag.bar, drag.now);
      const days = drag.now.end - drag.now.start + 1;
      tip.textContent = drag.mode === "start" ? `Start ${fmtDay(drag.now.start)}` : drag.mode === "end" ? `Target ${fmtDay(drag.now.end)}` : `${fmtSpan(drag.now)}`;
      tip.textContent += ` · ${days} ${days === 1 ? "day" : "days"}`;
      tip.style.left = e.clientX + 14 + "px";
      tip.style.top = e.clientY + 16 + "px";
      drawLinks();
    }

    function place(bar: HTMLElement, s: Span): void {
      bar.style.left = x(s.start) + "px";
      bar.style.width = Math.max(4, (s.end - s.start + 1) * ppd) + "px";
    }

    function endDrag(): Drag | null {
      const d = drag;
      if (!d) return null;
      d.bar.removeEventListener("pointermove", onPointerMove);
      d.bar.removeEventListener("pointerup", onPointerUp);
      d.bar.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      try { d.bar.releasePointerCapture(d.pointerId); } catch { /* already released */ }
      d.bar.classList.remove("dragging");
      tip.hidden = true;
      drag = null;
      return d;
    }

    function onPointerUp(): void {
      const d = endDrag();
      if (!d) return;
      if (!d.moved) { app.openItem(d.id); finishRedraw(); return; }
      const changed = d.now.start !== d.from.start || d.now.end !== d.from.end;
      if (!changed) { finishRedraw(); return; }
      void schedule(d.id, d.now, d.from.kind !== "dates");
    }

    function onCancel(): void {
      const d = endDrag();
      if (!d) return;
      place(d.bar, d.from);
      drawLinks();
      finishRedraw();
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Escape" || !drag) return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }

    function finishRedraw(): void {
      if (redrawAfterDrag) { redrawAfterDrag = false; draw(); }
    }

    /**
     * Save new dates: only the date fields the type has; both are written when one of them was missing.
     * Written as local midnight, the way Azure DevOps's own date picker saves a date.
     */
    async function schedule(id: number, s: Span, writeBoth: boolean): Promise<void> {
      const it = ws.get(id);
      if (!it) return;
      const df = dateFields(it.type);
      if (!df.start && !df.target) { toast(`${it.type} has no start or target date field.`, { kind: "error" }); draw(); return; }
      const changes: { field: string; value: unknown }[] = [];
      if (df.start && (writeBoth || !it.startDate || planDay(it.startDate) !== s.start)) changes.push({ field: START, value: planIso(s.start) });
      if (df.target && (writeBoth || !it.targetDate || planDay(it.targetDate) !== s.end)) changes.push({ field: TARGET, value: planIso(s.end) });
      if (!changes.length) { draw(); return; }
      const res = await app.actions.setFields(id, changes, `#${id} ${it.title.length > 40 ? it.title.slice(0, 38) + "…" : it.title}: ${fmtSpan(s)}`);
      if (!res) draw(); // refused: put the bar back
      redrawAfterDrag = false;
    }

    // ---------- other teams ----------
    /** Read the chosen teams (from the cache when read in the last minutes), then draw. */
    async function loadPlans(force = false): Promise<void> {
      const want = teams.slice();
      const token = ++planToken;
      if (force) { for (const r of want) plans.delete(teamKey(r)); draw(); }
      if (!want.length) return;
      const got = await teamPlans(ws.api, want, { closedDays: ws.opts.closedDays, force });
      if (!alive || token !== planToken) return;
      want.forEach((r, i) => plans.set(teamKey(r), got[i]));
      indexExt();
      fb.refresh();
      draw();
    }

    function indexExt(): void {
      for (const k of [...plans.keys()]) if (!teams.some((t) => teamKey(t) === k)) plans.delete(k);
      ext = new Map();
      for (const r of teams) {
        const p = plans.get(teamKey(r));
        if (!p || p instanceof Error) continue;
        for (const it of p.items) if (!ext.has(it.id)) ext.set(it.id, { item: it, team: teamKey(r), plan: p });
      }
    }

    function setTeams(list: TeamRef[]): void {
      if (list.length > MAX_TEAMS) { toast(`At most ${MAX_TEAMS} other teams.`, { kind: "error" }); list = list.slice(0, MAX_TEAMS); }
      teams = cleanTeams(list, me, MAX_TEAMS);
      prefs.set(teamsPref, teams);
      teamsLabel();
      indexExt();
      fb.refresh();
      draw();
      void loadPlans();
    }

    /** The Teams popup: teams of this project, and of other projects on request. */
    async function openTeams(): Promise<void> {
      let mine: Team[] = [];
      let projects: Project[] = [];
      teamsBtn.disabled = true;
      try {
        [mine, projects] = await Promise.all([ws.api.teams(ws.project), ws.api.projects().catch(() => [] as Project[])]);
      } catch (e) {
        toast("Could not read the teams: " + errorText(e), { kind: "error" });
        return;
      } finally { teamsBtn.disabled = false; }
      if (!alive) return;
      const chosen = (r: TeamRef): boolean => teams.some((t) => teamKey(t) === teamKey(r));
      const pick = (r: TeamRef, label: string): HTMLElement => h("label.rm-team-pick", { title: chosen(r) ? `Take ${r.team} off the roadmap` : `Show ${r.team}'s Epics and Features in their own rows, read-only` },
        h("input", {
          type: "checkbox", checked: chosen(r),
          onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; setTeams(on ? [...teams, r] : teams.filter((t) => teamKey(t) !== teamKey(r))); },
        }), label);
      const fromOthers = h("div.rm-team-list");
      const showOthers = (): void => fromOthers.replaceChildren(...teams.filter((t) => t.project !== ws.project).map((t) => pick(t, `${t.team} · ${t.project}`)));
      showOthers();
      const otherList = h("div.rm-team-list");
      const others = projects.filter((p) => p.name !== ws.project).sort((a, b) => a.name.localeCompare(b.name));
      const projectSel = h("select.input.small", {
        "aria-label": "Another project", title: "Choose another project to pick its teams",
        onchange: async () => {
          const name = projectSel.value;
          otherList.replaceChildren();
          if (!name) return;
          otherList.append(h("span.small.muted", null, "Reading its teams…"));
          try {
            const list = await ws.api.teams(name);
            if (projectSel.value !== name) return;
            otherList.replaceChildren(...(list.length ? list.map((t) => pick({ project: name, team: t.name }, t.name)) : [h("span.small.muted", null, "No teams.")]));
          } catch (e) { otherList.replaceChildren(h("span.small.err", null, errorText(e))); }
        },
      }, h("option", { value: "" }, "Choose a project…"), others.map((p) => h("option", { value: p.name }, p.name)));
      const box = h("div.rm-teams", null,
        h("p.small.muted", null, "Each team gets its own rows, read-only. Arrows show dependencies between teams; red ones start before what they wait for ends."),
        h("h4", null, ws.project),
        h("label.rm-team-pick", { title: "This team is always shown first" }, h("input", { type: "checkbox", checked: true, disabled: true }), `${ws.team} (this team)`),
        mine.filter((t) => t.name !== ws.team).sort((a, b) => a.name.localeCompare(b.name)).map((t) => pick({ project: ws.project, team: t.name }, t.name)),
        others.length ? [h("h4", null, "Other projects"), fromOthers, projectSel, otherList] : null);
      popup(teamsBtn, box, { className: "roadmap-teams", onClose: () => teamsBtn.focus() });
    }

    draw();
    if (teams.length) void loadPlans();

    return {
      // stories closing or moving change the forecast: work it out again (one query)
      update(changed) {
        childCounts.changed(changed);
        if (changed.size && st.forecast) { fcLoaded = false; fcDirty = fcLoading; }
        fb.refresh();
        draw();
        // other teams are read again when their copy is old
        if ([...plans.values()].some((p) => !(p instanceof Error) && Date.now() - p.readAt > PLAN_TTL)) void loadPlans();
      },
      select(id) {
        selected = id;
        for (const e of scroll.querySelectorAll<HTMLElement>(".rm-bar.sel, .rm-row.sel")) e.classList.remove("sel");
        if (id == null) return;
        for (const e of scroll.querySelectorAll<HTMLElement>(`.rm-bar[data-id="${id}"], .rm-row[data-id="${id}"]`)) e.classList.add("sel");
      },
      unmount() {
        alive = false;
        childCounts.stop();
        planToken++;
        endDrag();
        linkToken++;
        tip.remove();
      },
    };
  },
};
