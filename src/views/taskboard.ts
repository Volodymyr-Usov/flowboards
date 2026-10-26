// The sprint taskboard: the stories of one sprint as rows, their tasks in one column per task state.
// Drag a task to another column to change its state, to another row to put it under that story (or,
// in "Other tasks", under none); click a story or task to open it, its picture to change the owner,
// its hours to change them; "+" adds a task, "New" in the head a story in this sprint. The Board
// handles these clicks and the keys (arrows, Enter, Shift+F10 for the menu). A strip on top sums the
// sprint up; the burndown sits under it.
import type { Iteration, WorkItem } from "../api/types.ts";
import type { App } from "../app/context.ts";
import { fmtDate, isDone, isUnder, orderedStates, typeColor } from "../core/model.ts";
import { h, icon } from "../ui/dom.ts";
import { avatar, stateMark } from "../ui/kit.ts";
import { tagChip } from "../ui/tagchip.ts";
import { workingDaysLeft } from "./sprintlogic.ts";
import { dayKey, todayDay } from "../core/timeaxis.ts";

/** sprint dates are days without a time: shown as the day they name in any time zone */
const UTC_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };

/** What the Board's cards show, for a story row of the taskboard (made by the Board, which owns the pull requests and the dates). */
export interface StoryExtras {
  /** colouring by age and what is missing: 0 none, 1 yellow, 2 red */
  tint: 0 | 1 | 2;
  missing: string[];
  /** what the ⚠ says (the rules behind it) */
  missTitle: string;
  /** age: since created | in its column */
  clock: HTMLElement;
  /** tasks and pull requests done, as a bar (null: nothing to count, or counts are off) */
  bar: HTMLElement | null;
  /** the pull request count (a button that lists them) */
  pr: HTMLElement | null;
  /** the urgency bars on the right edge */
  urg: HTMLElement | null;
  /** the points: click to change */
  effort: HTMLElement | null;
  /** the title of the parent Feature, when the Board shows it */
  parent: string;
}

export interface TaskboardInput {
  /** the Board's extras for a story row and for a task card; `trash` is the little bin left of a task */
  story: (w: WorkItem, tasks: WorkItem[]) => StoryExtras;
  task: (t: WorkItem) => { clock: HTMLElement; pr: HTMLElement | null };
  trash: (t: WorkItem) => HTMLElement | null;
  app: App;
  sprint: Iteration | undefined;
  /** a story passes the page's filters */
  storyOk: (w: WorkItem) => boolean;
  /** person chips: on tasks too (a story shows when it or one of its tasks passes) */
  personActive: boolean;
  personOk: (w: WorkItem) => boolean;
  /** search words: matching stories get a yellow frame and go first */
  hit: (w: WorkItem, tasks: WorkItem[]) => boolean;
  /** the search is pinned (Enter): only matching stories, and loose tasks that match, show */
  onlyHits: boolean;
  taskHit: (t: WorkItem) => boolean;
  tags: boolean;
  /** the sprint's burndown, shown between the summary and the grid (Scrum teams) */
  burndown?: HTMLElement;
}

/** The sprints to choose from: dated ones in date order, the current one marked. */
export function sprintChoices(iterations: Iteration[]): Iteration[] {
  return iterations.filter((i) => i.start && i.finish).sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!));
}

