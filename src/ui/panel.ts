// The details panel on the right: every view opens it for a work item. Fields save when you leave
// them, press Enter or pick with the mouse; Esc puts the shown value back. Long texts save as you type.
// Closing the panel saves a text box that is still being edited, so typed text is never lost.
// A redraw keeps the focused field (and waits while a field has the focus).
import { prFromArtifact, REL, relId } from "../api/api.ts";
import { person } from "../api/normalize.ts";
import type { PullRequest, Update, WorkItem } from "../api/types.ts";
import type { App } from "../app/context.ts";
import type { CheckItem } from "../core/checklist.ts";
import { cleanList, fromList, moveItem, newCheckItem, progress, tick } from "../core/checklist.ts";
import { daysInState, daysSince, fmtDate, fmtDays, isDone, leaf, levelOf, orderedStates, plainText } from "../core/model.ts";
import { cleanTemplates, missingChildren } from "../core/templates.ts";
import { fieldLabel } from "../core/writes.ts";
import { draftTasks, draftTexts } from "./aihelp.ts";
import { createItem, sprintChoices } from "./create.ts";
import { followUp, splitStory, tasksOf } from "./storyactions.ts";
import { canSplitByHalf, followUpTitle, partTitles, splitTasks } from "../core/storysplit.ts";
import { askDelete } from "./deleteask.ts";
import { TASK_DRAG } from "./dragtypes.ts";
import { h, icon } from "./dom.ts";
import { avatar, errorText, itemLink, itemPicker, personPicker, spinner, stateMark, toast, typeMark } from "./kit.ts";
import { attachMentions, lockMentions, mentionSourceFor } from "./mentions.ts";
import { sanitize, sanitizeToString, textToHtml } from "./sanitize.ts";
import { tagInput, usedTags } from "./taginput.ts";

export interface Panel {
  open(id: number): void;
  close(): void;
  current(): number | null;
  onChange(fn: (id: number | null) => void): void;
}

