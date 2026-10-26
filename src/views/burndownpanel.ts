// The sprint burndown as a block: remaining hours of the sprint's tasks at the end of each working
// day, as Azure DevOps had them then, with the ideal line. Shown on the Sprint page and on the Board's
// taskboard; the numbers come from views/burndown.ts. One panel reads one sprint at a time and keeps
// what it read until Refresh.
import type { Iteration } from "../api/types.ts";
import type { App } from "../app/context.ts";
import { fmtDate } from "../core/model.ts";
import { prefs } from "../core/settings.ts";
import { h, icon, svg } from "../ui/dom.ts";
import { errorText, help, spinner } from "../ui/kit.ts";
import { loadBurndown, MAX_TASKS } from "./sprintdata.ts";
import type { BurndownPoint } from "./burndown.ts";
import { dayKey, planDay, todayDay } from "../core/timeaxis.ts";

const fmtNum = (n: number): string => (Math.round(n * 10) / 10).toLocaleString();
const UTC_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
const today = (): string => dayKey(todayDay());

export interface BurndownPanel {
  el: HTMLElement;
  /** Show this sprint's burndown (read once; the same sprint again keeps what is shown). */
  show(sprint: Iteration): void;
  /** Stop: a read still running is thrown away. */
  stop(): void;
}

/** foldKey: the heading folds the chart away, remembered under this key (and nothing is read while folded). */
export function burndownPanel(app: App, opts: { heading?: "h2" | "h3"; foldKey?: string } = {}): BurndownPanel {
  const ws = app.ws;
  const el = h("section.sp-burn.card-box", { "aria-label": "Burndown" });
  let shownFor = "";
  let alive = true;
  /** the sprint asked for last, and the body drawn for shownFor */
  let want: Iteration | null = null;
  let body: HTMLElement | null = null;
  let folded = opts.foldKey ? prefs.get<boolean>(opts.foldKey, false) : false;

  function head(it: Iteration): HTMLElement {
    const name = opts.foldKey
      ? h("button.sp-fold", { type: "button", "aria-expanded": String(!folded), title: folded ? "Show the burndown" : "Fold the burndown away (remembered in this browser)", onclick: () => setFolded(!folded) },
        icon(folded ? "chevron" : "down", 14), "Burndown")
      : "Burndown";
    return h("div.sp-sec-head", null, h(opts.heading ?? "h2", null, name),
      help("Remaining hours of the sprint's tasks at the end of each working day, as Azure DevOps had them at that moment. The dashed line is the ideal: from the first day's total down to zero on the last day."),
      h("span.spacer"),
      folded ? null : h("button.btn.small", { title: "Read the sprint's tasks again", onclick: () => void load(it) }, icon("refresh", 14), "Refresh"));
  }

  function setFolded(v: boolean): void {
    folded = v;
    if (opts.foldKey) prefs.set(opts.foldKey, v);
    el.classList.toggle("folded", v);
    if (!want) return;
    if (!v && want.id !== shownFor) { void load(want); return; }
    el.replaceChildren(head(want), ...(body && !v ? [body] : []));
    el.querySelector<HTMLElement>(".sp-fold")?.focus();
  }

  async function load(it: Iteration): Promise<void> {
    shownFor = it.id;
    const mine = (): boolean => alive && shownFor === it.id;
    const task = ws.taskLevel();
    const remainingField = ws.process.fields.remaining;
    const title = head(it);
    const b = h("div.sp-burn-body");
    body = b;
    el.replaceChildren(title, b);
    await fill(it, b, mine, task, remainingField);
  }

  async function fill(it: Iteration, body: HTMLElement, mine: () => boolean, task: ReturnType<typeof ws.taskLevel>, remainingField: string): Promise<void> {
    if (!task) { body.append(h("p.muted", null, "This process has no task level, so there is no remaining work to burn down.")); return; }
    if (!it.start || !it.finish) { body.append(h("p.muted", null, "This sprint has no dates.")); return; }
    if ((planDay(it.start) ?? 0) > todayDay()) { body.append(h("p.muted", null, `The burndown starts with the sprint on ${fmtDate(it.start, UTC_DATE)}.`)); return; }
    const progress = spinner("Reading the sprint's tasks…");
    body.append(progress);
    try {
      const r = await loadBurndown(app.api, ws, it, { alive: mine, onProgress: (t) => progress.replaceChildren(spinner(t)) });
      if (!r || !mine()) return;
      if (r.kind === "tooMany") { body.replaceChildren(h("p.muted", null, `Too many tasks for a burndown (${r.tasks.toLocaleString()}; at most ${MAX_TASKS.toLocaleString()}).`)); return; }
      if (r.kind === "noTasks") { body.replaceChildren(h("p.muted", null, "No tasks in this sprint.")); return; }
      body.replaceChildren(r.points.length ? chart(r.points) : h("p.muted", null, "No working days in this sprint."));
    } catch (e) {
      if (mine()) body.replaceChildren(h("p.err", null, "Could not read the sprint's tasks: " + errorText(e)));
    }
  }

  return {
    el,
    show(sprint) {
      want = sprint;
      el.classList.toggle("folded", folded);
      // folded: only the heading, and nothing read until it opens
      if (folded) { if (!el.firstChild || sprint.id !== shownFor) { shownFor = ""; body = null; el.replaceChildren(head(sprint)); } return; }
      if (sprint.id !== shownFor) void load(sprint);
    },
    stop() { alive = false; },
  };
}

