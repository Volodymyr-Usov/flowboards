// Scheduler: the team's recurring stories. A schedule says when (a date, an outlook, every week or month,
// a point of the sprint, the start or end of a month or quarter) and what story to make (title, text, who
// gets it, tasks, where it goes). Anyone in the team can edit them. The stories are made by whoever has
// Flowboards open (src/app/scheduler.ts); stories missed meanwhile are made later, up to a week back.
import type { View } from "../app/context.ts";
import { loadSchedules, produce, runId, runStore, SCHEDULED_EVENT, scheduleStore } from "../app/scheduler.ts";
import type { RunDoc } from "../app/scheduler.ts";
import { every, newDocId } from "../core/teamstore.ts";
import {
  blankSchedule, describeTrigger, dueOccurrences, nextOccurrence, scheduleProblem, todayLocal, weekdayName,
} from "../core/scheduler.ts";
import type { Schedule, Template, Trigger } from "../core/scheduler.ts";
import { cleanTemplates, EXAMPLE_TASKS } from "../core/templates.ts";
import type { ChildTemplate } from "../core/templates.ts";
import { h, icon } from "../ui/dom.ts";
import { confirm, dialog, empty, errorText, failed, itemLink, spinner, toast, typeMark } from "../ui/kit.ts";
import { boardColumns } from "./boardmodel.ts";
import { pageBar } from "../ui/pagebar.ts";

const KINDS: { value: Trigger["kind"]; label: string }[] = [
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "sprint", label: "In the sprint (start, middle or end)" },
  { value: "period", label: "Start or end of a month or quarter" },
  { value: "date", label: "On a specific date" },
  { value: "outlook", label: "Outlook: ahead of a specific date" },
];
const ASSIGN: { value: Template["assign"]["mode"]; label: string }[] = [
  { value: "none", label: "Nobody" },
  { value: "person", label: "One person" },
  { value: "rotate", label: "In turn, through the team" },
  { value: "random", label: "Drawn at random from the team" },
];
const PLACEMENT: { value: Template["placement"]; label: string }[] = [
  { value: "backlog", label: "The backlog" },
  { value: "current", label: "The current sprint" },
  { value: "next", label: "The next sprint" },
  { value: "occurrence", label: "The sprint it is made for (sprint triggers)" },
];
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

