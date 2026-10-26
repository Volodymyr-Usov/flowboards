// The editor for rules on moves, used in Settings and from a Board column's name: what an item needs
// before it moves to a state or column, optionally only from a given state, fields that must be filled,
// and who alone may make the move.
import type { App } from "../app/context.ts";
import type { Level } from "../api/types.ts";
import type { Workspace } from "../core/workspace.ts";
import { orderedStates } from "../core/model.ts";
import type { Requirement, Rule } from "../core/rules.ts";
import { fieldTitle, REQUIREMENTS } from "../core/rules.ts";
import { AC_FIELD, typeHasField } from "../core/health.ts";
import { h, icon } from "../ui/dom.ts";
import { keepFocus } from "../ui/focuskeep.ts";
import { avatar, dialog, errorText, help, personPicker, popup, select, toast } from "../ui/kit.ts";

/** changed: the draft changed (no redraw); redraw: draw it again, the focus stays on the same control (or goes to `focusKey`) */
export interface EditCtx { changed: () => void; redraw: (focusKey?: string) => void }

/** What is wrong before saving, and the control to mark (its data-fk). */
export interface Problem { message: string; key?: string }

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function moveIn<T>(list: T[], i: number, d: -1 | 1): void {
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

/** Small up/down arrows for reordering (the shared icon set has a down chevron only). */
export function svgArrow(up: boolean): SVGElement {
  const el = icon("down", 14);
  if (up) el.setAttribute("style", "transform: rotate(180deg)");
  return el;
}

function levelTypes(ws: Workspace, level: Rule["level"]): string[] {
  const levels = ws.process.levels;
  const of = (k: Level["kind"]): string[] => levels.filter((l) => l.kind === k).flatMap((l) => l.types);
  return level === "*" ? levels.flatMap((l) => l.types) : of(level);
}

/** Does any type of this level have acceptance criteria? (Basic's Issue and some custom types do not.) */
export function levelHasAcceptance(ws: Workspace, level: Rule["level"]): boolean {
  return levelTypes(ws, level).some((t) => typeHasField(ws.process, t, AC_FIELD));
}

function placeOptions(ws: Workspace, rule: Rule): { cols: string[]; states: string[] } {
  const cols = ws.board && (rule.level === "requirement" || rule.level === "*") ? ws.board.columns.map((c) => c.name) : [];
  const states = orderedStates(ws.process, levelTypes(ws, rule.level)).map((s) => s.name);
  return { cols, states };
}

function targetOptions(ws: Workspace, rule: Rule, ctx: EditCtx): HTMLSelectElement {
  const { cols, states } = placeOptions(ws, rule);
  const known = new Set([...cols, ...states]);
  return h("select.input", {
    title: "The state or board column this rule guards: moving an item there needs what is ticked below",
    "aria-label": "Move to", "data-fk": `rule:${rule.id}:target`,
    onchange: (e: Event) => { rule.target = (e.target as HTMLSelectElement).value; ctx.changed(); },
  },
  !rule.target ? h("option", { value: "", selected: true }, "Pick a state or column") : null,
  rule.target && !known.has(rule.target) ? h("option", { value: rule.target, selected: true }, `${rule.target} (not found)`) : null,
  cols.length ? h("optgroup", { label: `Board columns (${ws.board!.name})` }, cols.map((c) => h("option", { value: c, selected: rule.target === c }, c))) : null,
  states.length ? h("optgroup", { label: "States" }, states.filter((x) => !cols.includes(x)).map((x) => h("option", { value: x, selected: rule.target === x }, x))) : null);
}

function fromOptions(ws: Workspace, rule: Rule, ctx: EditCtx): HTMLSelectElement {
  const { cols, states } = placeOptions(ws, rule);
  const known = new Set([...cols, ...states]);
  return h("select.input", {
    title: "Where the move starts. \"Any earlier\" guards every move forward into the target; a named state or column guards only the move from there to the target, forward or back",
    "aria-label": "From", "data-fk": `rule:${rule.id}:from`,
    onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) rule.from = v; else delete rule.from; ctx.changed(); },
  },
  h("option", { value: "", selected: !rule.from }, "Any earlier state"),
  // a saved state or column that is gone: keep it visible, like targetOptions
  rule.from && !known.has(rule.from) ? h("option", { value: rule.from, selected: true }, `${rule.from} (not found)`) : null,
  cols.length ? h("optgroup", { label: `Board columns (${ws.board!.name})` }, cols.map((c) => h("option", { value: c, selected: rule.from === c }, c))) : null,
  states.length ? h("optgroup", { label: "States" }, states.filter((x) => !cols.includes(x)).map((x) => h("option", { value: x, selected: rule.from === x }, x))) : null);
}

