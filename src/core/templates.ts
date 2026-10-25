// Templates for child work: the team's standard tasks under a story (or standard stories under a
// Feature), per parent work item type. Kept in the project's shared settings. Pure: no page code.

export interface ChildTemplate {
  title: string;
  /** the child's work item type; empty = the child level's default type */
  type?: string;
  /** the task's activity (Development, Testing, …), when the child is a task */
  activity?: string;
  /** remaining work in hours, when the child is a task */
  remaining?: number;
}

/** A title made comparable: no case, no extra spaces. */
export function titleKey(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The template as saved: trimmed titles, no empty ones, no two with the same title, sane hours. */
export function cleanTemplates(list: ChildTemplate[] | undefined): ChildTemplate[] {
  const seen = new Set<string>();
  const out: ChildTemplate[] = [];
  for (const t of list ?? []) {
    const title = String(t?.title ?? "").trim().replace(/\s+/g, " ");
    const key = titleKey(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const c: ChildTemplate = { title };
    if (t.type?.trim()) c.type = t.type.trim();
    if (t.activity?.trim()) c.activity = t.activity.trim();
    const hours = Number(t.remaining);
    if (t.remaining != null && String(t.remaining) !== "" && Number.isFinite(hours) && hours >= 0) c.remaining = Math.round(hours * 100) / 100;
    out.push(c);
  }
  return out;
}

/** The template entries that are not yet children (by title, ignoring case and spaces). */
export function missingChildren(template: ChildTemplate[] | undefined, existingTitles: string[]): ChildTemplate[] {
  const have = new Set(existingTitles.map(titleKey));
  return cleanTemplates(template).filter((t) => !have.has(titleKey(t.title)));
}

/** A starting set offered in Settings for a story type. */
export const EXAMPLE_TASKS: ChildTemplate[] = [
  { title: "Write tests" },
  { title: "Update documentation" },
  { title: "Code review" },
];
