// Every change the extension makes to Azure DevOps goes through here: it checks the rules,
// sends the change with the revision the page saw (a newer revision is refused, never overwritten),
// puts the fresh item into the workspace, writes the change log, and gives back an undo.
// No page code here; ui/actions.ts adds the dialogs and messages.
import { prFromArtifact, REL, relId } from "../api/api.ts";
import type { DeletedItem, PatchOp, Person, WorkItem } from "../api/types.ts";
import type { ChangeLog } from "./changelog.ts";
import type { CheckItem } from "./checklist.ts";
import { Checklists, cleanList, progress } from "./checklist.ts";
import { AC_FIELD, typeHasField } from "./health.ts";
import { hasText, isDone, isRemoved, isUnder, levelOf, plainText } from "./model.ts";
import type { Facts, MoveCheck, Rule } from "./rules.ts";
import { checkMove } from "./rules.ts";
import type { Workspace } from "./workspace.ts";

export interface WriteResult { item: WorkItem; undo?: () => Promise<unknown> }

export class RuleError extends Error {
  check: MoveCheck;
  constructor(check: MoveCheck) {
    super(check.problems.map((p) => p.missing.join(", ")).join("; "));
    this.check = check;
  }
}

export interface FieldChange { field: string; value: unknown; label?: string }

/**
 * A change refused before it was sent: someone else changed the same field since the box was opened
 * (or since the change being undone). `item` is the copy with their value.
 */
export class ConflictError extends Error {
  conflict = true;
  item: WorkItem;
  fields: string[];
  constructor(item: WorkItem, fields: string[]) {
    super(`${fields.map(fieldLabel).join(", ")} of #${item.id} was changed by someone else meanwhile. Nothing was saved, so their change stays.`);
    this.item = item;
    this.fields = fields;
  }
}

/** The same field value? Empty is empty, people by account, text without outer spaces. */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v === "object") { const p = v as Partial<Person>; return String(p.uniqueName ?? p.displayName ?? JSON.stringify(v)).toLowerCase(); }
    return String(v).trim();
  };
  return norm(a) === norm(b);
}

/** Tags after adding and removing some (case does not matter); the item's other tags stay as they are. */
export function applyTags(tags: string[], add: string[], remove: string[]): { tags: string[]; added: string[]; removed: string[] } {
  const has = (xs: string[], t: string): boolean => xs.some((x) => x.toLowerCase() === t.toLowerCase());
  const removed = tags.filter((t) => has(remove, t));
  const kept = tags.filter((t) => !has(remove, t));
  const added: string[] = [];
  for (const raw of add) { const t = raw.trim(); if (t && !has(kept, t) && !has(added, t)) added.push(t); }
  return { tags: [...kept, ...added], added, removed };
}