/** Every field of the level's types, with its display name, sorted by name. */
function fieldsOf(ws: Workspace, level: Rule["level"]): { ref: string; name: string }[] {
  const out = new Map<string, string>();
  for (const t of levelTypes(ws, level)) {
    const info = ws.process.types[t];
    for (const ref of info?.fields ?? []) out.set(ref, info?.fieldNames?.[ref] ?? fieldTitle(ref));
  }
  if (!out.size) for (const ref of [ws.process.fields.effort, "Microsoft.VSTS.Common.Priority", "System.Description", "Microsoft.VSTS.Common.AcceptanceCriteria", "System.AssignedTo", "System.Tags"]) out.set(ref, fieldTitle(ref));
  return [...out].map(([ref, name]) => ({ ref, name })).filter((f) => !/^System.(Id|Rev|State|WorkItemType|TeamProject|CreatedDate|CreatedBy|ChangedDate|ChangedBy|Watermark|AuthorizedAs|AuthorizedDate|RevisedDate|PersonId|BoardColumn|BoardColumnDone|BoardLane|CommentCount|NodeName|AreaId|IterationId|IterationLeveld|AreaLeveld|ExternalLinkCount|HyperLinkCount|AttachedFileCount|RelatedLinkCount|RemoteLinkCount|Parent|History|Reason)$/.test(f.ref))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fieldChips(ws: Workspace, rule: Rule, ctx: EditCtx): HTMLElement {
  const all = fieldsOf(ws, rule.level);
  const nameOf = (ref: string): string => all.find((f) => f.ref === ref)?.name ?? fieldTitle(ref);
  const list = rule.fields ?? [];
  return h("div.set-chips", null,
    list.map((ref, k) => h("span.chip", { title: ref }, nameOf(ref),
      h("button.icon-btn.small", {
        title: `Remove ${nameOf(ref)}`, "aria-label": `Remove ${nameOf(ref)}`, "data-fk": `rule:${rule.id}:fld:${ref}`, "data-fg": `rule:${rule.id}:fld`, "data-fe": `rule:${rule.id}:addfield`,
        onclick: () => { list.splice(k, 1); if (!list.length) delete rule.fields; ctx.redraw(); },
      }, icon("close", 12)))),
    h("button.btn.small", {
      title: "Add a field that must be filled before this move", "data-fk": `rule:${rule.id}:addfield`,
      onclick: (e: Event) => {
        const input = h("input.input", { type: "search", placeholder: "Find a field", "aria-label": "Find a field" });
        const box = h("div.pick-list");
        let close = (): void => {};
        const draw = (): void => {
          const q = input.value.trim().toLowerCase();
          box.replaceChildren(...all.filter((f) => !list.includes(f.ref) && (!q || f.name.toLowerCase().includes(q) || f.ref.toLowerCase().includes(q))).slice(0, 80)
            .map((f) => h("button.pick-item", { title: f.ref, onclick: () => { close(); rule.fields = [...list, f.ref]; ctx.redraw(); } }, h("span", null, f.name), h("small", null, f.ref))));
          if (!box.children.length) box.append(h("div.muted.pad", null, "No field found"));
        };
        input.addEventListener("input", draw);
        input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") (box.querySelector(".pick-item") as HTMLElement | null)?.click(); });
        draw();
        close = popup(e.currentTarget as Element, h("div.picker.wide", null, input, box));
      },
    }, icon("plus", 12), "Add field"),
    !list.length ? h("span.small.muted", null, "No fields") : null);
}

export function ruleCard(app: App, rule: Rule, i: number, list: Rule[], ctx: EditCtx, opts: { title?: string } = {}): HTMLElement {
  const ws = app.ws;
  const req = ws.requirementLevel();
  const portfolio = ws.portfolioLevels();
  const task = ws.taskLevel();
  const levelOpts: { value: Rule["level"]; label: string }[] = [
    { value: "requirement", label: req.name },
    ...(portfolio.length ? [{ value: "portfolio" as const, label: portfolio.map((l) => l.name).join(", ") }] : []),
    ...(task ? [{ value: "task" as const, label: task.name }] : []),
    { value: "*", label: "Every level" },
  ];
  const people = ws.people();
  const nameOf = (u: string): string => people.find((p) => p.uniqueName.toLowerCase() === u.toLowerCase())?.displayName ?? u;
  const chips = h("div.set-chips", null,
    rule.onlyBy.map((u, k) => h("span.chip.set-person", { title: u },
      avatar(app.api, people.find((p) => p.uniqueName.toLowerCase() === u.toLowerCase()) ?? { displayName: nameOf(u), uniqueName: u }, 18),
      nameOf(u),
      h("button.icon-btn.small", {
        title: `Remove ${nameOf(u)}`, "aria-label": `Remove ${nameOf(u)}`, "data-fk": `rule:${rule.id}:by:${u}`, "data-fg": `rule:${rule.id}:by`, "data-fe": `rule:${rule.id}:addperson`,
        onclick: () => { rule.onlyBy.splice(k, 1); ctx.redraw(); },
      }, icon("close", 12)))),
    h("button.btn.small", {
      title: "Add a person who may make this move. When the list is empty, anyone may.", "data-fk": `rule:${rule.id}:addperson`,
      onclick: (e: Event) => personPicker(app.api, e.currentTarget as Element, people.filter((p) => !rule.onlyBy.some((u) => u.toLowerCase() === p.uniqueName.toLowerCase())), undefined, (p) => {
        if (p) { rule.onlyBy.push(p.uniqueName); ctx.redraw(); }
      }, { allowNone: false }),
    }, icon("plus", 12), "Add person"),
    !rule.onlyBy.length ? h("span.small.muted", null, "Anyone may") : null);

  return h("div.set-card.set-rule", null,
    h("div.set-card-head", null,
      h("b", null, opts.title ?? `Rule ${i + 1}`),
      rule.target ? h("span.small.muted", null, rule.from ? `moving from ${rule.from} to ${rule.target}` : `moving to ${rule.target}`) : null,
      h("span.spacer"),
      // after a move the focus stays on the moved rule's arrow (the other arrow once it reaches an end)
      h("button.icon-btn.small", { title: "Move this rule up", "aria-label": "Move up", disabled: i === 0, "data-fk": `rule:${rule.id}:up`, onclick: () => { moveIn(list, i, -1); ctx.redraw(i - 1 === 0 ? `rule:${rule.id}:down` : undefined); } }, svgArrow(true)),
      h("button.icon-btn.small", { title: "Move this rule down", "aria-label": "Move down", disabled: i === list.length - 1, "data-fk": `rule:${rule.id}:down`, onclick: () => { moveIn(list, i, 1); ctx.redraw(i + 1 === list.length - 1 ? `rule:${rule.id}:up` : undefined); } }, svgArrow(false)),
      h("button.icon-btn.small", { title: "Remove this rule", "aria-label": "Remove rule", "data-fk": `rule:${rule.id}:rm`, "data-fg": "rule:rm", "data-fe": "rules:add", onclick: () => { list.splice(i, 1); ctx.redraw(); } }, icon("close", 14))),
    h("div.set-grid", null,
      h("label.set-field", null, h("span", null, "Level"),
        select(levelOpts, rule.level, (v) => { rule.level = v; ctx.redraw(); }, { title: "Which items the rule applies to", "aria-label": "Level", "data-fk": `rule:${rule.id}:level` })),
      h("label.set-field", null, h("span", null, "From"), fromOptions(ws, rule, ctx)),
      h("label.set-field", null, h("span", null, "Move to"), targetOptions(ws, rule, ctx))),
    h("div.set-field", null, h("span", null, "Fields that must be filled", help("Pick any field of this level's work item types. The move is stopped while one of them is empty.")), fieldChips(ws, rule, ctx)),
    h("div.set-field", null, h("span", null, "Needs"),
      // acceptance criteria only where the level's types have them (still shown when a saved rule asks for them)
      h("div.set-checks", null, REQUIREMENTS.filter((r) => r.id !== "acceptance" || rule.requires.includes(r.id) || levelHasAcceptance(ws, rule.level)).map((r, k) => h("label.set-check", { title: r.help },
        h("input", {
          type: "checkbox", checked: rule.requires.includes(r.id), "data-fk": k === 0 ? `rule:${rule.id}:needs` : `rule:${rule.id}:needs:${r.id}`,
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            rule.requires = on ? [...rule.requires, r.id as Requirement] : rule.requires.filter((x) => x !== r.id);
            ctx.changed();
          },
        }), r.label)))),
    // inheritance: on by default; a rule can start fresh at its column (never used by most teams, but possible)
    rule.from ? null : h("div.set-field", null, h("span", null, "Inheritance", help("Rules hold in their column and in every column to its right: what Ready asks, Active and Review ask too. Untick to start fresh here: this column and those to its right then ask only what this rule and the later ones ask, not what the columns before ask.")),
      h("label.set-check", { title: "On: this column also asks what the columns to its left ask. Off: the rules start fresh at this column." },
        h("input", { type: "checkbox", checked: !rule.breaks, "data-fk": `rule:${rule.id}:inherit`, onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) delete rule.breaks; else rule.breaks = true; ctx.changed(); } }),
        "Also ask what the columns before it ask (inherited)")),
    h("div.set-field", null, h("span", null, "Only these people may", help("Only the people listed may make this move. This part cannot be skipped with \"move anyway\".")), chips),
    h("label.set-field", null, h("span", null, "Note"),
      h("input.input", {
        value: rule.note ?? "", placeholder: "Why the rule exists (shown when it stops a move)", title: "A sentence shown with the rule when it stops a move", "data-fk": `rule:${rule.id}:note`,
        oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v) rule.note = v; else delete rule.note; ctx.changed(); },
      })));
}

