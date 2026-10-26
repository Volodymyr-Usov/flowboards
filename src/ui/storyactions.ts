// Two buttons on a story's details panel: split it in half (its tasks too), and make a follow-up story.
// Both go through app.actions.batch: one message afterwards with one Undo for everything they did.
import type { WorkItem } from "../api/types.ts";
import type { App } from "../app/context.ts";
import { statesOf } from "../core/model.ts";
import { canSplitByHalf, followUpTitle, partTitles, splitTasks } from "../core/storysplit.ts";
import type { WriteResult, Writer } from "../core/writes.ts";
import { h } from "./dom.ts";
import { dialog } from "./kit.ts";

const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The tasks of a story (children of the task level). */
export function tasksOf(app: App, it: WorkItem): WorkItem[] {
  const task = app.ws.taskLevel();
  return task ? app.ws.children(it.id).filter((c) => task.types.includes(c.type)) : [];
}

/** The fields a copy keeps: owner, place, description, acceptance criteria, tags, priority, estimate, dates. */
function copyFields(app: App, o: WorkItem): Record<string, unknown> {
  const ws = app.ws;
  const has = (f: string): boolean => { const fs = ws.process.types[o.type]?.fields; return !fs || fs.includes(f); };
  const fields: Record<string, unknown> = {
    "System.AreaPath": o.area, "System.IterationPath": o.iteration, "System.AssignedTo": o.assignedTo?.uniqueName, "System.Description": o.description,
  };
  if (o.acceptance && has("Microsoft.VSTS.Common.AcceptanceCriteria")) fields["Microsoft.VSTS.Common.AcceptanceCriteria"] = o.acceptance;
  if (o.tags.length) fields["System.Tags"] = o.tags.join("; ");
  if (o.priority != null && has("Microsoft.VSTS.Common.Priority")) fields["Microsoft.VSTS.Common.Priority"] = o.priority;
  if (o.effort != null && ws.process.fields.effort && has(ws.process.fields.effort)) fields[ws.process.fields.effort] = o.effort;
  if (o.targetDate && has("Microsoft.VSTS.Scheduling.TargetDate")) fields["Microsoft.VSTS.Scheduling.TargetDate"] = o.targetDate;
  if (o.dueDate && has("Microsoft.VSTS.Scheduling.DueDate")) fields["Microsoft.VSTS.Scheduling.DueDate"] = o.dueDate;
  return fields;
}

/** An estimate split in two: the first part keeps the larger half (to one decimal), the second the rest. */
export function halfEstimate(n: number): [number, number] {
  const first = Math.ceil((n * 10) / 2) / 10;
  return [first, Math.round((n - first) * 10) / 10];
}

/** Undo of a story we made: delete it (it goes to the Recycle Bin); where that is refused, set it to Removed. */
function undoCreate(app: App, w: Writer, id: number, type: string): () => Promise<unknown> {
  return async () => {
    try { await w.deleteItem(id); return; } catch { /* no right to delete: set it to Removed instead */ }
    const gone = statesOf(app.ws.process, [type], ["Removed"])[0];
    if (gone) await w.setFields(id, [{ field: "System.State", value: gone }]);
  };
}

/**
 * Split a story by half: the first half of its tasks stays (the story becomes "… (part 1)"), the second half moves to a
 * new copy "… (part 2)" with the same description, owner, sprint, tags, estimate and parent. Asks first.
 */
