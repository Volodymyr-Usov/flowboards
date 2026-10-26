// A one-page sprint report: the goal, what was finished, what is still open, and the numbers.
// Print it or save it as PDF, download it as Excel, or copy it. The goal is kept in the extension's
// shared storage per sprint, so the whole team sees the same one.
import type { Iteration, WorkItem } from "../api/types.ts";
import type { App } from "../app/context.ts";
import { fmtDate, isDone, isRemoved, leaf, statesOf } from "../core/model.ts";
import { cycleDays, percentile } from "../core/metrics.ts";
import { collectionName, TeamStore } from "../core/teamstore.ts";
import { h } from "../ui/dom.ts";
import { sortable } from "../ui/sortable.ts";
import { dialog, errorText, spinner, stateMark, toast } from "../ui/kit.ts";
import { sheetButtons } from "../ui/tableexport.ts";
import { sprintQuery } from "./sprintdata.ts";
import type { Cell } from "../ui/xlsx.ts";

export interface Goal { id: string; text: string; by: string; at: string }

/** Where sprint goals are kept: the team's shared storage, one document per sprint. */
export function goalStore(app: App): TeamStore<Goal> {
  return new TeamStore<Goal>(app.api, collectionName("sprintgoals", app.ws.project, app.ws.team));
}
export const goalId = (sprintId: string): string => `goal-${sprintId}`;

const UTC: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
const round1 = (n: number): number => Math.round(n * 10) / 10;