export function taskboard(input: TaskboardInput): HTMLElement {
  const { app, sprint } = input;
  const ws = app.ws;
  const req = ws.requirementLevel();
  const taskLevel = ws.taskLevel();
  if (!taskLevel) return h("div.board-empty", null, "This process has no task level, so there is no taskboard.");
  if (!sprint) {
    return h("div.board-empty", null,
      h("p", null, `${ws.team} has no current sprint.`),
      h("p.small.muted", null, "Pick a sprint above, or give the team sprints in Azure DevOps: Project settings > Team configuration > Iterations."),
      h("a.btn.small", { href: `${ws.api.ctx.orgUrl}${encodeURIComponent(ws.project)}/_settings/work-team?_a=iterations`, target: "_blank", rel: "noopener" }, "Open the team's iterations"));
  }
  const states = orderedStates(ws.process, taskLevel.types);
  const isTask = (w: WorkItem): boolean => taskLevel.types.includes(w.type);
  const tasksOf = (id: number): WorkItem[] => ws.children(id).filter(isTask);
  const showTask = (t: WorkItem): boolean => !input.personActive || input.personOk(t);

  // the sprint's stories: passing the filters, and (with person chips) theirs or with one of their tasks
  const rows = ws.ofLevel(req)
    .filter((w) => isUnder(w.iteration, sprint.path) && input.storyOk(w))
    .map((w) => ({ w, tasks: tasksOf(w.id), hit: false }))
    .filter((r) => !input.personActive || input.personOk(r.w) || r.tasks.some((t) => input.personOk(t)));
  for (const r of rows) r.hit = input.hit(r.w, r.tasks);
  if (input.onlyHits) rows.splice(0, rows.length, ...rows.filter((r) => r.hit));
  rows.sort((a, b) => Number(b.hit) - Number(a.hit));
  const inRows = new Set(rows.map((r) => r.w.id));
  // tasks of the sprint whose story is not on the board (no parent, or a parent outside the sprint)
  const loose = [...ws.items.values()].filter((t) => isTask(t) && isUnder(t.iteration, sprint.path) && !inRows.has(t.parent ?? 0) && showTask(t) && (!input.onlyHits || input.taskHit(t)));

  // ---------- the strip on top ----------
  const allTasks = [...rows.flatMap((r) => r.tasks), ...loose];
  const remaining = allTasks.filter((t) => !isDone(t)).reduce((a, t) => a + (t.remaining ?? 0), 0);
  const daysLeft = sprint.start && sprint.finish ? workingDaysLeft(sprint.start, sprint.finish, dayKey(todayDay()), ws.settings.workingDays) : 0;
  const strip = h("div.tb-strip", null,
    h("b", null, sprint.name),
    h("span.muted", null, `${fmtDate(sprint.start, UTC_DATE)} – ${fmtDate(sprint.finish, UTC_DATE)}`),
    h("span", { title: "Working days left in the sprint, today included" }, `${daysLeft} working day${daysLeft === 1 ? "" : "s"} left`),
    h("span", null, `${rows.filter((r) => isDone(r.w)).length}/${rows.length} ${req.name.toLowerCase()} done`),
    h("span", null, `${allTasks.filter(isDone).length}/${allTasks.length} tasks done`),
    h("span", { title: "Remaining hours of the open tasks" }, `${Math.round(remaining * 10) / 10} h remaining`),
    h("a.tb-link", { href: "#sprint", title: "Burndown, capacity per person and the sprint goal" }, icon("sprint", 13), "Burndown and capacity"));

  // ---------- the grid ----------
  const readOnly = app.actions.readOnly;
  const grid = h("div.tb-grid", { style: { "--tb-cols": String(states.length) } },
    h("div.tb-head.tb-first", null, req.name, h("span.spacer"),
      readOnly ? null : h("button.btn.small.tb-new", { type: "button", title: `New ${req.types.join(" or ")} in ${sprint.name}`, dataset: { add: "story", parent: 0, iteration: sprint.path } }, icon("plus", 12), "New item")),
    states.map((s) => h("div.tb-head", null, h("i.dot", { style: { background: s.color } }), s.name)));

  const remainingField = ws.process.fields.remaining;
  /** the hours left: click to change (the Board opens the box) */
  const hours = (t: WorkItem): HTMLElement | null => {
    if (isDone(t)) return null;
    if (readOnly || !remainingField) return t.remaining != null ? h("span.mono.muted", null, `${t.remaining} h`) : null;
    return h(`button.tb-hours.mono${t.remaining == null ? ".empty" : ""}`, { type: "button", tabindex: -1, title: t.remaining != null ? `${t.remaining} h left. Click to change.` : "No remaining hours. Click to set.",
      dataset: { num: t.id, field: remainingField, value: t.remaining ?? "", label: "Remaining hours" } }, t.remaining != null ? `${t.remaining} h` : "– h");
  };
  /** a person's picture: click to pick another owner */
  const owner = (w: WorkItem, size: number): HTMLElement => readOnly ? avatar(ws.api, w.assignedTo, size, { title: w.assignedTo?.displayName ?? "Nobody" })
    : h("button.owner", { type: "button", tabindex: -1, dataset: { owner: w.id }, title: w.assignedTo ? `Owner: ${w.assignedTo.displayName}. Click to change.` : "Nobody owns this. Click to pick someone." }, avatar(ws.api, w.assignedTo, size, { title: "" }));

  const taskCard = (t: WorkItem): HTMLElement => {
    const x = input.task(t);
    return h("div.tb-task", {
    class: [isDone(t) && "done"], draggable: readOnly ? null : "true", tabindex: -1, dataset: { id: t.id, open: t.id, task: t.id, row: t.parent ?? 0 },
    style: { "--col": typeColor(ws.process, t.type) },
    title: `${t.type} #${t.id}: ${t.title}${t.assignedTo ? ` · ${t.assignedTo.displayName}` : ""}${t.remaining != null ? ` · ${t.remaining} h left` : ""}. Drag to another column to change its state, to another row to move it to that story; or Shift+F10 for a menu.`,
  },
  h("div.tb-t-row", null, input.trash(t), h("span.tb-t", null, t.title)),
  h("span.tb-meta", null, x.clock, x.pr, h("span.spacer"), hours(t), owner(t, 18)));
  };

  const cells = (rowId: number, tasks: WorkItem[]): HTMLElement[] => states.map((s) => {
    // a task whose state is not a column (another task type) goes to the first column of its category
    const here = tasks.filter((t) => t.state === s.name || (!states.some((x) => x.name === t.state) && states.find((x) => x.category === t.category)?.name === s.name));
    return h("div.tb-cell", { dataset: { row: rowId, state: s.name } }, here.map(taskCard));
  });

  for (const r of rows) {
    const shown = r.tasks.filter(showTask);
    const done = r.tasks.filter(isDone).length;
    const x = input.story(r.w, r.tasks);
    grid.append(
      h("div.tb-story", { class: [r.hit && "hit", isDone(r.w) && "done", x.tint > 0 && `t${x.tint}`], tabindex: -1, dataset: { id: r.w.id }, style: { "--col": typeColor(ws.process, r.w.type) } },
        h("div.tb-s-top", null,
          h("span.mono.muted", null, `#${r.w.id}`),
          readOnly ? stateMark(ws, r.w) : h("button.tb-state", { type: "button", tabindex: -1, dataset: { stateOf: r.w.id }, title: `${r.w.state}: click to change the state` }, stateMark(ws, r.w)),
          h("span.spacer"),
          x.clock,
          owner(r.w, 20)),
        x.parent ? h("div.tb-s-parent", { title: "The parent" }, x.parent) : null,
        h("button.tb-s-title", { type: "button", tabindex: -1, dataset: { open: r.w.id }, title: "Open the details" }, r.w.title),
        input.tags && r.w.tags.length ? h("div.c-tags", null, r.w.tags.slice(0, 3).map((t) => tagChip(t))) : null,
        h("div.tb-s-bottom", null,
          x.bar ?? h("span.small.muted", null, `${done}/${r.tasks.length} tasks`),
          x.pr,
          x.effort,
          h("span.spacer"),
          x.missing.length ? h("span.warn-mark", { title: x.missTitle }, "⚠") : null,
          readOnly ? null : h("button.icon-btn.small.add", { tabindex: -1, title: `New ${taskLevel.defaultType}`, dataset: { add: "task", parent: r.w.id } }, icon("plus", 12))),
        x.urg),
      ...cells(r.w.id, shown));
  }
  if (loose.length) {
    grid.append(h("div.tb-story.tb-loose", null, h("b", null, "Other tasks"), h("p.small.muted", null, `In ${sprint.name}, not under a ${req.defaultType.toLowerCase()} shown here`)), ...cells(0, loose));
  }
  if (!rows.length && !loose.length) grid.append(h("div.board-empty.tb-none", null, `Nothing in ${sprint.name} passes the filters.`));

  // ---------- drag a task: another column changes its state, another row its story ----------
  if (!readOnly) {
    let dragId = 0;
    grid.addEventListener("dragstart", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(".tb-task");
      if (!t) return;
      dragId = Number(t.dataset.task);
      e.dataTransfer?.setData("text/plain", String(dragId));
      t.classList.add("dragging");
    });
    grid.addEventListener("dragend", (e) => { dragId = 0; (e.target as HTMLElement).closest(".tb-task")?.classList.remove("dragging"); grid.querySelectorAll(".tb-cell.drop").forEach((c) => c.classList.remove("drop")); });
    const cellAt = (e: DragEvent): HTMLElement | null => {
      const c = (e.target as HTMLElement).closest<HTMLElement>(".tb-cell");
      return c && dragId ? c : null;
    };
    grid.addEventListener("dragover", (e) => {
      const c = cellAt(e);
      if (!c) return;
      e.preventDefault();
      grid.querySelectorAll(".tb-cell.drop").forEach((x) => x !== c && x.classList.remove("drop"));
      c.classList.add("drop");
    });
    grid.addEventListener("drop", (e) => {
      const c = cellAt(e);
      if (!c) return;
      e.preventDefault();
      c.classList.remove("drop");
      const t = ws.get(dragId);
      dragId = 0;
      if (!t) return;
      const row = Number(c.dataset.row);
      // "Other tasks" takes the task from its story; a task whose story is elsewhere keeps it there
      const parent = row || (inRows.has(t.parent ?? 0) ? 0 : t.parent ?? 0);
      const state = c.dataset.state!;
      void (async () => {
        if (parent !== (t.parent ?? 0) && !(await app.actions.reparent(t.id, parent))) return;
        if (t.state !== state) await app.actions.move(t.id, { state });
      })();
    });
  }

  return h("div.tb", null, strip, input.burndown ?? "", grid);
}
