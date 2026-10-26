// Calendar: Target dates, due dates, sprint ends and closed work on a month calendar.
// Each day shows the items due that day (target date for Epics and Features, due date for tasks),
// sprints run as bands across the top of the weeks, and finished work can show on its closed date.
// Drag a chip to another day to change its date; drag an item from "Without a date" to give it one,
// or onto it to clear the date. Click a day to add a day off or an event there.
import type { Capacity, Iteration, Person, WorkItem } from "../api/types.ts";
import type { App, View } from "../app/context.ts";
import { loadSchedules, runStore } from "../app/scheduler.ts";
import { runFor } from "../core/schedrun.ts";
import { textMatch } from "../core/filters.ts";
import { occurrences, renderTitle } from "../core/scheduler.ts";
import type { Occurrence, Schedule } from "../core/scheduler.ts";
import { initials, isDone, personKey, stateColor, typeColor } from "../core/model.ts";
import { prefs } from "../core/settings.ts";
import { collectionName, newDocId, TeamStore } from "../core/teamstore.ts";
import { h, icon } from "../ui/dom.ts";
import { filterBar, peopleStrip, processFieldNames } from "../ui/filterbar.ts";
import { pageBar } from "../ui/pagebar.ts";
import { undoAll } from "../ui/actions.ts";
import { avatar, closePopup, dialog, errorText, help, popup, segmented, stateMark, toast, toggle, typeMark } from "../ui/kit.ts";
import type { Away, TeamEvent } from "./daysoff.ts";
import { addRange, awayFrom, eventDays, followTo, rangeSummary, removeRange, splitBySprint } from "./daysoff.ts";
import type { Day } from "./timeaxis.ts";
import {
  addMonths, dayIso, dayKey, fmtDay, fmtSpan, localDay, monthGrid, monthKey, monthStart, packLanes, parseMonthKey, parts, planDay, todayDay, weekday,
} from "./timeaxis.ts";

const TARGET = "Microsoft.VSTS.Scheduling.TargetDate";
const DUE = "Microsoft.VSTS.Scheduling.DueDate";
const DRAG_TYPE = "application/x-calendar-item";
const PER_DAY = 4;
const AGENDA_DAYS = 60;

type Mode = "month" | "agenda";

interface Entry {
  item: WorkItem;
  day: Day;
  /** the field that holds the date (null for a closed date, which cannot be moved) */
  field: string | null;
  kind: "target" | "due" | "closed";
  late: boolean;
  done: boolean;
}

/** A story a schedule makes (or has made) on a day */
interface Sched { schedule: Schedule; occ: Occurrence; made?: number }

interface SprintSpan { it: Iteration; start: Day; end: Day }

// ---------- days off and team events: add, change, remove (also used by the Sprint page) ----------

export type DayOffKind = "off" | "teamoff" | "event";

/** What a change starts from: a team event, or a day off as one sprint keeps it. */
export interface DayOffTarget { event?: TeamEvent; away?: { person?: Person; start: Day; end: Day; iterationId: string } }

const eventStore = (app: App): TeamStore<TeamEvent> => new TeamStore<TeamEvent>(app.api, collectionName("events", app.ws.project, app.ws.team));
const workDaysOf = (app: App): number[] => app.ws.settings.workingDays?.length ? app.ws.settings.workingDays : [1, 2, 3, 4, 5];

/** Change one person's (or the team's) days off in one sprint, keeping everything else. Gives back the Undo. */
async function changeDaysOff(app: App, it: Iteration, person: Person | undefined, change: (list: { start: string; end: string }[]) => { start: string; end: string }[]): Promise<() => Promise<void>> {
  const ws = app.ws;
  const cap = await app.api.capacity(ws.project, ws.team, it.id);
  if (!person) {
    const old = cap.teamDaysOff;
    await app.actions.setTeamDaysOff(ws.project, ws.team, it.id, change(old), it.name);
    return () => app.actions.setTeamDaysOff(ws.project, ws.team, it.id, old, it.name);
  }
  const find = (c: Capacity) => c.members.find((x) => personKey(x.person) === personKey(person));
  const m = find(cap);
  const old = m?.daysOff ?? [];
  const activities = m?.activities.length ? m.activities : [{ name: "", capacityPerDay: 0 }];
  await app.actions.setCapacity(ws.project, ws.team, it.id, person.id!, { activities, daysOff: change(old) }, person.displayName, it.name);
  return async () => {
    // hours per day may have changed meanwhile: only the days off go back
    const now = find(await app.api.capacity(ws.project, ws.team, it.id));
    await app.actions.setCapacity(ws.project, ws.team, it.id, person.id!, { activities: now?.activities.length ? now.activities : activities, daysOff: old }, person.displayName, it.name);
  };
}

/** One Undo for the changes made, then `onChange` (also when the Undo fails). */
function undoThen(undos: (() => Promise<unknown>)[], onChange?: () => void): (() => Promise<void>) | undefined {
  const all = undoAll(undos);
  return all ? async () => { try { await all(); } finally { onChange?.(); } } : undefined;
}

