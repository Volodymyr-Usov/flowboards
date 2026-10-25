// Splitting a story in two and making a follow-up: the pure parts (which tasks go where, the new titles). Pure.
import type { WorkItem } from "../api/types.ts";
import { byOrder } from "./model.ts";

/** The title without a "(part n)" ending, so splitting a part again does not pile suffixes up. */
export function baseTitle(title: string): string {
  return title.replace(/\s*\(part \d+\)\s*$/i, "").trim() || title;
}

/** The two halves of a story's tasks, in the backlog order: the first half is the larger one when the count is odd. */
export function splitTasks<T extends WorkItem>(tasks: T[]): { first: T[]; second: T[] } {
  const sorted = [...tasks].sort(byOrder);
  const cut = Math.ceil(sorted.length / 2);
  return { first: sorted.slice(0, cut), second: sorted.slice(cut) };
}

/** A story can be split by half when it has at least two tasks (one for each part). */
export const canSplitByHalf = (tasks: unknown[]): boolean => tasks.length >= 2;

export const partTitles = (title: string): [string, string] => { const b = baseTitle(title); return [`${b} (part 1)`, `${b} (part 2)`]; };

export const followUpTitle = (it: Pick<WorkItem, "id" | "title">): string => `Follow-up for ${it.title} (#${it.id})`;