export const schedulerView: View = {
  id: "scheduler",
  title: "Scheduler",
  icon: "repeat",
  group: "plan",
  about: "Stories the team needs again and again, made on their own: on a date, every week or month, at the start or end of a sprint or a quarter. Anyone in the team can edit the schedules; whoever has Flowboards open makes what is due.",
  mount(el, app, params) {
    const ws = app.ws;
    const ro = app.actions.readOnly;
    const body = h("div.sch");
    const bar = pageBar(app);
    const newBtn = ro ? null : h("button.btn", { type: "button", title: "Add a schedule", onclick: () => void edit(null) }, icon("plus", 14), "New schedule");
    if (newBtn) bar.line2.append(newBtn);
    el.append(bar.el, body);

    let schedules: Schedule[] | null = null;
    let runs: RunDoc[] = [];
    let problem: unknown = null;
    let alive = true;

    async function load(): Promise<void> {
      try {
        [schedules, runs] = await Promise.all([loadSchedules(app), runStore(app).all()]);
        problem = null;
      } catch (e) { problem = e; }
      if (alive) draw();
    }

    const when = (iso: string): string => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const personName = (u: string): string => ws.people().find((p) => p.uniqueName === u)?.displayName ?? u;

    function assignText(t: Template): string {
      if (t.assign.mode === "none") return "Nobody";
      if (t.assign.mode === "person") return personName(t.assign.person);
      const pool = t.assign.pool.length ? `${t.assign.pool.length} chosen people` : "the whole team";
      return t.assign.mode === "rotate" ? `In turn: ${pool}` : `Drawn at random: ${pool}`;
    }
    const placeText = (t: Template): string => (t.placement === "fixed" ? t.iteration.split("\\").pop() ?? "A chosen sprint" : PLACEMENT.find((p) => p.value === t.placement)!.label.replace(/ \(.*\)/, ""));
    const tasksText = (t: Template): string => (t.tasks.mode === "none" ? "No tasks" : t.tasks.mode === "standard" ? "The team's standard tasks" : `${t.tasks.custom.length} own task${t.tasks.custom.length === 1 ? "" : "s"}`);

    function card(s: Schedule): HTMLElement {
      const ctx = { iterations: ws.iterations };
      const today = todayLocal();
      const mine = runs.filter((r) => r.scheduleId === s.id);
      const done = mine.filter((r) => r.state === "done").sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
      const due = dueOccurrences(s, ctx, today).filter((o) => !mine.some((r) => r.id === runId(s.id, o.key)));
      const next = nextOccurrence(s, ctx, today);
      const state = !s.enabled ? "Paused" : due.length ? `${due.length} due now: made as soon as a page is open` : next ? `Next: ${when(next.date)}` : "Nothing left to make";
      const last = done[0];
      const lastItem = last?.itemId ? ws.get(last.itemId) : undefined;
      return h(`div.sch-card${s.enabled ? "" : ".off"}`, { dataset: { id: s.id } },
        h("div.sch-head", null,
          h("b.sch-name", null, s.name),
          h("span.sch-state", null, state),
          h("span.spacer"),
          ro ? null : h("label.sch-on", { title: s.enabled ? "On: pause it" : "Paused: turn it on" },
            h("input", { type: "checkbox", checked: s.enabled, onchange: (e: Event) => void toggle(s, (e.target as HTMLInputElement).checked) }), "On"),
          ro ? null : h("button.btn.small", { type: "button", title: "Make the story now, on top of the schedule", onclick: () => void makeNow(s) }, icon("plus", 12), "Make now"),
          ro ? null : h("button.btn.small", { type: "button", onclick: () => void edit(s) }, "Edit"),
          ro ? null : h("button.icon-btn.small", { type: "button", title: "Delete this schedule (the stories it made stay)", "aria-label": "Delete the schedule", onclick: () => void remove(s) }, icon("trash", 14))),
        h("div.sch-rows", null,
          h("div.sch-row", null, h("span.lab", null, "When"), describeTrigger(s.trigger)),
          h("div.sch-row", null, h("span.lab", null, "Story"), h("span", null, s.template.title),
            h("span.muted", null, ` · ${assignText(s.template)} · ${tasksText(s.template)} · ${placeText(s.template)}${s.template.column ? ` · starts in ${s.template.column}` : ""}`)),
          last ? h("div.sch-row", null, h("span.lab", null, "Last made"),
            lastItem ? itemLink(ws, lastItem, (w) => app.openItem(w.id)) : h("span.mono", null, last.itemId ? `#${last.itemId}` : "—"),
            h("span.muted", null, ` for ${when(last.date)}${last.by ? `, by ${last.by}` : ""}`)) : null,
          done.length > 1 ? h("details.sch-hist", null, h("summary", null, `${done.length} made so far`),
            h("ul", null, done.slice(0, 12).map((r) => h("li", null, h("span.mono", null, r.itemId ? `#${r.itemId}` : "—"), ` ${r.title ?? ""} `, h("span.muted", null, `for ${r.date}`))))) : null));
    }

    let focused = "";
    function draw(): void {
      if (problem) { body.replaceChildren(failed(problem, () => void load())); return; }
      if (!schedules) { body.replaceChildren(spinner("Reading the schedules…")); return; }
      body.replaceChildren(
        h("p.small.muted.sch-intro", null, "A schedule makes a story on its own: whoever has Flowboards open does it, once for each occurrence. If nobody had a page open, it is made later, up to a week back. Anyone in the team can edit these."),
        schedules.length
          ? h("div.sch-list", null, schedules.map(card))
          : empty("No schedules yet", "Add one for the stories that come back: a weekly review, the start of every sprint, the end of every quarter.", ro ? undefined : { label: "New schedule", onClick: () => void edit(null) }));
      // coming from a calendar icon: show that schedule once
      const want = params?.schedule;
      if (want && focused !== want) {
        const card = body.querySelector<HTMLElement>(`.sch-card[data-id="${CSS.escape(want)}"]`);
        if (card) { focused = want; card.classList.add("focus"); card.scrollIntoView({ block: "center" }); }
      }
    }

    async function toggle(s: Schedule, on: boolean): Promise<void> {
      try { await scheduleStore(app).update(s.id, (d) => ({ ...d, enabled: on })); } catch (e) { toast(errorText(e), { kind: "error" }); }
      await load();
    }

    async function remove(s: Schedule): Promise<void> {
      if (!(await confirm("Delete this schedule?", `"${s.name}" stops making stories. The ones it made stay where they are.`, "Delete", true))) return;
      try { await scheduleStore(app).remove(s.id); } catch (e) { toast(errorText(e), { kind: "error" }); }
      await load();
    }

    async function makeNow(s: Schedule): Promise<void> {
      const cur = ws.currentIteration();
      const occ = { key: `now-${Date.now().toString(36)}`, date: todayLocal(), sprint: cur?.start && cur.finish ? { name: cur.name, path: cur.path, start: cur.start.slice(0, 10), finish: cur.finish.slice(0, 10) } : undefined };
      try {
        const item = await produce(app, s, occ, runs);
        if (item) toast(`Made #${item.id} ${item.title}`, { kind: "ok" });
      } catch (e) { toast(errorText(e), { kind: "error" }); }
      await load();
    }

    // ---------- the form ----------

    async function edit(existing: Schedule | null): Promise<void> {
      const today = todayLocal();
      const s: Schedule = existing ? structuredClone(existing) : blankSchedule(newDocId("s"), today);
      const members = ws.teamMembers().length ? ws.teamMembers() : ws.people();
      const input = (props: Record<string, unknown>): HTMLInputElement => h("input.input", props) as HTMLInputElement;
      const sel = <T extends string>(options: { value: T; label: string }[], value: T): HTMLSelectElement =>
        h("select.input", null, options.map((o) => h("option", { value: o.value, selected: o.value === value }, o.label))) as HTMLSelectElement;
      const row = (label: string, ...kids: (Node | string | null)[]): HTMLElement => h("label.sch-f", null, h("span", null, label), ...kids);

      const name = input({ type: "text", value: s.name, maxlength: 120, placeholder: "For example: Weekly review", "aria-label": "Name of the schedule" });
      const kind = sel(KINDS, s.trigger.kind);
      const whenBox = h("div.sch-when");
      // the fields of each kind of trigger
      const t = s.trigger;
      const date = input({ type: "date", value: "date" in t ? t.date : addDaysStr(today, 14), "aria-label": "Date" });
      const lead = input({ type: "number", min: 0, max: 365, value: t.kind === "outlook" ? t.leadDays : 14, "aria-label": "Days ahead" });
      const weekdays = MON_FIRST.map((d) => h("label.sch-day", null, h("input", { type: "checkbox", checked: t.kind === "weekly" ? t.weekdays.includes(d) : d === 1, dataset: { d } }), weekdayName(d).slice(0, 3)));
      const everyWeeks = input({ type: "number", min: 1, max: 52, value: t.kind === "weekly" ? t.everyWeeks : 1, "aria-label": "Every how many weeks" });
      const day = input({ type: "number", min: 1, max: 31, value: t.kind === "monthly" && t.day > 0 ? t.day : 1, "aria-label": "Day of the month" });
      const lastDay = h("input", { type: "checkbox", checked: t.kind === "monthly" && t.day === 0 }) as HTMLInputElement;
      const everyMonths = input({ type: "number", min: 1, max: 12, value: t.kind === "monthly" ? t.everyMonths : 1, "aria-label": "Every how many months" });
      const sprintAt = sel([{ value: "start", label: "Start of the sprint" }, { value: "mid", label: "Middle of the sprint" }, { value: "end", label: "End of the sprint" }] as { value: "start" | "mid" | "end"; label: string }[], t.kind === "sprint" ? t.at : "start");
      const everySprints = input({ type: "number", min: 1, max: 12, value: t.kind === "sprint" ? t.everySprints : 1, "aria-label": "Every how many sprints" });
      const periodAt = sel([{ value: "month-start", label: "Start of the month" }, { value: "month-end", label: "End of the month" }, { value: "quarter-start", label: "Start of the quarter" }, { value: "quarter-end", label: "End of the quarter" }] as { value: "month-start" | "month-end" | "quarter-start" | "quarter-end"; label: string }[], t.kind === "period" ? t.at : "month-start");
      const offset = input({ type: "number", min: -60, max: 60, value: t.kind === "sprint" || t.kind === "period" ? t.offsetDays : 0, "aria-label": "Days after (negative: before)" });
      const preview = h("p.small.muted.sch-preview", { role: "status" });

      const trigger = (): Trigger => {
        switch (kind.value) {
          case "date": return { kind: "date", date: date.value };
          case "outlook": return { kind: "outlook", date: date.value, leadDays: Number(lead.value) || 0 };
          case "weekly": return { kind: "weekly", weekdays: weekdays.filter((l) => (l.querySelector("input") as HTMLInputElement).checked).map((l) => Number((l.querySelector("input") as HTMLInputElement).dataset.d)), everyWeeks: Number(everyWeeks.value) || 1 };
          case "monthly": return { kind: "monthly", day: lastDay.checked ? 0 : Number(day.value) || 1, everyMonths: Number(everyMonths.value) || 1 };
          case "sprint": return { kind: "sprint", at: sprintAt.value as "start" | "mid" | "end", offsetDays: Number(offset.value) || 0, everySprints: Number(everySprints.value) || 1 };
          default: return { kind: "period", at: periodAt.value as "month-start", offsetDays: Number(offset.value) || 0 };
        }
      };
      const drawWhen = (): void => {
        const k = kind.value;
        const fields: Node[] = [];
        if (k === "date" || k === "outlook") fields.push(row("Date", date));
        if (k === "outlook") fields.push(row("Made this many days ahead", lead), h("p.small.muted", null, "The story appears that many days before the date and carries the date as its target."));
        if (k === "weekly") fields.push(h("div.sch-f", null, h("span", null, "On"), h("div.sch-days", null, ...weekdays)), row("Every … weeks", everyWeeks));
        if (k === "monthly") fields.push(row("On day", day, h("label.sch-inline", null, lastDay, "the last day of the month")), row("Every … months", everyMonths));
        if (k === "sprint") fields.push(row("At", sprintAt), row("Days after the point (negative: before)", offset), row("Every … sprints", everySprints));
        if (k === "period") fields.push(row("At", periodAt), row("Days after the point (negative: before)", offset));
        whenBox.replaceChildren(...fields);
        refresh();
      };
      const refresh = (): void => {
        const probe: Schedule = { ...s, trigger: trigger(), created: today };
        try {
          const next = nextOccurrence(probe, { iterations: ws.iterations }, today);
          const todayIsDue = dueOccurrences(probe, { iterations: ws.iterations }, today).some((o) => o.date === today);
          preview.textContent = `${describeTrigger(probe.trigger)}. ${todayIsDue ? "It is due today. " : ""}${next ? `Next: ${when(next.date)}.` : todayIsDue ? "" : kind.value === "sprint" ? "No sprint with dates is set up for the team yet." : "No date left."}`;
        } catch { preview.textContent = ""; }
      };
      kind.addEventListener("change", drawWhen);
      whenBox.addEventListener("input", refresh);
      whenBox.addEventListener("change", refresh);

      const title = input({ type: "text", value: s.template.title, maxlength: 255, placeholder: "For example: Review the week {week}", "aria-label": "Title of the story" });
      const text = h("textarea.input.sch-text", { rows: 4, placeholder: "What the story is for, and what to do. Blank lines and \"- \" lists are kept.", "aria-label": "Description of the story" }, s.template.description) as HTMLTextAreaElement;
      const assign = sel(ASSIGN, s.template.assign.mode);
      const person = sel([{ value: "", label: "Pick a person…" }, ...members.map((p) => ({ value: p.uniqueName, label: p.displayName }))], s.template.assign.person);
      const pool = members.map((p) => h("label.sch-day.wide", null, h("input", { type: "checkbox", checked: s.template.assign.pool.includes(p.uniqueName), dataset: { u: p.uniqueName } }), p.displayName));
      const poolBox = h("details.sch-pool", null, h("summary", null, "Who is in the turn (none ticked: the whole team)"), h("div.sch-days", null, ...pool));
      const assignBox = h("div.sch-assign", null, person, poolBox);
      const drawAssign = (): void => { person.hidden = assign.value !== "person"; poolBox.hidden = assign.value !== "rotate" && assign.value !== "random"; };
      assign.addEventListener("change", drawAssign);
      drawAssign();
      const tasksMode = sel([{ value: "none", label: "No tasks" }, { value: "standard", label: "The team's standard tasks (Settings > Standard tasks)" }, { value: "custom", label: "Its own list of tasks" }] as { value: Template["tasks"]["mode"]; label: string }[], s.template.tasks.mode);
      // the task list looks like the story's Tasks section in the details panel: a bin, the task, its hours, "New Task" under it
      const taskLevel = ws.taskLevel();
      const taskType = taskLevel?.defaultType ?? "Task";
      const activityField = ws.process.fields.activity;
      const hasActivity = !!taskLevel && taskLevel.types.some((t) => { const fs = ws.process.types[t]?.fields; return !fs || fs.includes(activityField); });
      const own: ChildTemplate[] = structuredClone(s.template.tasks.custom);
      const taskBox = h("section.psec.sch-tasks");
      const drawTasks = (focus = -1): void => {
        const standard = tasksMode.value === "standard";
        taskBox.hidden = tasksMode.value === "none";
        const list = standard ? cleanTemplates(app.settings.shared.childTemplates?.[ws.requirementLevel().defaultType]) : own;
        const rows = list.map((t, k) => h("li", null,
          standard ? null : h("button.icon-btn.child-del", { type: "button", title: "Delete this task", "aria-label": `Delete task ${k + 1}`, onclick: () => { own.splice(k, 1); drawTasks(); } }, icon("trash", 13)),
          typeMark(ws, t.type ?? taskType),
          standard ? h("span.sch-t-title", null, t.title) : h("input.input.sch-t-input", {
            value: t.title, placeholder: "Title of the task", maxlength: 255, "aria-label": `Title of task ${k + 1}`, dataset: { k, ownEnter: "1" },
            oninput: (e: Event) => { t.title = (e.target as HTMLInputElement).value; },
            onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); own.splice(k + 1, 0, { title: "" }); drawTasks(k + 1); } },
          }),
          hasActivity && (standard ? t.activity : true) ? (standard ? h("span.muted.small", null, t.activity) : h("input.input.sch-t-act", {
            value: t.activity ?? "", placeholder: "Activity", maxlength: 60, "aria-label": `Activity of task ${k + 1}`,
            oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v.trim()) t.activity = v; else delete t.activity; },
          })) : null,
          standard ? (t.remaining ? h("span.muted.small", null, `${t.remaining} h`) : null) : h("input.input.sch-t-hours", {
            type: "number", min: 0, step: 0.5, value: t.remaining ?? "", placeholder: "h", "aria-label": `Hours of task ${k + 1}`,
            oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v !== "" && Number(v) >= 0) t.remaining = Number(v); else delete t.remaining; },
          })));
        taskBox.replaceChildren(
          h("h3", null, "Tasks", h("span.count", null, list.length ? ` ${list.length}` : "")),
          list.length ? h("ul.child-list", null, rows) : h("p.small.muted", null, standard ? "The team has no standard tasks for this type yet (Settings > Standard tasks)." : "No tasks yet."),
          ...(standard ? [] : [h("div.row-tools", null,
            h("button.btn.small", { type: "button", onclick: () => { own.push({ title: "" }); drawTasks(own.length - 1); } }, icon("plus", 12), `New ${taskType}`),
            !own.length ? h("button.btn.small", { type: "button", title: `Start with: ${EXAMPLE_TASKS.map((x) => x.title).join(", ")}`, onclick: () => { own.push(...EXAMPLE_TASKS.map((x) => ({ ...x }))); drawTasks(); } }, icon("sparkle", 12), "Examples") : null)]));
        if (focus >= 0) taskBox.querySelector<HTMLInputElement>(`input.sch-t-input[data-k="${focus}"]`)?.focus();
      };
      tasksMode.addEventListener("change", () => drawTasks());
      drawTasks();
      // where the story goes: the sprint by a rule, or one chosen sprint; and the column (state) it starts in
      const sprints = ws.iterations.filter((i) => i.start && i.finish).sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!));
      const current = s.template.placement === "fixed" ? `fixed:${s.template.iteration}` : s.template.placement;
      const placement = sel<string>([...PLACEMENT, ...sprints.map((i) => ({ value: `fixed:${i.path}`, label: `Sprint: ${i.name}` }))], current);
      const columns = boardColumns(ws.process, ws.requirementLevel(), ws.board, app.settings.shared.boardMode === "states" || !ws.board?.columnField ? "states" : "columns");
      const column = sel<string>([{ value: "", label: "Where a new story starts (New)" }, ...columns.map((c) => ({ value: c.name, label: c.name }))], columns.some((c) => c.name === s.template.column) ? s.template.column : "");
      const tags = input({ type: "text", value: s.template.tags.join(", "), placeholder: "Scheduled is always added", "aria-label": "More tags" });

      const form = h("div.form.sch-form", null,
        row("Name", name),
        h("h4.sch-sub", null, "When"),
        row("It is made", kind), whenBox, preview,
        h("h4.sch-sub", null, "The story"),
        row("Title", title), h("p.small.muted", null, "Tokens: {date} {day} {week} {month} {quarter} {year} {sprint}"),
        row("Description", text),
        row("Assigned to", assign), assignBox,
        row("Tasks", tasksMode), taskBox,
        row("Sprint", placement),
        row("Starts in", column),
        row("More tags", tags));
      drawWhen();

      const read = (): Schedule => ({
        ...s,
        name: name.value.trim(),
        trigger: trigger(),
        template: {
          title: title.value.trim(),
          description: text.value,
          assign: { mode: assign.value as Template["assign"]["mode"], person: person.value, pool: pool.map((l) => l.querySelector("input") as HTMLInputElement).filter((i) => i.checked).map((i) => i.dataset.u!) },
          tasks: { mode: tasksMode.value as Template["tasks"]["mode"], custom: cleanTemplates(own) },
          placement: (placement.value.startsWith("fixed:") ? "fixed" : placement.value) as Template["placement"],
          iteration: placement.value.startsWith("fixed:") ? placement.value.slice(6) : "",
          column: column.value,
          tags: tags.value.split(",").map((x) => x.trim()).filter(Boolean),
        },
      });
      const baseline = JSON.stringify(read());

      let saved = false;
      await dialog(existing ? "Edit the schedule" : "New schedule", form, [
        { label: "Cancel", value: "" },
        {
          label: "Save", primary: true, value: "save",
          onClick: async () => {
            const next = read();
            const why = scheduleProblem(next);
            if (why) { toast(why, { kind: "error" }); return false; }
            if (next.template.tasks.mode === "custom" && !next.template.tasks.custom.length) { toast("Write at least one task, or choose another way.", { kind: "error" }); return false; }
            try {
              await scheduleStore(app).upsert(next.id, (cur) => ({ ...next, created: cur?.created ?? next.created, by: cur?.by ?? app.api.ctx.me?.displayName, __etag: cur?.__etag }));
              saved = true;
              return true;
            } catch (e) { toast(errorText(e), { kind: "error" }); return false; }
          },
        },
      ], { wide: true, dirty: () => JSON.stringify(read()) !== baseline });
      if (saved) { toast("Schedule saved. The stories that are due are made as soon as a page is open.", { kind: "ok" }); await load(); }
    }

    function addDaysStr(day: string, n: number): string {
      const d = new Date(day + "T00:00:00");
      d.setDate(d.getDate() + n);
      return todayLocal(d);
    }

    void load();
    const stop = every(30000, load);
    const onMade = (): void => void load();
    document.addEventListener(SCHEDULED_EVENT, onMade);
    return {
      update() { if (alive) draw(); },
      unmount() { alive = false; stop(); document.removeEventListener(SCHEDULED_EVENT, onMade); },
    };
  },
};

