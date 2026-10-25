// Rules on moves ("gates"): what an item needs before it may enter a state or board column,
// and who may make that move. Pure: the page gathers the facts, this decides.
// The rules are kept in the extension's shared storage, so the whole project sees the same ones.
// They guard moves made in this extension; Azure DevOps itself does not know them.

export type Requirement =
  | "description" | "acceptance" | "owner" | "parent" | "effort" | "iteration"
  | "hasChildren" | "childrenDone" | "prsMerged" | "noOpenPredecessors" | "tags" | "checklistDone";

export const REQUIREMENTS: { id: Requirement; label: string; help: string }[] = [
  { id: "description", label: "Description", help: "The description has at least 20 characters of text." },
  { id: "acceptance", label: "Acceptance criteria", help: "The acceptance criteria have at least 10 characters of text." },
  { id: "owner", label: "Owner", help: "Someone is in Assigned To." },
  { id: "parent", label: "Parent", help: "The item has a parent (a story under a Feature, a Feature under an Epic)." },
  { id: "effort", label: "Estimate", help: "Story points, effort or size is filled in." },
  { id: "iteration", label: "Sprint", help: "The item is in a sprint, not the backlog root." },
  { id: "hasChildren", label: "Tasks present", help: "The item has at least one child: a story has a task, a Feature has a story." },
  { id: "childrenDone", label: "Children done", help: "Every child item is done (Resolved or Completed)." },
  { id: "prsMerged", label: "Pull requests merged", help: "Every linked pull request is completed or abandoned." },
  { id: "noOpenPredecessors", label: "Predecessors done", help: "Every item this one depends on is done." },
  { id: "tags", label: "A tag", help: "At least one tag." },
  { id: "checklistDone", label: "Checklist done", help: "Every item of the work item's checklist is ticked. An item with no checklist passes, unless the team has a checklist for its type (Settings, Checklists); then it needs one, all ticked." },
];

export interface Rule {
  id: string;
  /** level kind or "*" */
  level: "portfolio" | "requirement" | "task" | "*";
  /** the state or board column name the rule guards (as shown on the board) */
  target: string;
  /** when set, the rule guards only the move from this state or column to the target (either direction) */
  from?: string;
  /** reference names of fields that must be filled, e.g. Microsoft.VSTS.Scheduling.StoryPoints */
  fields?: string[];
  requires: Requirement[];
  /** unique names (emails) of the only people who may make this move; empty = anyone */
  onlyBy: string[];
  /** a sentence shown with the rule */
  note?: string;
  /**
   * Rules hold in their column and in every column to its right (what Ready asks, Active and Review ask too).
   * With this on, inheritance starts again at this rule's column: it does not also require what the columns
   * before it ask. Off (not set) by default.
   */
  breaks?: boolean;
}

/** Facts about one item, collected by the page. */
export interface Facts {
  kind: Rule["level"];
  description: string;
  acceptance: string;
  hasOwner: boolean;
  hasParent: boolean;
  hasEffort: boolean;
  inSprint: boolean;
  children: number;
  openChildren: number;
  openPrs: number;
  openPredecessors: number;
  tags: number;
  /** the item's checklist: ticked and total items; null = it could not be read; missing = not looked at */
  checklist?: { done: number; total: number } | null;
  /** how many items the team's default checklist for this type has (0 = none) */
  checklistDefault?: number;
  me: string;
  /** the item's field values by reference name (for rules that name fields) */
  values?: Record<string, unknown>;
  /** display names of fields by reference name */
  fieldNames?: Record<string, string>;
}

/** Empty: nothing, blank text, or HTML with no text in it. */
export function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "number" || typeof v === "boolean") return false;
  if (typeof v === "object") return !(v as { displayName?: string }).displayName && Object.keys(v as object).length === 0;
  const text = String(v).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim();
  return text === "";
}

