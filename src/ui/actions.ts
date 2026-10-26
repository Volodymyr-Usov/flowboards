// The changes a person can make, with what the page shows around them: a message with Undo after a
// save, the reason when Azure DevOps refuses, and a dialog listing what a rule still needs.
// Views call these; they never call the Writer directly.
import { REL, relId } from "../api/api.ts";
import type { DeletedItem, WorkItem } from "../api/types.ts";
import type { CheckItem, Checklists } from "../core/checklist.ts";
import { AC_FIELD, typeHasField } from "../core/health.ts";
import { levelOf } from "../core/model.ts";
import type { MoveCheck, Requirement } from "../core/rules.ts";
import { fieldTitle, isEmptyValue } from "../core/rules.ts";
import type { ChildTemplate } from "../core/templates.ts";
import { missingChildren } from "../core/templates.ts";
import type { FieldChange, WriteResult } from "../core/writes.ts";
import { ConflictError, RuleError, Writer } from "../core/writes.ts";
import { h, once } from "./dom.ts";
import { textToHtml } from "./sanitize.ts";
import { dialog, errorText, toast } from "./kit.ts";

/**
 * One Undo for several changes: the last change is undone first; it runs at most once. One that
 * fails does not stop the others (they would stay changed); the first failure is reported at the end.
 */
export function undoAll(undos: (() => Promise<unknown>)[]): (() => Promise<void>) | undefined {
  if (!undos.length) return undefined;
  const list = [...undos].reverse(); // a copy: the caller's list stays as it was
  return once(async () => {
    let first: unknown;
    let failed = false;
    for (const u of list) {
      try { await u(); } catch (e) { if (!failed) { failed = true; first = e; } }
    }
    if (failed) throw first;
  });
}

/** The failed steps of a batch for its message: the first three with why, then how many more. */
export function failedSteps(failed: { label: string; error: string }[]): string {
  const shown = failed.slice(0, 3).map((f) => `${f.label} (${f.error})`).join("; ");
  return failed.length > 3 ? `${shown}; and ${failed.length - 3} more` : shown;
}

export class Actions {
  writer: Writer;
  readOnly = false;
  /** why the last change failed (shown next to an editor that keeps the typed text) */
  lastError = "";
  /** the last change was refused because someone else changed the same field meanwhile (null: it was not) */
  lastConflict: ConflictError | null = null;

  constructor(writer: Writer) { this.writer = writer; }

  private get ws() { return this.writer.ws; }

  private label(id: number): string {
    const it = this.ws.get(id);
    return it ? `#${id} ${it.title.length > 50 ? it.title.slice(0, 48) + "…" : it.title}` : `#${id}`;
  }

  private async run(job: () => Promise<WriteResult>, done: (r: WriteResult) => string, quiet = false, action?: { label: string; run: () => void }): Promise<WorkItem | null> {
    if (this.readOnly) { toast("Read-only: you cannot change work items here.", { kind: "error" }); return null; }
    try {
      const r = await job();
      this.lastError = "";
      this.lastConflict = null;
      if (r.undo && !quiet) toast(done(r), { kind: "ok", undo: r.undo, action });
      return r.item;
    } catch (e) {
      this.lastError = errorText(e);
      this.lastConflict = e instanceof ConflictError ? e : null;
      // a box saved as someone types shows a conflict itself, with the choice; no message at each try
      if (!(quiet && this.lastConflict)) toast(this.lastError, { kind: "error" });
      return null;
    }
  }

  /** Changes that are not work items refuse in read-only mode, like the work item changes. */
  private writable(): void {
    if (this.readOnly) throw new Error("Read-only: nothing can be changed here.");
  }

  // ---- changes that are not work items: done and reported (ChangeLog); they throw on failure ----

  /** Rename a tag in the whole project (logged). */
  async renameTag(project: string, tagId: string, name: string, oldName?: string): Promise<void> {
    this.writable();
    await this.writer.renameTag(project, tagId, name, oldName);
  }