export async function openSprintReport(app: App, sprint: Iteration): Promise<void> {
  const ws = app.ws;
  const req = ws.requirementLevel();
  const goals = goalStore(app);
  const body = h("div.report", null, spinner("Reading the sprint…"));
  // filled once the sprint is read; built on each click so a goal typed just now is included
  let sheets: () => { name: string; rows: Cell[][] }[] = () => [];
  // the goal box saves itself (on leaving it, and on closing), so closing never asks to discard it
  let saveGoal: () => Promise<void> = async () => undefined;

  const show = dialog(`Sprint report: ${sprint.name}`, body, [
    { label: "Close", value: "" },
    { label: "Print or save as PDF", primary: true, onClick: () => { document.body.classList.add("print-report"); setTimeout(() => { window.print(); document.body.classList.remove("print-report"); }, 50); return false; } },
  ], { wide: true, dirty: () => false });

  try {
    const removed = statesOf(ws.process, req.types, ["Removed"]);
    // only the team's own areas: other teams may share the sprint
    const ids = await app.api.query(ws.project, { ...sprintQuery(ws, req.types, sprint.path), notStates: removed.length ? removed : undefined });
    const items = (await app.api.items(ws.project, ids)).filter((w) => !isRemoved(w)).sort((a, b) => Number(isDone(b)) - Number(isDone(a)) || (a.order ?? 0) - (b.order ?? 0));
    const done = items.filter(isDone);
    const open = items.filter((w) => !isDone(w));
    const effort = (l: WorkItem[]): number => l.reduce((s, w) => s + (w.effort ?? 0), 0);
    const cycles = done.map((w) => cycleDays({ ...w, closed: w.closed ?? w.resolved })).filter((d): d is number => d != null).sort((a, b) => a - b);
    let goal = await goals.get(goalId(sprint.id)).catch(() => null);
    const pct = items.length ? Math.round((done.length / items.length) * 100) : 0;
    const effortPct = effort(items) ? Math.round((effort(done) / effort(items)) * 100) : null;
    const byType = new Map<string, number>();
    for (const w of done) byType.set(w.type, (byType.get(w.type) ?? 0) + 1);
    const dates = sprint.start && sprint.finish ? `${fmtDate(sprint.start, UTC)} – ${fmtDate(sprint.finish, UTC)}` : "";
    const ended = sprint.finish ? Date.parse(sprint.finish) < Date.now() : false;

    const numbers: [string, string][] = [
      [`${req.name} finished`, `${done.length} of ${items.length} (${pct}%)`],
      ["Estimate finished", effortPct == null ? "–" : `${round1(effort(done))} of ${round1(effort(items))} (${effortPct}%)`],
      ["Still open", `${open.length}${open.length && ended ? " — move them to the next sprint" : ""}`],
      ["Cycle time, typical (median)", cycles.length ? `${round1(percentile(cycles, 50))} days, over ${cycles.length} finished` : "–"],
      ...(cycles.length >= 5 ? [["Cycle time, 85 of 100 within", `${round1(percentile(cycles, 85))} days`] as [string, string]] : []),
      ...[...byType].map(([t, n]) => [`${t} finished`, String(n)] as [string, string]),
    ];

    const goalBox = h("textarea.input.report-goal", { rows: 2, placeholder: "The sprint goal, in one or two sentences", value: goal?.text ?? "", disabled: app.actions.readOnly, "aria-label": "Sprint goal" }) as HTMLTextAreaElement;
    const goalNote = h("span.small.muted", null, goal ? `Set by ${goal.by}` : app.actions.readOnly ? "No goal written." : "Saved for the whole team when you leave the box");
    const goalPrint = h("p.report-goal-print", null, goal?.text || "No goal written.");
    goalBox.addEventListener("input", () => { goalPrint.textContent = goalBox.value.trim() || "No goal written."; });
    saveGoal = async () => {
      if (app.actions.readOnly || goalBox.value.trim() === (goal?.text ?? "")) return;
      try {
        goal = await goals.put({ id: goalId(sprint.id), text: goalBox.value.trim(), by: app.api.ctx.me.displayName, at: new Date().toISOString() });
        goalPrint.textContent = goal.text || "No goal written.";
        goalNote.textContent = `Saved, set by ${app.api.ctx.me.displayName}`;
      } catch (e) { toast(errorText(e), { kind: "error" }); }
    };
    goalBox.addEventListener("change", () => void saveGoal());

    const list = (l: WorkItem[]) => sortable(h("table.data.report-table", null,
      h("thead", null, h("tr", null, h("th", null, "Id"), h("th", null, "Title"), h("th", null, "State"), h("th", null, "Owner"), h("th.num", null, "Estimate"))),
      h("tbody", null, l.map((w) => h("tr", null,
        h("td.mono", null, String(w.id)), h("td", null, w.title), h("td", null, stateMark(ws, w)), h("td", null, w.assignedTo?.displayName ?? ""), h("td.num", null, w.effort != null ? String(w.effort) : ""))))));

    body.replaceChildren(
      h("div.report-print", null,
        h("header.report-head", null,
          h("div.report-title", null, h("h1", null, `${sprint.name} — ${ws.team}`), sheetButtons(`${ws.team} ${sprint.name} report`, () => sheets(), "the whole report")),
          h("p.muted", null, `${dates}${dates ? " · " : ""}${ws.project} · report of ${fmtDate(new Date().toISOString())}`)),
        h("section", null, h("h3", null, "Goal"), goalBox, goalNote, goalPrint),
        h("section.report-numbers", null, numbers.map(([l, v]) => h("div.report-num", null, h("span.l", null, l), h("b", null, v)))),
        h("section", null, h("h3", null, `Finished (${done.length})`), done.length ? list(done) : h("p.muted", null, "Nothing finished.")),
        h("section", null, h("h3", null, `Still open (${open.length})`), open.length ? list(open) : h("p.muted", null, "Everything planned is finished.")),
        h("p.small.muted.report-foot", null, `Counts the work that is in ${leaf(sprint.path)} now; items moved out of the sprint are not counted. Cycle time: from work started to finished.`)));

    sheets = () => [
      { name: "Summary", rows: [["Sprint report", `${sprint.name} — ${ws.team}`], ["Dates", dates], ["Goal", goalBox.value.trim()], ...numbers] },
      { name: "Finished", rows: [["Id", "Type", "Title", "State", "Owner", "Estimate", "Closed"], ...done.map((w) => [w.id, w.type, w.title, w.state, w.assignedTo?.displayName ?? "", w.effort ?? "", (w.closed ?? w.resolved ?? "").slice(0, 10)])] },
      { name: "Still open", rows: [["Id", "Type", "Title", "State", "Owner", "Estimate"], ...open.map((w) => [w.id, w.type, w.title, w.state, w.assignedTo?.displayName ?? "", w.effort ?? ""])] },
    ];
  } catch (e) {
    body.replaceChildren(h("p", null, `Could not read the sprint: ${errorText(e)}`));
  }
  await show;
  await saveGoal();
}