export async function splitStory(app: App, it: WorkItem): Promise<void> {
  const tasks = tasksOf(app, it);
  if (!canSplitByHalf(tasks)) return;
  const { first, second } = splitTasks(tasks);
  const [t1, t2] = partTitles(it.title);
  const ws = app.ws;
  // the estimate is split too, so the two parts together are not counted twice
  const effortField = ws.process.fields.effort;
  const fs = ws.process.types[it.type]?.fields;
  const halves = it.effort != null && it.effort > 0 && effortField && (!fs || fs.includes(effortField)) ? halfEstimate(it.effort) : null;
  const list = (xs: WorkItem[]): HTMLElement => h("ul", null, xs.map((t) => h("li", null, `#${t.id} ${t.title}`)));
  const ok = await dialog("Split this story in half?", h("div", null,
    h("p", null, h("b", null, it.title)),
    h("p", null, `It becomes “${t1}”${halves ? ` with an estimate of ${halves[0]} (of ${it.effort})` : ""} and keeps these ${first.length} tasks:`), list(first),
    h("p", null, `A new story “${t2}” is made with the same description, owner, sprint, tags and parent${halves ? `, the rest of the estimate (${halves[1]})` : ""}, and gets these ${second.length} tasks:`), list(second),
    h("p.small.muted", null, "The message afterwards has Undo, which puts everything back and removes the new story.")),
  [{ label: "Cancel", value: "" }, { label: "Split in half", value: "ok", primary: true }]) === "ok";
  if (!ok) return;
  let copyId = 0;
  const steps: { label: string; run: (w: Writer) => Promise<WriteResult> }[] = [{
    label: `Make “${t2}”`,
    run: async (w) => {
      const item = await w.create(it.type, { ...copyFields(app, it), "System.Title": t2, ...(halves ? { [effortField]: halves[1] } : {}) }, it.parent);
      copyId = item.id;
      // the copy stands where the original stands (state and board column), where the process allows it
      const same: { field: string; value: unknown }[] = [{ field: "System.State", value: it.state }];
      if (ws.board?.columnField && it.boardColumn) same.push({ field: ws.board.columnField, value: it.boardColumn });
      await w.setFields(item.id, same).catch(() => undefined);
      await w.comment(it.id, `<p>Split in half: the second half of the tasks went to #${item.id}.</p>`).catch(() => undefined);
      await w.comment(item.id, `<p>Part 2 of #${it.id} ${esc(it.title)}: split in half.</p>`).catch(() => undefined);
      return { item, undo: undoCreate(app, w, item.id, it.type) };
    },
  }];
  for (const t of second) {
    steps.push({ label: `#${t.id} to part 2`, run: (w) => (copyId ? w.reparent(t.id, copyId) : Promise.reject(new Error("the second part was not made"))) });
  }
  steps.push({
    // without the second part this one stays as it is (title and estimate)
    label: "Rename this story", run: (w) => !copyId ? Promise.reject(new Error("the second part was not made")) : w.setFields(it.id, [{ field: "System.Title", value: t1 }, ...(halves ? [{ field: effortField, value: halves[0] }] : [])]),
  });
  await app.actions.batch(`“${it.title}” split in half: ${first.length} tasks stay, ${second.length} moved to part 2`, steps);
}

/**
 * A follow-up: a new story “Follow-up for … (#n)” with the same description (and a line that says what it follows), under the
 * same parent and in the backlog. The story it follows only gets a comment.
 */
export async function followUp(app: App, it: WorkItem): Promise<void> {
  const ws = app.ws;
  const title = followUpTitle(it);
  const fields: Record<string, unknown> = {
    "System.Title": title, "System.AreaPath": it.area, "System.IterationPath": ws.settings.backlogIteration ?? ws.project,
    "System.Description": `<p>Follow-up for #${it.id} ${esc(it.title)}.</p>${it.description ?? ""}`,
  };
  const has = (f: string): boolean => { const fs = ws.process.types[it.type]?.fields; return !fs || fs.includes(f); };
  if (it.acceptance && has("Microsoft.VSTS.Common.AcceptanceCriteria")) fields["Microsoft.VSTS.Common.AcceptanceCriteria"] = it.acceptance;
  if (it.tags.length) fields["System.Tags"] = it.tags.join("; ");
  if (it.priority != null && has("Microsoft.VSTS.Common.Priority")) fields["Microsoft.VSTS.Common.Priority"] = it.priority;
  await app.actions.batch(`Follow-up made for “${it.title}”`, [{
    label: title,
    run: async (w) => {
      const item = await w.create(it.type, fields, it.parent);
      await w.comment(it.id, `<p>Follow-up made: #${item.id}.</p>`).catch(() => undefined);
      return { item, undo: undoCreate(app, w, item.id, it.type) };
    },
  }]);
}
