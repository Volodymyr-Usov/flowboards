// The pull request times, drawn the same on the Pull requests page and on Flow: a chart of the median wait for
// the first approval and the median time to merge per week of completion, and for Flow a whole card with the
// period's figures. The numbers come from app/prtimes.ts (completed pull requests, approvals kept in the team's storage).
import type { PullRequest } from "../api/types.ts";
import { approvedAt, completedSince, isTeamPr, readApprovals } from "../app/prtimes.ts";
import type { App } from "../app/context.ts";
import { personKey } from "../core/model.ts";
import { prefs } from "../core/settings.ts";
import { h, svg } from "../ui/dom.ts";
import { empty, errorText, help, segmented, spinner } from "../ui/kit.ts";
import { fmtDuration, timeSummary, weeklyTimes } from "./prlogic.ts";

export function timesChart(weeks: ReturnType<typeof weeklyTimes>): SVGElement {
  const W = 720, H = 180, L = 44, R = 16, T = 24, B = 22;
  const vals = weeks.flatMap((w) => [w.approval, w.merge]).filter((v): v is number => v != null);
  const max = Math.max(1 / 24, ...vals) * 1.25;
  const n = weeks.length;
  const x = (i: number): number => L + (n > 1 ? (i * (W - L - R)) / (n - 1) : (W - L - R) / 2);
  const y = (v: number): number => T + (H - T - B) * (1 - v / max);
  const s = svg("svg", { class: "prs-times-chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Median wait for the first approval and time to merge, per week" });
  for (const f of [0, 0.5, 1]) {
    const v = f * max;
    s.append(svg("line", { class: "prs-grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }), svg("text", { class: "prs-axis", x: L - 6, y: y(v) + 4, "text-anchor": "end" }, fmtDuration(v)));
  }
  const line = (key: "approval" | "merge", cls: string, label: string): void => {
    const pts = weeks.map((w, i) => (w[key] == null ? null : { x: x(i), y: y(w[key]!), w }));
    let d = "";
    pts.forEach((p, i) => { if (p) d += `${d && pts[i - 1] ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`; });
    if (d) s.append(svg("path", { class: `prs-line ${cls}`, d }));
    for (const p of pts) {
      if (!p) continue;
      const wk = new Date(p.w.start).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
      const count = key === "approval" ? `${p.w.approvedCount} approved` : `${p.w.merged} merged`;
      s.append(svg("g", null, svg("title", null, `Week of ${wk}: ${label} ${fmtDuration(p.w[key]!)} median (${count})`),
        svg("circle", { class: `prs-dot ${cls}`, cx: p.x, cy: p.y, r: 4 }),
        svg("text", { class: `prs-val ${cls}`, x: p.x, y: p.y - 8, "text-anchor": "middle" }, fmtDuration(p.w[key]!))));
    }
  };
  line("merge", "mg", "time to merge");
  line("approval", "ap", "wait for the first approval");
  weeks.forEach((w, i) => s.append(svg("text", { class: "prs-axis", x: x(i), y: H - 5, "text-anchor": "middle" }, new Date(w.start).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }))));
  return s;
}


/**
 * The card on Flow: the pull requests of the project completed in the last `weeks()` weeks, by the team's
 * members (or everyone's, a choice that is kept), with the period's medians and the weekly chart.
 */
export function prTimesCard(app: App, weeks: () => number): { el: HTMLElement; load(): void; stop(): void } {
  const el = h("section.card-box.flow-card.flow-prs", { "aria-label": "Pull request times" });
  let who: "team" | "all" = prefs.get<string>("flow:prwho", "team") === "all" ? "all" : "team";
  let stopped = false;
  let token = 0;
  let prs: PullRequest[] | null = null;
  let error: unknown = null;
  let reading = false;
  let left = 0;
  const keys = new Set(app.ws.teamMembers().map((p) => personKey(p)));
  const teamKnown = app.ws.teamMembers().length > 0;

  function draw(): void {
    const w = weeks();
    const seg = teamKnown ? segmented<"team" | "all">([
      { value: "team", label: "My team", title: `Pull requests that a member of ${app.ws.team} wrote or was asked to review (who the members are: Settings > Team)` },
      { value: "all", label: "Everyone", title: `Every pull request of ${app.ws.project}` },
    ], who, (v) => { who = v; prefs.set("flow:prwho", v); draw(); }) : null;
    const head = h("div.flow-card-head", null, h("h2", null, "Pull requests: waiting and merging"),
      help(`From the pull requests of ${app.ws.project} that were completed in the last ${w} weeks. Wait for the first approval: from the day the pull request was opened to its first approving vote (pull requests that were never approved are left out of that one). Time to merge: from opened to completed, including any time it spent as a draft. The weekly line is the median (the middle value) of the pull requests completed that week; the figures above are for the whole period, with the 85th percentile next to the median. The first approvals are read once and kept in the team's storage, so later visits are quick.`),
      h("span.spacer"), seg);
    if (error) { el.replaceChildren(head, h("p.small.muted", null, `Could not read the pull requests: ${errorText(error)}`)); return; }
    if (!prs) { el.replaceChildren(head, spinner("Reading the completed pull requests…")); return; }
    const mine = prs.filter((p) => who === "all" || isTeamPr(app, p, keys));
    const rows = mine.map((p) => { const a = approvedAt(app, p); return { created: p.created, closed: p.closed!, approved: a ? new Date(a).toISOString() : null, known: a !== undefined }; });
    const sum = timeSummary(rows);
    const scope = h("p.small.muted.flow-scope", null,
      who === "team" && teamKnown ? `Pull requests of ${app.ws.project} that a member of ${app.ws.team} wrote or was asked to review (${mine.length} of ${prs.length}), ` : `Every pull request of ${app.ws.project} (${prs.length}), `,
      `completed in the last ${w} weeks.`, w > 51 ? " The chart shows the last 52 weeks; the figures above cover the whole period." : "", prs.length >= 1000 ? " Azure DevOps gave the newest 1000; older ones are not in these figures." : "");
    if (!mine.length) { el.replaceChildren(head, scope, empty("No pull request completed", `None in these ${w} weeks${who === "team" && teamKnown ? ` for ${app.ws.team}'s members. Choose “Everyone” to see the others` : ""}.`)); return; }
    const fig = (value: number | null): string => (value == null ? "–" : fmtDuration(value));
    const tile = (n: string, label: string, tip: string): HTMLElement => h("div.flow-tile.prs-tile", { title: tip }, h("div.n", null, n), h("div.l", null, label));
    const tiles = h("div.flow-tiles", null,
      tile(String(sum.merged), "Completed", `${sum.merged} pull requests were completed in these ${w} weeks`),
      tile(fig(sum.approvalMedian), "Wait for approval, median", `Half of the ${sum.approved} approved pull requests got their first approval within ${fig(sum.approvalMedian)} of being opened`),
      tile(fig(sum.approvalP85), "Wait for approval, 85%", `85% got their first approval within ${fig(sum.approvalP85)}`),
      tile(fig(sum.mergeMedian), "Time to merge, median", `Half of the ${sum.merged} pull requests were completed within ${fig(sum.mergeMedian)} of being opened`),
      tile(fig(sum.mergeP85), "Time to merge, 85%", `85% were completed within ${fig(sum.mergeP85)} of being opened`));
    const weekCount = Math.max(1, Math.min(52, w + 1));
    const key = h("div.prs-times-head", null,
      h("span.prs-key.ap", null, h("i"), "Wait for first approval (median per week)"),
      h("span.prs-key.mg", null, h("i"), "Time to merge (median per week)"));
    const note = reading ? h("p.small.muted", null, `Reading first approvals… ${left} to go (kept in the team's storage for the next visit).`)
      : left ? h("p.small.muted", null, `${left} older pull requests have no approval time yet; the next visit reads more.`) : "";
    el.replaceChildren(head, scope, tiles, key, timesChart(weeklyTimes(rows, weekCount)), note);
  }

  async function load(): Promise<void> {
    const my = ++token;
    error = null;
    prs = null;
    draw();
    try {
      const list = await completedSince(app, weeks());
      if (stopped || my !== token) return;
      prs = list;
      draw();
      // the first approvals: from the team's storage, the rest read (and kept)
      const wanted = list.filter((p) => who === "all" || isTeamPr(app, p, keys));
      reading = true;
      left = wanted.length;
      const res = await readApprovals(app, wanted, () => stopped || my !== token, () => { left = Math.max(0, left - 1); if (!stopped && my === token) draw(); });
      reading = false;
      left = res.left;
    } catch (e) {
      if (stopped || my !== token) return;
      error = e;
    }
    reading = false;
    if (!stopped && my === token) draw();
  }
  return { el, load: () => void load(), stop: () => { stopped = true; } };
}
