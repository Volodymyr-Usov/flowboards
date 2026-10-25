// The "new work item" form, shared by every view: type, title, description, acceptance criteria,
// points or remaining work, owner, sprint, tags, under which parent. Only the fields the type has are
// shown. AI can draft the texts from the title. When the team has standard tasks for the type
// (Settings, Standard tasks), they can be added under the new item at once. After Create the new item
// opens in the details panel; "Create and add another" keeps the form open for the next one.
import type { Iteration, WorkItem } from "../api/types.ts";

import type { App } from "../app/context.ts";
import { leaf, levelOf, plainText } from "../core/model.ts";
import { cleanTemplates } from "../core/templates.ts";
import { fieldLabel } from "../core/writes.ts";
import { draftTexts } from "./aihelp.ts";
import { h } from "./dom.ts";
import { dialog, toast } from "./kit.ts";
import { attachMentions, mentionSourceFor } from "./mentions.ts";
import { sanitize, sanitizeToString, textToHtml } from "./sanitize.ts";
import { tagInput, usedTags } from "./taginput.ts";

export interface CreateOptions {
  /** the level's types to choose from (first is the default) */
  types: string[];
  parentId?: number;
  iteration?: string;
  assignedTo?: string;
  fields?: Record<string, unknown>;
  /** open the new item in the details panel after Create (default true) */
  open?: boolean;
}

const AC = "Microsoft.VSTS.Common.AcceptanceCriteria";

/**
 * The sprints a new item can go to: the backlog, then the current and coming sprints. A sprint given
 * beforehand (`preset`) is always offered, an ended one marked "(ended)", so it stays chosen.
 * `ended: true` offers every ended sprint too, last, the newest first (the details panel).
 */
export function sprintChoices(backlog: string, iterations: Iteration[], preset?: string, opts: { ended?: boolean } = {}): { path: string; label: string }[] {
  const out: { path: string; label: string }[] = [{ path: backlog, label: `${leaf(backlog)} (backlog)` }];
  const add = (path: string, label: string): void => { if (!out.some((c) => c.path === path)) out.push({ path, label }); };
  const label = (i: Iteration): string => `${leaf(i.path)}${i.timeFrame === "past" ? " (ended)" : i.timeFrame === "current" ? " (current)" : ""}`;
  for (const i of iterations) {
    if (i.timeFrame !== "past" || (i.path === preset && !opts.ended)) add(i.path, label(i));
  }
  if (opts.ended) for (const i of [...iterations].reverse()) if (i.timeFrame === "past") add(i.path, label(i));
  if (preset) add(preset, leaf(preset));
  return out;
}

