// Sprint: Plan a sprint: backlog on the left, the sprint on the right, capacity per person.
// Header numbers (dates, days left, planned effort, velocity of the last three sprints), hours per
// person against capacity, drag work between backlog and sprint, and a burndown from task history.
// The sprint goal shows at the top; at the end of a sprint one button moves unfinished work to the next one.
import type { Capacity, CapacityMember, Iteration, Person, WorkItem } from "../api/types.ts";
import type { View } from "../app/context.ts";
import { textMatch } from "../core/filters.ts";
import { prefs } from "../core/settings.ts";
import { DAY, fmtDate, isClosed, isDone, isOpen, isUnder, parentLevel, personKey, statesOf, workingDays } from "../core/model.ts";
import type { Writer, WriteResult } from "../core/writes.ts";
import { h, icon, rafThrottle, svg } from "../ui/dom.ts";
import { filterBar, peopleStrip, processFieldNames } from "../ui/filterbar.ts";
import { pageBar } from "../ui/pagebar.ts";
import { sortable } from "../ui/sortable.ts";
import { avatar, dialog, empty, errorText, help, spinner, stateMark, toast, toggle, typeMark } from "../ui/kit.ts";
import { burndownPanel } from "./burndownpanel.ts";
import { dayOffDialog } from "./calendar.ts";
import { dayKey, planDay, todayDay } from "./timeaxis.ts";
import { goalId, goalStore, openSprintReport } from "./sprintreport.ts";
import type { Goal } from "./sprintreport.ts";
import { canSplit, cleanupSteps, dropNeighbors, escapeHtml, nextSprint, sprintOver, tasksInSprint, workingDaysLeft } from "./sprintlogic.ts";
import { sprintVelocity } from "./sprintdata.ts";
import type { CleanupChoice, CleanupMode } from "./sprintlogic.ts";

type Col = "backlog" | "sprint";

const fmtNum = (n: number): string => (Math.round(n * 10) / 10).toLocaleString();
const esc = escapeHtml;
const UTC_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
// the local day, like the time axis of the other views
const today = (): string => dayKey(todayDay());