/** A readable name for a field reference name. */
export function fieldTitle(ref: string, names?: Record<string, string>): string {
  return names?.[ref] ?? ref.split(".").pop()!.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * "Checklist done", or why not. An item whose checklist has items passes when every item is ticked.
 * An item with no checklist (or an empty one) passes, unless the team has a default list for its
 * type: then it fails until the list is added and ticked. A checklist that could not be read fails.
 */
export function checklistProblem(f: Pick<Facts, "checklist" | "checklistDefault">): string | null {
  const c = f.checklist;
  if (c === null) return "could not be read";
  if (!c || c.total === 0) return f.checklistDefault ? "no checklist yet: add the team's list" : null;
  return c.done < c.total ? `${c.total - c.done} of ${c.total} not ticked` : null;
}

/** One thing a rule still asks for: its words, and what it is (so a page can offer a fix). */
export interface MissingPart { label: string; req?: Requirement; field?: string; /** "only these people may" */ only?: boolean }

export function missingParts(rule: Rule, f: Facts): MissingPart[] {
  const out: MissingPart[] = [];
  for (const r of rule.requires) {
    const ok = {
      description: f.description.trim().length >= 20,
      acceptance: f.acceptance.trim().length >= 10,
      owner: f.hasOwner,
      parent: f.hasParent,
      effort: f.hasEffort,
      iteration: f.inSprint,
      hasChildren: f.children > 0,
      childrenDone: f.openChildren === 0,
      prsMerged: f.openPrs === 0,
      noOpenPredecessors: f.openPredecessors === 0,
      tags: f.tags > 0,
      checklistDone: checklistProblem(f) === null,
    }[r];
    if (!ok) {
      const label = REQUIREMENTS.find((x) => x.id === r)?.label ?? r;
      const detail = r === "childrenDone" ? ` (${f.openChildren} open)` : r === "prsMerged" ? ` (${f.openPrs} open)` : r === "noOpenPredecessors" ? ` (${f.openPredecessors} open)` : r === "checklistDone" ? ` (${checklistProblem(f)})` : "";
      out.push({ label: label + detail, req: r });
    }
  }
  for (const ref of rule.fields ?? []) {
    if (isEmptyValue(f.values?.[ref])) out.push({ label: fieldTitle(ref, f.fieldNames), field: ref });
  }
  if (rule.onlyBy.length && !rule.onlyBy.some((u) => u.toLowerCase() === f.me.toLowerCase())) {
    out.push({ label: `Only ${rule.onlyBy.join(", ")} may move items to ${rule.target}`, only: true });
  }
  return out;
}

export function missing(rule: Rule, f: Facts): string[] {
  return missingParts(rule, f).map((p) => p.label);
}

/**
 * The rules a move must pass: those of the target and, when moving forward over several steps,
 * of each step in between. Moving back passes no rule.
 * `steps` = the columns (or states) in board order.
 */
export function rulesForMove(rules: Rule[], kind: Rule["level"], steps: string[], from: string, to: string): Rule[] {
  const a = steps.indexOf(from);
  const b = steps.indexOf(to);
  const forward = b >= 0 && !(a >= 0 && b <= a);
  const passed = forward ? steps.slice(a < 0 ? b : a + 1, b + 1) : [];
  return rules.filter((r) => {
    if (r.level !== "*" && r.level !== kind) return false;
    // a rule with a starting state guards exactly that move, forward or back
    if (r.from) return r.from === from && r.target === to;
    return passed.includes(r.target);
  });
}

/**
 * The rules that hold for an item standing at step `at`: those of its own step and of every step before it, unless a rule
 * breaks the inheritance (`breaks`): then only that step's rules and those after it count. One-way rules ("from X to Y")
 * guard that move only. `where` tells which step a rule guards (-1: none we know).
 */
export function inheritedRules(rules: Rule[], kind: Rule["level"], at: number, where: (rule: Rule) => number): Rule[] {
  const applicable = rules.filter((r) => !r.from && (r.level === "*" || r.level === kind)).map((rule) => ({ rule, i: where(rule) })).filter((x) => x.i >= 0 && x.i <= at);
  const from = Math.max(-1, ...applicable.filter((x) => x.rule.breaks).map((x) => x.i));
  return applicable.filter((x) => x.i >= from).map((x) => x.rule);
}

export interface MoveCheck { ok: boolean; problems: { rule: Rule; missing: string[]; parts: MissingPart[] }[] }

export function checkMove(rules: Rule[], f: Facts, steps: string[], from: string, to: string): MoveCheck {
  // a forward move also needs what holds in the target column by inheritance (Ready's rules hold in Active too)
  const a = steps.indexOf(from);
  const b = steps.indexOf(to);
  const forward = b >= 0 && !(a >= 0 && b <= a);
  const direct = rulesForMove(rules, f.kind, steps, from, to);
  const inherited = forward ? inheritedRules(rules, f.kind, b, (r) => steps.indexOf(r.target)).filter((r) => !direct.some((d) => d.id === r.id)) : [];
  const problems = [...direct, ...inherited]
    .map((rule) => { const parts = missingParts(rule, f); return { rule, missing: parts.map((p) => p.label), parts }; })
    .filter((p) => p.missing.length);
  return { ok: problems.length === 0, problems };
}

/** A sensible starting set, offered on the settings page; nothing is on until someone saves it. */
export function suggestedRules(states: { name: string; category: string }[]): Rule[] {
  const first = (cat: string) => states.find((s) => s.category === cat)?.name;
  const out: Rule[] = [];
  const active = first("InProgress");
  const resolved = first("Resolved");
  const done = first("Completed");
  if (active) out.push({ id: "r-active", level: "requirement", target: active, requires: ["description", "owner", "parent"], onlyBy: [], note: "Work starts only when it is described and someone owns it." });
  if (resolved) out.push({ id: "r-resolved", level: "requirement", target: resolved, requires: ["acceptance", "prsMerged"], onlyBy: [] });
  if (done) out.push({ id: "r-done", level: "requirement", target: done, requires: ["childrenDone", "prsMerged"], onlyBy: [], note: "Add a person to let only them close stories." });
  return out;
}