export function createPanel(app: App): Panel {
  const ws = () => app.ws;
  const root = h("aside.panel", { "aria-label": "Work item details", hidden: true, tabindex: -1 });
  const resizer = h("div.panel-resize", { title: "Drag to make the panel wider or narrower" });
  root.append(resizer);
  const body = h("div.panel-body");
  root.append(body);
  document.body.append(root);
  let currentId: number | null = null;
  const listeners: ((id: number | null) => void)[] = [];
  let width = Number(readStore(() => localStorage.getItem("ado-dashboard:panelWidth"))) || 520;
  root.style.width = width + "px";

  resizer.addEventListener("pointerdown", (e) => {
    resizer.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => { width = Math.max(360, Math.min(window.innerWidth - 80, window.innerWidth - ev.clientX)); root.style.width = width + "px"; };
    const up = (): void => { resizer.removeEventListener("pointermove", move); try { localStorage.setItem("ado-dashboard:panelWidth", String(width)); } catch { /* not kept */ } };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up, { once: true });
  });

  document.addEventListener("keydown", (e) => {
    if (currentId == null || e.defaultPrevented) return;
    // Alt+Left, like the browser's Back: to the item this one was opened from
    if (e.key === "ArrowLeft" && e.altKey && trail.length && !document.querySelector(".backdrop, .popup")) { e.preventDefault(); back(); return; }
    if (e.key !== "Escape") return;
    const t = e.target instanceof HTMLElement ? e.target : document.body;
    if (t.closest(".panel") &&(t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "INPUT")) { t.blur(); return; }
    if (document.querySelector(".backdrop, .popup")) return;
    // Esc steps back to the item this one was opened from; with nowhere to go back to, it closes the panel
    if (trail.length) back(); else close();
  });
  // the mouse's Back button (button 4): the same step back, instead of leaving the page
  const mouseBack = (ev: Event): void => {
    const e = ev as MouseEvent;
    if (e.button !== 3 || currentId == null || !trail.length || document.querySelector(".backdrop")) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "mouseup") back();
  };
  for (const type of ["mousedown", "mouseup", "auxclick"]) document.addEventListener(type, mouseBack, true);

  ws().onChange((changed) => { if (currentId != null && changed.has(currentId)) render(false); });

  /**
   * Is someone in the middle of something a redraw would destroy? A box being edited (or one whose
   * save failed and keeps the typed text), the comment box while it has the focus, or AI task
   * suggestions not yet created or discarded.
   */
  const busyHere = (): boolean => Boolean(root.querySelector(".editing, .draft-box")) || inField();
  /** the focus is in a field of the panel (a redraw would take it, and a value not saved yet) */
  const inField = (): boolean => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && body.contains(a) && (a.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(a.tagName));
  };
  /** a background redraw was skipped while busy: done when the person is finished */
  let missed = false;
  root.addEventListener("focusout", () => setTimeout(catchUp, 0));
  function catchUp(): void {
    if (missed && !busyHere() && currentId != null) { missed = false; void render(false); }
  }

  function notify(): void { for (const f of listeners) f(currentId); }

  function flush(): void {
    const active = document.activeElement as HTMLElement | null;
    if (active && root.contains(active)) active.blur();
  }

  /**
   * Where the focus was before the panel opened: it goes back there on close. When the view drew that
   * element again meanwhile, the new one with the same data-id (or data-open) takes the focus.
   */
  let returnTo: { el: HTMLElement; sel: string | null } | null = null;
  function backTo(): HTMLElement | null {
    if (!returnTo) return null;
    if (returnTo.el.isConnected) return returnTo.el;
    const el = returnTo.sel ? document.querySelector<HTMLElement>(returnTo.sel) : null;
    return el && !root.contains(el) ? el : null;
  }

  /** the items this one was opened from inside the panel (a task from its story), the latest last */
  const trail: number[] = [];
  /** open an item from the outside (a card, a link in a view): a fresh start, nothing to go back to */
  function open(id: number): void {
    if (id !== currentId) trail.length = 0;
    show(id);
  }
  /** open an item from inside the panel (the parent, a child, a dependency): Back, Esc and the mouse's Back return */
  function go(id: number): void {
    if (currentId != null && id !== currentId) { trail.push(currentId); if (trail.length > 30) trail.shift(); }
    show(id);
  }
  function back(): void {
    const prev = trail.pop();
    if (prev != null) show(prev);
  }

  function show(id: number): void {
    flush();
    if (root.hidden) {
      const a = document.activeElement as HTMLElement | null;
      const k = a ? ["id", "open"].find((x) => a.dataset[x]) : undefined;
      returnTo = a && a !== document.body && !root.contains(a)
        ? { el: a, sel: k ? `${a.tagName.toLowerCase()}[data-${k}="${CSS.escape(a.dataset[k]!)}"]` : null } : null;
    }
    currentId = id;
    root.hidden = false;
    document.body.classList.add("panel-open");
    // the focus moves to the panel (without scrolling the page), so Tab goes through its fields
    root.focus({ preventScroll: true });
    void render(true).then(() => {
      const a = document.activeElement;
      if (currentId === id && (!a || a === document.body || !a.isConnected)) root.focus({ preventScroll: true });
    });
    notify();
  }

  function close(): void {
    const hadFocus = root.contains(document.activeElement);
    flush();
    trail.length = 0;
    currentId = null;
    root.hidden = true;
    document.body.classList.remove("panel-open");
    notify();
    const back = backTo();
    returnTo = null;
    if (back && (hadFocus || document.activeElement === document.body)) back.focus({ preventScroll: true });
  }

  let loadToken = 0;
  let shownId: number | null = null; // the item the body shows now
  /** an item that is not part of the team's work (another team, another project), read for the panel only */
  let outside: WorkItem | null = null;
  /** `force`: also while a field has the focus (a save failed: the field must show the saved value again) */
  async function render(full: boolean, force = false): Promise<void> {
    const id = currentId;
    if (id == null) return;
    // keep the scroll position and any box being edited when the item changes underneath
    // (checked before taking a turn, so a full render still on its way is not dropped)
    if (!full && (force ? root.querySelector(".editing, .draft-box") : busyHere())) { missed = true; return; }
    missed = false;
    const token = ++loadToken;
    let it = ws().get(id);
    const scroll = body.scrollTop;
    // while another item's details are still shown, show a spinner instead of them
    if (shownId !== id && (!it || !it.relations)) { body.replaceChildren(spinner()); shownId = null; }
    if (!it && outside?.id === id && !full) it = outside;
    if (!it) {
      // read from whatever project it is in (project ""), with its links; kept out of the team's work
      try { it = await ws().api.item("", id); } catch (e) { if (token === loadToken) body.replaceChildren(h("div.pad", null, errorText(e))); return; }
      if (token !== loadToken) return;
      outside = it;
    }
    if (!it.relations) {
      await ws().withRelations([id]).catch(() => {});
      if (token !== loadToken) return;
      it = ws().get(id) ?? it;
    }
    const focus = full ? null : focusMark();
    body.replaceChildren(view(it, !ws().get(id)));
    shownId = id;
    if (!full) body.scrollTop = scroll;
    focus?.();
  }

  /**
   * Where the focus is in the body, to put it back after a redraw: the field with the same
   * data-fkey, else the control at the same place; else the panel itself.
   */
  function focusMark(): (() => void) | null {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !body.contains(a)) return null;
    const key = a.dataset.fkey;
    const all = (): HTMLElement[] => [...body.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [contenteditable='true'], [contenteditable='plaintext-only']")];
    const at = all().indexOf(a);
    return () => {
      const el = (key ? body.querySelector<HTMLElement>(`[data-fkey="${key}"]`) : null) ?? (at >= 0 ? all()[at] : null);
      (el ?? root).focus({ preventScroll: true });
    };
  }

  /** A change that failed or was cancelled: draw the item again, so no control keeps the unsaved value. */
  function redrawOnFail(id: number, job: Promise<unknown>): void {
    void job.then((r) => { if (!r && currentId === id) void render(false, true); });
  }

  /** `notOurs`: the item is not part of the team's work here; it is shown, and changed in Azure DevOps. */
  function view(it: WorkItem, notOurs = false): HTMLElement {
    const w = ws();
    const level = levelOf(w.process, it.type);
    const actions = app.actions;
    const ro = actions.readOnly || notOurs;
    const checkChip = h("button.ck-chip", { hidden: true, title: "Checklist: ticked of all. Click to go to it." });
    /** two buttons for a story: split it in half, or make a follow-up (see ui/storyactions.ts) */
    function storyTools(item: WorkItem, readonly: boolean, kind: string | undefined): HTMLElement[] {
      if (readonly || kind !== "requirement") return [];
      const tasks = tasksOf(app, item);
      const can = canSplitByHalf(tasks);
      const [p1, p2] = partTitles(item.title);
      return [
        h("button.btn.small.ph-tool", { type: "button", disabled: !can, "aria-label": "Split in half",
          title: can ? `Split in half: the first ${splitTasks(tasks).first.length} of its ${tasks.length} tasks stay here and the story is renamed “${p1}”; the other ${splitTasks(tasks).second.length} move to a new story “${p2}” that has the same description, owner, sprint, tags, estimate and parent. You are asked first, and Undo is offered afterwards.`
            : "Split in half needs at least two tasks, so that each part gets some. Add tasks first.",
          onclick: () => void splitStory(app, item) }, icon("split", 13), "Split"),
        h("button.btn.small.ph-tool", { type: "button", "aria-label": "Follow-up",
          title: `Follow-up: make a new story “${followUpTitle(item)}” with the same description, under the same parent, in the backlog, for what comes after this one. This story only gets a comment that links to it. Undo is offered afterwards.`,
          onclick: () => void followUp(app, item) }, icon("followup", 13), "Follow-up"),
      ];
    }
    const head = h("header.panel-head", null,
      h("div.ph-top", null,
        trail.length ? h("button.icon-btn.ph-back", { type: "button", "aria-label": "Back", title: `Back to ${ws().get(trail[trail.length - 1])?.title ?? "#" + trail[trail.length - 1]} (Esc, Alt+Left or the mouse's Back button)`, onclick: back }, icon("back")) : null,
        typeMark(w, it.type), h("span.muted", null, `${it.type} `),
        h("a.mono", { href: w.api.itemUrl(it.project ?? w.project, it.id), target: "_blank", rel: "noopener", title: "Open in Azure DevOps" }, `#${it.id}`, icon("external", 12)),
        checkChip,
        h("span.spacer"),
        ...storyTools(it, ro, level?.kind),
        h("button.icon-btn", { title: "Close (Esc)", "aria-label": "Close", onclick: close }, icon("close"))),
      editableTitle(it, ro),
      notOurs ? h("p.muted.small", null, `Not part of ${w.team}'s work${it.project && it.project !== w.project ? ` (project ${it.project})` : ""}: shown here, changed in Azure DevOps.`) : null);

    // ---- fields ----
    const states = orderedStates(w.process, [it.type]);
    const board = w.board;
    const useColumns = level?.kind === "requirement" && board?.columnField && app.settings.shared.boardMode === "columns";
    const stateCtl = useColumns
      ? confirmed(h("select.input", { disabled: ro, "aria-label": "Column", dataset: { fkey: "state" } },
        board!.columns.map((c) => h("option", { value: c.name, selected: c.name === it.boardColumn }, `${c.name} (${c.stateMappings[it.type] ?? "?"})`))),
        (v) => actions.move(it.id, { column: v }))
      : confirmed(h("select.input", { disabled: ro, "aria-label": "State", dataset: { fkey: "state" } },
        states.map((s) => h("option", { value: s.name, selected: s.name === it.state }, s.name))),
        (v) => actions.move(it.id, { state: v }));
    // Close: straight to the finished state (on a team board, its last column), never skipping the team's rules; the panel closes with it
    const doneStates = new Set(states.filter((s) => s.category === "Completed").map((s) => s.name));
    const closeTarget: { state?: string; column?: string } | null = useColumns
      ? (() => { const c = [...board!.columns].reverse().find((x) => doneStates.has(x.stateMappings[it.type] ?? "")); return c ? { column: c.name } : null; })()
      : (() => { const s = states.find((x) => x.category === "Completed"); return s ? { state: s.name } : null; })();
    const closeBtn = !ro && level?.kind === "requirement" && !isDone(it) && closeTarget
      ? h("button.btn.small.close-item", { type: "button", title: `Close this ${it.type.toLowerCase()} now: moves it to ${closeTarget.column ?? closeTarget.state}. The team's rules still apply.`,
        onclick: async (e: Event) => {
          const b = e.currentTarget as HTMLButtonElement;
          b.disabled = true;
          const done = await actions.close(it.id, closeTarget);
          b.disabled = false;
          if (done && currentId === it.id) close();
        } }, icon("check", 13), "Close")
      : null;
    const ownerBtn = h("button.owner-btn", {
      disabled: ro, title: "Change the owner", dataset: { fkey: "owner" },
      onclick: (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        // the focus comes back to the button after a pick, so Tab goes on from here
        personPicker(w.api, b, w.people(), it.assignedTo, (p) => { b.focus({ preventScroll: true }); void actions.assign(it.id, p ? p.uniqueName : null); });
      },
    }, avatar(w.api, it.assignedTo, 22), h("span", null, it.assignedTo?.displayName ?? "Nobody"));
    const iterCtl = confirmed(h("select.input", { disabled: ro, "aria-label": "Sprint", dataset: { fkey: "sprint" } },
      sprintChoices(w.settings.backlogIteration ?? w.project, w.iterations, it.iteration, { ended: true }).map((c) => h("option", { value: c.path, selected: c.path === it.iteration }, c.label))),
      (v) => actions.setField(it.id, "System.IterationPath", v));
    const tagsCtl = tagsField(it, ro);
    const num = (field: string, value: number | undefined, step = 1) => confirmed(h("input.input", {
      type: "number", min: 0, step, value: value ?? "", disabled: ro, "aria-label": fieldLabel(field), dataset: { fkey: field },
    }), (v) => actions.setField(it.id, field, v === "" ? "" : Number(v)), false);
    const date = (field: string, value: string | undefined) => confirmed(h("input.input", {
      type: "date", value: value ? value.slice(0, 10) : "", disabled: ro, "aria-label": fieldLabel(field), dataset: { fkey: field },
    }), (v) => actions.setField(it.id, field, v ? new Date(v + "T00:00:00Z").toISOString() : ""));
    const pf = w.process.fields;
    const typeFields = w.process.types[it.type]?.fields;
    const has = (f: string) => !typeFields || typeFields.includes(f);
    const parentLevel = level ? w.process.levels.find((l) => l.rank === level.rank - 1) : undefined;
    const parent = w.get(it.parent);
    const parentCtl = h("div.parent-ctl", null,
      parent ? itemLink(w, parent, (p) => go(p.id)) : it.parent ? h("span.mono", null, "#" + it.parent) : h("span.muted", null, "None"),
      parentLevel && !ro ? h("button.btn.small", {
        dataset: { fkey: "parent" },
        onclick: (e: Event) => {
          const b = e.currentTarget as HTMLButtonElement;
          itemPicker(w, b, (x) => parentLevel.types.includes(x.type) && x.id !== it.id, (p) => { b.focus({ preventScroll: true }); void actions.reparent(it.id, p ? p.id : 0); }, { placeholder: `Find a ${parentLevel.defaultType}`, allowNone: "No parent" });
        },
      }, "Change") : null);

    const grid = h("div.fields", null,
      row(useColumns ? "Column" : "State", stateCtl, closeBtn, useColumns ? h("span.muted", null, `State: ${it.state}`) : null),
      row("Owner", ownerBtn),
      row("Sprint", iterCtl),
      parentLevel || it.parent ? row("Parent", parentCtl) : null,
      row("Tags", tagsCtl),
      level?.kind !== "task" && has(pf.effort) ? row(fieldLabel(pf.effort), num(pf.effort, it.effort)) : null,
      level?.kind === "task" ? row("Remaining", num(pf.remaining, it.remaining, 0.5)) : null,
      level?.kind === "task" && it.originalEstimate != null ? row("Estimate", h("span", null, `${it.originalEstimate} h, done ${it.completedWork ?? 0} h`)) : null,
      has("Microsoft.VSTS.Common.Priority") ? row("Priority", confirmed(h("select.input", { disabled: ro, "aria-label": "Priority", dataset: { fkey: "priority" } },
        // "–" while it has none, so 1 can be picked too
        it.priority == null ? h("option", { value: "", selected: true }, "–") : null,
        [1, 2, 3, 4].map((p) => h("option", { value: p, selected: it.priority === p }, String(p)))),
      (v) => actions.setField(it.id, "Microsoft.VSTS.Common.Priority", v === "" ? "" : Number(v)))) : null,
      level?.kind === "portfolio" || has("Microsoft.VSTS.Scheduling.TargetDate") && (it.startDate || it.targetDate) ? row("Start", date("Microsoft.VSTS.Scheduling.StartDate", it.startDate)) : null,
      level?.kind === "portfolio" || has("Microsoft.VSTS.Scheduling.TargetDate") && (it.startDate || it.targetDate) ? row("Target", date("Microsoft.VSTS.Scheduling.TargetDate", it.targetDate)) : null,
      level?.kind === "task" && has("Microsoft.VSTS.Scheduling.DueDate") ? row("Due", date("Microsoft.VSTS.Scheduling.DueDate", it.dueDate)) : null,
      row("Area", h("span", { title: it.area }, leaf(it.area))),
    );

    const facts = h("p.facts.muted", null,
      stateMark(w, it), ` for ${fmtDays(daysInState(it))} · created ${fmtDate(it.created)}${it.createdBy ? " by " + it.createdBy.displayName : ""} · changed ${daysSince(it.changed) < 1 ? "today" : `${fmtDays(daysSince(it.changed))} ago`}`);

    const sections: HTMLElement[] = [
      richSection("Description", "System.Description", it, ro, level?.kind !== "task"),
      level?.kind !== "task" ? richSection("Acceptance criteria", "Microsoft.VSTS.Common.AcceptanceCriteria", it, ro, true) : h("span"),
      notOurs ? h("span") : checklistSection(it, checkChip),
      notOurs ? h("span") : childrenSection(it),
      depsSection(it, ro),
      prSection(it),
      commentsSection(it, ro),
      historySection(it),
    ];
    return h("div", null, head, facts, grid, sections);
  }

  function row(label: string, ctl: Node, ...extra: (Node | null)[]): HTMLElement {
    return h("div.field", null, h("label", null, label), h("div", null, ctl, ...extra));
  }

  /**
   * A field that saves once its value is chosen: on Enter, on leaving it, and (`pickSaves`, for lists
   * and dates) right away when picked with the mouse. Arrow keys only move the value, so ↓ in State
   * does not move the item at each step. Esc puts the shown value back, without saving.
   */
  function confirmed<E extends HTMLInputElement | HTMLSelectElement>(el: E, save: (v: string) => Promise<unknown>, pickSaves = true): E {
    let shown = el.value;
    let saving = false;
    let keyed = false; // the last change came from the keyboard
    const id = currentId;
    const commit = (): void => {
      if (saving || el.value === shown || el.disabled) return;
      const v = el.value;
      saving = true;
      void save(v).then((r) => {
        saving = false;
        // changed again (and left) while saving: that value is saved too
        if (r) { shown = v; if (el.isConnected && document.activeElement !== el) commit(); return; }
        if (el.isConnected) el.value = shown;
        if (currentId === id) void render(false, true);
      });
    };
    el.addEventListener("keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === "Enter") { e.preventDefault(); commit(); }
      else if (k === "Escape") {
        // nothing changed: Esc goes on to the panel (a list closes it, a box lets go of the focus)
        if (el.value === shown) return;
        e.preventDefault();
        el.value = shown;
        el.blur();
      } else if (k !== "Tab" && k !== "Shift") keyed = true;
    });
    el.addEventListener("mousedown", () => { keyed = false; });
    el.addEventListener("change", () => {
      if (pickSaves && !keyed) commit();
      keyed = false;
    });
    el.addEventListener("blur", commit);
    return el;
  }

  /** Tags as chips: each one added or removed is saved at once (one save at a time, Undo in the message). */
  function tagsField(it: WorkItem, ro: boolean): HTMLElement {
    let saved = [...it.tags];
    let latest = saved;
    let saving = false;
    const ti = tagInput({
      tags: it.tags, disabled: ro, label: "Tags",
      known: () => usedTags(ws().items.values()),
      onChange: (t) => { latest = t; void push(); },
    });
    ti.input.dataset.fkey = "tags";
    const key = (xs: string[]): string => xs.map((t) => t.toLowerCase()).sort().join(";");
    const has = (xs: string[], t: string): boolean => xs.some((x) => x.toLowerCase() === t.toLowerCase());
    async function push(): Promise<void> {
      if (saving) return; // the save that runs takes the newest list when it is done
      const want = latest;
      if (key(want) === key(saved)) return;
      const added = want.filter((t) => !has(saved, t));
      const removed = saved.filter((t) => !has(want, t));
      const quote = (xs: string[]): string => xs.map((t) => `"${t}"`).join(", ");
      const msg = !removed.length ? `Tag ${quote(added)} added to #${it.id}` : !added.length ? `Tag ${quote(removed)} removed from #${it.id}` : `Tags of #${it.id} changed`;
      saving = true;
      const r = await app.actions.setField(it.id, "System.Tags", want.join("; "), msg);
      saving = false;
      if (!r) { ti.set(saved); if (currentId === it.id) void render(false, true); return; }
      saved = want;
      void push();
    }
    return ti.el;
  }

  function editableTitle(it: WorkItem, ro: boolean): HTMLElement {
    const hint = "Click to edit; Enter saves";
    const el = h("h2.panel-title", { contenteditable: ro ? "false" : "plaintext-only", spellcheck: "true", title: ro ? "" : hint }, it.title);
    const giveUp = (): void => { el.textContent = it.title; el.classList.remove("editing", "unsaved"); el.title = hint; };
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); el.blur(); }
      // Esc puts the saved title back (and does not close the panel)
      if (e.key === "Escape") { e.preventDefault(); giveUp(); el.blur(); }
    });
    el.addEventListener("focus", () => el.classList.add("editing"));
    el.addEventListener("blur", () => {
      const v = (el.textContent ?? "").trim();
      if (!v || v === it.title) { giveUp(); return; }
      // "editing" stays while saving, so a redraw meanwhile does not drop the typed text
      void app.actions.setField(it.id, "System.Title", v).then((r) => {
        if (!el.isConnected) return;
        if (r) { el.classList.remove("editing", "unsaved"); catchUp(); return; }
        // not saved: the typed text stays, with the reason; Enter tries again, Esc gives up
        el.classList.add("unsaved");
        el.title = `Not saved: ${app.actions.lastError || "Azure DevOps refused"}. Click, then Enter tries again; Esc puts the saved title back.`;
      });
    });
    return el;
  }

  /**
   * Description or acceptance criteria: you type in the box, it saves by itself (a moment after you
   * stop typing, and when you leave the box). @ and # suggest people and work items to mention.
   */
  function richSection(title: string, field: string, it: WorkItem, ro: boolean, aiOk: boolean): HTMLElement {
    const html = String(it.fields[field] ?? "");
    const sec = h("section.psec", null, h("h3", null, title));
    const tools = h("div.sec-tools");
    sec.firstChild!.appendChild(tools);
    if (ro) {
      sec.append(h("div.rich", null, html ? sanitize(html) : h("span.muted", null, "Empty")));
      return sec;
    }
    const ed = h("div.rich.editor", { contenteditable: "true", spellcheck: "true", role: "textbox", "aria-multiline": "true", "aria-label": title,
      "data-placeholder": `Type the ${title.toLowerCase()}; @ mentions a person, # a work item. Saved as you type.` });
    ed.append(sanitize(html));
    lockMentions(ed);
    if (!plainText(ed.innerHTML) && !ed.querySelector("img")) ed.replaceChildren();
    /** what Azure DevOps has: the box read back the same way, so an untouched box saves nothing */
    let lastSaved = sanitizeToString(ed.innerHTML);
    const status = h("span.save-state", { role: "status" });
    tools.append(status);
    let timer = 0;
    let saving = false;
    let again = false;
    let draft = false; // an AI draft waits for Keep
    const setStatus = (text: string, kind = ""): void => { status.textContent = text; status.className = `save-state ${kind}`.trim(); };
    const idle = (): void => { if (document.activeElement !== ed && !saving && !ed.classList.contains("unsaved") && !draft) ed.classList.remove("editing"); };
    async function save(): Promise<void> {
      clearTimeout(timer);
      if (draft) return;
      if (saving) { again = true; return; }
      const v = sanitizeToString(ed.innerHTML);
      if (v === lastSaved) { if (!ed.classList.contains("unsaved")) setStatus(""); idle(); return; }
      saving = true;
      setStatus("Saving…");
      const ok = await app.actions.saveTyped(it.id, field, plainText(v) || /<img/i.test(v) ? v : "");
      saving = false;
      if (ok) {
        lastSaved = v;
        ed.classList.remove("unsaved");
        setStatus("Saved", "ok");
        setTimeout(() => { if (status.textContent === "Saved") setStatus(""); }, 2000);
      } else {
        // not saved: the typed text stays (and the box is not redrawn); the next change tries again
        ed.classList.add("unsaved");
        setStatus(`Not saved: ${app.actions.lastError || "Azure DevOps refused"}`, "err");
      }
      if (again) { again = false; void save(); return; }
      idle();
      if (!ed.classList.contains("editing")) catchUp();
    }
    ed.addEventListener("focus", () => ed.classList.add("editing"));
    ed.addEventListener("input", () => {
      ed.classList.add("editing");
      if (!plainText(ed.innerHTML) && !ed.querySelector("img")) ed.replaceChildren();
      if (draft) return;
      if (!status.classList.contains("err")) setStatus("Editing…");
      clearTimeout(timer);
      timer = window.setTimeout(() => void save(), 1200);
    });
    ed.addEventListener("blur", () => { void save(); idle(); });
    // links in the box open with Ctrl (or Cmd) and a click, as in Azure DevOps; a plain click puts the caret there
    ed.addEventListener("click", (e) => {
      const a = (e.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!a || a.getAttribute("href") === "#") return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); window.open(a.href, "_blank", "noopener"); }
    });
    for (const a of ed.querySelectorAll<HTMLAnchorElement>("a[href]")) if (a.getAttribute("href") !== "#") a.title = a.title || "Ctrl+click to open";
    attachMentions(ed, mentionSourceFor(app));
    if (aiOk && app.ai.enabled) {
      tools.append(h("button.btn.small", {
        title: "Draft this text with AI; it is saved only when you click Keep",
        onclick: async (e: Event) => {
          const b = e.currentTarget as HTMLButtonElement;
          b.disabled = true;
          b.textContent = "Drafting…";
          try {
            const d = await draftTexts(app, { id: it.id, type: it.type, title: it.title, parent: ws().get(it.parent), description: it.description, acceptance: it.acceptance });
            draft = true;
            ed.classList.add("editing");
            ed.replaceChildren(sanitize(textToHtml(field === "System.Description" ? d.description : d.acceptance)));
            const bar = h("div.editbar", null,
              h("span.draft-note", null, "AI draft: check it, then Keep"),
              h("button.btn.small", { onclick: () => { draft = false; bar.remove(); ed.replaceChildren(sanitize(lastSaved)); lockMentions(ed); idle(); } }, "Discard"),
              h("button.btn.small.primary", { onclick: () => { draft = false; bar.remove(); void save(); } }, "Keep"));
            ed.after(bar);
          } catch (err) { toast((err as Error).message, { kind: "error" }); }
          b.disabled = false;
          b.replaceChildren(icon("sparkle", 12), "AI draft");
        },
      }, icon("sparkle", 12), "AI draft"));
    }
    sec.append(ed);
    return sec;
  }

  /** The item's checklist: kept in the extension's storage, read when the panel draws. */
  function checklistSection(it: WorkItem, chip: HTMLElement): HTMLElement {
    const lists = app.actions.checklists;
    const ro = app.actions.readOnly;
    const defaults = cleanList(app.settings.shared.checklists?.[it.type]);
    const count = h("span.count");
    const sec = h("section.psec.ck", null, h("h3", null, "Checklist", count));
    const body = h("div.ck-body");
    let items: CheckItem[] | null = lists.cached(it.id) ?? null;
    let saving = false;
    /** changes made while a save runs: saved one after the other when it is done, never dropped */
    const waiting: { fn: (xs: CheckItem[]) => CheckItem[]; what: string }[] = [];
    const add = h("input.input.ck-new", { type: "text", maxlength: 200, placeholder: "Add an item and press Enter", "aria-label": "New checklist item" }) as HTMLInputElement;
    const addItem = (): void => {
      const text = add.value.trim();
      if (!text) return;
      add.value = "";
      void change((xs) => [...xs, newCheckItem(text)], `added "${text}"`);
    };
    add.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } });
    add.addEventListener("focus", () => add.classList.add("editing"));
    add.addEventListener("blur", () => add.classList.remove("editing"));
    chip.onclick = () => sec.scrollIntoView({ block: "start", behavior: "smooth" });
    sec.append(body);
    if (!ro) sec.append(h("div.ck-add", null, add, h("button.btn.small", { title: "Add this item to the checklist", onclick: addItem }, icon("plus", 12), "Add")));

    async function change(fn: (xs: CheckItem[]) => CheckItem[], what: string): Promise<void> {
      if (items) draw(fn(items)); // show the change at once; the saved list replaces it
      waiting.push({ fn, what });
      if (saving) return; // the save that runs takes this one next
      saving = true;
      while (waiting.length) {
        const next = waiting.shift()!;
        const saved = await app.actions.changeChecklist(it.id, next.fn, next.what);
        // the saved list, with the changes still waiting shown on top
        draw(waiting.reduce((xs, w) => w.fn(xs), saved ?? lists.cached(it.id) ?? []));
      }
      saving = false;
    }

    function draw(list: CheckItem[] | null, error?: string): void {
      items = list;
      const p = progress(list ?? []);
      count.textContent = p.total ? ` ${p.done}/${p.total}` : "";
      chip.hidden = !p.total;
      chip.className = `ck-chip${p.total && p.done === p.total ? " done" : ""}`;
      chip.replaceChildren(icon("check", 12), `${p.done}/${p.total}`);
      chip.title = `Checklist: ${p.done} of ${p.total} ticked. Click to go to it.`;
      if (error) { body.replaceChildren(h("p.muted.small", null, error)); return; }
      if (!list) { body.replaceChildren(h("p.muted.small", null, "Loading…")); return; }
      if (!list.length) {
        body.replaceChildren(h("div.ck-empty", null,
          h("span.muted.small", null, defaults.length ? `No checklist yet. The team has a list for ${it.type}.` : "No checklist yet."),
          defaults.length && !ro ? h("button.btn.small", {
            title: `Start with the team's list: ${defaults.join(", ")}`,
            onclick: () => void change(() => fromList(defaults), "the team's list added"),
          }, icon("check", 12), `Use the team's list (${defaults.length})`) : null));
        return;
      }
      body.replaceChildren(h("ul.ck-list", null, list.map((x, i) => row(x, i, list.length))));
    }

    function row(x: CheckItem, i: number, n: number): HTMLElement {
      const byName = x.by ? ws().people().find((p) => p.uniqueName.toLowerCase() === x.by!.toLowerCase())?.displayName ?? x.by : "";
      const who = x.done && byName ? `Ticked by ${byName}${x.at ? " on " + fmtDate(x.at) : ""}` : "";
      const text = h("span.ck-text", { title: ro ? who : `${who ? who + ". " : ""}Click to rename` }, x.text);
      if (!ro) text.addEventListener("click", () => rename(x, text));
      return h(`li${x.done ? ".done" : ""}`, null,
        h("input", {
          type: "checkbox", checked: x.done, disabled: ro, "aria-label": x.text, title: ro ? who : x.done ? "Untick" : "Tick",
          onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; void change((xs) => tick(xs, x.id, on, app.api.ctx.me.uniqueName), `${on ? "ticked" : "unticked"} "${x.text}"`); },
        }),
        text,
        ro ? null : h("span.ck-tools", null,
          h("button.icon-btn.small", { title: "Move up", "aria-label": "Move up", disabled: i === 0, onclick: () => void change((xs) => moveItem(xs, x.id, -1), `moved "${x.text}" up`) }, icon("up", 12)),
          h("button.icon-btn.small", { title: "Move down", "aria-label": "Move down", disabled: i === n - 1, onclick: () => void change((xs) => moveItem(xs, x.id, 1), `moved "${x.text}" down`) }, icon("down", 12)),
          h("button.icon-btn.small", { title: "Remove this item", "aria-label": "Remove", onclick: () => void change((xs) => xs.filter((y) => y.id !== x.id), `removed "${x.text}"`) }, icon("close", 12))));
    }

    function rename(x: CheckItem, text: HTMLElement): void {
      const input = h("input.input.ck-edit.editing", { type: "text", value: x.text, maxlength: 200, "aria-label": "Rename the item" }) as HTMLInputElement;
      let done = false;
      const finish = (save: boolean): void => {
        if (done) return;
        done = true;
        const v = input.value.trim().replace(/\s+/g, " ");
        if (save && v && v !== x.text) void change((xs) => xs.map((y) => (y.id === x.id ? { ...y, text: v } : y)), `renamed "${x.text}" to "${v}"`);
        else draw(items);
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener("blur", () => finish(true));
      text.replaceWith(input);
      input.focus();
      input.select();
    }

    draw(items);
    // read the newest version (someone else may have ticked something)
    void lists.get(it.id).then((xs) => { if (!saving && !sec.querySelector(".ck-edit")) draw(xs); }, (e) => { if (!items) draw(null, `Checklist not read: ${errorText(e)}`); });
    return sec;
  }

  function childrenSection(it: WorkItem): HTMLElement {
    const w = ws();
    const level = levelOf(w.process, it.type);
    const childLevel = level ? w.process.levels.find((l) => l.rank === level.rank + 1) : undefined;
    const kids = w.children(it.id);
    const sec = h("section.psec", null, h("h3", null, childLevel ? childLevel.name : "Children", h("span.count", null, kids.length ? ` ${kids.filter(isDone).length}/${kids.length} done` : "")));
    if (!childLevel && !kids.length) return h("span");
    const list = h("ul.child-list");
    for (const k of kids) {
      const isTask = levelOf(w.process, k.type)?.kind === "task";
      const doneState = orderedStates(w.process, [k.type]).find((s) => s.category === "Completed")?.name;
      const openState = orderedStates(w.process, [k.type]).find((s) => s.category === "Proposed")?.name;
      list.append(h("li", {
        // a task can be dragged onto a story card of the Board (it moves under that story)
        class: [isTask && !app.actions.readOnly ? "drag-task" : ""], draggable: isTask && !app.actions.readOnly ? "true" : undefined,
        ondragstart: (e: DragEvent) => {
          if (!isTask || !e.dataTransfer) { e.preventDefault(); return; }
          e.dataTransfer.setData(TASK_DRAG, String(k.id));
          e.dataTransfer.setData("text/plain", `#${k.id} ${k.title}`);
          e.dataTransfer.effectAllowed = "move";
        },
      },
        isTask && doneState && !app.actions.readOnly ? h("input", {
          type: "checkbox", checked: isDone(k), title: isDone(k) ? `Reopen (to ${openState})` : `Close (to ${doneState})`,
          onchange: (e: Event) => redrawOnFail(it.id, app.actions.move(k.id, { state: (e.target as HTMLInputElement).checked ? doneState : openState })),
        }) : null,
        isTask && !app.actions.readOnly ? h("button.icon-btn.child-del", {
          type: "button", title: `Delete ${k.type.toLowerCase()} #${k.id}`, "aria-label": `Delete ${k.type} #${k.id} ${k.title}`, "data-fkey": `del-${k.id}`,
          onclick: () => void askDelete(app, k),
        }, icon("trash", 13)) : null,
        itemLink(w, k, (x) => go(x.id)), stateMark(w, k),
        k.assignedTo ? avatar(w.api, k.assignedTo, 18) : null,
        isTask && k.remaining ? h("span.muted.small", null, `${k.remaining} h`) : null));
    }
    sec.append(list);
    if (childLevel && !app.actions.readOnly) {
      const tools = h("div.row-tools", null,
        h("button.btn.small", { onclick: () => void createItem(app, { open: false, types: childLevel.types, parentId: it.id, iteration: childLevel.kind === "task" ? it.iteration : undefined, assignedTo: childLevel.kind === "task" ? it.assignedTo?.uniqueName : undefined }) }, icon("plus", 12), `New ${childLevel.defaultType}`));
      // the team's standard child work (Settings, Standard tasks): one click adds the missing ones
      const template = cleanTemplates(app.settings.shared.childTemplates?.[it.type]);
      const todo = missingChildren(template, kids.map((k) => k.title));
      if (todo.length) {
        const what = childLevel.kind === "task" ? "tasks" : childLevel.name.toLowerCase();
        tools.append(h("button.btn.small", {
          title: `Add the team's standard ${what} that are not here yet: ${todo.map((t) => t.title).join(", ")}`,
          onclick: (e: Event) => {
            const b = e.currentTarget as HTMLButtonElement;
            b.disabled = true;
            void app.actions.addStandardChildren(it.id, template).finally(() => { b.disabled = false; });
          },
        }, icon("check", 12), `Add standard ${what} (${todo.length})`));
      }
      if (childLevel.kind === "task" && app.ai.enabled) {
        tools.append(h("button.btn.small", {
          onclick: async (e: Event) => {
            const b = e.currentTarget as HTMLButtonElement;
            b.disabled = true;
            try { showTaskDrafts(it, await draftTasks(app, it), sec); } catch (err) { toast((err as Error).message, { kind: "error" }); }
            b.disabled = false;
          },
        }, icon("sparkle", 12), "Suggest tasks"));
      }
      sec.append(tools);
    }
    return sec;
  }

  function showTaskDrafts(story: WorkItem, drafts: { title: string; hours: number }[], sec: HTMLElement): void {
    const w = ws();
    const taskType = w.process.levels.find((l) => l.kind === "task")?.defaultType ?? "Task";
    const boxes = drafts.map((d) => ({ d, cb: h("input", { type: "checkbox", checked: true }) as HTMLInputElement }));
    const box = h("div.draft-box", null,
      h("p.draft-note", null, "AI suggestions. Tick the tasks to create:"),
      boxes.map(({ d, cb }) => h("label.draft-row", null, cb, `${d.title} (${d.hours} h)`)),
      h("button.btn.small.primary", {
        onclick: async (e: Event) => {
          (e.currentTarget as HTMLButtonElement).disabled = true;
          for (const { d, cb } of boxes) {
            if (!cb.checked) continue;
            await app.actions.create(taskType, {
              "System.Title": d.title, "System.IterationPath": story.iteration, "System.AreaPath": story.area,
              "System.AssignedTo": story.assignedTo?.uniqueName, [w.process.fields.remaining]: d.hours, [w.process.fields.original]: d.hours,
            }, story.id);
          }
          box.remove();
          catchUp();
        },
      }, "Create ticked tasks"),
      h("button.btn.small", { onclick: () => { box.remove(); catchUp(); } }, "Discard"));
    sec.append(box);
  }

  function depsSection(it: WorkItem, ro: boolean): HTMLElement {
    const w = ws();
    const rels = it.relations ?? [];
    const preds = rels.filter((r) => r.rel === REL.predecessor).map(relId).filter(Boolean);
    const succs = rels.filter((r) => r.rel === REL.successor).map(relId).filter(Boolean);
    const related = rels.filter((r) => r.rel === REL.related).map(relId).filter(Boolean);
    const item = (id: number, onRemove?: () => void) => {
      const x = w.get(id);
      return h("li", null, x ? itemLink(w, x, (y) => go(y.id)) : h("a.mono", { href: w.itemUrl(id), target: "_blank", rel: "noopener" }, "#" + id), x ? stateMark(w, x) : null,
        onRemove && !ro ? h("button.icon-btn.small", { title: "Remove this link", onclick: onRemove }, icon("close", 12)) : null);
    };
    const sec = h("section.psec", null, h("h3", null, "Dependencies"));
    sec.append(
      h("div.dep-group", null, h("b", null, "Waits for"), preds.length ? h("ul.child-list", null, preds.map((p) => item(p, () => void app.actions.removeDependency(p, it.id)))) : h("span.muted", null, " nothing")),
      h("div.dep-group", null, h("b", null, "Blocks"), succs.length ? h("ul.child-list", null, succs.map((s) => item(s, () => void app.actions.removeDependency(it.id, s)))) : h("span.muted", null, " nothing")),
      related.length ? h("div.dep-group", null, h("b", null, "Related"), h("ul.child-list", null, related.map((r) => item(r)))) : "");
    if (!ro) {
      sec.append(h("div.row-tools", null,
        h("button.btn.small", { title: "Add an item this one waits for (a predecessor)", onclick: (e: Event) => itemPicker(w, e.currentTarget as Element, (x) => x.id !== it.id, (p) => p && void app.actions.addDependency(p.id, it.id), { placeholder: "This waits for…" }) }, icon("plus", 12), "Waits for"),
        h("button.btn.small", { title: "Add an item that waits for this one (a successor)", onclick: (e: Event) => itemPicker(w, e.currentTarget as Element, (x) => x.id !== it.id, (s) => s && void app.actions.addDependency(it.id, s.id), { placeholder: "This blocks…" }) }, icon("plus", 12), "Blocks")));
    }
    return sec;
  }

  function prSection(it: WorkItem): HTMLElement {
    const w = ws();
    const refs = (it.relations ?? []).map((r) => prFromArtifact(r.url)).filter((x): x is NonNullable<typeof x> => !!x);
    const childRefs = w.children(it.id).flatMap((c) => (c.relations ?? []).map((r) => prFromArtifact(r.url)).filter((x): x is NonNullable<typeof x> => !!x));
    const all = [...new Map([...refs, ...childRefs].map((r) => [r.prId, r])).values()];
    if (!all.length) return h("span");
    const sec = h("section.psec", null, h("h3", null, "Pull requests", h("span.count", null, ` ${all.length}`)));
    const list = h("ul.pr-list", null, h("li.muted", null, "Loading…"));
    sec.append(list);
    void Promise.all(all.map((r) => w.api.pullRequest(r.prId).catch(() => null))).then((prs) => {
      const ok = prs.filter((p): p is PullRequest => !!p).sort((a, b) => b.created.localeCompare(a.created));
      list.replaceChildren(...ok.map((p) => h("li", null,
        h(`span.pr-status.${p.status}`, null, p.status === "completed" ? "Merged" : p.status === "draft" ? "Draft" : p.status === "abandoned" ? "Abandoned" : "Open"),
        h("a", { href: p.url, target: "_blank", rel: "noopener" }, `!${p.id} ${p.title}`),
        h("span.muted.small", null, ` ${p.repository.name} · ${p.createdBy.displayName}`),
        !refs.some((r) => r.prId === p.id) ? h("span.muted.small", null, " (from a task)") : null)));
      if (!ok.length) list.replaceChildren(h("li.muted", null, "Linked pull requests could not be read."));
    });
    return sec;
  }

  function commentsSection(it: WorkItem, ro: boolean): HTMLElement {
    const w = ws();
    const sec = h("section.psec", null, h("h3", null, "Comments"));
    const list = h("div.comments", null, h("p.muted", null, "Loading…"));
    const draftKey = `ado-dashboard:comment:${it.id}`;
    // a box like the description: @ and # suggest mentions; Ctrl+Enter sends
    const input = h("div.rich.editor.comment-box", { contenteditable: "true", spellcheck: "true", role: "textbox", "aria-multiline": "true", "aria-label": "New comment",
      "data-placeholder": "Add a comment; @ mentions a person, # a work item. Ctrl+Enter sends." });
    input.append(sanitize(readStore(() => sessionStorage.getItem(draftKey)) ?? ""));
    lockMentions(input);
    const typed = (): string => sanitizeToString(input.innerHTML);
    const isEmpty = (): boolean => !plainText(input.innerHTML) && !input.querySelector("img");
    input.addEventListener("input", () => {
      if (isEmpty()) input.replaceChildren();
      try { if (isEmpty()) sessionStorage.removeItem(draftKey); else sessionStorage.setItem(draftKey, typed()); } catch { /* not kept */ }
    });
    // while someone types here, a background redraw waits (it would take the focus and the caret)
    input.addEventListener("focus", () => input.classList.add("editing"));
    input.addEventListener("blur", () => input.classList.remove("editing"));
    sec.append(list);
    if (!ro) {
      attachMentions(input, mentionSourceFor(app));
      const send = h("button.btn.small.primary", {
        onclick: async () => {
          if (isEmpty()) return;
          send.disabled = true;
          if (await app.actions.comment(it.id, typed())) {
            input.replaceChildren();
            try { sessionStorage.removeItem(draftKey); } catch { /* not kept */ }
            load();
          }
          send.disabled = false;
        },
      }, "Add comment") as HTMLButtonElement;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.defaultPrevented) { e.preventDefault(); send.click(); } });
      sec.append(input, h("div.row-tools", null, send));
    }
    let asked = 0;
    function load(): void {
      const mine = ++asked;
      // only the newest answer counts: an older, slower one must not take the new comment away again
      void w.api.comments(it.project ?? w.project, it.id).then((cs) => {
        if (mine !== asked) return;
        list.replaceChildren(...(cs.length ? cs.map((c) => h("div.comment", null,
          h("div.c-head", null, avatar(w.api, c.createdBy, 20), h("b", null, c.createdBy.displayName), h("span.muted.small", null, fmtDate(c.createdDate, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))),
          h("div.rich", null, sanitize(c.text)))) : [h("p.muted", null, "No comments")]));
      }).catch((e) => { if (mine === asked) list.replaceChildren(h("p.muted", null, errorText(e))); });
    }
    load();
    return sec;
  }

  function historySection(it: WorkItem): HTMLElement {
    const w = ws();
    const details = h("details.psec.history", null, h("summary", null, h("h3", null, "History")));
    let loaded = false;
    details.addEventListener("toggle", () => {
      if (!details.open || loaded) return;
      loaded = true;
      const list = h("ol.hist", null, h("li.muted", null, "Loading…"));
      details.append(list);
      void w.api.updates(it.project ?? w.project, it.id).then((ups) => {
        list.replaceChildren(...[...ups].reverse().map(historyLine).filter((x): x is HTMLElement => !!x));
        if (!list.children.length) list.append(h("li.muted", null, "No changes recorded"));
      }).catch((e) => list.replaceChildren(h("li.muted", null, errorText(e))));
    });
    return details;
  }

  function historyLine(u: Update): HTMLElement | null {
    const parts: string[] = [];
    // one "Column" line: the team's own column field wins over System.BoardColumn
    const hasTeamColumn = u.changes.some((x) => /Kanban\.Column$/.test(x.field));
    for (const c of u.changes) {
      if (hasTeamColumn && c.field === "System.BoardColumn") continue;
      // fields Azure DevOps fills in by itself say nothing to a reader
      if (/^System\.(Id|AreaId|IterationId|NodeName|TeamProject|WorkItemType|CreatedDate|CreatedBy|ChangedDate|ChangedBy|AuthorizedDate|RevisedDate|PersonId|Parent|AreaLevel\d+|IterationLevel\d+|ExternalLinkCount|HyperLinkCount|AttachedFileCount|RelatedLinkCount|RemoteLinkCount)$|ExtensionMarker$/.test(c.field)) continue;
      if (/^System\.(Rev|Watermark|IsDeleted|CommentCount|History|BoardColumnDone|AuthorizedAs)$|^Microsoft\.VSTS\.Common\.(StateChangeDate|ActivatedDate|ActivatedBy|ResolvedDate|ResolvedBy|ClosedDate|ClosedBy|StackRank|BacklogPriority)$|Kanban\.Column\.Done$/.test(c.field)) continue;
      // people come as objects (or "Name <address>" for names that are not accounts): show the name only
      const show = (v: unknown) => v == null || v === "" ? "(empty)" : typeof v === "object" ? (person(v)?.displayName ?? "") : plainText(String(v)).replace(/\s*<[^>]*@[^>]*>$/, "").slice(0, 80);
      const label = /Kanban\.Column$/.test(c.field) ? "Column" : fieldLabel(c.field);
      if (["System.Description", "Microsoft.VSTS.Common.AcceptanceCriteria"].includes(c.field)) parts.push(`${label} edited`);
      else parts.push(c.oldValue == null ? `${label}: ${show(c.newValue)}` : `${label}: ${show(c.oldValue)} → ${show(c.newValue)}`);
    }
    for (const r of u.relationsAdded ?? []) parts.push(`Link added: ${r.rel.split(".").pop()} ${relId(r) ? "#" + relId(r) : ""}`.trim());
    for (const r of u.relationsRemoved ?? []) parts.push(`Link removed: ${r.rel.split(".").pop()} ${relId(r) ? "#" + relId(r) : ""}`.trim());
    if (!parts.length) return null;
    return h("li", null, h("div.c-head", null, h("b", null, u.by.displayName), h("span.muted.small", null, fmtDate(u.date, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))),
      h("ul", null, parts.map((p) => h("li", null, p))));
  }

  /** A read from browser storage; null when the browser blocks storage (it throws then). */
  function readStore(read: () => string | null): string | null {
    try { return read(); } catch { return null; }
  }

  return {
    open, close,
    current: () => currentId,
    onChange: (fn) => { listeners.push(fn); },
  };
}