function chart(points: BurndownPoint[]): HTMLElement {
  const W = 720, H = 230, L = 44, R = 12, T = 22, B = 28;
  const max = Math.max(1, ...points.map((p) => Math.max(p.ideal, p.actual ?? 0)));
  const niceMax = (() => { const m = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / m) * m; })();
  const n = points.length;
  const x = (i: number): number => L + (n > 1 ? (i * (W - L - R)) / (n - 1) : (W - L - R) / 2);
  const y = (v: number): number => T + (H - T - B) * (1 - v / niceMax);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => f * niceMax);
  const path = (vals: (number | null)[]): string => vals.map((v, i) => (v == null ? "" : `${i && vals[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)).join("");
  const lastIdx = points.reduce((k, p, i) => (p.actual != null ? i : k), -1);
  const ti = points.findIndex((p) => p.date === today());
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const s = svg("svg", { class: "sp-chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Burndown: ${lastIdx >= 0 ? fmtNum(points[lastIdx].actual!) : 0} hours left of ${fmtNum(points[0]?.ideal ?? 0)}` },
    grid.map((v) => svg("g", null,
      svg("line", { class: "sp-grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }),
      svg("text", { class: "sp-axis", x: L - 6, y: y(v) + 4, "text-anchor": "end" }, fmtNum(v)))),
    points.map((p, i) => (i % labelEvery === 0 || i === n - 1) ? svg("text", { class: "sp-axis", x: x(i), y: H - 8, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }, fmtDate(p.date, { day: "numeric", month: "short", timeZone: "UTC" })) : null),
    ti >= 0 ? svg("line", { class: "sp-today", x1: x(ti), x2: x(ti), y1: T, y2: H - B }) : null,
    svg("path", { class: "sp-ideal", d: path(points.map((p) => p.ideal)) }),
    svg("path", { class: "sp-actual", d: path(points.map((p) => p.actual)) }),
    points.map((p, i) => p.actual != null ? svg("circle", { class: "sp-dot", cx: x(i), cy: y(p.actual), r: i === lastIdx ? 4 : 2.5 }) : null),
    lastIdx >= 0 ? svg("text", { class: "sp-lbl", x: Math.min(x(lastIdx) + 8, W - R - 40), y: y(points[lastIdx].actual!) - 8 }, `${fmtNum(points[lastIdx].actual!)} h`) : null,
    points.map((p, i) => svg("rect", { class: "sp-hit", x: x(i) - (W - L - R) / Math.max(1, n - 1) / 2, y: T, width: (W - L - R) / Math.max(1, n - 1), height: H - T - B },
      svg("title", null, `${fmtDate(p.date, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}\nLeft: ${p.actual == null ? "not yet" : fmtNum(p.actual) + " h"}\nIdeal: ${fmtNum(p.ideal)} h`))));
  const legend = h("div.sp-legend.small", null,
    h("span", null, h("i.sp-key.actual"), "Remaining"), h("span", null, h("i.sp-key.ideal"), "Ideal"), ti >= 0 ? h("span", null, h("i.sp-key.today"), "Today") : null);
  const table = h("details.sp-table.small", null, h("summary", { title: "Show the numbers as a table" }, "Numbers"),
    h("table.data", null, h("thead", null, h("tr", null, h("th", null, "Day"), h("th.num", null, "Remaining h"), h("th.num", null, "Ideal h"))),
      h("tbody", null, points.map((p) => h("tr", null, h("td", null, fmtDate(p.date, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })), h("td.num", null, p.actual == null ? "" : fmtNum(p.actual)), h("td.num", null, fmtNum(p.ideal)))))));
  return h("div", null, legend, s, table);
}