  /** Delete a tag from the whole project (logged). */
  async deleteTag(project: string, tagId: string, name?: string): Promise<void> {
    this.writable();
    await this.writer.deleteTag(project, tagId, name);
  }

  /** Change the most cards a board column should hold, 0 = no limit (logged). */
  async setColumnLimit(project: string, team: string, boardName: string, column: string, limit: number, oldLimit?: number): Promise<void> {
    this.writable();
    await this.writer.setColumnLimit(project, team, boardName, column, limit, oldLimit);
  }

  /** Replace the team days off in a sprint (logged). */
  async setTeamDaysOff(project: string, team: string, iterationId: string, daysOff: { start: string; end: string }[], sprintName?: string): Promise<void> {
    this.writable();
    await this.writer.setTeamDaysOff(project, team, iterationId, daysOff, sprintName);
  }

  /** Set the capacity and days off of one person in a sprint (logged). */
  async setCapacity(project: string, team: string, iterationId: string, memberId: string,
    body: { activities: { name: string; capacityPerDay: number }[]; daysOff: { start: string; end: string }[] }, personName?: string, sprintName?: string): Promise<void> {
    this.writable();
    await this.writer.setCapacity(project, team, iterationId, memberId, body, personName, sprintName);
  }

  /**
   * Any other change (for example saving the shared settings): runs `job` and writes `action` to the
   * change log, worked or not. `what` names the thing changed, e.g. { type: "Settings", title: "Rules" }.
   */
  async logged<T>(action: string, what: { type: string; title: string }, job: () => Promise<T>): Promise<T> {
    this.writable();
    return this.writer.logged(action, what, job);
  }

  /**
   * `expect`: the values the edit started from (field → value); when someone else changed one of
   * those fields meanwhile, nothing is saved and lastConflict says so.
   */
  async setFields(id: number, changes: FieldChange[], message?: string, quiet = false, expect?: Record<string, unknown>): Promise<WorkItem | null> {
    return this.run(() => this.writer.setFields(id, changes, { expect }), () => message ?? `Saved ${this.label(id)}`, quiet);
  }

  /** `from`: the value the edit box started from (see setFields' expect). */
  async setField(id: number, field: string, value: unknown, message?: string, from?: { value: unknown }): Promise<WorkItem | null> {
    return this.setFields(id, [{ field, value }], message, false, from ? { [field]: from.value } : undefined);
  }

  /**
   * Saved as someone types (description, acceptance criteria): no "Saved, Undo" message each time; the box shows it.
   * `from`: the value the box was opened (or last saved) with: a change by someone else meanwhile is not overwritten.
   */
  async saveTyped(id: number, field: string, value: unknown, from?: { value: unknown }): Promise<WorkItem | null> {
    return this.setFields(id, [{ field, value }], undefined, true, from ? { [field]: from.value } : undefined);
  }

  /** Add and remove tags; tags someone else changed meanwhile stay as they are. */
  async changeTags(id: number, add: string[], remove: string[], message?: string): Promise<WorkItem | null> {
    return this.run(() => this.writer.changeTags(id, add, remove), () => message ?? `Tags of ${this.label(id)} changed`);
  }

  /**
   * Close an item at once (the Close button of the details panel): a move that never skips the rules.
   * When a rule says no, the dialog lists what is missing; a required field that is empty can be
   * filled in right there, and the close then goes on. Nothing else can be skipped.
   */
  close(id: number, target: { state?: string; column?: string }): Promise<WorkItem | null> {
    return this.move(id, target, { strict: true });
  }