/** What is wrong with a list of rules before saving, and the field to mark, or null. */
export function ruleProblem(rules: Rule[], label: (i: number) => string = (i) => `Rule ${i + 1}`): Problem | null {
  const i = rules.findIndex((r) => !r.target);
  if (i >= 0) return { message: `${label(i)}: pick the state or column it guards.`, key: `rule:${rules[i].id}:target` };
  const j = rules.findIndex((r) => !r.requires.length && !r.onlyBy.length && !(r.fields ?? []).length);
  if (j >= 0) return { message: `${label(j)}: tick what it needs, add a field, or add a person.`, key: `rule:${rules[j].id}:needs` };
  const k = rules.findIndex((r) => r.from && r.from === r.target);
  if (k >= 0) return { message: `${label(k)}: "From" and "Move to" are the same.`, key: `rule:${rules[k].id}:from` };
  return null;
}

/** What is wrong with a list of rules before saving, or null. */
export function checkRules(rules: Rule[], label?: (i: number) => string): string | null {
  return ruleProblem(rules, label)?.message ?? null;
}

/**
 * Mark the control with this data-fk as wrong: red outline, aria-invalid, the message under it;
 * scrolled to and focused. The mark goes when the control changes or the next check runs.
 * False when no such control is shown.
 */
export function markInvalid(root: HTMLElement, key: string | undefined, message: string): boolean {
  clearInvalid(root);
  const el = key ? root.querySelector<HTMLElement>(`[data-fk="${CSS.escape(key)}"]`) : null;
  if (!el) return false;
  // a box of checkboxes is outlined as a whole
  const box = el.closest<HTMLElement>(".set-checks") ?? el;
  const id = `err-${Math.random().toString(36).slice(2, 8)}`;
  const note = h("p.set-err", { id, role: "alert" }, icon("warn", 13), h("span", null, message));
  box.classList.add("invalid");
  el.setAttribute("aria-invalid", "true");
  el.setAttribute("aria-describedby", id);
  // under the field, or under the row of a list
  const field = el.closest(".set-field");
  if (field) field.append(note); else (el.closest(".set-row") ?? box).after(note);
  const stop = new AbortController();
  const clear = (): void => { stop.abort(); box.classList.remove("invalid"); el.removeAttribute("aria-invalid"); el.removeAttribute("aria-describedby"); note.remove(); };
  // capture: the mark goes before the page reacts to the change
  box.addEventListener("change", clear, { capture: true, signal: stop.signal });
  box.addEventListener("input", clear, { capture: true, signal: stop.signal });
  el.scrollIntoView({ block: "center" });
  el.focus({ preventScroll: true });
  return true;
}

