// A work item's value at a moment, from its list of changes. Pure logic.
import type { Update } from "../api/types.ts";

/**
 * The value of a field at moment t, from the updates (any order) and the value now: the new value
 * of the last change at or before t; before the first change, that change's old value; with no
 * change at all, the value now.
 */
export function valueAt(updates: Update[], field: string, now: unknown, t: number): unknown {
  let before: { at: number; v: unknown } | null = null;
  let after: { at: number; v: unknown } | null = null;
  for (const u of updates) {
    const c = u.changes.find((x) => x.field === field);
    if (!c) continue;
    const at = Date.parse(u.date);
    if (Number.isNaN(at)) continue;
    if (at <= t) { if (!before || at >= before.at) before = { at, v: c.newValue }; }
    else if (!after || at < after.at) after = { at, v: c.oldValue };
  }
  if (before) return before.v;
  if (after) return after.v;
  return now;
}