  /** Move to a state or board column. When a rule says no, show what is missing and offer to move anyway. */
  async move(id: number, target: { state?: string; column?: string }, opts: { strict?: boolean } = {}): Promise<WorkItem | null> {
    if (this.readOnly) { toast("Read-only: you cannot change work items here.", { kind: "error" }); return null; }
    const to = target.column ?? target.state ?? "";
    try {
      const r = await this.writer.move(id, target);
      if (r.undo) toast(`${this.label(id)} → ${to}`, { kind: "ok", undo: r.undo });
      return r.item;
    } catch (e) {
      if (!(e instanceof RuleError)) { toast(errorText(e), { kind: "error" }); return null; }
      if (opts.strict) return this.closeBlocked(id, target, e);
      const onlyPeople = e.check.problems.some((p) => p.missing.some((m) => m.startsWith("Only ")));
      const body = h("div.rule-report", null,
        h("p", null, `${this.label(id)} cannot move to ${to} yet. The team's rules ask for:`),
        e.check.problems.map((p) => h("div.rule-block", null,
          h("b", null, p.rule.from ? `Rule from ${p.rule.from} to ${p.rule.target}` : `Rule for ${p.rule.target}`), p.rule.note ? h("p.muted", null, p.rule.note) : null,
          h("ul", null, p.missing.map((m) => h("li", null, m))))),
        onlyPeople ? h("p.muted", null, "A rule on who may make this move cannot be skipped.") : h("p.muted", null, "Moving anyway skips these rules for this move only."));
      // what can be filled in right here: the two ways out are "Move anyway" and fixing what is missing
      const fix = this.fixForm(id, e.check);
      if (fix.el) body.append(fix.el);
      const choice = await dialog("Not ready to move", body, [
        { label: "Cancel", value: "" },
        ...(onlyPeople ? [] : [{ label: "Move anyway", value: "force", danger: true }]),
        { label: "Open the item", value: "open" },
        ...(fix.el ? [{ label: "Fix and move", value: "fix", primary: true }] : []),
      ]);
      if (choice === "open") this.onOpen?.(id);
      if (choice === "fix") {
        if (!(await fix.apply())) return null;
        // the rules look again: anything still missing comes back in a new message
        return this.move(id, target, opts);
      }
      if (choice !== "force") return null;
      return this.run(() => this.writer.move(id, target, { force: true }), () => `${this.label(id)} → ${to} (rules skipped)`);
    }
  }