export async function createItem(app: App, opts: CreateOptions): Promise<WorkItem | null> {
  const ws = app.ws;
  const pf = ws.process.fields;
  const parent = ws.get(opts.parentId);
  const type = h("select.input", null, opts.types.map((t) => h("option", { value: t }, t)));
  const kind = (): string | undefined => levelOf(ws.process, type.value)?.kind;
  const has = (f: string): boolean => { const fs = ws.process.types[type.value]?.fields; return !fs || fs.includes(f); };
  const title = h("input.input", { type: "text", placeholder: "Title", required: true, maxlength: 255 });
  const desc = richBox("Description", "What and why; @ mentions a person, # a work item.");
  const ac = richBox("Acceptance criteria", "How we know it is done");
  const effort = h("input.input", { type: "number", min: 0, step: 1, placeholder: "–" });
  const remaining = h("input.input", { type: "number", min: 0, step: 0.5, placeholder: "Hours" });
  const people = ws.people();
  const owner = h("select.input", null, h("option", { value: "" }, "Nobody"),
    people.map((p) => h("option", { value: p.uniqueName, selected: p.uniqueName === opts.assignedTo }, p.displayName)));
  const iters = sprintChoices(ws.settings.backlogIteration ?? ws.project, ws.iterations, opts.iteration);
  const iteration = h("select.input", null, iters.map((c) => h("option", { value: c.path, selected: c.path === (opts.iteration ?? iters[0].path) }, c.label)));
  let known: string[] | null = null;
  const tags = tagInput({ tags: [], known: () => (known ??= usedTags(ws.items.values())), label: "Tags" });
  const draftBtn = app.ai.enabled ? h("button.btn.small", {
    type: "button",
    onclick: async () => {
      if (!title.value.trim()) { title.focus(); return; }
      draftBtn!.disabled = true;
      draftBtn!.textContent = "Drafting…";
      try {
        const d = await draftTexts(app, { type: type.value, title: title.value, parent, description: plainText(desc.innerHTML), acceptance: plainText(ac.innerHTML) });
        if (d.description && isEmpty(desc)) desc.replaceChildren(sanitize(textToHtml(d.description)));
        if (d.acceptance && isEmpty(ac)) ac.replaceChildren(sanitize(textToHtml(d.acceptance)));
      } catch (e) { toast((e as Error).message, { kind: "error" }); }
      draftBtn!.disabled = false;
      draftBtn!.textContent = "Draft texts with AI";
    },
  }, "Draft texts with AI") : null;

  // the team's standard child work for the chosen type, offered as one tick
  const stdBox = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
  const stdText = h("span");
  const stdRow = h("label.std-row", { title: "Create the team's standard child work under the new item (set in Settings, Standard tasks)" }, stdBox, stdText);
  const template = (): ReturnType<typeof cleanTemplates> => cleanTemplates(app.settings.shared.childTemplates?.[type.value]);

  const acRow = h("div.frow", null, h("span", null, "Acceptance criteria"), ac);
  const effortRow = h("label", null, h("span", null, fieldLabel(pf.effort)), effort);
  const remainingRow = h("label", null, h("span", null, "Remaining work (hours)"), remaining);
  const numRow = h("div.row2", null, effortRow, remainingRow);
  /** only the fields this type has */
  const drawFields = (): void => {
    const fs = ws.process.types[type.value]?.fields;
    acRow.hidden = fs ? !fs.includes(AC) : kind() === "task";
    effortRow.hidden = kind() !== "requirement" || !has(pf.effort);
    remainingRow.hidden = kind() !== "task" || !has(pf.remaining);
    numRow.hidden = effortRow.hidden && remainingRow.hidden;
    const t = template();
    const level = levelOf(ws.process, type.value);
    const child = level ? ws.process.levels.find((l) => l.rank === level.rank + 1) : undefined;
    stdRow.hidden = !t.length || !child;
    stdText.textContent = child ? `Add the standard ${child.kind === "task" ? "tasks" : child.name.toLowerCase()}: ${t.map((x) => x.title).join(", ")}` : "";
  };
  type.addEventListener("change", drawFields);
  drawFields();

  const madeList = h("p.muted.small.made", { hidden: true, role: "status" });
  const form = h("div.form", null,
    parent ? h("p.muted", null, `Under ${parent.type} #${parent.id} ${parent.title}`) : null,
    opts.types.length > 1 ? h("label", null, h("span", null, "Type"), type) : null,
    h("label", null, h("span", null, "Title"), title),
    h("div.frow", null, h("span", null, "Description", draftBtn), desc),
    acRow,
    numRow,
    h("div.row2", null, h("label", null, h("span", null, "Owner"), owner), h("label", null, h("span", null, "Sprint"), iteration)),
    h("div.frow", null, h("span", null, "Tags"), tags.el),
    stdRow,
    madeList);

  // what counts as typed work for "Discard changes?": taken again after each "Create and add another"
  const snapshot = (): string => JSON.stringify([type.value, title.value, desc.innerHTML, ac.innerHTML, effort.value, remaining.value, owner.value, iteration.value, tags.value(), stdBox.checked]);
  let baseline = snapshot();

  let created: WorkItem | null = null;
  const made: WorkItem[] = [];
  async function make(): Promise<WorkItem | null> {
    if (!title.value.trim()) { title.focus(); toast("A title is needed.", { kind: "error" }); return null; }
    const html = (box: HTMLElement): string | undefined => isEmpty(box) ? undefined : sanitizeToString(box.innerHTML);
    const num = (input: HTMLInputElement): number | undefined => input.value === "" || !Number.isFinite(Number(input.value)) ? undefined : Number(input.value);
    const fields: Record<string, unknown> = {
      "System.Title": title.value.trim(),
      "System.Description": html(desc),
      "System.AssignedTo": owner.value || undefined,
      "System.IterationPath": iteration.value,
      "System.Tags": tags.value().join("; ") || undefined,
      "System.AreaPath": parent && parent.area && ws.settings.areas.some((a) => parent.area === a.path || parent.area.startsWith(a.path + "\\")) ? parent.area : ws.defaultArea(),
    };
    if (!acRow.hidden) fields[AC] = html(ac);
    if (!effortRow.hidden) fields[pf.effort] = num(effort);
    if (!remainingRow.hidden && num(remaining) != null) {
      fields[pf.remaining] = num(remaining);
      if (pf.original && has(pf.original)) fields[pf.original] = num(remaining);
    }
    Object.assign(fields, opts.fields ?? {});
    const it = await app.actions.create(type.value, fields, opts.parentId);
    if (!it) return null;
    created = it;
    if (!stdRow.hidden && stdBox.checked) await app.actions.addStandardChildren(it.id, template());
    return it;
  }

  /** after "Create and add another": type, parent, sprint, owner and tags stay; the texts go */
  function next(it: WorkItem): void {
    made.push(it);
    madeList.hidden = false;
    madeList.textContent = `Created ${made.map((x) => `#${x.id}`).join(", ")}. Next one:`;
    title.value = "";
    desc.replaceChildren();
    ac.replaceChildren();
    effort.value = "";
    remaining.value = "";
    baseline = snapshot();
    title.focus();
  }

  const shown = dialog(`New ${opts.types.length === 1 ? opts.types[0] : "work item"}`, form, [
    { label: "Cancel", value: "" },
    {
      label: "Create and add another",
      onClick: async () => { const it = await make(); if (it) next(it); return false; },
    },
    {
      label: "Create", primary: true, value: "create",
      onClick: async () => (await make()) != null,
    },
  ], { wide: true, dirty: () => snapshot() !== baseline });
  // the title first: typing must not change the type
  title.focus();
  const choice = await shown;
  if (choice === "create" && created && opts.open !== false) app.openItem((created as WorkItem).id);
  return created;

  function richBox(label: string, placeholder: string): HTMLElement {
    const box = h("div.rich.editor.create-box", { contenteditable: "true", spellcheck: "true", role: "textbox", "aria-multiline": "true", "aria-label": label, "data-placeholder": placeholder });
    box.addEventListener("input", () => { if (isEmpty(box)) box.replaceChildren(); });
    attachMentions(box, mentionSourceFor(app));
    return box;
  }
}

function isEmpty(box: HTMLElement): boolean {
  return !plainText(box.innerHTML).trim() && !box.querySelector("img");
}