export const sprintView: View = {
  id: "sprint",
  title: "Sprint",
  icon: "sprint",
  group: "plan",
  about: "Plan the sprint: drag work from the backlog into the sprint, and check hours per person against capacity.",
  mount(el, app, params) {
    const ws = app.ws;
    if (!ws.iterations.length) {
      el.append(empty("No sprints", "This team has no sprints yet. Add them in Azure DevOps: Project settings, Team configuration, Iterations."));
      return {};
    }
    const prefKey = `sprint:${ws.project}/${ws.team}`;
    const iters = (): Iteration[] => [...ws.iterations].sort((a, b) => (Date.parse(a.start ?? "") || 0) - (Date.parse(b.start ?? "") || 0));
    const isPast = (i: Iteration): boolean => i.timeFrame === "past" || (!i.timeFrame && !!i.finish && Date.parse(i.finish) + DAY < Date.now());
    const pickInitial = (): Iteration => {
      const list = iters();
      const byId = (id: string | undefined): Iteration | undefined => (id ? list.find((i) => i.id === id || i.path === id) : undefined);
      const saved = byId(prefs.get<string>(prefKey, ""));
      return byId(params.it) ?? (saved && !isPast(saved) ? saved : undefined) ?? ws.currentIteration() ?? list.find((i) => !isPast(i)) ?? list[list.length - 1];
    };

    // ---------- state ----------
    let sprint = pickInitial();
    let alive = true;
    const selected = new Set<number>();
    let anchor: { id: number; col: Col } | null = null;
    let openId: number | null = app.openId();
    const collapsed = new Set<string>(prefs.get<string[]>(prefKey + ":collapsed", []));
    const expanded = new Set<number>();
    let moveTasks = prefs.get<boolean>("sprint:moveTasks", true);
    let moving = "";
    const capCache = new Map<string, Capacity | Error>();
    const capLoading = new Set<string>();
    /** sprints whose capacity changed while it was being read: read again when that read is done */
    const capAgain = new Set<string>();
    const velCache = new Map<string, number | Error>(); // sprint path -> closed effort, or why it could not be read
    const velLoading = new Set<string>();
    const goals = goalStore(app);
    const goalCache = new Map<string, Goal | null | Error>(); // sprint id -> its goal, none, or why it could not be read
    const goalLoading = new Set<string>();
    let source = ""; // what the left list shows: "" = the backlog, else the id of another sprint
    let capOpen = prefs.get<boolean>("sprint:capOpen", true);

    // ---------- what is where ----------
    const req = ws.requirementLevel();
    const task = ws.taskLevel();
    const featLevel = parentLevel(ws.process, req);
    const backlogPath = (): string => ws.settings.backlogIteration ?? ws.project;
    const isTask = (w: WorkItem): boolean => !!task && task.types.includes(w.type);
    const inSprint = (w: WorkItem): boolean => isUnder(w.iteration, sprint.path);
    const plannedIters = (): Iteration[] => ws.iterations.filter((i) => !isPast(i));
    const inBacklog = (w: WorkItem): boolean => isOpen(w) && !plannedIters().some((i) => isUnder(w.iteration, i.path));
    const sprintReqs = (): WorkItem[] => ws.ofLevel(req).filter(inSprint);
    const sprintTasks = (): WorkItem[] => (task ? ws.ofLevel(task).filter(inSprint) : []);
    const backlogReqs = (): WorkItem[] => ws.ofLevel(req).filter(inBacklog);
    // the left list: the backlog, or another coming sprint to pull planned work from
    const sourceIt = (): Iteration | undefined => (source && source !== sprint.id ? ws.iterations.find((i) => i.id === source) : undefined);
    const leftPath = (): string => sourceIt()?.path ?? backlogPath();
    const leftName = (): string => sourceIt()?.name ?? "the backlog";
    const leftReqs = (): WorkItem[] => { const s = sourceIt(); return s ? ws.ofLevel(req).filter((w) => isOpen(w) && isUnder(w.iteration, s.path)) : backlogReqs(); };
    const openTasksOf = (id: number): WorkItem[] => ws.children(id).filter((c) => isTask(c) && isOpen(c));
    const effortOf = (ids: Iterable<number>): number => { let s = 0; for (const id of ids) s += ws.get(id)?.effort ?? 0; return s; };
    const sumEffort = (list: WorkItem[]): number => list.reduce((s, w) => s + (w.effort ?? 0), 0);
    const teamDaysOff = (): { start: string; end: string }[] => { const c = capCache.get(sprint.id); return c && !(c instanceof Error) ? c.teamDaysOff : []; };

    /** Working days of the sprint: all of them, and those from today on. */
    const days = (): { total: number; left: number } => {
      if (!sprint.start || !sprint.finish) return { total: 0, left: 0 };
      const total = workingDays(sprint.start, sprint.finish, ws.settings.workingDays, teamDaysOff());
      return { total, left: workingDaysLeft(sprint.start, sprint.finish, today(), ws.settings.workingDays, teamDaysOff()) };
    };

    // ---------- the page frame (built once) ----------
    const picker = h("select.input.sp-pick", { title: "Choose the sprint to plan", "aria-label": "Sprint", onchange: () => choose(picker.value) });
    const prevBtn = h("button.icon-btn", { title: "Previous sprint", "aria-label": "Previous sprint", onclick: () => step(-1) }, svg("svg", { class: "icon", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg("path", { d: "M15 6l-6 6 6 6" })));
    const nextBtn = h("button.icon-btn", { title: "Next sprint", "aria-label": "Next sprint", onclick: () => step(1) }, icon("chevron"));
    const nowBtn = h("button.btn.small", { title: "Go to the current sprint", onclick: () => { const c = ws.currentIteration(); if (c) choose(c.id); } }, "Current");
    const movingNote = h("span.small.muted.sp-moving", { role: "status" });
    const cleanupBtn = h("button.btn.small.sp-cleanup", { hidden: true, onclick: () => void openCleanup() });
    const goalBox = h("section.sp-goal.card-box", { "aria-label": "Sprint goal" });
    const tasksToggle = toggle("Move open tasks too", moveTasks, (v) => { moveTasks = v; prefs.set("sprint:moveTasks", v); }, "When a story moves, move its open tasks with it");
    const reportBtn = h("button.btn.small", {
      title: "A one-page report of this sprint: goal, finished, still open, numbers; print, PDF or Excel",
      // the report can change the goal: read it again afterwards
      onclick: async () => { const it = sprint; if (goalEd) await saveGoal(goalEd); await openSprintReport(app, it); goalCache.delete(it.id); void loadGoal(it); },
    }, "Sprint report");
    const stats = h("div.sp-stats.card-box");
    const capBox = h("section.sp-cap.card-box", { "aria-label": "Capacity" });
    // hours per person against capacity, next to the lists (changes while dragging)
    const loadStrip = h("div.sp-load", { "aria-label": "Load per person" });
    const colBacklog = h("section.sp-col.card-box", { dataset: { col: "backlog" }, "aria-label": "Backlog" });
    const colSprint = h("section.sp-col.card-box", { dataset: { col: "sprint" }, "aria-label": "In this sprint" });
    const burn = burndownPanel(app);
    // search and filters for both lists (the numbers above always count the whole sprint)
    // line 2: search, filters, the sprint and its buttons; line 3: person chips and switches
    const bar = pageBar(app, { search: { placeholder: "Search title, tag, owner, id…", title: "Show only the items that contain every word, in both lists", label: "Search the backlog and the sprint", onChange: () => redraw() } });
    const search = bar.search;
    const fb = filterBar({ key: "sprint.filters", items: () => [...leftReqs(), ...sprintReqs()], names: () => processFieldNames(ws.process), onChange: () => redraw() });
    const people = peopleStrip({ api: app.api, key: "sprint.people", items: () => [...leftReqs(), ...sprintReqs()].filter((w) => fb.test(w)), onChange: () => redraw() });
    const shows = (w: WorkItem): boolean => fb.test(w) && people.test(w) && textMatch(search.words(), w);
    const filtering = (): boolean => fb.active() || people.active() || search.words().length > 0;
    bar.line2.append(fb.el, h("span.sp-nav", null, prevBtn, picker, nextBtn), nowBtn, reportBtn, cleanupBtn);
    bar.end.append(movingNote);
    bar.line3.append(people.el, app.actions.readOnly ? "" : tasksToggle);
    // the lists first, right under the goal; numbers, capacity and the burndown below them
    el.append(bar.el, goalBox, loadStrip, h("div.sp-cols", null, colBacklog, colSprint), stats, capBox, burn.el);

    function fillPicker(): void {
      const cur = ws.currentIteration();
      picker.replaceChildren(...iters().map((i) => h("option", { value: i.id, selected: i.id === sprint.id },
        `${i.name}${i.id === cur?.id ? " (current)" : ""}${i.start ? ` · ${fmtDate(i.start, { day: "numeric", month: "short", timeZone: "UTC" })}` : ""}`)));
      const list = iters();
      const idx = list.findIndex((i) => i.id === sprint.id);
      prevBtn.disabled = idx <= 0;
      nextBtn.disabled = idx < 0 || idx >= list.length - 1;
      nowBtn.disabled = !cur || cur.id === sprint.id;
    }
    function step(d: number): void {
      const list = iters();
      const i = list.findIndex((x) => x.id === sprint.id) + d;
      if (list[i]) choose(list[i].id);
    }
    function choose(id: string): void {
      const it = ws.iterations.find((i) => i.id === id);
      if (!it || it.id === sprint.id) return;
      // the goal typed for the sprint left is saved first
      if (goalEd && goalEd.it.id === sprint.id) void saveGoal(goalEd);
      sprint = it;
      if (source === it.id) source = "";
      prefs.set(prefKey, it.id);
      try { history.replaceState(null, "", `#sprint?it=${encodeURIComponent(it.id)}`); } catch { /* not allowed in this frame */ }
      selected.clear();
      anchor = null;
      expanded.clear();
      draw();
    }

    // ---------- sprint goal: an always-open box that saves as you type ----------
    interface GoalEd { it: Iteration; box: HTMLTextAreaElement; status: HTMLElement; saved: string; timer: number; saving: Promise<void> | null; again: boolean; failed: boolean }
    let goalEd: GoalEd | null = null;
    /** The box is in use (focused, saving, not saved, or typed in): a redraw leaves it alone. */
    const goalBusy = (): boolean => !!goalEd && goalEd.it.id === sprint.id && goalEd.box.isConnected
      && (document.activeElement === goalEd.box || !!goalEd.saving || goalEd.failed || goalEd.box.value.trim() !== goalEd.saved);

    async function loadGoal(it: Iteration, force = false): Promise<void> {
      if (goalLoading.has(it.id) || (!force && goalCache.has(it.id))) return;
      goalLoading.add(it.id);
      try { goalCache.set(it.id, await goals.get(goalId(it.id))); } catch (e) { goalCache.set(it.id, e instanceof Error ? e : new Error(String(e))); } finally { goalLoading.delete(it.id); }
      if (alive && it.id === sprint.id) drawGoal();
    }

    const goalStatus = (ed: GoalEd, text: string, kind = ""): void => { ed.status.textContent = text; ed.status.className = `save-state ${kind}`.trim(); };

    /** Save what the box holds, for the sprint it belongs to (also after switching sprint). */
    async function saveGoal(ed: GoalEd): Promise<void> {
      clearTimeout(ed.timer);
      if (ed.saving) { ed.again = true; return ed.saving; }
      const value = ed.box.value.trim();
      // back to what is saved (also after a failed save): nothing to send, and the error is no longer true
      if (value === ed.saved) { ed.failed = false; goalStatus(ed, ""); return; }
      goalStatus(ed, "Saving…");
      ed.saving = (async () => {
        try {
          const g = await goals.put({ id: goalId(ed.it.id), text: value, by: app.api.ctx.me.displayName, at: new Date().toISOString() });
          goalCache.set(ed.it.id, g);
          ed.saved = value;
          ed.failed = false;
          goalStatus(ed, "Saved", "ok");
          setTimeout(() => { if (ed.status.textContent === "Saved") goalStatus(ed, ""); }, 2000);
        } catch (e) {
          ed.failed = true;
          goalStatus(ed, `Not saved: ${errorText(e)}`, "err");
          // the box is gone (another sprint is shown): say it in a message
          if (!ed.box.isConnected) toast(`The goal of ${ed.it.name} was not saved: ${errorText(e)}`, { kind: "error" });
        }
      })();
      await ed.saving;
      ed.saving = null;
      if (ed.again) { ed.again = false; await saveGoal(ed); }
    }

    function drawGoal(): void {
      const g = goalCache.get(sprint.id);
      const ro = app.actions.readOnly;
      if (goalBusy()) return; // what is typed stays
      const label = h("b.sp-goal-l", null, "Sprint goal");
      if (g === undefined) { goalBox.replaceChildren(label, h("span.muted.small", null, "Reading…")); return; }
      if (g instanceof Error) {
        goalBox.replaceChildren(label, h("span.err.small", { title: errorText(g) }, "Could not read the goal. "),
          h("button.btn.link.small", { title: "Read the goal again", onclick: () => { goalCache.delete(sprint.id); drawGoal(); void loadGoal(sprint); } }, "Try again"));
        return;
      }
      const text = g?.text ?? "";
      const setBy = g ? `Set by ${g.by}${g.at ? `, ${fmtDate(g.at)}` : ""}` : "";
      if (ro) {
        goalEd = null;
        goalBox.replaceChildren(label, h("span.sp-goal-t", { class: text ? undefined : "muted", title: setBy || undefined }, text || "No goal written."));
        return;
      }
      if (goalEd && goalEd.it.id === sprint.id && goalEd.box.isConnected && goalEd.saved === text) return;
      const box = h("textarea.input.sp-goal-in", {
        rows: 1, value: text, placeholder: "Write the goal…", "aria-label": "Sprint goal", spellcheck: "true",
        title: `What the team wants to reach in this sprint; the whole team sees it. Saved as you type.${setBy ? "\n" + setBy : ""}`,
      }) as HTMLTextAreaElement;
      const ed: GoalEd = { it: sprint, box, status: h("span.save-state", { role: "status" }), saved: text, timer: 0, saving: null, again: false, failed: false };
      goalEd = ed;
      const grow = (): void => { box.style.height = "auto"; box.style.height = `${box.scrollHeight + 2}px`; };
      box.addEventListener("input", () => {
        grow();
        if (!ed.failed) goalStatus(ed, "Editing…");
        clearTimeout(ed.timer);
        ed.timer = window.setTimeout(() => void saveGoal(ed), 1000);
      });
      box.addEventListener("blur", () => void saveGoal(ed));
      box.addEventListener("keydown", (e) => {
        // Enter saves now (Shift+Enter: a new line); Esc puts back what is saved
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); box.blur(); }
        else if (e.key === "Escape" && box.value.trim() !== ed.saved) { e.preventDefault(); e.stopPropagation(); clearTimeout(ed.timer); box.value = ed.saved; grow(); goalStatus(ed, ""); }
      });
      goalBox.replaceChildren(label, box, h("span.sp-goal-side", null, ed.status, setBy ? h("span.small.faint", null, setBy) : null));
      requestAnimationFrame(grow);
    }

    // ---------- end-of-sprint clean-up ----------
    const unfinished = (): WorkItem[] => sprintReqs().filter((w) => !isDone(w));
    const nextOf = (): Iteration | undefined => nextSprint(iters(), sprint, today());

    function drawCleanup(): void {
      const next = nextOf();
      const n = unfinished().length;
      cleanupBtn.hidden = app.actions.readOnly || !sprintOver(sprint, today()) || !next || !n;
      if (cleanupBtn.hidden || !next) return;
      cleanupBtn.textContent = `Move unfinished (${n}) to ${next.name}`;
      cleanupBtn.title = `${sprint.name} has ${sprint.finish && Date.parse(sprint.finish.slice(0, 10)) < Date.parse(today()) ? "ended" : "its last day today"}: choose which unfinished stories move to ${next.name}, or split a story so its finished work stays here`;
      cleanupBtn.disabled = !!moving;
    }

    async function openCleanup(): Promise<void> {
      const from = sprint;
      const next = nextOf();
      if (!next || moving) return;
      const stories = unfinished();
      if (!stories.length) return;
      // only the tasks in the sprint being cleaned up: tasks already planned elsewhere stay where they are
      const tasksOf = (id: number): WorkItem[] => (task ? tasksInSprint(ws.children(id).filter(isTask), from.path) : []);
      // Undo of Split sets the copy to Removed: without a Removed state the copy could not be undone
      const canRemove = (type: string): boolean => statesOf(ws.process, [type], ["Removed"]).length > 0;
      const noRemoved = stories.some((w) => !canRemove(w.type));
      const rows = stories.map((w) => {
        const all = tasksOf(w.id);
        const open = all.filter(isOpen).filter((t) => !isDone(t));
        const finished = all.filter(isDone);
        const removable = canRemove(w.type);
        const splitOk = removable && canSplit(all, isDone);
        const choice = { mode: "move" as CleanupMode, tasks: new Set(open.map((t) => t.id)) };
        const taskBoxes = open.map((t) => h("input", { type: "checkbox", checked: true, "aria-label": `Take task #${t.id} along`, onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) choice.tasks.add(t.id); else choice.tasks.delete(t.id); } }));
        const where = h("span.small.muted");
        const sel = h("select.input.small.sp-cu-mode", {
          "aria-label": `What happens to #${w.id}`, title: "Move: to the next sprint. Split: a copy goes to the next sprint with the open tasks; this one stays with its finished tasks. Leave: no change.",
          onchange: () => { choice.mode = sel.value as CleanupMode; paint(); },
        },
        h("option", { value: "move" }, `Move to ${next.name}`),
        h("option", { value: "split", disabled: !splitOk }, splitOk ? "Split" : removable ? "Split (needs a finished task)" : "Split (cannot be undone here)"),
        h("option", { value: "leave" }, "Leave here"));
        const paint = (): void => {
          for (const b of taskBoxes) b.disabled = choice.mode === "leave";
          where.textContent = choice.mode === "split" ? `Ticked tasks go to the copy "${w.title} (continued)" in ${next.name}.` : choice.mode === "move" ? `Ticked tasks move with it.` : "Nothing changes.";
        };
        paint();
        const el = h("div.sp-cu-story", null,
          h("div.sp-cu-head", null, sel, typeMark(ws, w.type), h("span.mono.muted", null, "#" + w.id), h("span.sp-cu-title", { title: w.title }, w.title), stateMark(ws, w),
            w.assignedTo ? avatar(app.api, w.assignedTo, 18) : null, h("span.mono.small", { title: "Effort" }, w.effort != null ? fmtNum(w.effort) : "–")),
          open.length ? h("div.sp-cu-tasks", null, open.map((t, i) => h("label.sp-cu-task", null, taskBoxes[i], typeMark(ws, t.type), h("span.mono.muted", null, "#" + t.id), h("span", null, t.title),
            h("span.small.muted", null, t.remaining != null ? `${fmtNum(t.remaining)} h left` : "")))) : null,
          h("div.sp-cu-note", null, where, finished.length ? h("span.small.muted", null, ` ${finished.length} finished ${finished.length === 1 ? "task stays" : "tasks stay"} in ${from.name}.`) : null));
        return { story: w, open, choice, el };
      });
      const status = h("p.small.muted.sp-cu-status", { role: "status" });
      const body = h("div.sprint-cleanup", null,
        h("p", null, `${stories.length} unfinished ${stories.length === 1 ? "story" : "stories"} in ${from.name}. Choose for each one:`),
        h("ul.small.sp-cu-help", null,
          h("li", null, h("b", null, "Move"), `: the story and its ticked open tasks go to ${next.name}.`),
          h("li", null, h("b", null, "Split"), `: for a story with finished work. A copy named "… (continued)" is made in ${next.name} under the same parent, with the same owner, description and tags, and no estimate (estimate what is left). The ticked open tasks move to the copy. The original stays in ${from.name} with its finished tasks, and its state does not change: close it when the team agrees.`),
          h("li", null, h("b", null, "Leave"), ": nothing changes.")),
        noRemoved ? h("p.small.warn-text", null, `Split is off for ${stories.every((w) => !canRemove(w.type)) ? "these stories" : "some stories"}: their process has no Removed state, so a copy made by Split could not be undone from here. Make the copy in Azure DevOps if you need one.`) : null,
        h("div.sp-cu-list", null, rows.map((r) => r.el)),
        h("p.small.muted", null, "Undo in the message afterwards puts the work back; a copy made by Split is then set to Removed."),
        status);
      let running: Promise<{ done: number; failed: { label: string; error: string }[] }> | null = null;
      await dialog(`Clean up ${from.name}`, body, [
        { label: "Cancel", value: "" },
        {
          label: "Apply", primary: true,
          onClick: async () => {
            const choices: CleanupChoice[] = rows.filter((r) => r.choice.mode !== "leave")
              .map((r) => ({ story: r.story, mode: r.choice.mode, tasks: r.open.filter((t) => r.choice.tasks.has(t.id)) }));
            if (!choices.length) { status.textContent = "Nothing to do: every story is set to Leave here."; return false; }
            running = runCleanup(choices, next, (n, total) => { status.textContent = `Working… ${n} of ${total}`; });
            await running;
          },
        },
      ], { wide: true });
      // closed with Cancel, Escape or × while Apply runs: wait for the changes, so the report still shows
      const r = running ? await (running as Promise<{ done: number; failed: { label: string; error: string }[] }>) : null;
      if (r && r.failed.length) {
        await dialog("Some changes failed", h("div", null,
          h("p", null, `${r.done} changes were made; these were not:`),
          h("ul", null, r.failed.map((f) => h("li", null, h("b", null, f.label), `: ${f.error}`)))));
      }
    }

    /** Make the changes of the clean-up, in order, as one change with one Undo. */
    async function runCleanup(choices: CleanupChoice[], next: Iteration, onStep: (n: number, total: number) => void): Promise<{ done: number; failed: { label: string; error: string }[] }> {
      const from = sprint;
      const copies = new Map<string, number>(); // step ref -> id of the copy made
      const has = (type: string, field: string): boolean => { const f = ws.process.types[type]?.fields; return !f || f.includes(field); };
      const jobs = cleanupSteps(choices, next.path).map((s): { label: string; run: (w: Writer) => Promise<WriteResult> } => {
        if (s.kind === "iteration") return { label: `#${s.id} to ${next.name}`, run: (w) => w.setFields(s.id, [{ field: "System.IterationPath", value: s.path }]) };
        if (s.kind === "reparent") {
          return {
            label: `#${s.id} under the copy`,
            run: (w) => {
              const c = copies.get(s.ref);
              return c ? w.reparent(s.id, c) : Promise.reject(new Error("the copy of its story was not made"));
            },
          };
        }
        return {
          label: `Copy of #${s.from}`,
          run: async (w) => {
            const o = ws.get(s.from);
            if (!o) throw new Error(`#${s.from} is not loaded`);
            const fields: Record<string, unknown> = {
              "System.Title": s.title, "System.IterationPath": s.path, "System.AreaPath": o.area,
              "System.AssignedTo": o.assignedTo?.uniqueName,
              "System.Description": `<p>Continued from #${o.id} (${esc(from.name)}).</p>${o.description ?? ""}`,
            };
            if (o.acceptance && has(o.type, "Microsoft.VSTS.Common.AcceptanceCriteria")) fields["Microsoft.VSTS.Common.AcceptanceCriteria"] = o.acceptance;
            if (o.tags.length) fields["System.Tags"] = o.tags.join("; ");
            if (o.priority != null && has(o.type, "Microsoft.VSTS.Common.Priority")) fields["Microsoft.VSTS.Common.Priority"] = o.priority;
            const item = await w.create(o.type, fields, s.parent);
            copies.set(s.ref, item.id);
            await w.comment(o.id, `<p>Split at the end of ${esc(from.name)}: the rest continues in #${item.id}.</p>`).catch(() => undefined);
            // Undo: the copy cannot be deleted from here, so it is set to Removed
            const gone = statesOf(ws.process, [o.type], ["Removed"])[0];
            const undo = async (): Promise<WriteResult> => {
              const r = await w.setFields(item.id, [{ field: "System.State", value: gone }]);
              // read the copy once more: a read of it started by the steps undone before could bring it back as New
              await ws.refresh(item.id).catch(() => undefined);
              // comments cannot be deleted from here: a second one says the split was undone
              await w.comment(o.id, `<p>Split undone: #${item.id} was set to ${esc(gone)}.</p>`).catch(() => undefined);
              return r;
            };
            return { item, undo: gone ? undo : undefined };
          },
        };
      });
      moving = "Cleaning up…";
      movingNote.textContent = moving;
      drawCleanup();
      try {
        const moved = choices.filter((c) => c.mode === "move").length;
        const split = choices.filter((c) => c.mode === "split").length;
        const what = [moved ? `${moved} moved` : "", split ? `${split} split` : ""].filter(Boolean).join(", ");
        return await app.actions.batch(`${from.name} cleaned up: ${what} to ${next.name}`, jobs, onStep);
      } finally {
        moving = "";
        movingNote.textContent = "";
        redraw();
      }
    }

    // ---------- loading capacity, velocity, burndown ----------
    async function loadCapacity(it: Iteration, force = false): Promise<void> {
      if (capLoading.has(it.id)) { if (force) capAgain.add(it.id); return; }
      if (!force && capCache.has(it.id)) return;
      capLoading.add(it.id);
      try {
        const c = await app.api.capacity(ws.project, ws.team, it.id);
        capCache.set(it.id, c);
      } catch (e) {
        capCache.set(it.id, e instanceof Error ? e : new Error(String(e)));
      } finally {
        capLoading.delete(it.id);
      }
      // a change was saved while this read ran: it may not have seen it
      if (capAgain.delete(it.id)) { await loadCapacity(it, true); return; }
      if (alive && it.id === sprint.id) redraw();
    }

    /** The three past sprints before this one (or before today). */
    const velocitySprints = (): Iteration[] => {
      const before = Math.min(Date.parse(sprint.start ?? "") || Date.now(), Date.now());
      return iters().filter((i) => i.id !== sprint.id && i.finish && Date.parse(i.finish) < before).slice(-3);
    };
    async function loadVelocity(): Promise<void> {
      const need = velocitySprints().filter((i) => !velCache.has(i.path) && !velLoading.has(i.path));
      if (!need.length) return;
      for (const i of need) velLoading.add(i.path);
      await Promise.all(need.map(async (i) => {
        try {
          velCache.set(i.path, await sprintVelocity(app.api, ws, req.types, i.path));
        } catch (e) {
          // remember the failure so draw() does not ask again and again
          velCache.set(i.path, e instanceof Error ? e : new Error(String(e)));
        } finally {
          velLoading.delete(i.path);
        }
      }));
      if (alive) redraw();
    }

    // ---------- header numbers ----------
    function drawStats(): void {
      const d = days();
      const reqs = sprintReqs();
      const planned = sumEffort(reqs);
      const doneEffort = sumEffort(reqs.filter(isClosed));
      const vs = velocitySprints();
      const known = vs.filter((i) => velCache.has(i.path));
      const velErr = vs.map((i) => velCache.get(i.path)).find((v): v is Error => v instanceof Error);
      const velocity = vs.length && !velErr && known.length === vs.length ? known.reduce((s, i) => s + (velCache.get(i.path) as number), 0) / vs.length : null;
      const retryVel = (): void => { for (const i of vs) if (velCache.get(i.path) instanceof Error) velCache.delete(i.path); drawStats(); void loadVelocity(); };
      const preview = drag?.started && drag.over && drag.over !== drag.from ? (drag.over === "sprint" ? 1 : -1) * effortOf(drag.ids) : 0;
      const after = planned + preview;
      const top = Math.max(after, planned, velocity ?? 0, 1) * 1.1;
      const over = velocity != null && after > velocity * 1.1;
      const stat = (n: string, l: string, title: string): HTMLElement => h("div.stat", { title }, h("span.n", null, n), h("span.l", null, l));
      stats.replaceChildren(
        h("div.sp-stat-row", null,
          stat(sprint.start ? `${fmtDate(sprint.start, { day: "numeric", month: "short", timeZone: "UTC" })} – ${fmtDate(sprint.finish, { day: "numeric", month: "short", timeZone: "UTC" })}` : "No dates", sprint.name, sprint.path),
          stat(String(d.left), `of ${d.total} working days left`, "Working days of the team, without team days off"),
          stat(preview ? `${fmtNum(planned)} → ${fmtNum(after)}` : fmtNum(planned), `planned effort (${fmtNum(doneEffort)} done)`, "Sum of the effort of the sprint's stories"),
          velErr
            ? h("div.stat", { title: "Velocity could not be read: " + errorText(velErr) }, h("span.n", null, "?"),
              h("span.l", null, "velocity ", h("button.btn.link.small", { title: "Read the velocity again", onclick: retryVel }, "Try again")))
            : stat(velocity == null ? (vs.length ? "…" : "–") : fmtNum(velocity), "velocity", vs.length ? `Average effort closed in ${vs.map((i) => i.name).join(", ")}` : "No past sprints to measure"),
          h("div.sp-pv", { title: velocity == null ? "Planned effort" : `Planned ${fmtNum(after)} against a velocity of ${fmtNum(velocity)}` },
            h("div.small.muted", null, "Planned vs velocity"),
            h("div.sp-bar", null,
              h("i", { class: over ? "warn" : "ok", style: { width: `${(after / top) * 100}%` } }),
              velocity != null ? h("b.sp-mark", { style: { left: `${(velocity / top) * 100}%` } }) : null),
            h("div.small.muted", null, velocity == null ? "" : over ? `${fmtNum(after - velocity)} above velocity` : `${fmtNum(Math.max(0, velocity - after))} below velocity`))));
    }

    // ---------- capacity ----------
    interface CapRow { key: string; person?: Person; member?: CapacityMember; perDay: number; daysOff: number; available: number; assigned: number; editable: boolean }
    interface CapData { cap: Capacity | Error; rows: CapRow[]; unassigned: number; hasCap: boolean; off: { start: string; end: string }[] }

    /** Hours per person: available (capacity) and assigned (remaining work of the sprint's open tasks). */
    function capData(): CapData | null {
      const cap = capCache.get(sprint.id);
      if (!cap) return null;
      const tasks = sprintTasks().filter(isOpen);
      const assigned = new Map<string, number>();
      let unassigned = 0;
      const assignees = new Map<string, Person>();
      for (const t of tasks) {
        const r = t.remaining ?? 0;
        if (!t.assignedTo) { unassigned += r; continue; }
        const k = personKey(t.assignedTo);
        assignees.set(k, t.assignedTo);
        assigned.set(k, (assigned.get(k) ?? 0) + r);
      }
      const members = cap instanceof Error ? [] : cap.members;
      const hasCap = members.some((m) => m.activities.some((a) => a.capacityPerDay > 0));
      const from = sprint.start && Date.parse(sprint.start) < Date.now() ? today() : sprint.start;
      const off = teamDaysOff();
      const dayCount = (personal: { start: string; end: string }[]): number => (from && sprint.finish && Date.parse(from.slice(0, 10)) <= Date.parse(sprint.finish.slice(0, 10)) ? workingDays(from, sprint.finish, ws.settings.workingDays, [...off, ...personal]) : 0);
      const personalOff = (m: CapacityMember): number => (sprint.start && sprint.finish ? workingDays(sprint.start, sprint.finish, ws.settings.workingDays, off) - workingDays(sprint.start, sprint.finish, ws.settings.workingDays, [...off, ...m.daysOff]) : 0);
      const rows: CapRow[] = [];
      const seen = new Set<string>();
      for (const m of members) {
        const k = personKey(m.person);
        seen.add(k);
        const perDay = m.activities.reduce((s, a) => s + a.capacityPerDay, 0);
        rows.push({ key: k, person: m.person, member: m, perDay, daysOff: personalOff(m), available: perDay * dayCount(m.daysOff), assigned: assigned.get(k) ?? 0, editable: !!m.person.id && m.activities.length <= 1 });
      }
      const teamPeople = ws.teamMembers();
      for (const p of [...teamPeople, ...assignees.values()]) {
        const k = personKey(p);
        if (seen.has(k)) continue;
        seen.add(k);
        const member = teamPeople.some((x) => personKey(x) === k);
        if (!member && !assigned.get(k)) continue;
        rows.push({ key: k, person: p, perDay: 0, daysOff: 0, available: 0, assigned: assigned.get(k) ?? 0, editable: member && !!p.id });
      }
      rows.sort((a, b) => (a.person?.displayName ?? "").localeCompare(b.person?.displayName ?? ""));
      return { cap, rows, unassigned, hasCap, off };
    }

    /** While dragging: the remaining hours that would come into the sprint (+) or leave it (-), per person ("" = nobody). */
    function dragHours(): Map<string, number> {
      const out = new Map<string, number>();
      if (!drag?.started || !drag.over || drag.over === drag.from || !moveTasks) return out;
      const into = drag.over === "sprint";
      for (const id of drag.ids) {
        for (const t of openTasksOf(id)) {
          if (into === inSprint(t)) continue; // already where it would go
          const k = t.assignedTo ? personKey(t.assignedTo) : "";
          out.set(k, (out.get(k) ?? 0) + (into ? 1 : -1) * (t.remaining ?? 0));
        }
      }
      return out;
    }

    const loadClass = (assignedH: number, availableH: number, hasCap: boolean): string => {
      const ratio = availableH > 0 ? assignedH / availableH : assignedH > 0 ? Infinity : 0;
      return !hasCap ? "none" : ratio > 1 ? "bad" : ratio >= 0.9 ? "warn" : "ok";
    };

    function drawLoad(): void {
      const d = capData();
      const capLink = h("button.btn.link.small", { title: "Show hours per day, days off and the load of each person", onclick: () => { setCapOpen(true); capBox.scrollIntoView({ block: "start", behavior: "smooth" }); } }, "Capacity");
      if (!d) { loadStrip.replaceChildren(h("span.sp-load-l", null, "Load"), h("span.small.muted", null, "Reading capacity…")); return; }
      const delta = dragHours();
      const chips = d.rows.filter((r) => r.available > 0 || r.assigned > 0 || delta.has(r.key)).map((r) => {
        const dh = delta.get(r.key) ?? 0;
        const after = Math.max(0, r.assigned + dh);
        const cls = loadClass(after, r.available, d.hasCap);
        const shown = dh ? `${fmtNum(r.assigned)}→${fmtNum(after)}` : fmtNum(after);
        const nums = d.hasCap ? `${shown}/${fmtNum(r.available)} h` : `${shown} h`;
        const pct = r.available > 0 ? Math.min(100, (after / r.available) * 100) : after > 0 ? 100 : 0;
        return h("span.sp-load-p", { class: [dh !== 0 && "chg"], title: `${r.person?.displayName ?? ""}: ${dh ? `${fmtNum(r.assigned)} → ` : ""}${fmtNum(after)} h assigned${d.hasCap ? ` of ${fmtNum(r.available)} h available` : ""}` },
          avatar(app.api, r.person, 18), h("span.mono", null, nums),
          d.hasCap ? h("span.sp-bar.sp-load-bar", null, h("i", { class: cls, style: { width: pct + "%" } })) : null);
      });
      const un = d.unassigned + (delta.get("") ?? 0);
      loadStrip.replaceChildren(...[h("span.sp-load-l", { title: "Remaining hours of the sprint's open tasks per person, against their capacity. While you drag, it shows what the move would make." }, "Load"),
        ...chips,
        un > 0 ? h("span.sp-load-p.muted", { class: [delta.has("") && "chg"], title: "Remaining hours of open tasks without an owner" }, avatar(app.api, undefined, 18), h("span.mono", null, `${fmtNum(un)} h`)) : null,
        !chips.length && !un ? h("span.small.muted", null, "No hours assigned yet.") : null,
        h("span.spacer"), capLink].filter((x): x is HTMLElement => !!x));
    }

    function setCapOpen(v: boolean): void {
      if (capOpen === v) return;
      capOpen = v;
      prefs.set("sprint:capOpen", v);
      drawCapacity();
    }

    /** The day a day off added from here starts on: today in a running sprint, else its first day. */
    const offStart = (): number | undefined => {
      const s = planDay(sprint.start);
      const e = planDay(sprint.finish);
      const t = todayDay();
      return s == null ? undefined : e != null && t > s && t <= e ? t : s;
    };

    let capRebuilding = false; // the table is being replaced: a box leaving it does not save
    function drawCapacity(): void {
      const d = capData();
      const head = h("button.sp-cap-toggle", { "aria-expanded": String(capOpen), title: capOpen ? "Hide the capacity table" : "Show the capacity table", onclick: () => setCapOpen(!capOpen) },
        h("span", { class: ["sp-chev", capOpen && "open"] }, icon("chevron", 12)), h("h2", null, "Capacity"));
      const sumText = d && !(d.cap instanceof Error)
        ? `${d.hasCap ? `${fmtNum(d.rows.reduce((s, r) => s + r.available, 0))} h available · ` : ""}${fmtNum(d.rows.reduce((s, r) => s + r.assigned, 0) + d.unassigned)} h assigned` : "";
      const headEl = h("div.sp-sec-head", null, head,
        help("Available hours = hours per day × working days (for the current sprint: from today on), without personal and team days off. Assigned = remaining work of the sprint's open tasks."),
        capOpen ? null : h("span.small.muted", null, sumText));
      if (!capOpen) { capBox.replaceChildren(headEl); return; }
      if (!d) { capBox.replaceChildren(headEl, spinner("Reading capacity…")); return; }
      const { cap, rows, unassigned, hasCap, off } = d;
      const total = { available: rows.reduce((s, r) => s + r.available, 0), assigned: rows.reduce((s, r) => s + r.assigned, 0) + unassigned };
      const ro = app.actions.readOnly;

      const bar = (assignedH: number, availableH: number): HTMLElement => {
        const ratio = availableH > 0 ? assignedH / availableH : assignedH > 0 ? Infinity : 0;
        const cls = loadClass(assignedH, availableH, hasCap);
        const pct = availableH > 0 ? Math.min(100, ratio * 100) : assignedH > 0 ? 100 : 0;
        const text = !hasCap ? `${fmtNum(assignedH)} h assigned` : availableH > 0 ? `${fmtNum(assignedH)} of ${fmtNum(availableH)} h (${Math.round(ratio * 100)}%)` : `${fmtNum(assignedH)} h, no capacity`;
        return h("div.sp-bar.sp-cap-bar", { title: text, "data-xl": hasCap && availableH > 0 ? `${Math.round(ratio * 100)}%` : "" }, h("i", { class: cls, style: { width: pct + "%" } }));
      };
      const perDayCell = (r: CapRow): HTMLElement => {
        if (!r.editable || !r.person?.id) {
          return h("span.mono", { title: r.member && r.member.activities.length > 1 ? `Several activities (${r.member.activities.map((a) => `${a.name || "Unassigned"} ${a.capacityPerDay}`).join(", ")}); change them in Azure DevOps` : "Cannot be changed here" }, fmtNum(r.perDay));
        }
        // saved on Enter or on leaving the box, never on each arrow step; the box stays usable while it saves
        const input = h("input.input.sp-num", {
          type: "number", min: 0, max: 24, step: 0.5, value: String(r.perDay), "aria-label": `Hours per day of ${r.person.displayName}`, disabled: ro, dataset: { key: r.key },
          title: ro ? "Read-only: capacity cannot be changed here." : `Hours per day ${r.person.displayName} can work in this sprint. Type or use the arrows, then press Enter or leave the box to save.`,
        }) as HTMLInputElement;
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); void saveCapacity(r, input); }
          else if (e.key === "Escape" && input.value !== String(r.perDay)) { e.preventDefault(); e.stopPropagation(); input.value = String(r.perDay); }
        });
        input.addEventListener("blur", () => { if (!capRebuilding) void saveCapacity(r, input); });
        return input;
      };
      const offCell = (r: CapRow): HTMLElement => {
        const list = r.member?.daysOff.map((o) => `${fmtDate(o.start, UTC_DATE)} – ${fmtDate(o.end, UTC_DATE)}`).join("\n") || "No days off";
        const n = r.daysOff ? String(r.daysOff) : "";
        if (ro || !r.person?.id) return h("span", { title: list }, n);
        const p = r.person;
        return h("button.sp-off", {
          type: "button", title: `${list}\nClick to add a day off for ${p.displayName}`, "aria-label": `Add a day off for ${p.displayName}${n ? ` (${n} days off now)` : ""}`,
          onclick: () => { const it = sprint; const from = offStart(); void dayOffDialog(app, { kind: "off", person: p, from, to: from, onChange: () => void loadCapacity(it, true) }); },
        }, n ? h("span.mono", null, n) : null, icon("plus", 12));
      };
      const table = sortable(h("table.data.sp-cap-table", null,
        h("thead", null, h("tr", null, h("th", null, "Person"), h("th.num", null, "Hours/day"), h("th.num", null, "Days off"), h("th.num", null, "Available h"), h("th.num", null, "Assigned h"), h("th.sp-wide", null, "Load"))),
        h("tbody", null,
          rows.map((r) => h("tr", null,
            h("td", null, h("span.sp-person", null, avatar(app.api, r.person, 22), r.person?.displayName ?? "")),
            h("td.num", { "data-sort": String(r.perDay) }, perDayCell(r)),
            h("td.num", { "data-sort": String(r.daysOff) }, offCell(r)),
            h("td.num", null, hasCap ? fmtNum(r.available) : ""),
            h("td.num", null, fmtNum(r.assigned)),
            h("td.sp-wide", { "data-sort": String(r.available > 0 ? r.assigned / r.available : r.assigned > 0 ? 9999 : 0) }, bar(r.assigned, r.available)))),
          h("tr.sp-unassigned", null, h("td", null, h("span.sp-person", null, avatar(app.api, undefined, 22), "Unassigned work")), h("td"), h("td"), h("td"),
            h("td.num", null, fmtNum(unassigned)), h("td.sp-wide", { title: "Remaining hours of open tasks without an owner", "data-xl": "" }, unassigned ? h("span.small.muted", null, "Give these tasks an owner") : null))),
        h("tfoot", null, h("tr.sp-total", null, h("td", null, "Team"), h("td"), h("td.num", { title: "Team days off" }, off.length ? String(sprint.start && sprint.finish ? workingDays(sprint.start, sprint.finish, ws.settings.workingDays) - days().total : 0) : ""),
          h("td.num", null, hasCap ? fmtNum(total.available) : ""), h("td.num", null, fmtNum(total.assigned)), h("td.sp-wide", null, bar(total.assigned, total.available))))), "sp-cap");
      const note = cap instanceof Error
        ? h("p.err.small", null, "Could not read capacity: " + errorText(cap))
        : !hasCap ? h("p.muted.small", null, "No capacity is set for this sprint, so only assigned work is shown. Enter hours per day below, or set capacity in Azure DevOps.") : null;
      // a box being typed in keeps its text and the caret across the redraw
      const act = document.activeElement as HTMLInputElement | null;
      const keep = act && capBox.contains(act) && act.classList.contains("sp-num") ? { key: act.dataset.key ?? "", value: act.value, sent: act.dataset.sent } : null;
      capRebuilding = true;
      try {
        capBox.replaceChildren(h("div", null, headEl, note, task ? null : h("p.muted.small", null, "This process has no task level: assigned hours are 0."), h("div.sp-scroll", null, table)));
      } finally { capRebuilding = false; }
      if (keep) {
        const n = [...capBox.querySelectorAll<HTMLInputElement>(".sp-num")].find((x) => x.dataset.key === keep.key);
        if (n) { n.value = keep.value; if (keep.sent) n.dataset.sent = keep.sent; n.focus(); }
      }
    }

    async function saveCapacity(r: CapRow, input: HTMLInputElement): Promise<void> {
      if (app.actions.readOnly) { input.value = String(r.perDay); return; }
      // an empty box means no change, not 0
      if (input.value.trim() === "") { input.value = String(r.perDay); return; }
      const value = Number(input.value);
      // the same value again (Enter, then leaving the box): saved once
      if (value === r.perDay || input.dataset.sent === String(value)) return;
      if (!Number.isFinite(value) || value < 0 || value > 24) { toast("Hours per day must be between 0 and 24.", { kind: "error" }); input.value = String(r.perDay); return; }
      const it = sprint;
      input.dataset.sent = String(value);
      try {
        const name = r.member?.activities[0]?.name ?? "";
        await app.actions.setCapacity(ws.project, ws.team, it.id, r.person!.id!, { activities: [{ name, capacityPerDay: value }], daysOff: r.member?.daysOff ?? [] }, r.person!.displayName, it.name);
        toast(`${r.person!.displayName}: ${fmtNum(value)} h per day in ${it.name}`, { kind: "ok" });
      } catch (e) {
        delete input.dataset.sent;
        toast("Could not save capacity: " + errorText(e), { kind: "error" });
      }
      await loadCapacity(it, true);
    }

    // ---------- columns ----------
    const rowFor = (w: WorkItem, col: Col, extra: HTMLElement | null = null): HTMLElement => {
      const movable = isOpen(w) && !app.actions.readOnly; // no moving or dragging in read-only
      const moveBtn = movable ? h("button.icon-btn.small.sp-move", {
        title: col === "backlog" ? `Move to ${sprint.name}` : `Move back to ${leftName()}`, "aria-label": col === "backlog" ? `Move #${w.id} to ${sprint.name}` : `Move #${w.id} to ${leftName()}`,
        onclick: (e: Event) => { e.stopPropagation(); const ids = selected.has(w.id) ? idsIn(col) : [w.id]; void moveItems(ids, col === "backlog" ? "sprint" : "backlog"); },
      }, col === "backlog" ? icon("chevron", 14) : svg("svg", { class: "icon", width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg("path", { d: "M15 6l-6 6 6 6" }))) : null;
      return h("div.sp-row", {
        class: [selected.has(w.id) && "sel", openId === w.id && "open", !isOpen(w) && "done", drag?.started && drag.ids.includes(w.id) && "dragged"],
        tabindex: 0, role: "option", "aria-selected": String(selected.has(w.id)),
        dataset: { id: w.id, col, ...(movable ? { drag: "1" } : {}) },
        title: movable ? `Click to open; Ctrl or Shift + click to select several; drag to move${col === "sprint" ? " or to change the order" : ""}` : "Click to open",
      },
        movable ? h("span.sp-grip", { "aria-hidden": "true" }, icon("drag", 14)) : h("span.sp-grip"),
        typeMark(ws, w.type),
        h("span.mono.muted.sp-id", null, "#" + w.id),
        h("span.sp-title", null, w.title),
        extra,
        col === "sprint" ? stateMark(ws, w) : null,
        w.assignedTo ? avatar(app.api, w.assignedTo, 20) : null,
        h("span.sp-eff.mono", { title: "Effort" }, w.effort != null ? fmtNum(w.effort) : "–"),
        moveBtn);
    };

    /** The selected items of a column, in screen order, that can move. */
    const idsIn = (col: Col): number[] => [...(col === "backlog" ? colBacklog : colSprint).querySelectorAll<HTMLElement>(".sp-row[data-drag]")]
      .map((r) => Number(r.dataset.id)).filter((id) => selected.has(id));

    function drawBacklog(): void {
      const all = leftReqs();
      const from = sourceIt();
      const list = all.filter(shows);
      const groups = new Map<string, { title: string; parent?: WorkItem; items: WorkItem[] }>();
      for (const w of list) {
        const p = ws.get(w.parent);
        const key = p && featLevel?.types.includes(p.type) ? String(p.id) : "none";
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { title: key === "none" ? `No ${featLevel ? featLevel.name.replace(/s$/, "").toLowerCase() : "parent"}` : p!.title, parent: key === "none" ? undefined : p, items: [] }));
        g.items.push(w);
      }
      const ordered = [...groups.entries()].sort(([a], [b]) => (a === "none" ? 1 : 0) - (b === "none" ? 1 : 0));
      const scroll = colBacklog.querySelector(".sp-list")?.scrollTop ?? 0;
      const listEl = h("div.sp-list", { role: "listbox", "aria-multiselectable": "true", "aria-label": "Backlog items" },
        !list.length ? h("p.muted.pad", null, all.length ? `Nothing in ${leftName()} matches the search and the filters.` : from ? `Nothing open is planned in ${from.name}.` : "The backlog is empty: every open item is planned in a sprint.") : null,
        ordered.map(([key, g]) => {
          const shut = collapsed.has(key);
          return h("div.sp-group", null,
            h("button.sp-group-head", {
              "aria-expanded": String(!shut), title: shut ? "Show the items of this group" : "Hide the items of this group",
              onclick: () => { if (shut) collapsed.delete(key); else collapsed.add(key); prefs.set(prefKey + ":collapsed", [...collapsed]); drawBacklog(); },
            }, h("span", { class: ["sp-chev", !shut && "open"] }, icon("chevron", 12)), g.parent ? typeMark(ws, g.parent.type) : null,
              h("span.sp-gt", null, g.title), h("span.small.muted", null, `${g.items.length} · ${fmtNum(sumEffort(g.items))}`)),
            shut ? null : g.items.map((w) => rowFor(w, "backlog")));
        }));
      // what the left list shows: the backlog, or a coming sprint to pull planned work from
      const srcSel = h("select.input.sp-src", {
        "aria-label": "Show items from", title: "Show the backlog, or the open items planned in a coming sprint, to pull them into this one",
        onchange: () => { source = srcSel.value; selected.clear(); anchor = null; fb.refresh(); people.refresh(); drawBacklog(); drawSprint(); paintSelection(); },
      }, h("option", { value: "", selected: !from }, "Backlog"),
      iters().filter((i) => !isPast(i) && i.id !== sprint.id).map((i) => h("option", { value: i.id, selected: from?.id === i.id }, i.name))) as HTMLSelectElement;
      colBacklog.setAttribute("aria-label", from ? from.name : "Backlog");
      colBacklog.replaceChildren(
        h("div.sp-col-head", null, h("h2.sp-src-h", null, srcSel), h("span.small.muted", null, `${list.length < all.length ? `${list.length} of ${all.length}` : list.length} items · ${fmtNum(sumEffort(list))} effort`),
          h("span.spacer"), h("span.sp-drop-hint.small", null, `Drop here to move to ${leftName()}`)),
        listEl);
      listEl.scrollTop = scroll;
    }

    function drawSprint(): void {
      const allReqs = sprintReqs();
      const reqs = allReqs.filter(shows);
      const tasks = sprintTasks();
      const reqIds = new Set(allReqs.map((w) => w.id));
      const orphan = tasks.filter((t) => (!t.parent || !reqIds.has(t.parent)) && shows(t));
      const remaining = tasks.filter(isOpen).reduce((s, t) => s + (t.remaining ?? 0), 0);
      const preview = drag?.started && drag.over === "sprint" && drag.from === "backlog" ? effortOf(drag.ids) : 0;
      const scroll = colSprint.querySelector(".sp-list")?.scrollTop ?? 0;
      const taskRows = (list: WorkItem[]): HTMLElement => h("div.sp-tasks", null, list.map((t) => h("div.sp-task", {
        class: [openId === t.id && "open", !isOpen(t) && "done"], tabindex: 0, dataset: { id: t.id, col: "sprint", task: "1" }, title: "Click to open",
      }, typeMark(ws, t.type), h("span.mono.muted.sp-id", null, "#" + t.id), h("span.sp-title", null, t.title), stateMark(ws, t),
        avatar(app.api, t.assignedTo, 18), h("span.sp-eff.mono", { title: "Remaining hours" }, t.remaining != null ? fmtNum(t.remaining) + " h" : "–"))));
      const listEl = h("div.sp-list", { role: "listbox", "aria-multiselectable": "true", "aria-label": "Items in this sprint" },
        !reqs.length ? h("p.muted.pad", null, allReqs.length ? "Nothing in this sprint matches the search and the filters." : `Nothing planned yet. Drag items here from ${leftName()}.`) : null,
        reqs.map((w) => {
          const ts = tasks.filter((t) => t.parent === w.id);
          const rem = ts.filter(isOpen).reduce((s, t) => s + (t.remaining ?? 0), 0);
          const open = expanded.has(w.id);
          const toggleBtn = ts.length ? h("button.sp-tasks-btn.small", {
            title: open ? "Hide the tasks" : "Show the tasks", "aria-expanded": String(open),
            onclick: (e: Event) => { e.stopPropagation(); if (open) expanded.delete(w.id); else expanded.add(w.id); drawSprint(); },
          }, h("span", { class: ["sp-chev", open && "open"] }, icon("chevron", 10)), `${ts.filter(isClosed).length}/${ts.length} tasks · ${fmtNum(rem)} h`) : h("span.small.faint.sp-notasks", null, "no tasks");
          return h("div.sp-story", null, rowFor(w, "sprint", toggleBtn), open ? taskRows(ts) : null);
        }),
        orphan.length ? h("div.sp-group", null, h("div.sp-group-head.static", null, h("span.sp-gt", null, "Tasks without a story in this sprint"), h("span.small.muted", null, String(orphan.length))), taskRows(orphan)) : null);
      const planned = sumEffort(allReqs);
      colSprint.replaceChildren(
        h("div.sp-col-head", null, h("h2", null, "In this sprint"),
          h("span.small.muted", { title: filtering() ? "Effort and hours count the whole sprint" : undefined }, `${reqs.length < allReqs.length ? `${reqs.length} of ${allReqs.length}` : reqs.length} items · ${preview ? `${fmtNum(planned)} → ${fmtNum(planned + preview)}` : fmtNum(planned)} effort · ${fmtNum(remaining)} h left`),
          h("span.spacer"), h("span.sp-drop-hint.small", null, `Drop here to plan in ${sprint.name}`)),
        listEl);
      listEl.scrollTop = scroll;
    }

    // ---------- moving ----------
    async function moveItems(ids: number[], to: Col): Promise<void> {
      if (moving) { toast("Still moving the last items; one moment.", { kind: "info" }); return; }
      const path = to === "sprint" ? sprint.path : leftPath();
      const where = to === "sprint" ? sprint.name : leftName();
      const list = ids.map((id) => ws.get(id)).filter((w): w is WorkItem => !!w && isOpen(w) && w.iteration !== path);
      if (!list.length) return;
      const failed = new Set<number>(); // stories that did not move: their tasks stay too
      const moveStep = (id: number) => (w: Writer): Promise<WriteResult> => w.setFields(id, [{ field: "System.IterationPath", value: path }]);
      const steps: { label: string; run: (w: Writer) => Promise<WriteResult> }[] = [];
      let tasks = 0;
      for (const w of list) {
        steps.push({ label: `#${w.id} ${w.title}`, run: async (wr) => { try { return await moveStep(w.id)(wr); } catch (e) { failed.add(w.id); throw e; } } });
        if (!moveTasks) continue;
        for (const t of openTasksOf(w.id)) {
          if (t.iteration === path) continue;
          tasks++;
          steps.push({ label: `#${t.id} ${t.title}`, run: (wr) => (failed.has(w.id) ? Promise.resolve({ item: t }) : moveStep(t.id)(wr)) });
        }
      }
      const first = list[0];
      const what = list.length === 1 ? `#${first.id} ${first.title.length > 40 ? first.title.slice(0, 38) + "…" : first.title}` : `${list.length} items`;
      const msg = `${what} moved to ${where}${tasks ? `, with ${tasks} open task${tasks === 1 ? "" : "s"}` : ""}`;
      try {
        await app.actions.batch(msg, steps, (n, total) => { moving = `Moving ${n} of ${total}…`; movingNote.textContent = moving; });
      } finally {
        moving = "";
        movingNote.textContent = "";
      }
      for (const w of list) selected.delete(w.id);
      redraw();
    }

    /** Change the order inside the sprint: the items go between `prev` and `next` (0 = none). */
    async function reorderItems(ids: number[], spot: { prev: number; next: number }): Promise<void> {
      if (moving) return;
      const shown = [...colSprint.querySelectorAll<HTMLElement>(".sp-story > .sp-row")].map((r) => Number(r.dataset.id));
      const list = shown.filter((id) => ids.includes(id));
      if (!list.length) return;
      if (list.length === 1) await app.actions.reorder(list[0], spot.prev, spot.next);
      else {
        let prev = spot.prev;
        const steps = list.map((id) => { const p = prev; prev = id; return { label: `#${id}`, run: (w: Writer) => w.reorder(id, p, spot.next) }; });
        try {
          await app.actions.batch(`${list.length} items reordered in ${sprint.name}`, steps, (n, total) => { moving = `Reordering ${n} of ${total}…`; movingNote.textContent = moving; });
        } finally {
          moving = "";
          movingNote.textContent = "";
        }
      }
      redraw();
    }

    // ---------- selection, click, drag ----------
    interface Drag { ids: number[]; from: Col; x: number; y: number; started: boolean; ghost: HTMLElement | null; over: Col | null; rowId: number; spot: { prev: number; next: number } | null }
    let drag: Drag | null = null;
    const dropLine = h("div.sp-drop-line", { "aria-hidden": "true", hidden: true });
    let lastPt = { x: 0, y: 0 };
    let scrollRaf = 0;

    function clickRow(id: number, col: Col, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void {
      if (e.ctrlKey || e.metaKey) {
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        anchor = { id, col };
      } else if (e.shiftKey && anchor && anchor.col === col) {
        const ids = [...(col === "backlog" ? colBacklog : colSprint).querySelectorAll<HTMLElement>(".sp-row[data-drag]")].map((r) => Number(r.dataset.id));
        const a = ids.indexOf(anchor.id), b = ids.indexOf(id);
        if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(ids[i]);
        else selected.add(id);
      } else {
        selected.clear();
        anchor = { id, col };
        app.openItem(id);
      }
      paintSelection();
    }

    function paintSelection(): void {
      for (const r of el.querySelectorAll<HTMLElement>(".sp-row, .sp-task")) {
        const id = Number(r.dataset.id);
        r.classList.toggle("sel", selected.has(id));
        r.classList.toggle("open", openId === id);
        if (r.classList.contains("sp-row")) r.setAttribute("aria-selected", String(selected.has(id)));
      }
      movingNote.textContent = moving || (selected.size ? `${selected.size} selected · ${fmtNum(effortOf(selected))} effort` : "");
    }

    let stopOpenUp: (() => void) | null = null;
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || moving) return;
      const t = e.target as HTMLElement;
      if (t.closest("button, input, a, select, summary")) return;
      const row = t.closest<HTMLElement>(".sp-row, .sp-task");
      if (!row || !el.contains(row)) return;
      const id = Number(row.dataset.id);
      const col = row.dataset.col as Col;
      if (row.classList.contains("sp-task") || !row.dataset.drag) {
        // tasks, closed items and read-only rows only open: when released over the same row
        stopOpenUp?.();
        const up = (ev: PointerEvent): void => {
          stopOpenUp?.();
          // by id: a redraw may have replaced the row meanwhile
          if (ev.type === "pointerup" && (ev.target as Element | null)?.closest?.<HTMLElement>(".sp-row, .sp-task")?.dataset.id === row.dataset.id) app.openItem(id);
        };
        stopOpenUp = (): void => { document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", up); stopOpenUp = null; };
        document.addEventListener("pointerup", up);
        document.addEventListener("pointercancel", up);
        return;
      }
      drag = { ids: [], from: col, x: e.clientX, y: e.clientY, started: false, ghost: null, over: null, rowId: id, spot: null };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", endDrag);
      document.addEventListener("keydown", onKey, true);
    };

    const paintDrop = rafThrottle((): void => {
      colBacklog.classList.toggle("drop-on", !!drag?.started && drag.over === "backlog" && drag.from !== "backlog");
      colSprint.classList.toggle("drop-on", !!drag?.started && drag.over === "sprint" && drag.from !== "sprint");
      drawStats();
      drawSprint();
      drawLoad();
    });

    /** Where a drop inside the sprint list would put the dragged items, and where to draw the line. */
    function reorderSpot(y: number): { prev: number; next: number; top: number; left: number; width: number } | null {
      const d = drag!;
      const blocks = [...colSprint.querySelectorAll<HTMLElement>(".sp-story")];
      const order = blocks.map((b) => Number(b.querySelector<HTMLElement>(".sp-row")?.dataset.id));
      const rest = blocks.filter((_, i) => !d.ids.includes(order[i]));
      if (!rest.length) return null;
      let i = rest.findIndex((b) => { const r = b.getBoundingClientRect(); return y < r.top + r.height / 2; });
      if (i < 0) i = rest.length;
      const n = dropNeighbors(order, d.ids, i);
      const box = colSprint.querySelector(".sp-list")?.getBoundingClientRect();
      if (!n || !box) return null;
      const top = rest[i] ? rest[i].getBoundingClientRect().top : rest[i - 1].getBoundingClientRect().bottom;
      if (top < box.top - 2 || top > box.bottom + 2) return null; // scrolled out of sight
      return { ...n, top, left: box.left + 4, width: box.width - 8 };
    }

    /** The pointer is at x, y: which list it is over, and where a reorder would go. */
    function dragAt(x: number, y: number): void {
      if (!drag?.started) return;
      const under = document.elementFromPoint(x, y)?.closest<HTMLElement>(".sp-col");
      const over = under && el.contains(under) ? (under.dataset.col as Col) : null;
      if (over !== drag.over) { drag.over = over; paintDrop(); }
      const spot = over === "sprint" && drag.from === "sprint" ? reorderSpot(y) : null;
      drag.spot = spot ? { prev: spot.prev, next: spot.next } : null;
      dropLine.hidden = !spot;
      if (spot) Object.assign(dropLine.style, { top: `${spot.top - 1}px`, left: `${spot.left}px`, width: `${spot.width}px` });
    }

    /** While dragging near an edge: scroll the list under the pointer, or the page. */
    const edgeScroll = (): void => {
      scrollRaf = 0;
      if (!drag?.started) return;
      const { x, y } = lastPt;
      let moved = false;
      const list = document.elementFromPoint(x, y)?.closest<HTMLElement>(".sp-list");
      if (list && el.contains(list)) {
        const r = list.getBoundingClientRect();
        const step = y < r.top + 32 ? -8 : y > r.bottom - 32 ? 8 : 0;
        const before = list.scrollTop;
        if (step) list.scrollTop += step;
        moved = list.scrollTop !== before;
      }
      const page = y < 80 ? -12 : y > window.innerHeight - 40 ? 12 : 0;
      if (page) { const before = window.scrollY; window.scrollBy(0, page); moved ||= window.scrollY !== before; }
      if (moved) dragAt(x, y);
      scrollRaf = requestAnimationFrame(edgeScroll);
    };

    const onMove = (e: PointerEvent): void => {
      if (!drag) return;
      // the button went up where this page did not hear it: the drag is over
      if (e.pointerType === "mouse" && e.buttons === 0) { endDrag(); return; }
      if (!drag.started) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
        drag.started = true;
        drag.ids = selected.has(drag.rowId) ? idsIn(drag.from) : [drag.rowId];
        if (!drag.ids.length) drag.ids = [drag.rowId];
        const first = ws.get(drag.ids[0]);
        drag.ghost = h("div.sprint-ghost", { "aria-hidden": "true" },
          drag.ids.length > 1 ? `${drag.ids.length} items · ${fmtNum(effortOf(drag.ids))} effort` : `#${first?.id} ${first?.title ?? ""}`);
        document.body.append(drag.ghost, dropLine);
        document.body.classList.add("sprint-dragging");
        scrollRaf = requestAnimationFrame(edgeScroll);
        for (const r of el.querySelectorAll<HTMLElement>(".sp-row")) r.classList.toggle("dragged", drag.ids.includes(Number(r.dataset.id)));
      }
      e.preventDefault();
      drag.ghost!.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
      lastPt = { x: e.clientX, y: e.clientY };
      dragAt(e.clientX, e.clientY);
    };

    const endDrag = (): void => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", endDrag);
      document.removeEventListener("keydown", onKey, true);
      drag?.ghost?.remove();
      dropLine.remove();
      dropLine.hidden = true;
      cancelAnimationFrame(scrollRaf);
      scrollRaf = 0;
      document.body.classList.remove("sprint-dragging");
      colBacklog.classList.remove("drop-on");
      colSprint.classList.remove("drop-on");
      for (const r of el.querySelectorAll<HTMLElement>(".sp-row.dragged")) r.classList.remove("dragged");
      const was = drag;
      drag = null;
      if (was?.started) { drawStats(); drawSprint(); drawLoad(); }
    };

    const onUp = (e: PointerEvent): void => {
      const d = drag;
      if (!d) return;
      if (!d.started) { endDrag(); clickRow(d.rowId, d.from, e); return; }
      const target = d.over && d.over !== d.from ? d.over : null;
      const spot = d.spot;
      endDrag();
      if (target) void moveItems(d.ids, target);
      else if (spot) void reorderItems(d.ids, spot);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && drag) { e.stopPropagation(); e.preventDefault(); endDrag(); }
    };

    const onRowKey = (e: KeyboardEvent): void => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".sp-row, .sp-task");
      if (!row || e.target !== row) return;
      const id = Number(row.dataset.id);
      if (e.key === "Enter") { e.preventDefault(); app.openItem(id); }
      else if (e.key === " " && row.dataset.drag) { e.preventDefault(); clickRow(id, row.dataset.col as Col, { ctrlKey: true, metaKey: false, shiftKey: false }); }
      else if (e.key === "Escape" && selected.size) { selected.clear(); paintSelection(); }
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("keydown", onRowKey);

    // ---------- drawing ----------
    function draw(): void {
      fillPicker();
      drawCleanup();
      drawGoal();
      void loadGoal(sprint);
      for (const id of [...selected]) { const w = ws.get(id); if (!w || !isOpen(w)) selected.delete(id); }
      drawStats();
      drawCapacity();
      drawLoad();
      people.refresh();
      drawBacklog();
      drawSprint();
      paintSelection();
      void loadCapacity(sprint);
      void loadVelocity();
      // the burndown reads the sprint's tasks day by day: after the rest is on screen
      const it = sprint;
      setTimeout(() => { if (alive) burn.show(it); }, 50);
    }
    const redraw = rafThrottle(() => { if (alive && !drag?.started) draw(); });

    draw();

    return {
      update() { fb.refresh(); redraw(); },
      select(id) {
        openId = id;
        paintSelection();
        if (id != null) {
          const r = el.querySelector<HTMLElement>(`.sp-row[data-id="${id}"], .sp-task[data-id="${id}"]`);
          r?.scrollIntoView({ block: "nearest" });
        }
      },
      unmount() {
        alive = false;
        if (goalEd) void saveGoal(goalEd); // a goal typed just now is not lost
        burn.stop();
        endDrag();
        stopOpenUp?.();
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("keydown", onRowKey);
      },
    };
  },
};