  /**
   * The boxes for what a rule still asks for and can be filled in here: a description, acceptance criteria, an owner,
   * an estimate, a sprint, a tag, a first task, a field. What cannot (children done, pull requests, the checklist…)
   * is only listed in the message. `apply` saves what was filled in; false when nothing was.
   */
  private fixForm(id: number, check: MoveCheck): { el: HTMLElement | null; apply: () => Promise<boolean> } {
    const it = this.ws.get(id);
    if (!it || this.readOnly) return { el: null, apply: async () => false };
    const ws = this.ws;
    const parts = check.problems.flatMap((p) => p.parts).filter((p) => !p.only);
    const reqs = new Set(parts.map((p) => p.req).filter((r): r is Requirement => !!r));
    const fieldRefs = [...new Set(parts.map((p) => p.field).filter((f): f is string => !!f))];
    const rows: HTMLElement[] = [];
    const changes: (() => FieldChange | null)[] = [];
    const after: (() => Promise<unknown>)[] = [];
    const row = (label: string, control: HTMLElement): void => { rows.push(h("label.set-field", null, h("span", null, label), control)); };
    const area = (ph: string): HTMLTextAreaElement => h("textarea.input", { rows: 3, placeholder: ph, "aria-label": ph }) as HTMLTextAreaElement;
    if (reqs.has("description")) {
      const t = area("Describe it, at least 20 characters");
      row("Description", t);
      changes.push(() => (t.value.trim() ? { field: "System.Description", value: textToHtml(t.value) } : null));
    }
    // a type without acceptance criteria (Basic's Issue, a custom type) gets no box for them
    if (reqs.has("acceptance") && typeHasField(ws.process, it.type, AC_FIELD)) {
      const t = area("The acceptance criteria, at least 10 characters");
      row("Acceptance criteria", t);
      changes.push(() => (t.value.trim() ? { field: "Microsoft.VSTS.Common.AcceptanceCriteria", value: textToHtml(t.value) } : null));
    }
    if (reqs.has("owner")) {
      const s = h("select.input", { "aria-label": "Owner" }, h("option", { value: "" }, "Pick someone…"), ws.people().map((p) => h("option", { value: p.uniqueName }, p.displayName))) as HTMLSelectElement;
      row("Owner", s);
      after.push(async () => { if (s.value) await this.assign(id, s.value); });
    }
    if (reqs.has("effort")) {
      const n = h("input.input", { type: "number", min: 0, step: 0.5, placeholder: "Points, effort or size", "aria-label": "Estimate" }) as HTMLInputElement;
      row("Estimate", n);
      changes.push(() => (n.value !== "" && Number(n.value) > 0 ? { field: ws.process.fields.effort, value: Number(n.value) } : null));
    }
    if (reqs.has("iteration")) {
      const list = ws.iterations.filter((i) => i.start && i.finish).sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!));
      const cur = ws.currentIteration();
      const s = h("select.input", { "aria-label": "Sprint" }, h("option", { value: "" }, "Pick a sprint…"), list.map((i) => h("option", { value: i.path, selected: i.path === cur?.path }, i.name))) as HTMLSelectElement;
      row("Sprint", s);
      changes.push(() => (s.value ? { field: "System.IterationPath", value: s.value } : null));
    }
    if (reqs.has("tags")) {
      const t = h("input.input", { type: "text", placeholder: "A tag (several with ;)", "aria-label": "Tag" }) as HTMLInputElement;
      row("Tag", t);
      // only the new tags are sent, added to what the item has then
      after.push(async () => {
        const add = t.value.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
        if (add.length) await this.changeTags(id, add, [], `Tags added to ${this.label(id)}`);
      });
    }
    if (reqs.has("hasChildren")) {
      const lvl = levelOf(ws.process, it.type);
      const child = lvl ? ws.process.levels.find((l) => l.rank === lvl.rank + 1) : undefined;
      if (child) {
        const t = h("input.input", { type: "text", placeholder: `Title of the first ${child.defaultType.toLowerCase()}`, "aria-label": `New ${child.defaultType}` }) as HTMLInputElement;
        row(child.kind === "task" ? "Task" : child.name, t);
        after.push(async () => {
          if (!t.value.trim()) return;
          await this.create(child.defaultType, { "System.Title": t.value.trim(), "System.IterationPath": child.kind === "task" ? it.iteration : undefined, "System.AssignedTo": child.kind === "task" ? it.assignedTo?.uniqueName : undefined }, id);
        });
      }
    }
    for (const ref of fieldRefs) {
      const t = h("input.input", { type: "text", placeholder: fieldTitle(ref, ws.process.types[it.type]?.fieldNames), "aria-label": fieldTitle(ref, ws.process.types[it.type]?.fieldNames) }) as HTMLInputElement;
      row(fieldTitle(ref, ws.process.types[it.type]?.fieldNames), t);
      changes.push(() => (t.value.trim() ? { field: ref, value: t.value.trim() } : null));
    }
    if (!rows.length) return { el: null, apply: async () => false };
    const el = h("div.rule-fill", null, h("p", null, "Or fix what is missing here, then move:"), ...rows);
    return {
      el,
      apply: async () => {
        const list = changes.map((c) => c()).filter((c): c is FieldChange => !!c);
        let did = false;
        if (list.length) did = (await this.setFields(id, list, undefined, true)) !== null;
        for (const job of after) { try { await job(); did = true; } catch (e) { toast(errorText(e), { kind: "error" }); } }
        if (!did) toast("Nothing was filled in, so nothing was fixed.", { kind: "error" });
        return did;
      },
    };
  }

  /** The close was refused by the team's rules: say what is missing; empty required fields can be filled in here. */
  private async closeBlocked(id: number, target: { state?: string; column?: string }, e: RuleError): Promise<WorkItem | null> {
    const it = this.ws.get(id);
    const names = it ? this.ws.process.types[it.type]?.fieldNames : undefined;
    // required fields that are empty: one box each (a comment, a reason…)
    const refs = [...new Set(e.check.problems.flatMap((p) => p.rule.fields ?? []))].filter((ref) => isEmptyValue(it?.fields[ref]));
    const boxes = new Map(refs.map((ref) => [ref, h("input.input", { type: "text", "aria-label": fieldTitle(ref, names), placeholder: fieldTitle(ref, names) }) as HTMLInputElement]));
    const onlyPeople = e.check.problems.some((p) => p.missing.some((m) => m.startsWith("Only ")));
    const body = h("div.rule-report", null,
      h("p", null, `${this.label(id)} cannot be closed yet. The team's rules ask for:`),
      e.check.problems.map((p) => h("div.rule-block", null,
        h("b", null, p.rule.from ? `Rule from ${p.rule.from} to ${p.rule.target}` : `Rule for ${p.rule.target}`), p.rule.note ? h("p.muted", null, p.rule.note) : null,
        h("ul", null, p.missing.map((m) => h("li", null, m))))),
      refs.length ? h("div.rule-fill", null, h("p", null, "Fill in here, then close:"), ...refs.map((ref) => h("label.set-field", null, h("span", null, fieldTitle(ref, names)), boxes.get(ref)!))) : null,
      h("p.muted", null, onlyPeople ? "A rule on who may do this cannot be skipped." : "Rules cannot be skipped when closing: fix what is listed, then press Close again."));
    const choice = await dialog("Cannot close yet", body, [
      { label: refs.length ? "Cancel" : "OK", value: "" },
      ...(refs.length ? [{ label: "Save and close", value: "fill", primary: true }] : []),
    ]);
    if (choice !== "fill") return null;
    const changes = refs.map((ref) => ({ field: ref, value: boxes.get(ref)!.value.trim() })).filter((c) => c.value);
    if (!changes.length) return null;
    const saved = await this.setFields(id, changes, undefined, true);
    if (!saved) return null;
    return this.close(id, target);
  }

  async reparent(id: number, parent: number): Promise<WorkItem | null> {
    const p = this.ws.get(parent);
    return this.run(() => this.writer.reparent(id, parent), () => `${this.label(id)} is now under ${p ? this.label(p.id) : "no parent"}`);
  }

  async reorder(id: number, previousId: number, nextId: number): Promise<WorkItem | null> {
    return this.run(() => this.writer.reorder(id, previousId, nextId), () => `Priority of ${this.label(id)} changed`);
  }

  async assign(id: number, uniqueName: string | null): Promise<WorkItem | null> {
    return this.setFields(id, [{ field: "System.AssignedTo", value: uniqueName ?? "" }], uniqueName ? `${this.label(id)} assigned` : `${this.label(id)} unassigned`);
  }

  async addDependency(predecessor: number, successor: number): Promise<WorkItem | null> {
    return this.run(() => this.writer.addLink(successor, REL.predecessor, predecessor), () => `#${successor} now waits for #${predecessor}`);
  }

  async removeDependency(predecessor: number, successor: number): Promise<WorkItem | null> {
    return this.run(() => this.writer.removeLink(successor, REL.predecessor, predecessor), () => `#${successor} no longer waits for #${predecessor}`);
  }

  async create(type: string, fields: Record<string, unknown>, parentId?: number): Promise<WorkItem | null> {
    if (this.readOnly) { toast("Read-only: you cannot create work items here.", { kind: "error" }); return null; }
    try {
      const item = await this.writer.create(type, fields, parentId);
      // Undo deletes it again (to the Recycle Bin, where it can be brought back)
      toast(`Created ${type} #${item.id}`, { kind: "ok", timeout: 8000, undo: () => this.deleteMade([item]), action: this.onOpen ? { label: "Open", run: () => this.onOpen?.(item.id) } : undefined });
      return item;
    } catch (e) {
      toast(errorText(e), { kind: "error" });
      return null;
    }
  }

  /** Checklists of the project's work items (read them here; change them with changeChecklist). */
  get checklists(): Checklists { return this.writer.checklists; }

  /** Change an item's checklist; `what` says what changed, for the change log. Null when it failed. */
  async changeChecklist(id: number, change: (items: CheckItem[]) => CheckItem[], what: string): Promise<CheckItem[] | null> {
    if (this.readOnly) { toast("Read-only: you cannot change checklists here.", { kind: "error" }); return null; }
    try { return await this.writer.changeChecklist(id, change, what); } catch (e) { toast(errorText(e), { kind: "error" }); return null; }
  }

  /**
   * Add the team's standard child work under an item: only the entries whose title is not already
   * a child (children not loaded here are read by their links first). Gives back what was created.
   */
  async addStandardChildren(parentId: number, template: ChildTemplate[]): Promise<WorkItem[] | null> {
    if (this.readOnly) { toast("Read-only: you cannot create work items here.", { kind: "error" }); return null; }
    const ws = this.ws;
    try {
      await ws.withRelations([parentId]);
      const parent = ws.get(parentId);
      if (!parent) throw new Error(`Work item ${parentId} is not loaded`);
      const level = levelOf(ws.process, parent.type);
      const childLevel = level ? ws.process.levels.find((l) => l.rank === level.rank + 1) : undefined;
      if (!childLevel) throw new Error(`A ${parent.type} has no child level.`);
      const kids = ws.children(parentId);
      const linked = (parent.relations ?? []).filter((r) => r.rel === REL.child).map(relId).filter((x) => x > 0 && !kids.some((k) => k.id === x));
      const others = linked.length ? await ws.api.items(parent.project ?? ws.project, linked) : [];
      const todo = missingChildren(template, [...kids, ...others].map((k) => k.title));
      if (!todo.length) { toast(`Every standard ${childLevel.defaultType.toLowerCase()} is already under ${this.label(parentId)}.`); return []; }
      const pf = ws.process.fields;
      const isTask = childLevel.kind === "task";
      const made: WorkItem[] = [];
      for (const t of todo) {
        const type = t.type && childLevel.types.includes(t.type) ? t.type : childLevel.defaultType;
        const has = (f: string): boolean => { const fs = ws.process.types[type]?.fields; return !fs || fs.includes(f); };
        const fields: Record<string, unknown> = {
          "System.Title": t.title, "System.IterationPath": parent.iteration, "System.AreaPath": parent.area,
          "System.AssignedTo": isTask ? parent.assignedTo?.uniqueName : undefined,
        };
        if (isTask && t.activity && pf.activity && has(pf.activity)) fields[pf.activity] = t.activity;
        if (isTask && t.remaining != null && has(pf.remaining)) {
          fields[pf.remaining] = t.remaining;
          if (pf.original && has(pf.original)) fields[pf.original] = t.remaining;
        }
        try { made.push(await this.writer.create(type, fields, parentId)); } catch (e) {
          const undone = [...made];
          toast(`${made.length ? `Added ${made.length}, then stopped: ` : ""}${errorText(e)}`, { kind: "error", undo: made.length ? () => this.deleteMade(undone) : undefined });
          return made;
        }
      }
      const undone = [...made];
      toast(`Added ${made.length} standard ${made.length === 1 ? childLevel.defaultType.toLowerCase() : childLevel.name.toLowerCase()} under ${this.label(parentId)}`, { kind: "ok", undo: () => this.deleteMade(undone) });
      return made;
    } catch (e) {
      toast(errorText(e), { kind: "error" });
      return null;
    }
  }

  /**
   * The Undo of a create: the items made go to the Recycle Bin (the last made first). One that someone
   * changed meanwhile goes too: it can be brought back from the Recycle Bin.
   */
  private async deleteMade(items: WorkItem[]): Promise<void> {
    this.writable();
    await undoAll(items.map((it) => () => this.writer.deleteItem(it.id)))?.();
  }

  /** Delete a work item (to the Recycle Bin), with Undo. Ask the person first. */
  async deleteItem(id: number): Promise<boolean> {
    const what = this.label(id);
    const bin = this.onShowBin ? { label: "Recycle Bin", run: () => this.onShowBin?.() } : undefined;
    return (await this.run(() => this.writer.deleteItem(id), () => `Deleted ${what} (in the Recycle Bin)`, false, bin)) !== null;
  }

  /** Restore items from the Recycle Bin, with one Undo for all. Returns the ids that came back. */
  async restoreDeleted(items: DeletedItem[]): Promise<number[]> {
    if (this.readOnly) { toast("Read-only: you cannot change work items here.", { kind: "error" }); return []; }
    const undos: (() => Promise<unknown>)[] = [];
    const done: number[] = [];
    const failed: string[] = [];
    for (const d of items) {
      try { undos.push((await this.writer.restoreDeleted(d)).undo); done.push(d.id); } catch (e) { failed.push(`#${d.id}: ${errorText(e)}`); }
    }
    if (done.length) {
      const one = items.find((d) => d.id === done[0])!;
      const what = done.length === 1 ? `#${one.id} ${one.title}` : `${done.length} items`;
      toast(`Restored ${what}`, { kind: "ok", undo: undoAll(undos), action: done.length === 1 && this.onOpen ? { label: "Open", run: () => this.onOpen?.(done[0]) } : undefined });
    }
    if (failed.length) toast(`Not restored: ${failed.join("; ")}`, { kind: "error" });
    return done;
  }

  async comment(id: number, html: string): Promise<boolean> {
    try { await this.writer.comment(id, html); return true; } catch (e) { toast(errorText(e), { kind: "error" }); return false; }
  }

  /**
   * Several changes as one: done in order, then one message with one Undo for all of them (last undone first).
   * A step that fails is listed and the others still run. onStep tells which step runs now.
   */
  async batch(message: string, steps: { label: string; run: (w: Writer) => Promise<WriteResult> }[], onStep?: (n: number, total: number) => void): Promise<{ done: number; failed: { label: string; error: string }[] }> {
    if (this.readOnly) { toast("Read-only: you cannot change work items here.", { kind: "error" }); return { done: 0, failed: steps.map((s) => ({ label: s.label, error: "Read-only" })) }; }
    const undos: (() => Promise<unknown>)[] = [];
    const failed: { label: string; error: string }[] = [];
    let done = 0;
    for (let i = 0; i < steps.length; i++) {
      onStep?.(i + 1, steps.length);
      try {
        const r = await steps[i].run(this.writer);
        done++;
        if (r.undo) undos.push(r.undo);
      } catch (e) {
        failed.push({ label: steps[i].label, error: errorText(e) });
      }
    }
    const undo = undoAll(undos);

    if (done) toast(failed.length ? `${message}; ${failed.length} of ${steps.length} changes failed: ${failedSteps(failed)}` : message, { kind: failed.length ? "error" : "ok", undo });
    else if (failed.length) toast(`Nothing changed: ${failed.length === 1 ? failed[0].error : failedSteps(failed)}`, { kind: "error" });
    return { done, failed };
  }

  /** Set by the app: open an item's panel (used by the rule dialog). */
  onOpen: ((id: number) => void) | null = null;
  /** opens the Recycle Bin page (set by the app) */
  onShowBin: (() => void) | null = null;
}