export function clearInvalid(root: HTMLElement): void {
  for (const n of root.querySelectorAll(".set-err")) n.remove();
  for (const x of root.querySelectorAll(".invalid")) x.classList.remove("invalid");
  for (const x of root.querySelectorAll("[aria-invalid]")) { x.removeAttribute("aria-invalid"); x.removeAttribute("aria-describedby"); }
}

/**
 * The full rule list after one column's rules were edited: the edited rules take the places the
 * column's rules had, extra ones go after the last of them (or at the end when it had none), and
 * every other rule keeps its place.
 */
export function placeRules<T>(all: T[], was: T[], now: T[]): T[] {
  const slots = all.flatMap((r, i) => (was.includes(r) ? [i] : []));
  if (!slots.length) return [...all, ...now];
  const lastSlot = slots[slots.length - 1];
  const out: T[] = [];
  let k = 0;
  all.forEach((r, i) => {
    if (!was.includes(r)) out.push(r);
    else if (i === lastSlot) { out.push(...now.slice(k)); k = now.length; }
    else if (k < now.length) out.push(now[k++]);
  });
  return out;
}

/** Edit the rules that guard moves into one Board column, in place; saved for the whole project. */
export function openColumnRules(app: App, column: string): void {
  const all = clone(app.settings.shared.rules);
  const mine = all.filter((r) => (r.level === "requirement" || r.level === "*") && r.target === column);
  const was = [...mine]; // the column's rules as they were, to keep their places in the list
  const readOnly = app.actions.readOnly;
  const body = h("div.set-list.col-rules");
  const msg = h("p.small.warn-text", { role: "alert" });
  const ctx: EditCtx = {
    changed: () => { msg.textContent = ""; },
    redraw: (focusKey) => {
      const back = keepFocus(body);
      draw();
      const to = focusKey ? body.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focusKey)}"]`) : null;
      if (to) to.focus(); else back();
    },
  };
  const draw = (): void => {
    body.replaceChildren(
      h("p.small.muted", null, `What a ${(app.ws.requirementLevel().defaultType ?? "work item").toLowerCase()} needs before it moves into ${column}. Checked when someone moves it with this dashboard; saved for everyone in the project.`),
      ...(mine.length ? mine.map((r, i) => ruleCard(app, r, i, mine, ctx)) : [h("p.muted.set-empty", null, `${column} has no rule: every move into it is allowed.`)]),
      readOnly ? h("p.small.muted", null, "Read-only: rules cannot be changed here.") : h("div.set-actions", null,
        h("button.btn", {
          title: `Add a rule for moves into ${column}`, "data-fk": "rules:add",
          onclick: () => { const id = newId("r"); mine.push({ id, level: "requirement", target: column, requires: [], onlyBy: [] }); ctx.redraw(`rule:${id}:level`); },
        }, icon("plus", 14), "Add rule")),
      msg);
    if (readOnly) for (const el of body.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select")) el.disabled = true;
  };
  draw();
  void dialog(`Rules for ${column}`, body, [
    { label: readOnly ? "Close" : "Cancel", value: "" },
    ...(readOnly ? [] : [{
      label: "Save", primary: true,
      onClick: async () => {
        const problem = ruleProblem(mine);
        if (problem) { if (!markInvalid(body, problem.key, problem.message)) msg.textContent = problem.message; return false; }
        try {
          // the column's rules stay where they were in the full list; the rest keep their order
          await app.actions.logged("Settings: rules for a column changed", { type: "Settings", title: "Rules" }, () => app.settings.saveShared({ rules: placeRules(all, was, mine) }));
          toast(mine.length ? `Rules for ${column} saved for the project` : `Rules for ${column} removed`, { kind: "ok" });
          return true;
        } catch (e) { msg.textContent = errorText(e); return false; }
      },
    }]),
  ], { wide: true });
}