/**
 * Add a person's day off, a team day off or a team event; with `edit`, change one. Starts on `from`
 * (and `to`); `person` presets who. `onChange` runs after a change and after its Undo.
 */
export async function dayOffDialog(app: App, opts: { kind?: DayOffKind; person?: Person; from?: Day; to?: Day; edit?: DayOffTarget; onChange?: () => void } = {}): Promise<boolean> {
  const ws = app.ws;
  const edit = opts.edit;
  const me = app.api.ctx.me;
  const base = ws.teamMembers().length ? ws.teamMembers() : ws.people();
  const who0 = edit?.away?.person ?? opts.person ?? me;
  // someone who is not in the list (only an assignee) is added, so they can be picked
  const people = base.some((p) => personKey(p) === personKey(who0)) || (!opts.person && !edit?.away?.person) ? base : [...base, who0];
  const k0: DayOffKind = edit ? (edit.event ? "event" : edit.away?.person ? "off" : "teamoff") : opts.kind ?? "off";
  const span = edit?.event ? eventDays(edit.event) : edit?.away ? { start: edit.away.start, end: edit.away.end } : null;
  const start0 = span?.start ?? opts.from ?? todayDay();
  const end0 = span?.end ?? opts.to ?? start0;
  const kind = h("select.input", { "aria-label": "What", disabled: !!edit },
    h("option", { value: "off", selected: k0 === "off" }, "A person's day off"), h("option", { value: "teamoff", selected: k0 === "teamoff" }, "Team day off (everyone)"),
    h("option", { value: "event", selected: k0 === "event" }, "Team event (release, holiday, offsite…)")) as HTMLSelectElement;
  const who = h("select.input", { "aria-label": "Who" }, people.map((p) => h("option", { value: p.uniqueName, selected: personKey(p) === personKey(who0) }, p.displayName))) as HTMLSelectElement;
  const from = h("input.input", { type: "date", value: dayKey(start0), "aria-label": "From" }) as HTMLInputElement;
  const to = h("input.input", { type: "date", value: dayKey(end0), "aria-label": "To" }) as HTMLInputElement;
  const title = h("input.input", { type: "text", value: edit?.event?.title ?? "", placeholder: "For example: Release 2.4, Company offsite", "aria-label": "Title" }) as HTMLInputElement;
  const whoRow = h("label", null, h("span", null, "Who"), who);
  const titleRow = h("label", null, h("span", null, "Title"), title);
  const summary = h("p.small.cal-sum", { role: "status" });
  const dayOf = (v: string): Day | null => (v ? planDay(v + "T00:00:00Z") : null);
  const check = (): { text: string; ok: boolean } => rangeSummary(dayOf(from.value), dayOf(to.value || from.value), kind.value as DayOffKind, ws.iterations, workDaysOf(app));
  const sync = (): void => {
    whoRow.hidden = kind.value !== "off";
    titleRow.hidden = kind.value !== "event";
    const s = check();
    summary.textContent = s.text;
    summary.classList.toggle("err", !s.ok);
  };
  // To follows From when it was before it or still on the old From
  let oldFrom = from.value;
  from.addEventListener("input", () => { to.value = followTo(from.value, oldFrom, to.value); oldFrom = from.value; sync(); });
  to.addEventListener("input", sync);
  kind.addEventListener("change", sync);
  sync();
  const verb = edit ? "Save" : "Add";
  const r = await dialog(edit ? "Change" : "Add to the calendar", h("div.form", null,
    h("label", null, h("span", null, "What"), kind), whoRow, titleRow,
    h("div.row2", null, h("label", null, h("span", null, "From"), from), h("label", null, h("span", null, "To (the last day)"), to)),
    summary,
    h("p.small.muted", null, "Days off are kept in each sprint's capacity in Azure DevOps, so sprint planning counts them. Team events are kept in this extension.")),
  [{ label: "Cancel", value: "" }, {
    label: verb, value: "done", primary: true,
    onClick: async () => {
      const s = check();
      if (!s.ok) { toast(s.text, { kind: "error" }); return false; }
      const a = dayOf(from.value)!;
      const b = dayOf(to.value || from.value)!;
      const k = kind.value as DayOffKind;
      const undos: (() => Promise<unknown>)[] = [];
      let msg = "";
      try {
        if (k === "event") {
          const t = title.value.trim();
          if (!t) { title.focus(); toast("Give the event a title.", { kind: "error" }); return false; }
          const events = eventStore(app);
          if (edit?.event) {
            const old = edit.event;
            await events.put({ ...old, title: t, start: dayKey(a), end: dayKey(b) });
            undos.push(() => events.put(old));
            msg = `Changed: ${t}`;
          } else {
            const id = newDocId("event");
            await events.put({ id, kind: "event", title: t, start: dayKey(a), end: dayKey(b), createdBy: me.displayName });
            undos.push(() => events.remove(id));
            msg = `Added: ${t}`;
          }
        } else {
          const person = k === "off" ? people.find((p) => p.uniqueName === who.value) : undefined;
          if (k === "off" && !person?.id) { toast("This person is not a team member in Azure DevOps, so a day off cannot be kept for them.", { kind: "error" }); return false; }
          const was = edit?.away;
          const wasIt = was ? ws.iterations.find((x) => x.id === was.iterationId) : undefined;
          if (was && wasIt) undos.push(await changeDaysOff(app, wasIt, was.person, (list) => removeRange(list, was.start, was.end)));
          const { parts, outside } = splitBySprint(a, b, ws.iterations);
          for (const p of parts) undos.push(await changeDaysOff(app, p.iteration, person, (list) => addRange(list, p.start, p.end)));
          const whose = person ? ` for ${person.displayName}` : "";
          msg = `${was ? "Day off changed" : k === "teamoff" ? "Team day off added" : "Day off added"}${whose}: ${fmtSpan({ start: a, end: b })}`
            + (outside ? `; ${outside} day${outside === 1 ? "" : "s"} outside any sprint not kept` : "");
        }
      } catch (e) {
        if (!undos.length) throw e; // nothing changed: the dialog stays open with the reason
        toast(`Not everything was saved: ${errorText(e)}`, { kind: "error", undo: undoThen(undos, opts.onChange) });
        opts.onChange?.();
        return true;
      }
      toast(msg, { kind: "ok", undo: undoThen(undos, opts.onChange) });
      opts.onChange?.();
      return true;
    },
  }]);
  return r === "done";
}