const FIELD_LABEL: Record<string, string> = {
  "System.Title": "Title", "System.State": "State", "System.AssignedTo": "Owner", "System.IterationPath": "Sprint",
  "System.AreaPath": "Area", "System.Tags": "Tags", "System.Description": "Description",
  "Microsoft.VSTS.Common.AcceptanceCriteria": "Acceptance criteria", "Microsoft.VSTS.Scheduling.StartDate": "Start date",
  "Microsoft.VSTS.Scheduling.TargetDate": "Target date", "Microsoft.VSTS.Scheduling.DueDate": "Due date",
  "Microsoft.VSTS.Common.Priority": "Priority",
};

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field.split(".").pop()!.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function show(v: unknown): string {
  if (v == null || v === "") return "(empty)";
  if (typeof v === "object" && v && "displayName" in v) return String((v as Person).displayName);
  const s = typeof v === "string" ? plainText(v) : String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

function rawValue(item: WorkItem, field: string): unknown {
  return item.fields[field];
}

export class Writer {
  ws: Workspace;
  log: ChangeLog;
  rules: () => Rule[];
  /** unique name of the signed-in person */
  me: string;
  meName: string;
  /** checklists of the project's work items (the extension's shared storage) */
  checklists: Checklists;
  /** the team's default checklist for a work item type (set by the app from the shared settings) */
  checklistDefaults: (type: string) => string[] = () => [];

  constructor(ws: Workspace, log: ChangeLog, rules: () => Rule[], me: Person) {
    this.ws = ws;
    this.log = log;
    this.rules = rules;
    this.me = me.uniqueName;
    this.meName = me.displayName;
    this.checklists = new Checklists(ws.api, ws.project);
  }

  private item(id: number): WorkItem {
    const it = this.ws.get(id);
    if (!it) throw new Error(`Work item ${id} is not loaded`);
    return it;
  }

  /** Send a patch with the revision we saw (or `rev`); log it; put the result in the workspace. */
  async patch(id: number, ops: PatchOp[], action: string, before: Record<string, unknown>, after: Record<string, unknown>, bypassed?: string[], rev?: number): Promise<WorkItem> {
    let it = this.item(id);
    // a copy marked as a guess (after a priority change or a refusal) has an old revision: read it first,
    // so a write right after (an Undo chain, a move after a reorder) is not refused as "changed meanwhile"
    if (it.stale) {
      const guessRev = it.rev;
      await this.ws.refresh(id).catch(() => undefined);
      it = this.item(id);
      if (rev === guessRev) rev = it.rev;
    }
    const project = it.project ?? this.ws.project;
    try {
      const fresh = await this.ws.api.update(project, id, ops, { rev: rev ?? it.rev });
      this.ws.put(fresh);
      void this.log.add({ by: this.me, byName: this.meName, itemId: id, itemTitle: fresh.title, itemType: fresh.type, action, before, after, ok: true, bypassed });
      return fresh;
    } catch (e) {
      void this.log.add({ by: this.me, byName: this.meName, itemId: id, itemTitle: it.title, itemType: it.type, action, before, after, ok: false, error: (e as Error).message });
      // refused as changed meanwhile: what Azure DevOps has now replaces our copy, whatever its revision
      if ((e as { status?: number }).status === 412) { this.ws.markStale(id); this.refreshLater(id); }
      throw e;
    }
  }

  /** A field's value in a copy: the raw field, else what the copy was read into (state, title, board column). */
  valueOf(it: WorkItem, field: string): unknown {
    if (field in it.fields) return it.fields[field];
    if (field === "System.State") return it.state;
    if (field === "System.Title") return it.title;
    if (field === "System.Tags") return it.tags.join("; ");
    if (field === this.ws.board?.columnField || field === "System.BoardColumn") return it.boardColumn;
    return undefined;
  }

  /**
   * Run a write on the newest copy of an item. `expect`: the field values the change was made on (what
   * an edit box showed when it was opened). When the item now has other values in those fields, someone
   * else changed them meanwhile: refused with a ConflictError, nothing is sent. A change of other fields
   * meanwhile is no conflict. `retry`: refused by Azure DevOps as changed meanwhile (our copy was behind):
   * read the item again and try once more; the check above runs again on the fresh copy.
   */
  private async guarded<T>(id: number, expect: Record<string, unknown> | undefined, run: (it: WorkItem) => Promise<T>, retry = Boolean(expect)): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let it = this.item(id);
      if (expect) {
        // a guessed copy may hold old values: read it first
        if (it.stale) { await this.ws.refresh(id).catch(() => undefined); it = this.item(id); }
        let copy = it;
        // a copy read with a short field list may not have the field: read the item in full for the check
        if (Object.keys(expect).some((f) => it.fieldsRead && !it.fieldsRead.includes(f))) {
          const full = await this.ws.api.item(it.project ?? this.ws.project, id).catch(() => it);
          copy = { ...it, fields: { ...it.fields, ...full.fields } };
        }
        const differ = Object.keys(expect).filter((f) => !sameValue(this.valueOf(copy, f), expect[f]));
        if (differ.length) throw new ConflictError(it, differ);
      }
      try {
        return await run(it);
      } catch (e) {
        if (!retry || attempt > 0 || (e as { status?: number }).status !== 412) throw e;
        await this.ws.refresh(id).catch(() => undefined);
      }
    }
  }

  /**
   * Change plain fields. `expect`: the values the change was made on (see guarded). Undo puts the old
   * values back, but only while the fields still hold what this change wrote: a newer change by someone
   * else is not undone.
   */
  async setFields(id: number, changes: FieldChange[], opts: { expect?: Record<string, unknown> } = {}): Promise<WriteResult> {
    return this.guarded(id, opts.expect, async (it) => {
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const ops: PatchOp[] = [];
      for (const c of changes) {
        const old = rawValue(it, c.field);
        before[c.field] = old ?? null;
        after[c.field] = c.value ?? null;
        const empty = c.value == null || c.value === "";
        if (empty && old == null) continue;
        ops.push(empty ? { op: "remove", path: `/fields/${c.field}` } : { op: "add", path: `/fields/${c.field}`, value: c.value });
      }
      if (!ops.length) return { item: it };
      const action = changes.map((c) => `${c.label ?? fieldLabel(c.field)}: ${show(before[c.field])} → ${show(c.value)}`).join("; ");
      const fresh = await this.patch(id, ops, action, before, after);
      const wrote: Record<string, unknown> = {};
      for (const c of changes) wrote[c.field] = this.valueOf(fresh, c.field) ?? null;
      return {
        item: fresh,
        undo: () => this.setFields(id, changes.map((c) => ({ field: c.field, label: c.label, value: personValue(before[c.field]) })), { expect: wrote }),
      };
    });
  }

  /**
   * Add and remove tags: applied to the item's newest tags, so a tag someone else added or removed
   * meanwhile stays as they left it. Undo takes back only what this change did.
   */
  async changeTags(id: number, add: string[], remove: string[]): Promise<WriteResult> {
    return this.guarded(id, undefined, async (it) => {
      const r = applyTags(it.tags, add, remove);
      if (!r.added.length && !r.removed.length) return { item: it };
      const value = r.tags.join("; ");
      const ops: PatchOp[] = [value ? { op: "add", path: "/fields/System.Tags", value } : { op: "remove", path: "/fields/System.Tags" }];
      const action = [r.added.length ? `Tags added: ${r.added.join(", ")}` : "", r.removed.length ? `Tags removed: ${r.removed.join(", ")}` : ""].filter(Boolean).join("; ");
      const fresh = await this.patch(id, ops, action, { "System.Tags": it.tags.join("; ") || null }, { "System.Tags": value || null });
      return { item: fresh, undo: () => this.changeTags(id, r.removed, r.added) };
    }, true);
  }

  // ---------- state and board column ----------

  /** The facts the rules look at, for one item. Reads its links when they are not loaded yet. */
  async facts(id: number): Promise<Facts> {
    await this.ws.withRelations([id]);
    const it = this.item(id);
    const kind = this.ws.levelOf(it)?.kind ?? "requirement";
    const kids = this.ws.children(id);
    const rels = it.relations ?? [];
    const prIds = rels.map((r) => prFromArtifact(r.url)).filter((x): x is NonNullable<typeof x> => !!x);
    let openPrs = 0;
    if (this.rules().some((r) => r.requires.includes("prsMerged"))) {
      // a pull request that cannot be read (not "gone": that answers null) counts as open, like an unreadable child
      const prs = await Promise.all(prIds.map((p) => this.ws.api.pullRequest(p.prId).catch(() => "unreadable" as const)));
      openPrs = prs.filter((p) => p === "unreadable" || (p && (p.status === "active" || p.status === "draft"))).length;
    }
    const preds = rels.filter((r) => r.rel === REL.predecessor).map(relId).filter((x) => x > 0);
    // children by link too: a child closed long ago or in another team's area is not in the workspace
    const kidIds = [...new Set([...kids.map((k) => k.id), ...rels.filter((r) => r.rel === REL.child).map(relId).filter((x) => x > 0)])];
    const needLinks = this.rules().some((r) => r.requires.some((q) => q === "hasChildren" || q === "childrenDone" || q === "noOpenPredecessors"));
    const linked = await this.linked(it, needLinks ? [...preds, ...kidIds] : []);
    // an item that cannot be read counts as open; a removed one does not count
    const counted = kidIds.filter((k) => { const x = linked.get(k) ?? this.ws.get(k); return !x || !isRemoved(x); });
    const openChildren = counted.filter((k) => { const x = linked.get(k) ?? this.ws.get(k); return !x || !isDone(x); }).length;
    const openPredecessors = preds.filter((p) => { const x = linked.get(p) ?? this.ws.get(p); return !x || !(isDone(x) || isRemoved(x)); }).length;
    const backlogRoot = this.ws.settings.backlogIteration ?? this.ws.project;
    // rules may name any field: read the item in full only then (the board loads a short field list)
    let values: Record<string, unknown> = it.fields;
    const needed = this.rules().flatMap((r) => r.fields ?? []);
    if (needed.some((f) => !(f in it.fields))) {
      values = { ...(await this.ws.api.item(it.project ?? this.ws.project, id).catch(() => it)).fields };
    }
    // the checklist is read only when a rule asks for it; one that cannot be read counts as not done
    let checklist: Facts["checklist"];
    let checklistDefault = 0;
    if (this.rules().some((r) => r.requires.includes("checklistDone"))) {
      checklistDefault = cleanList(this.checklistDefaults(it.type)).length;
      checklist = await this.checklists.get(id).then(progress, () => null);
    }
    return {
      values,
      checklist,
      checklistDefault,
      fieldNames: this.ws.process.types[it.type]?.fieldNames,
      kind,
      description: plainText(it.description),
      acceptance: plainText(it.acceptance),
      hasAcceptanceField: typeHasField(this.ws.process, it.type, AC_FIELD),
      hasOwner: Boolean(it.assignedTo),
      hasParent: Boolean(it.parent),
      hasEffort: it.effort != null && it.effort > 0,
      inSprint: it.iteration !== backlogRoot && !(isUnder(backlogRoot, it.iteration)),
      children: counted.length,
      openChildren,
      openPrs,
      openPredecessors,
      tags: it.tags.length,
      me: this.me,
    };
  }

  /** These linked items: from the workspace, the rest read now (they are not put in the workspace). */
  private async linked(it: WorkItem, ids: number[]): Promise<Map<number, WorkItem>> {
    const out = new Map<number, WorkItem>();
    const missing: number[] = [];
    for (const id of new Set(ids)) {
      const x = this.ws.get(id);
      if (x) out.set(id, x); else missing.push(id);
    }
    if (missing.length) {
      const got = await this.ws.api.items(it.project ?? this.ws.project, missing).catch(() => [] as WorkItem[]);
      for (const g of got) out.set(g.id, g);
    }
    return out;
  }

  /** Read an item again in the background; if that fails, the page shows the item as it was a little longer. */
  private refreshLater(id: number): void {
    // an item that is not part of the team's work (the other end of a link) must not be put into it
    if (!this.ws.get(id)) return;
    this.ws.refresh(id).catch((e) => console.warn(`#${id} not read again`, e));
  }

  /** Board steps for the rules: the board's column names, or the type's states in order. */
  steps(it: WorkItem, useColumns: boolean): string[] {
    const level = levelOf(this.ws.process, it.type);
    if (useColumns && level?.kind === "requirement" && this.ws.board) return this.ws.board.columns.map((c) => c.name);
    const states = this.ws.process.types[it.type]?.states ?? [];
    const order = ["Proposed", "InProgress", "Resolved", "Completed"];
    return [...states].filter((s) => s.category !== "Removed").sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category)).map((s) => s.name);
  }

  /**
   * Rules can name board columns or states. A move on the board is checked both ways: column to
   * column, and state to state (when the state changes too). Each rule counts once.
   */
  async check(id: number, from: string, to: string, useColumns: boolean, stateTo?: string): Promise<MoveCheck> {
    const rules = this.rules();
    if (!rules.length) return { ok: true, problems: [] };
    const it = this.item(id);
    const facts = await this.facts(id);
    const a = checkMove(rules, facts, this.steps(it, useColumns), from, to);
    if (!useColumns || !stateTo || stateTo === it.state) return a;
    const b = checkMove(rules, facts, this.steps(it, false), it.state, stateTo);
    const seen = new Set(a.problems.map((p) => p.rule.id));
    const problems = [...a.problems, ...b.problems.filter((p) => !seen.has(p.rule.id))];
    return { ok: problems.length === 0, problems };
  }

  /**
   * Move an item to a state, or (for stories on a team board) to a board column, which also sets
   * the state the column maps to. `force` skips the rules except "only these people may".
   * `expect`: the field values the move was planned on (an Undo); see guarded.
   */
  async move(id: number, target: { state?: string; column?: string }, opts: { force?: boolean; expect?: Record<string, unknown> } = {}): Promise<WriteResult> {
    return this.guarded(id, opts.expect, (it) => this.moveNow(it, target, Boolean(opts.force)));
  }

  /**
   * The board column a move by state ends in, for the rules: the item's own column when it already
   * stands for that state, else the first column that does. Only for stories on the team's board.
   */
  columnForState(it: WorkItem, state: string): string | null {
    const board = this.ws.board;
    if (!board?.columnField || levelOf(this.ws.process, it.type)?.kind !== "requirement") return null;
    const own = board.columns.find((c) => c.name === it.boardColumn);
    if (own && own.stateMappings[it.type] === state) return own.name;
    return board.columns.find((c) => c.stateMappings[it.type] === state)?.name ?? null;
  }

  private async moveNow(it: WorkItem, target: { state?: string; column?: string }, force: boolean): Promise<WriteResult> {
    const id = it.id;
    const board = this.ws.board;
    const columnField = board?.columnField;
    const useColumns = Boolean(target.column && board && columnField);
    const from = useColumns ? it.boardColumn ?? "" : it.state;
    const to = useColumns ? target.column! : target.state!;
    let state = target.state;
    if (useColumns) {
      const col = board!.columns.find((c) => c.name === to);
      state = col?.stateMappings[it.type] ?? state;
    }
    // a story moved by its state (a list, the Backlog, Health, Ask AI) lands in a board column too:
    // the rules of that column count as if it had been moved there on the board
    const landsIn = !useColumns && state && state !== it.state ? this.columnForState(it, state) : null;
    const check = landsIn != null
      ? await this.check(id, it.boardColumn ?? "", landsIn, true, state)
      : await this.check(id, from, to, useColumns, state);
    let bypassed: string[] | undefined;
    if (!check.ok) {
      const people = check.problems.filter((p) => p.rule.onlyBy.length && p.missing.some((m) => m.startsWith("Only ")));
      if (!force || people.length) throw new RuleError(check);
      bypassed = check.problems.flatMap((p) => p.missing.map((m) => `${p.rule.target}: ${m}`));
    }
    const ops: PatchOp[] = [];
    const before: Record<string, unknown> = { "System.State": it.state };
    const after: Record<string, unknown> = {};
    if (state && state !== it.state) { ops.push({ op: "add", path: "/fields/System.State", value: state }); after["System.State"] = state; }
    if (useColumns && columnField) {
      before[columnField] = it.boardColumn ?? null;
      after[columnField] = to;
      ops.push({ op: "add", path: `/fields/${columnField}`, value: to });
    }
    if (!ops.length) return { item: it };
    const action = useColumns ? `Column: ${from || "(none)"} → ${to}${state && state !== it.state ? ` (state ${it.state} → ${state})` : ""}` : `State: ${it.state} → ${state}`;
    // send the revision the move was planned on: if the item changed during the rule check, it is refused
    const fresh = await this.patch(id, ops, action, before, after, bypassed, it.rev);
    // Undo moves it back only while it stands where this move put it: a newer move by someone else stays
    const expect: Record<string, unknown> = { "System.State": this.valueOf(fresh, "System.State") };
    if (useColumns && columnField) expect[columnField] = this.valueOf(fresh, columnField);
    return {
      item: fresh,
      undo: () => this.move(id, useColumns ? { column: from, state: it.state } : { state: it.state }, { force: true, expect }),
    };
  }

  // ---------- links ----------

  /** Put an item under another parent (or under none with 0). */
  async reparent(id: number, newParent: number): Promise<WriteResult> {
    if (id === newParent) throw new Error("An item cannot go under itself.");
    const cur = this.item(id);
    // read the item fresh with its links: the parent link to remove is found by its place in the list
    const [it] = await this.ws.api.items(cur.project ?? this.ws.project, [id], { relations: true });
    if (!it) throw new Error(`Work item ${id} could not be read.`);
    if (it.rev >= cur.rev || cur.stale) this.ws.put(it, "poll");
    const old = it.parent ?? 0;
    if (old === newParent) return { item: it };
    if (newParent && this.ws.get(newParent) && this.ws.ancestors(this.item(newParent)).some((a) => a.id === id)) throw new Error("An item cannot go under its own child.");
    const ops: PatchOp[] = [];
    const idx = (it.relations ?? []).findIndex((r) => r.rel === REL.parent);
    if (old && idx < 0) throw new Error(`The parent link of #${id} could not be read; try again.`);
    if (idx >= 0) ops.push({ op: "remove", path: `/relations/${idx}` });
    if (newParent) ops.push({ op: "add", path: "/relations/-", value: { rel: REL.parent, url: `${this.ws.api.ctx.orgUrl}_apis/wit/workItems/${newParent}` } });
    const np = this.ws.get(newParent);
    const op = this.ws.get(old);
    const action = `Parent: ${op ? `#${op.id} ${op.title}` : "(none)"} → ${np ? `#${np.id} ${np.title}` : newParent ? "#" + newParent : "(none)"}`;
    // sent with the revision just read: the link positions above belong to it
    const fresh = await this.patch(id, ops, action, { parent: old || null }, { parent: newParent || null }, undefined, it.rev);
    // the old and new parent changed too (their child links); read them again so their revisions match
    for (const p of [old, newParent]) if (p) this.refreshLater(p);
    return { item: fresh, undo: () => this.reparent(id, old) };
  }

  async addLink(id: number, rel: string, target: number): Promise<WriteResult> {
    this.item(id); // refuses an item that is not loaded, before anything is sent
    const fresh = await this.patch(id, [{ op: "add", path: "/relations/-", value: { rel, url: `${this.ws.api.ctx.orgUrl}_apis/wit/workItems/${target}` } }],
      `Link added: ${relName(rel)} #${target}`, {}, { link: `${rel} ${target}` });
    this.refreshLater(target);
    return { item: fresh, undo: () => this.removeLink(id, rel, target) };
  }

  async removeLink(id: number, rel: string, target: number): Promise<WriteResult> {
    await this.ws.withRelations([id]);
    const it = this.item(id);
    const idx = (it.relations ?? []).findIndex((r) => r.rel === rel && relId(r) === target);
    if (idx < 0) return { item: it };
    const fresh = await this.patch(id, [{ op: "remove", path: `/relations/${idx}` }], `Link removed: ${relName(rel)} #${target}`, { link: `${rel} ${target}` }, {});
    this.refreshLater(target);
    return { item: fresh, undo: () => this.addLink(id, rel, target) };
  }

  // ---------- order ----------

  /** Move an item between two others in the team's backlog order (0 = start or end). */
  async reorder(id: number, previousId: number, nextId: number): Promise<WriteResult> {
    const it = this.item(id);
    const oldOrder = it.order;
    const list = this.ws.ofLevel(this.ws.levelOf(it)).filter((x) => x.id !== id);
    const oldIdx = this.ws.ofLevel(this.ws.levelOf(it)).findIndex((x) => x.id === id);
    const oldPrev = oldIdx > 0 ? this.ws.ofLevel(this.ws.levelOf(it))[oldIdx - 1].id : 0;
    const oldNext = list[oldIdx]?.id ?? 0;
    try {
      const res = await this.ws.api.reorder(it.project ?? this.ws.project, this.ws.team, [id], previousId, nextId);
      const order = res.find((r) => r.id === id)?.order;
      // the new revision is not known (Azure DevOps sends only the order): keep the old one, mark the
      // copy as a guess, and read the item again; that read replaces it whatever its revision
      const fresh: WorkItem = { ...it, order: order ?? it.order, stale: true };
      this.ws.put(fresh);
      const p = this.ws.get(previousId);
      void this.log.add({ by: this.me, byName: this.meName, itemId: id, itemTitle: it.title, itemType: it.type, action: `Priority: moved ${p ? `after #${p.id}` : "to the top"}`, before: { order: oldOrder ?? null }, after: { order: order ?? null }, ok: true });
      this.refreshLater(id);
      return { item: fresh, undo: () => this.reorder(id, oldPrev, oldNext) };
    } catch (e) {
      void this.log.add({ by: this.me, byName: this.meName, itemId: id, itemTitle: it.title, itemType: it.type, action: "Priority change", before: {}, after: {}, ok: false, error: (e as Error).message });
      throw e;
    }
  }

  // ---------- create, comment ----------

  async create(type: string, fields: Record<string, unknown>, parentId?: number): Promise<WorkItem> {
    const ops: PatchOp[] = Object.entries(fields).filter(([, v]) => v != null && v !== "")
      .map(([f, v]) => ({ op: "add", path: `/fields/${f}`, value: v }));
    if (!fields["System.AreaPath"]) ops.push({ op: "add", path: "/fields/System.AreaPath", value: this.ws.defaultArea() });
    if (parentId) ops.push({ op: "add", path: "/relations/-", value: { rel: REL.parent, url: `${this.ws.api.ctx.orgUrl}_apis/wit/workItems/${parentId}` } });
    const title = String(fields["System.Title"] ?? "");
    try {
      const item = await this.ws.api.create(this.ws.project, type, ops);
      this.ws.put(item);
      void this.log.add({ by: this.me, byName: this.meName, itemId: item.id, itemTitle: item.title, itemType: type, action: `Created ${type}${parentId ? ` under #${parentId}` : ""}`, before: {}, after: fields, ok: true });
      if (parentId) this.refreshLater(parentId);
      return item;
    } catch (e) {
      void this.log.add({ by: this.me, byName: this.meName, itemId: 0, itemTitle: title, itemType: type, action: `Create ${type}`, before: {}, after: fields, ok: false, error: (e as Error).message });
      throw e;
    }
  }

  /** Delete a work item (to the Recycle Bin). Undo brings it back. */
  async deleteItem(id: number): Promise<WriteResult> {
    const it = this.item(id);
    const project = it.project ?? this.ws.project;
    const entry = { by: this.me, byName: this.meName, itemId: id, itemTitle: it.title, itemType: it.type, action: `Deleted ${it.type}`, before: { state: it.state }, after: {} };
    try {
      await this.ws.api.deleteItem(project, id);
    } catch (e) {
      void this.log.add({ ...entry, ok: false, error: (e as Error).message });
      throw e;
    }
    void this.log.add({ ...entry, ok: true });
    this.ws.forget(id);
    if (it.parent) this.refreshLater(it.parent);
    return {
      item: it,
      undo: async () => {
        await this.ws.api.restoreItem(project, id);
        void this.log.add({ ...entry, action: `Restored ${it.type}`, before: {}, after: { state: it.state }, ok: true });
        await this.ws.refresh(id);
        if (it.parent) this.refreshLater(it.parent);
      },
    };
  }

  /** Bring an item back from the Recycle Bin; it shows on the pages with the next read. Undo deletes it again. */
  async restoreDeleted(d: DeletedItem): Promise<{ undo: () => Promise<unknown> }> {
    const project = this.ws.project;
    const entry = { by: this.me, byName: this.meName, itemId: d.id, itemTitle: d.title, itemType: d.type, action: `Restored ${d.type}`, before: {}, after: {} };
    try {
      await this.ws.api.restoreItem(project, d.id);
    } catch (e) {
      void this.log.add({ ...entry, ok: false, error: (e as Error).message });
      throw e;
    }
    void this.log.add({ ...entry, ok: true });
    void this.ws.poll().catch(() => undefined);
    return {
      undo: async () => {
        await this.ws.api.deleteItem(project, d.id);
        void this.log.add({ ...entry, action: `Deleted ${d.type}`, ok: true });
        this.ws.forget(d.id);
      },
    };
  }

  async comment(id: number, html: string): Promise<void> {
    const it = this.item(id);
    const entry = { by: this.me, byName: this.meName, itemId: id, itemTitle: it.title, itemType: it.type, action: `Comment: ${show(html)}`, before: {}, after: { comment: html } };
    try {
      await this.ws.api.addComment(it.project ?? this.ws.project, id, html);
    } catch (e) {
      void this.log.add({ ...entry, ok: false, error: (e as Error).message });
      throw e;
    }
    void this.log.add({ ...entry, ok: true });
    this.refreshLater(id);
  }

  // ---------- changes that are not work items (tags, board, capacity, settings) ----------

  /**
   * Run a change that is not a work item field and write it to the change log, worked or not.
   * `what` names the thing changed (a tag, a board column, a sprint); the entry has no work item (id 0).
   */
  async logged<T>(action: string, what: { type: string; title: string }, job: () => Promise<T>, before: Record<string, unknown> = {}, after: Record<string, unknown> = {}): Promise<T> {
    const entry = { by: this.me, byName: this.meName, itemId: 0, itemTitle: what.title, itemType: what.type, action, before, after };
    try {
      const r = await job();
      void this.log.add({ ...entry, ok: true });
      return r;
    } catch (e) {
      void this.log.add({ ...entry, ok: false, error: (e as Error).message });
      throw e;
    }
  }

  /** Rename a tag in the whole project. */
  renameTag(project: string, tagId: string, name: string, oldName = ""): Promise<void> {
    return this.logged(`Tag renamed: ${oldName || tagId} → ${name}`, { type: "Tag", title: name },
      () => this.ws.api.renameTag(project, tagId, name), { tag: oldName || tagId }, { tag: name });
  }

  /** Delete a tag from the whole project (and so from every item that has it). */
  deleteTag(project: string, tagId: string, name = ""): Promise<void> {
    return this.logged(`Tag deleted: ${name || tagId}`, { type: "Tag", title: name || tagId },
      () => this.ws.api.deleteTag(project, tagId), { tag: name || tagId }, {});
  }

  /** Change the most cards a board column should hold (0 = no limit). */
  setColumnLimit(project: string, team: string, boardName: string, column: string, limit: number, oldLimit?: number): Promise<void> {
    const text = (n: number | undefined): string => (n == null ? "?" : n ? String(n) : "no limit");
    return this.logged(`Column limit of ${column}: ${text(oldLimit)} → ${text(limit)}`, { type: "Board column", title: `${boardName}: ${column}` },
      () => this.ws.api.setColumnLimit(project, team, boardName, column, limit), { limit: oldLimit ?? null }, { limit });
  }

  /** Replace the team days off in a sprint. */
  setTeamDaysOff(project: string, team: string, iterationId: string, daysOff: { start: string; end: string }[], sprintName = ""): Promise<void> {
    return this.logged(`Team days off in ${sprintName || "a sprint"}: ${daysOff.length} ${daysOff.length === 1 ? "range" : "ranges"}`, { type: "Sprint", title: sprintName || iterationId },
      () => this.ws.api.setTeamDaysOff(project, team, iterationId, daysOff), {}, { daysOff });
  }

  /** Set the capacity and days off of one person in a sprint. */
  setCapacity(project: string, team: string, iterationId: string, memberId: string,
    body: { activities: { name: string; capacityPerDay: number }[]; daysOff: { start: string; end: string }[] }, personName = "", sprintName = ""): Promise<void> {
    const hours = body.activities.reduce((n, a) => n + (a.capacityPerDay || 0), 0);
    return this.logged(`Capacity of ${personName || "a team member"} in ${sprintName || "a sprint"}: ${hours} h per day, ${body.daysOff.length} days-off ${body.daysOff.length === 1 ? "range" : "ranges"}`,
      { type: "Capacity", title: personName || memberId }, () => this.ws.api.setCapacity(project, team, iterationId, memberId, body), {}, { ...body });
  }


  /** Change an item's checklist (kept in the extension's storage, not in the item) and log it. */
  async changeChecklist(id: number, change: (items: CheckItem[]) => CheckItem[], action: string): Promise<CheckItem[]> {
    const it = this.ws.get(id);
    const entry = { by: this.me, byName: this.meName, itemId: id, itemTitle: it?.title ?? "", itemType: it?.type ?? "", action: `Checklist: ${action}`, before: {} };
    try {
      const items = await this.checklists.change(id, change, this.me);
      const p = progress(items);
      void this.log.add({ ...entry, after: { checklist: `${p.done}/${p.total}` }, ok: true });
      return items;
    } catch (e) {
      void this.log.add({ ...entry, after: {}, ok: false, error: (e as Error).message });
      throw e;
    }
  }

  /** Text fields need some text before they count; helper for forms. */
  static enough(html: string, min: number): boolean { return hasText(html, min); }
}

function personValue(v: unknown): unknown {
  if (v && typeof v === "object" && "uniqueName" in v) return (v as Person).uniqueName;
  return v;
}

function relName(rel: string): string {
  return ({ [REL.parent]: "parent", [REL.child]: "child", [REL.predecessor]: "predecessor", [REL.successor]: "successor", [REL.related]: "related" } as Record<string, string>)[rel] ?? rel;
}