/** Remove a team event or a day off (as one sprint keeps it), with Undo in the message. */
export async function removeDayOff(app: App, target: DayOffTarget, label: string, onChange?: () => void): Promise<void> {
  const undos: (() => Promise<unknown>)[] = [];
  try {
    if (target.event) {
      const ev = target.event;
      const events = eventStore(app);
      await events.remove(ev.id);
      undos.push(() => events.put(ev));
    } else if (target.away) {
      const a = target.away;
      const it = app.ws.iterations.find((x) => x.id === a.iterationId);
      if (it) undos.push(await changeDaysOff(app, it, a.person, (list) => removeRange(list, a.start, a.end)));
    }
    toast(`Removed: ${label}`, { kind: "ok", undo: undoThen(undos, onChange) });
  } catch (e) { toast(errorText(e), { kind: "error" }); }
  onChange?.();
}

export const calendarView: View = {
  id: "calendar",
  title: "Calendar",
  icon: "calendar",
  group: "plan",
  about: "Target dates, due dates, sprints, closed work, days off and team events on a month calendar. Drag an item to another day to change its date.",
  mount(el, app) {
    const ws = app.ws;
    const st = {
      month: parseMonthKey(prefs.get<string>("calendar:month", "")) ?? monthStart(todayDay()),
      mode: prefs.get<Mode>("calendar:mode", "month"),
      finished: prefs.get<boolean>("calendar:finished", false),
      away: prefs.get<boolean>("calendar:away", true),
    };
    // days off (from each sprint's capacity) and team events (the extension's shared storage)
    const capCache = new Map<string, Capacity>();
    const events = new TeamStore<TeamEvent>(app.api, collectionName("events", ws.project, ws.team));
    let away: Away[] = [];
    let teamEvents: TeamEvent[] = [];
    // the stories the team's schedules make in sight: small icons that lead to the Scheduler
    let scheduled = new Map<Day, Sched[]>();
    let schedKey = "";
    let extrasKey = "";
    let extrasToken = 0; // only the newest read may set days off and events
    if (st.mode !== "month" && st.mode !== "agenda") st.mode = "month";
    let selected: number | null = null;

    const setMonth = (m: Day): void => { st.month = monthStart(m); prefs.set("calendar:month", monthKey(st.month)); draw(); };

    // ---------- search and filters: which work items show (people also filter days off) ----------
    const bar = pageBar(app, { search: { placeholder: "Search title, tag, owner, id…", title: "Show only the items that contain every word", label: "Search the calendar", onChange: () => draw(false) } });
    const search = bar.search;
    // the values offered are those of the items the calendar can show
    const fb = filterBar({ key: "calendar.filters", items: () => [...entries(true).map((e) => e.item), ...undated()], names: () => processFieldNames(ws.process), onChange: () => draw(false) });
    const people = peopleStrip({
      api: app.api, key: "calendar.people", onChange: () => draw(false),
      // the items the calendar can show, and the people with days off in sight
      items: () => [...entries(true).map((e) => e.item), ...undated()].filter((w) => fb.test(w)),
      extra: () => (st.away ? away.flatMap((a) => (a.kind === "person" && a.person ? [a.person] : [])) : []),
    });
    const shows = (w: WorkItem): boolean => fb.test(w) && people.test(w) && textMatch(search.words(), w);
    const filtering = (): boolean => fb.active() || people.active() || search.words().length > 0;
    const count = h("span.small.muted.filter-count");

    // ---------- page ----------
    const title = h("h2.cal-title");
    const nav = h("div.cal-nav", null,
      h("button.icon-btn", { title: "Previous month", "aria-label": "Previous month", onclick: () => setMonth(addMonths(st.month, -1)) }, h("span.cal-flip", null, icon("chevron", 16))),
      h("button.btn.small", { title: "Go to this month", onclick: () => setMonth(todayDay()) }, "Today"),
      h("button.icon-btn", { title: "Next month", "aria-label": "Next month", onclick: () => setMonth(addMonths(st.month, 1)) }, icon("chevron", 16)),
      title);
    const main = h("div.cal-main");
    const side = h("aside.cal-side.card-box");
    // drop a dated item on "Without a date" to clear its date
    side.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer?.types.includes(DRAG_TYPE)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      side.classList.add("drop");
    });
    side.addEventListener("dragleave", (ev) => { if (!side.contains(ev.relatedTarget as Node | null)) side.classList.remove("drop"); });
    side.addEventListener("drop", (ev) => {
      side.classList.remove("drop");
      const got = readDrag(ev);
      if (!got) return;
      ev.preventDefault();
      void clearDate(got.id, got.field);
    });
    // line 2: filters, the month and Add; the count at the end. Line 3: people, then how it shows
    bar.line2.append(fb.el, nav,
      h("button.btn.small", { title: app.actions.readOnly ? "Read-only: nothing can be added here" : "Add a day off for a person, a team day off, or a team event", disabled: app.actions.readOnly, onclick: () => addAt() }, icon("plus", 14), "Add"));
    bar.end.append(count);
    bar.line3.append(people.el,
      segmented<Mode>([
        { value: "month", label: "Month", title: "Show a month as a grid" },
        { value: "agenda", label: "Agenda", title: `List the next ${AGENDA_DAYS} days` },
      ], st.mode, (m) => { st.mode = m; prefs.set("calendar:mode", m); draw(); }),
      toggle("Days off and events", st.away, (v) => { st.away = v; prefs.set("calendar:away", v); draw(); }, "Show people's days off, team days off and team events"),
      toggle("Show finished work", st.finished, (v) => { st.finished = v; prefs.set("calendar:finished", v); draw(); }, "Also show done items on the day they were closed"),
      help("Red: the date has passed and the item is not done. Bands at the top of each week are sprints. Done items show crossed out on their closed date when \"Show finished work\" is on."));
    el.append(bar.el, h("div.cal-layout", null, main, side));

    // ---------- data ----------
    function firstDow(): number {
      const wd = ws.settings.workingDays ?? [1, 2, 3, 4, 5];
      return wd.includes(0) && !wd.includes(6) ? 0 : 1;
    }
    const workDays = (): number[] => ws.settings.workingDays?.length ? ws.settings.workingDays : [1, 2, 3, 4, 5];

    /** The dated items to show; `all` = before the search and the filters. */
    function entries(all = false): Entry[] {
      const t = todayDay();
      const req = ws.requirementLevel();
      const out: Entry[] = [];
      for (const it of ws.items.values()) {
        if (!all && !shows(it)) continue;
        const done = isDone(it);
        if (!done) {
          const target = planDay(it.targetDate);
          const due = target == null ? planDay(it.dueDate) : null;
          const day = target ?? due;
          if (day == null) continue;
          out.push({ item: it, day, field: target != null ? TARGET : DUE, kind: target != null ? "target" : "due", late: day < t, done });
        } else if (st.finished) {
          const kind = ws.levelOf(it)?.kind;
          // finished tasks only when they had a due date: a sprint closes dozens of them
          if (kind === "task" && !it.dueDate) continue;
          if (kind === "requirement" && !req.types.includes(it.type)) continue;
          const at = it.closed ?? it.resolved ?? it.stateChanged;
          if (!at) continue;
          out.push({ item: it, day: localDay(at), field: null, kind: "closed", late: false, done });
        }
      }
      const rank = (e: Entry): number => ws.levelOf(e.item)?.rank ?? 9;
      return out.sort((a, b) => a.day - b.day || Number(a.done) - Number(b.done) || Number(b.late) - Number(a.late) || rank(a) - rank(b) || (a.item.order ?? 0) - (b.item.order ?? 0) || a.item.id - b.item.id);
    }

    function sprints(): SprintSpan[] {
      const out: SprintSpan[] = [];
      for (const it of ws.iterations) {
        const s = planDay(it.start);
        const e = planDay(it.finish);
        if (s != null && e != null) out.push({ it, start: Math.min(s, e), end: Math.max(s, e) });
      }
      return out.sort((a, b) => a.start - b.start);
    }

    function byDay(list: Entry[]): Map<Day, Entry[]> {
      const m = new Map<Day, Entry[]>();
      for (const e of list) {
        let l = m.get(e.day);
        if (!l) m.set(e.day, (l = []));
        l.push(e);
      }
      return m;
    }

    // ---------- days off and events ----------
    function visibleRange(): { start: Day; end: Day } {
      if (st.mode === "agenda") { const t = todayDay(); return { start: t, end: t + AGENDA_DAYS - 1 }; }
      const weeks = monthGrid(st.month, firstDow());
      return { start: weeks[0][0], end: weeks[weeks.length - 1][6] };
    }

    async function loadExtras(force = false): Promise<void> {
      if (!st.away) return;
      const r = visibleRange();
      const key = `${r.start}-${r.end}`;
      if (!force && key === extrasKey) return;
      extrasKey = key;
      const token = ++extrasToken;
      const touched = sprints().filter((sp) => sp.end >= r.start && sp.start <= r.end).map((sp) => sp.it);
      try {
        const caps = await Promise.all(touched.map(async (it) => {
          if (force || !capCache.has(it.id)) capCache.set(it.id, await app.api.capacity(ws.project, ws.team, it.id).catch(() => ({ members: [], teamDaysOff: [] } as Capacity)));
          return { iteration: it, capacity: capCache.get(it.id)! };
        }));
        const evs = (await events.all().catch(() => [] as TeamEvent[])).filter((e) => e.kind === "event");
        if (token !== extrasToken) return; // a newer month was asked for meanwhile
        away = awayFrom(caps);
        teamEvents = evs;
      } catch (e) { if (token === extrasToken) toast(errorText(e), { kind: "error" }); }
      if (token === extrasToken) draw(false);
    }

    async function loadScheduled(force = false): Promise<void> {
      const r = visibleRange();
      const key = `${r.start}-${r.end}`;
      if (!force && key === schedKey) return;
      schedKey = key;
      try {
        const [list, runs] = await Promise.all([loadSchedules(app), runStore(app).all().catch(() => [])]);
        const map = new Map<Day, Sched[]>();
        for (const s of list.filter((x) => x.enabled)) {
          for (const occ of occurrences(s, { iterations: ws.iterations }, dayKey(r.start), dayKey(r.end))) {
            const day = planDay(occ.date);
            if (day == null) continue;
            const made = runFor(runs, s.id, occ)?.itemId;
            map.set(day, [...(map.get(day) ?? []), { schedule: s, occ, made }]);
          }
        }
        scheduled = map;
      } catch { scheduled = new Map(); }
      draw(false);
    }

    /** a small story icon: leads to that schedule on the Scheduler page */
    function schedIcon(x: Sched): HTMLElement {
      const title = renderTitle(x.schedule.template.title, x.occ);
      return h("button.cal-sched", {
        type: "button", class: [x.made ? "made" : ""],
        title: `${x.made ? `Made as #${x.made}` : "Scheduled story"}: ${title}\n${x.schedule.name}. Click to open it in the Scheduler.`,
        "aria-label": `${x.made ? "Scheduled story made" : "Scheduled story"}: ${title}`,
        onclick: () => app.navigate("scheduler", { schedule: x.schedule.id }),
      }, icon("repeat", 12));
    }

    interface Mark { start: Day; end: Day; kind: "event" | "teamoff" | "off"; label: string; title: string; away?: Away; event?: TeamEvent; person?: Person }
    function marks(): Mark[] {
      if (!st.away) return [];
      const out: Mark[] = [];
      for (const e of teamEvents) {
        const d = eventDays(e);
        if (d) out.push({ ...d, kind: "event", label: e.title, title: `Team event: ${e.title}\n${fmtSpan(d)}\nAdded by ${e.createdBy}. Click for details.`, event: e });
      }
      // one band per person per range, even when two sprints both list it
      const seen = new Set<string>();
      for (const a of away) {
        const k = `${a.kind}|${a.person ? personKey(a.person) : ""}|${a.start}|${a.end}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (a.kind === "team") out.push({ start: a.start, end: a.end, kind: "teamoff", label: "Team day off", title: `Team day off\n${fmtSpan(a)}. Click for details.`, away: a });
        else if (people.testPerson(a.person)) out.push({ start: a.start, end: a.end, kind: "off", label: `${a.person?.displayName.split(" ")[0] ?? "?"} off`, title: `${a.person?.displayName ?? "Someone"}: day off\n${fmtSpan(a)}. Click for details.`, away: a, person: a.person });
      }
      return out.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
    }

    function markEl(m: Mark, style: Record<string, string>): HTMLElement {
      return h(`button.cal-mark.${m.kind}`, { type: "button", style, title: m.title, onclick: (ev: Event) => markPopup(ev.currentTarget as Element, m) },
        m.kind === "off" && m.person ? h("span.cal-ini", null, initials(m.person.displayName)) : m.kind === "event" ? icon("calendar", 11) : null,
        h("span.n", null, m.label));
    }

    function markPopup(anchor: Element, m: Mark): void {
      const ro = app.actions.readOnly;
      const what = m.kind === "event" ? `Team event: ${m.event!.title}` : m.kind === "teamoff" ? "Team day off" : `${m.person?.displayName ?? "Someone"}: day off`;
      popup(anchor, h("div.cal-pop", null,
        h("div.cal-pop-head", null, what),
        h("p.small", null, fmtSpan(m)),
        m.kind !== "event" ? h("p.small.muted", null, "Kept in the sprint's capacity in Azure DevOps.") : h("p.small.muted", null, `Added by ${m.event!.createdBy}. Kept in this extension, for the whole team.`),
        !ro ? h("div.cal-pop-btns", null,
          h("button.btn.small", { title: m.kind === "event" ? "Change the title or the dates" : m.kind === "off" ? "Change the dates or the person" : "Change the dates", onclick: () => { closePopup(); void dayOffDialog(app, { edit: markTarget(m), onChange: changed }); } }, "Edit"),
          h("button.btn.small.danger", { title: "Remove it; Undo in the message brings it back", onclick: () => { closePopup(); void removeDayOff(app, markTarget(m), `${what}, ${fmtSpan(m)}`, changed); } }, "Remove")) : null), { className: "calendar-pop" });
    }
    const markTarget = (m: Mark): DayOffTarget => (m.event ? { event: m.event } : { away: { person: m.away?.person, start: m.start, end: m.end, iterationId: m.away?.iterationId ?? "" } });

    const changed = (): void => void loadExtras(true);
    /** Where Add starts: today in this month, else the first working day of the month shown. */
    const addStart = (): Day => {
      const t = todayDay();
      if (st.mode !== "month" || monthStart(t) === st.month) return t;
      let d = st.month;
      for (let i = 0; i < 6 && !workDays().includes(weekday(d)); i++) d++;
      return d;
    };
    const addAt = (day?: Day): void => { if (!app.actions.readOnly) void dayOffDialog(app, { from: day ?? addStart(), onChange: changed }); };

    // ---------- writing ----------
    async function moveTo(id: number, field: string, day: Day): Promise<void> {
      const it = ws.get(id);
      if (!it) return;
      const cur = planDay(field === DUE ? it.dueDate : it.targetDate);
      if (cur === day) return;
      const name = field === DUE ? "due date" : "target date";
      await app.actions.setField(id, field, dayIso(day), `#${id} ${short(it.title)}: ${name} ${fmtDay(day)}`);
    }
    async function clearDate(id: number, field: string): Promise<void> {
      const it = ws.get(id);
      if (!it || planDay(field === DUE ? it.dueDate : it.targetDate) == null) return;
      await app.actions.setField(id, field, "", `#${id} ${short(it.title)}: ${field === DUE ? "due date" : "target date"} cleared`);
    }
    const short = (s: string): string => s.length > 40 ? s.slice(0, 38) + "…" : s;

    // ---------- pieces ----------
    function chip(e: Entry, undated = false): HTMLElement {
      const it = e.item;
      const what = e.kind === "target" ? "Target date" : e.kind === "due" ? "Due date" : "Closed";
      const tip = `${it.type} #${it.id}: ${it.title}\n${it.state}${it.assignedTo ? " · " + it.assignedTo.displayName : ""}\n${undated ? "No target date" : `${what}: ${fmtDay(e.day)}`}`
        + (e.late ? "\nLate: the date has passed and it is not done." : "")
        + (e.field ? `\nDrag ${undated ? "onto a day to give it that target date" : "to another day to change the date"}; click to open.` : "\nClick to open.");
      return h("button.cal-chip", {
        type: "button",
        class: [e.late && "late", e.done && "done", selected === it.id && "sel"],
        draggable: e.field ? "true" : undefined,
        dataset: { id: it.id },
        style: { "--c": typeColor(ws.process, it.type), "--sc": stateColor(ws.process, it.type, it.state) },
        title: tip,
        onclick: () => app.openItem(it.id),
        ondragstart: (ev: DragEvent) => startDrag(ev, it, e.field),
      },
      h("i.dot", { "aria-hidden": "true" }),
      e.done ? icon("check", 11) : null,
      h("span.t", null, it.title));
    }

    function startDrag(ev: DragEvent, it: WorkItem, field: string | null): void {
      if (!field || !ev.dataTransfer) { ev.preventDefault(); return; }
      ev.dataTransfer.setData(DRAG_TYPE, `${it.id}|${field}`);
      ev.dataTransfer.setData("text/plain", `#${it.id} ${it.title}`);
      ev.dataTransfer.effectAllowed = "move";
    }

    function readDrag(ev: DragEvent): { id: number; field: string } | null {
      const raw = ev.dataTransfer?.getData(DRAG_TYPE) ?? "";
      const [id, field] = raw.split("|");
      return Number(id) && (field === TARGET || field === DUE) ? { id: Number(id), field } : null;
    }

    // ---------- month ----------
    function drawMonth(): HTMLElement {
      const weeks = monthGrid(st.month, firstDow());
      const t = todayDay();
      const wd = workDays();
      const all = byDay(entries());
      const spr = sprints();
      const cur = ws.currentIteration();
      const month = parts(st.month).m;
      const allMarks = marks();

      const dows = h("div.cal-dows", null, weeks[0].map((d) => h("div.cal-dow", { class: wd.includes(weekday(d)) ? undefined : "off" }, fmtDay(d, { weekday: "short" }))));
      const rows = weeks.map((week) => {
        const w0 = week[0];
        const w6 = week[6];
        const inWeek = spr.filter((s) => s.end >= w0 && s.start <= w6);
        const lanes = packLanes(inWeek.map((s) => ({ start: Math.max(s.start, w0), end: Math.min(s.end, w6) })));
        const sprintLanes = inWeek.length ? Math.max(...lanes) + 1 : 0;
        const mk = allMarks.filter((m) => m.end >= w0 && m.start <= w6);
        const mkLanes = packLanes(mk.map((m) => ({ start: Math.max(m.start, w0), end: Math.min(m.end, w6) })));
        const markCount = mk.length ? Math.max(...mkLanes) + 1 : 0;
        const laneCount = sprintLanes + markCount;
        const row = h("div.cal-week", { class: app.actions.readOnly ? undefined : "addable", style: { gridTemplateRows: `auto${laneCount ? ` repeat(${laneCount}, 20px)` : ""} 1fr` } });
        const bgs = week.map((d, i) => h("div.cal-bg", {
          class: [!wd.includes(weekday(d)) && "off", parts(d).m !== month && "out", d === t && "today"],
          style: { gridColumn: String(i + 1) },
          dataset: { day: d },
          title: app.actions.readOnly ? undefined : `${fmtDay(d, { weekday: "long", day: "numeric", month: "long" })}: click to add a day off or an event`,
        }));
        row.append(...bgs);
        week.forEach((d, i) => {
          const p = parts(d);
          row.append(h("div.cal-num", { class: [d === t && "today", p.m !== month && "out"], style: { gridColumn: String(i + 1), gridRow: "1" }, title: fmtDay(d, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) },
            p.d === 1 ? fmtDay(d, { day: "numeric", month: "short" }) : String(p.d), d === t ? h("span.cal-today-word", null, "Today") : null));
        });
        inWeek.forEach((s, k) => {
          const a = Math.max(s.start, w0);
          const b = Math.min(s.end, w6);
          const starts = s.start >= w0;
          const ends = s.end <= w6;
          const isCur = s.it.id === cur?.id;
          row.append(h("div.cal-band", {
            class: [starts && "start", ends && "end", isCur && "current"],
            style: { gridColumn: `${a - w0 + 1} / ${b - w0 + 2}`, gridRow: String(lanes[k] + 2) },
            title: `${s.it.name}: ${fmtSpan(s)}${isCur ? " (current sprint)" : ""}`,
          }, h("span.n", null, starts ? `${s.it.name} starts` : s.it.name), ends && b - a >= 1 ? h("span.e", null, "ends") : ends ? h("span.e", null, "end") : null));
        });
        mk.forEach((m, k) => {
          const a = Math.max(m.start, w0);
          const b = Math.min(m.end, w6);
          row.append(markEl(m, { gridColumn: `${a - w0 + 1} / ${b - w0 + 2}`, gridRow: String(sprintLanes + mkLanes[k] + 2) }));
        });
        week.forEach((d, i) => {
          const list = all.get(d) ?? [];
          const sch = scheduled.get(d) ?? [];
          if (!list.length && !sch.length) return;
          const cell = h("div.cal-items", { style: { gridColumn: String(i + 1), gridRow: String(laneCount + 2) } },
            sch.length ? h("div.cal-scheds", null, sch.map(schedIcon)) : null, list.slice(0, PER_DAY).map((x) => chip(x)));
          if (list.length > PER_DAY) {
            cell.append(h("button.cal-more", {
              type: "button", title: `Show all ${list.length} items of ${fmtDay(d)}`,
              onclick: (ev: Event) => popup(ev.currentTarget as Element, h("div.cal-pop", null,
                h("div.cal-pop-head", null, fmtDay(d, { weekday: "long", day: "numeric", month: "long" })), list.map((x) => chip(x))), { className: "calendar-pop" }),
            }, `+${list.length - PER_DAY} more`));
          }
          row.append(cell);
        });
        // drop on a day: the column under the pointer
        const colAt = (ev: MouseEvent): number => {
          const r = row.getBoundingClientRect();
          return Math.max(0, Math.min(6, Math.floor(((ev.clientX - r.left) / r.width) * 7)));
        };
        let over = -1;
        const mark = (i: number): void => {
          if (over === i) return;
          if (over >= 0) bgs[over].classList.remove("drop");
          over = i;
          if (i >= 0) bgs[i].classList.add("drop");
        };
        row.addEventListener("dragover", (ev) => {
          if (!ev.dataTransfer?.types.includes(DRAG_TYPE)) return;
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "move";
          mark(colAt(ev));
        });
        row.addEventListener("dragleave", (ev) => { if (!row.contains(ev.relatedTarget as Node | null)) mark(-1); });
        row.addEventListener("drop", (ev) => {
          const got = readDrag(ev);
          const i = colAt(ev);
          mark(-1);
          if (!got) return;
          ev.preventDefault();
          void moveTo(got.id, got.field, week[i]);
        });
        // a click on a day (not on what is in it) adds a day off or an event there
        row.addEventListener("click", (ev) => {
          if ((ev.target as Element).closest(".cal-chip, .cal-mark, .cal-more, button")) return;
          addAt(week[colAt(ev)]);
        });
        return row;
      });
      return h("div.cal-month", { role: "grid", "aria-label": fmtDay(st.month, { month: "long", year: "numeric" }) }, dows, rows);
    }

    // ---------- agenda ----------
    function drawAgenda(): HTMLElement {
      const t = todayDay();
      const end = t + AGENDA_DAYS - 1;
      const list = entries();
      const late = list.filter((e) => e.late);
      const days = byDay(list.filter((e) => e.day >= t && e.day <= end));
      const spr = sprints();
      const cur = ws.currentIteration();
      const agendaMarks = marks();
      const out = h("div.cal-agenda");
      const row = (e: Entry): HTMLElement => h("div.cal-arow", { class: [e.late && "late", e.done && "done", selected === e.item.id && "sel"], dataset: { id: e.item.id } },
        typeMark(ws, e.item.type),
        h("button.cal-atitle", { type: "button", title: `${e.item.type} #${e.item.id}: ${e.item.title}. Click to open.`, onclick: () => app.openItem(e.item.id) },
          h("span.mono.muted", null, `#${e.item.id}`), " ", e.item.title),
        h("span.cal-akind", { title: e.kind === "closed" ? "Closed on this day" : e.kind === "due" ? "Due date" : "Target date" },
          e.kind === "closed" ? "Closed" : e.kind === "due" ? "Due" : "Target", e.late ? ` ${fmtDay(e.day, { day: "numeric", month: "short" })}` : ""),
        stateMark(ws, e.item),
        avatar(app.api, e.item.assignedTo, 20));
      if (late.length) {
        out.append(h("section.cal-aday.late", null,
          h("h3", null, "Late", h("span.muted", null, ` · ${late.length} past their date and not done`)),
          late.map(row)));
      }
      let shown = 0;
      for (let d = t; d <= end; d++) {
        const items = days.get(d) ?? [];
        const marks = spr.filter((s) => s.start === d || s.end === d);
        const offs = agendaMarks.filter((m) => m.start <= d && m.end >= d);
        const sch = scheduled.get(d) ?? [];
        if (!items.length && !marks.length && !offs.length && !sch.length) continue;
        shown++;
        const when = d === t ? "Today" : d === t + 1 ? "Tomorrow" : "";
        out.append(h("section.cal-aday", { class: d === t ? "today" : undefined },
          h("h3", null, fmtDay(d, { weekday: "short", day: "numeric", month: "short" }), when ? h("span.muted", null, ` · ${when}`) : null),
          marks.map((s) => h("div.cal-amark", { class: s.it.id === cur?.id ? "current" : undefined, title: `${s.it.name}: ${fmtSpan(s)}` },
            icon("sprint", 14), `${s.it.name} ${s.start === d && s.end === d ? "starts and ends" : s.start === d ? "starts" : "ends"}`)),
          offs.length ? h("div.cal-aoffs", null, offs.map((m) => markEl(m, {}))) : null,
          sch.map((x) => h("div.cal-amark.sched", null, schedIcon(x), h("span", null, renderTitle(x.schedule.template.title, x.occ)), h("span.muted.small", null, x.made ? ` made as #${x.made}` : " scheduled"))),
          items.map(row)));
      }
      if (!shown && !late.length) out.append(h("div.empty", null, h("h3", null, "Nothing dated"), h("p", null, `No target dates, due dates or sprint changes in the next ${AGENDA_DAYS} days.`)));
      return out;
    }

    // ---------- without a date ----------
    /** Open Epics and Features without a date (before the search and the filters). */
    function undated(): WorkItem[] {
      const types = new Set(ws.portfolioLevels().flatMap((l) => l.types));
      // the same rule as the grid: an item with a target or a due date is on the grid, not here
      return [...ws.items.values()].filter((it) => types.has(it.type) && !isDone(it) && planDay(it.targetDate) == null && planDay(it.dueDate) == null)
        .sort((a, b) => (ws.levelOf(a)?.rank ?? 9) - (ws.levelOf(b)?.rank ?? 9) || (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);
    }

    function drawSide(): void {
      const all = undated();
      const list = all.filter(shows);
      side.replaceChildren(
        h("h3", null, "Without a date", h("span.muted", null, list.length < all.length ? ` (${list.length} of ${all.length})` : ` (${list.length})`), " ",
          help("Open Epics and Features without a target date or a due date. Drag one onto a day to give it that target date; drop an item from the calendar here to clear its date.")),
        list.length
          ? h("div.cal-side-list", null, list.map((it) => chip({ item: it, day: 0, field: TARGET, kind: "target", late: false, done: false }, true)))
          : h("p.muted.small", null, all.length ? "None matches the search and the filters." : "Every open Epic and Feature has a date."));
    }

    function draw(fetch = true): void {
      if (fetch) queueMicrotask(() => { void loadExtras(); void loadScheduled(); });
      nav.hidden = st.mode !== "month";
      title.textContent = fmtDay(st.month, { month: "long", year: "numeric" });
      main.replaceChildren(st.mode === "month" ? drawMonth() : drawAgenda());
      drawSide();
      people.refresh();
      if (filtering()) {
        const n = entries().length;
        const total = entries(true).length;
        count.textContent = `${n} of ${total} dated items shown`;
      } else count.textContent = "";
    }

    draw();

    return {
      update() { fb.refresh(); void loadScheduled(true); draw(); },
      select(id) {
        selected = id;
        for (const e of el.querySelectorAll<HTMLElement>(".cal-chip.sel, .cal-arow.sel")) e.classList.remove("sel");
        if (id == null) return;
        for (const e of el.querySelectorAll<HTMLElement>(`.cal-chip[data-id="${id}"], .cal-arow[data-id="${id}"]`)) e.classList.add("sel");
      },
    };
  },
};
