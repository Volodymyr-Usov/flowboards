// Settings: Rules on moves, checklists, standard tasks, strategy pillars, board options and AI help.
// Rules, checklists, standard tasks, board options and pillars are shared by the project (the extension's shared storage);
// AI help is personal. Unsaved edits are kept while you switch tabs, until Save or Discard (and in this
// browser tab across a reload); the app asks before a reload or a team switch throws them away.
import type { App, View } from "../app/context.ts";
import { AI_FEATURES, ANTHROPIC_MODELS, endpointProblem, keyTarget } from "../core/ai.ts";
import { cleanList } from "../core/checklist.ts";
import type { Person } from "../api/types.ts";
import { orderedStates, personKey } from "../core/model.ts";
import type { Rule } from "../core/rules.ts";
import { suggestedRules } from "../core/rules.ts";
import type { AiSettings, SharedSettings, TeamPeople } from "../core/settings.ts";
import type { UrgencyWeights } from "../core/urgency.ts";
import { cleanUrgency, DEFAULT_URGENCY } from "../core/urgency.ts";
import { resetPrefs } from "../core/settings.ts";
import type { ChildTemplate } from "../core/templates.ts";
import { cleanTemplates, EXAMPLE_TASKS, titleKey } from "../core/templates.ts";
import type { Child } from "../ui/dom.ts";
import { h, icon } from "../ui/dom.ts";
import type { BlockGroup } from "../ui/blocks.ts";
import { BLOCK_GROUPS, blocksOff, crossesHidden, getTabBlocks, resetBlocks, setBlockShown, setCrossesHidden } from "../ui/blocks.ts";
import { keepFocus } from "../ui/focuskeep.ts";
import { avatar, busy, confirm, errorText, help, personPicker, segmented, select, toast, typeMark } from "../ui/kit.ts";
import type { PrShow } from "./boardmodel.ts";
import { boardColumns } from "./boardmodel.ts";
import { boardScope, columnHidden, columnShownPatch, readBoardOpts, saveBoardOpts } from "./boardprefs.ts";
import { pageBar } from "../ui/pagebar.ts";
import type { PillarDraft } from "./pillareditor.ts";
import { checkPillars, pillarDraft, pillarEditor, savePillars } from "./pillareditor.ts";
import type { EditCtx, Problem } from "./ruleeditor.ts";
import { clearInvalid, clone, markInvalid, moveIn, newId, ruleCard, levelHasAcceptance, ruleProblem, svgArrow } from "./ruleeditor.ts";

type Tab = "menu" | "cards" | "columns" | "team" | "priority" | "rules" | "checklists" | "tasks" | "board" | "strategy" | "ai" | "mine";

const ALL_TABS: { id: Tab; label: string; title: string; icon: string }[] = [
  { id: "menu", label: "Menu & bars", icon: "more", title: "Which menu titles, buttons and controls show in the top bar and the page bars (yours)" },
  { id: "cards", label: "Cards", icon: "board", title: "What the Board's cards, Feature list and Epic boxes show (yours)" },
  { id: "columns", label: "Columns", icon: "flow", title: "Which Board columns show, and which pull requests count on cards (yours)" },
  { id: "team", label: "Team", icon: "people", title: "Who counts as a member of this team (shared)" },
  { id: "priority", label: "Priority", icon: "sprint", title: "What counts in a story's urgency, and how much (shared)" },
  { id: "rules", label: "Rules", icon: "warn", title: "What an item needs before it may move to a state or board column (shared)" },
  { id: "checklists", label: "Checklists", icon: "check", title: "The team's checklist (definition of done) per work item type (shared)" },
  { id: "tasks", label: "Standard tasks", icon: "plus", title: "The tasks one click adds under a story, per work item type (shared)" },
  { id: "strategy", label: "Strategy", icon: "strategy", title: "Strategy pillars and the tag that links Epics to them (shared)" },
  { id: "board", label: "Project board", icon: "projects", title: "Board columns source, how many days of closed work to load, when work is stale (shared)" },
  { id: "ai", label: "AI help", icon: "sparkle", title: "Your own AI key for drafts and questions (personal)" },
  { id: "mine", label: "My settings", icon: "undo", title: "Everything that is only yours, and the button that resets it" },
];
// AI help is off for now (core/ai.ts): its tab comes back with it
const TABS = ALL_TABS.filter((t) => t.id !== "ai" || AI_FEATURES);

const SHARED_NOTE = "Shared: everyone in this project sees and uses these. Anyone who can open this page can change them.";

type ChecklistDraft = Record<string, string[]>;
type TasksDraft = Record<string, ChildTemplate[]>;
interface BoardDraft { boardMode: SharedSettings["boardMode"]; closedDays: number; staleDays: number }
interface AiDraft { provider: AiSettings["provider"]; model: string; endpoint: string; newKey: string; removeKey: boolean }

// ---------- unsaved edits ----------

/** Unsaved edits per tab; kept while the page is open (switching tabs re-mounts the view). */
const drafts: Partial<Record<Tab, unknown>> = {};
const state = { saving: false };
/** the tab shown last: the gear opens it again */
let lastTab: Tab | null = null;
/** a tab was picked with a click or the keyboard: focus it after the view mounts again */
let focusTab = false;
/** where the drafts are kept in this browser tab (they survive a reload); "" before initDrafts */
let storeKey = "";
const draftListeners = new Set<() => void>();
/** the AI draft may hold a typed key: it is never written to storage */
const STORED: Tab[] = ["team", "priority", "rules", "checklists", "tasks", "board", "strategy"];

/** Read the drafts kept in this browser tab for this organization and project. */
export function initDrafts(scope: string): void {
  const key = `flowboards.settings-drafts:${scope}`;
  if (key === storeKey) return;
  storeKey = key;
  for (const k of Object.keys(drafts)) delete drafts[k as Tab];
  try {
    const raw = sessionStorage.getItem(key);
    const got = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    for (const t of STORED) if (got[t] !== undefined) drafts[t] = got[t];
  } catch { /* storage blocked: drafts live in memory only */ }
  for (const f of draftListeners) f();
}

function draftsChanged(): void {
  if (storeKey) {
    try {
      const keep = Object.fromEntries(STORED.filter((t) => drafts[t] !== undefined).map((t) => [t, drafts[t]]));
      if (Object.keys(keep).length) sessionStorage.setItem(storeKey, JSON.stringify(keep)); else sessionStorage.removeItem(storeKey);
    } catch { /* storage blocked or full */ }
  }
  for (const f of draftListeners) f();
}

/** The Settings tabs with unsaved changes, in tab order. */
export function draftTabs(): { id: string; label: string }[] {
  return TABS.filter((t) => drafts[t.id] !== undefined).map((t) => ({ id: t.id, label: t.label }));
}

export function hasDrafts(): boolean { return draftTabs().length > 0; }

export function onDraftsChange(fn: () => void): () => void {
  draftListeners.add(fn);
  return () => draftListeners.delete(fn);
}

/** Throw every unsaved edit away (a team switch the person confirmed). */
export function discardDrafts(): void {
  for (const k of Object.keys(drafts)) delete drafts[k as Tab];
  draftsChanged();
}

function clampInt(v: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v.trim() !== "" ? Math.min(max, Math.max(min, n)) : fallback;
}

const sel = (key: string): string => `[data-fk="${CSS.escape(key)}"]`;

export const settingsView: View = {
  id: "settings",
  title: "Settings",
  icon: "settings",
  group: "check",
  about: "Rules on moves, checklists, standard tasks, strategy pillars and board options, shared by the project.",
  mount(el, app: App, params) {
    const ws = app.ws;
    initDrafts(`${app.api.ctx.orgName}/${ws.project}`);
    const firstDraft = TABS.find((t) => drafts[t.id] !== undefined)?.id;
    const tab: Tab = TABS.some((t) => t.id === params.tab) ? (params.tab as Tab) : firstDraft ?? lastTab ?? "menu";
    lastTab = tab;

    const tabBar = h("div.set-tabs", { role: "tablist", "aria-label": "Settings sections" });
    const pane = h("div.set-pane", { role: "tabpanel", id: "set-pane", "aria-labelledby": `set-tab-${tab}` });
    // nothing to search here; the section tabs follow line 2
    el.append(pageBar(app).el, tabBar, pane);

    const pick = (t: Tab): void => { if (t === tab) return; focusTab = true; app.navigate("settings", { tab: t }); };
    function drawTabs(): void {
      const had = tabBar.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.tab : undefined;
      tabBar.replaceChildren(...TABS.map((t) => h("button.set-tab", {
        role: "tab", id: `set-tab-${t.id}`, "aria-selected": String(t.id === tab), "aria-controls": "set-pane", tabindex: t.id === tab ? 0 : -1,
        title: t.title + (drafts[t.id] ? " (unsaved changes)" : ""), dataset: { tab: t.id },
        onclick: () => pick(t.id),
      }, icon(t.icon, 15), t.label, drafts[t.id] ? h("span.set-dot", null, h("span.sr-only", null, " (unsaved changes)")) : null)));
      if (had) tabBar.querySelector<HTMLElement>(`[data-tab="${had}"]`)?.focus();
    }
    // arrows, Home and End move between the tabs; Enter or Space opens one
    tabBar.addEventListener("keydown", (e) => {
      const all = [...tabBar.querySelectorAll<HTMLElement>(".set-tab")];
      const i = all.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      const to = e.key === "ArrowRight" ? (i + 1) % all.length : e.key === "ArrowLeft" ? (i - 1 + all.length) % all.length
        : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : -1;
      if (to < 0) return;
      e.preventDefault();
      all[to].focus();
    });

    /** the Save of the tab shown: Ctrl+S presses it */
    let saveNow: (() => void) | null = null;
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      if (document.querySelector(".backdrop")) return;
      saveNow?.();
    };
    document.addEventListener("keydown", onKey);

    /** The shared settings `keys` as they are now, to put back with Undo. */
    const snapshot = (keys: (keyof SharedSettings)[]): Partial<SharedSettings> =>
      Object.fromEntries(keys.map((k) => [k, app.settings.shared[k] === undefined ? undefined : clone(app.settings.shared[k])]));
    /** read the team's work again when the range of closed work changed */
    const readAgainIfNeeded = (): boolean => {
      if (ws.opts.closedDays === app.settings.shared.closedDays) return false;
      ws.opts.closedDays = app.settings.shared.closedDays;
      void ws.load().catch(() => {});
      return true;
    };

    /**
     * A form with Save and Discard over a draft of some saved values. `undoKeys`: the shared settings
     * the save changes; the message after Save then has an Undo that saves them back.
     */
    function editor<T>(key: Tab, saved: () => T, render: (s: T, ctx: EditCtx) => Child,
      save: (s: T) => Promise<string>, check?: (s: T) => Problem | string | null, undoKeys?: (keyof SharedSettings)[]): HTMLElement {
      let s: T = (drafts[key] as T | undefined) ?? clone(saved());
      const body = h("div.set-body");
      const dirty = (): boolean => JSON.stringify(s) !== JSON.stringify(saved());
      // a kept draft that equals what is saved now is no draft
      if (drafts[key] !== undefined && !dirty()) { delete drafts[key]; draftsChanged(); }
      const ctx: EditCtx = {
        changed: () => {
          const was = drafts[key] !== undefined;
          if (dirty()) drafts[key] = s;
          else delete drafts[key];
          draftsChanged();
          drawFoot();
          if (was !== (drafts[key] !== undefined)) drawTabs();
        },
        redraw: (focusKey) => {
          const back = keepFocus(body);
          body.replaceChildren(render(s, ctx) as Node);
          ctx.changed();
          const to = focusKey ? body.querySelector<HTMLElement>(sel(focusKey)) : null;
          if (to) to.focus(); else back(saveBtn);
        },
      };
      const ro = app.actions.readOnly;
      const footMsg = h("span.small.set-foot-msg", { role: "status" });
      // Save is never disabled while focused: it says so instead, and the focus stays on it after a save
      const saveBtn = h("button.btn.primary", { onclick: () => void doSave() }, icon("check", 14), "Save");
      const discardBtn = h("button.btn", {
        title: "Throw away the changes made here",
        onclick: () => { delete drafts[key]; s = clone(saved()); clearInvalid(body); ctx.redraw(); saveBtn.focus(); },
      }, "Discard");
      const foot = h("div.set-foot", null, saveBtn, discardBtn, footMsg);
      async function doSave(): Promise<void> {
        if (!dirty() || ro || saveBtn.disabled) return;
        const found = check?.(s);
        const problem: Problem | null = typeof found === "string" ? { message: found } : found ?? null;
        if (problem) {
          // the field is marked in its card; without one the message stands by Save
          const marked = markInvalid(body, problem.key, problem.message);
          footMsg.className = "small set-foot-msg warn-text";
          footMsg.textContent = marked ? "Fix the marked field to save." : problem.message;
          if (!marked) saveBtn.focus();
          return;
        }
        const before = undoKeys ? snapshot(undoKeys) : null;
        await busy(saveBtn, async () => {
          state.saving = true;
          try {
            const msg = await save(s);
            delete drafts[key];
            s = clone(saved());
            ctx.redraw();
            const label = TABS.find((t) => t.id === key)?.label ?? key;
            toast(msg, {
              kind: "ok",
              undo: before ? async () => {
                await app.actions.logged(`Settings: ${label.toLowerCase()} change undone`, { type: "Settings", title: label }, () => app.settings.saveShared(before));
                readAgainIfNeeded();
              } : undefined,
            });
          } finally { state.saving = false; }
        });
        if (document.activeElement === document.body) saveBtn.focus();
      }
      function drawFoot(): void {
        const d = dirty();
        saveBtn.setAttribute("aria-disabled", String(!d || ro));
        saveBtn.title = ro ? "Read-only: settings cannot be saved here" : d ? "Save these settings (Ctrl+S)" : "Nothing changed yet";
        discardBtn.hidden = !d;
        // "Fix the marked field" stays while a field is marked
        if (body.querySelector(".set-err")) return;
        footMsg.className = `small set-foot-msg ${d && !ro ? "warn-text" : "muted"}`;
        footMsg.textContent = ro ? "Read-only" : d ? "Unsaved changes" : "";
      }
      saveNow = () => { if (dirty() && !ro) void doSave(); else toast(ro ? "Read-only: settings cannot be saved here." : "Nothing to save on this tab."); };
      body.replaceChildren(render(s, ctx) as Node);
      drawFoot();
      return h("div.set-editor", null, body, foot);
    }

    const scopeLine = (text: string, personal = false): HTMLElement =>
      h("p.set-scope", null, icon(personal ? "people" : "info", 14), text);

    // ---------------- Rules ----------------

    function rulesTab(): HTMLElement {
      const reqTypes = ws.requirementLevel().types;
      return h("div", null,
        h("p.set-intro", null, "Rules say what an item needs before it moves to a state or board column, optionally only when it comes from a given state, including fields that must be filled. They are checked when someone moves an item with this dashboard; Azure DevOps itself is not changed. \"Move anyway\" skips a rule for that move, except \"only these people\", which cannot be skipped. When a move is stopped, the message also lets you fix what is missing (a description, a task, an owner…) and move in one go."),
        h("p.set-intro", null, "A rule holds in its column and in every column to its right: what Ready asks, Active and Review ask too. The ⚠ on a card shows what the rules of its column (and of the columns before it) still ask for, and says which rule it is. A rule can start the inheritance afresh at its column (untick \"inherited\" on the rule). The ⚠ marks can be switched off with the button left of the colour theme."),
        scopeLine(SHARED_NOTE),
        editor<Rule[]>("rules", () => app.settings.shared.rules, (rules, ctx) => {
          return h("div.set-list", null,
            rules.length ? rules.map((r, i) => ruleCard(app, r, i, rules, ctx)) : h("p.muted.set-empty", null, "No rules yet: every move is allowed. Add a rule or start with the suggested ones."),
            h("div.set-actions", null,
              h("button.btn", {
                title: "Add an empty rule", disabled: app.actions.readOnly, "data-fk": "rules:add",
                onclick: () => { const id = newId("r"); rules.push({ id, level: "requirement", target: "", requires: [], onlyBy: [] }); ctx.redraw(`rule:${id}:level`); },
              }, icon("plus", 14), "Add rule"),
              h("button.btn", {
                title: "Add a sensible starting set for this process (nothing is on until you save)", disabled: app.actions.readOnly, "data-fk": "rules:suggest",
                onclick: () => {
                  const add = suggestedRules(orderedStates(ws.process, reqTypes), { acceptance: levelHasAcceptance(ws, "requirement") })
                    .filter((s) => !rules.some((r) => r.level === s.level && r.target === s.target))
                    .map((s) => ({ ...s, id: rules.some((r) => r.id === s.id) ? newId("r") : s.id }));
                  if (!add.length) { toast("The suggested rules are already in the list"); return; }
                  rules.push(...add);
                  ctx.redraw();
                  toast(`${add.length} suggested rule${add.length === 1 ? "" : "s"} added. Save to turn ${add.length === 1 ? "it" : "them"} on.`);
                },
              }, icon("sparkle", 14), "Suggested rules")));
        }, async (rules) => {
          await app.actions.logged("Settings: rules on moves changed", { type: "Settings", title: "Rules" }, () => app.settings.saveShared({ rules: clone(rules) }));
          return rules.length ? `${rules.length} rule${rules.length === 1 ? "" : "s"} saved for the project` : "Rules removed: every move is allowed";
        }, (rules) => ruleProblem(rules), ["rules"]));
    }

    // ---------------- Checklists ----------------

    /** Up, down and remove for row k of a list; `base` names the list ("ck:Bug"), for the focus after a change. */
    const rowTools = <T>(list: T[], k: number, ctx: EditCtx, what: string, base: string): HTMLElement => h("div.set-row-tools", null,
      h("button.icon-btn.small", {
        title: `Move this ${what} up`, "aria-label": "Move up", disabled: k === 0, "data-fk": `${base}:${k}:up`,
        onclick: () => { moveIn(list, k, -1); ctx.redraw(k - 1 === 0 ? `${base}:0:down` : `${base}:${k - 1}:up`); },
      }, svgArrow(true)),
      h("button.icon-btn.small", {
        title: `Move this ${what} down`, "aria-label": "Move down", disabled: k === list.length - 1, "data-fk": `${base}:${k}:down`,
        onclick: () => { moveIn(list, k, 1); ctx.redraw(k + 1 === list.length - 1 ? `${base}:${k + 1}:up` : `${base}:${k + 1}:down`); },
      }, svgArrow(false)),
      // after a remove the focus goes to the next row's remove (the one before at the end, else Add)
      h("button.icon-btn.small", {
        title: `Remove this ${what}`, "aria-label": `Remove ${what}`, "data-fk": `${base}:${k}:rm`, "data-fg": `${base}:rm`, "data-fe": `${base}:add`,
        onclick: () => {
          list.splice(k, 1);
          ctx.redraw(list.length ? `${base}:${Math.min(k, list.length - 1)}:rm` : `${base}:add`);
        },
      }, icon("close", 14)));

    function checklistsTab(): HTMLElement {
      const types = ws.process.levels.flatMap((l) => l.types.map((t) => ({ type: t, level: l.name })));
      return h("div", null,
        h("p.set-intro", null, "A checklist is a short list to tick on a work item, such as the team's definition of done. Set the team's list per work item type here: an item of that type with no checklist yet offers it in its details panel (\"Use the team's list\"), where it can then be changed for that item. Checklists are kept in this extension's storage, not in the work items."),
        h("p.set-intro", null, "The rule \"Checklist done\" (Rules tab) stops a move until every item of the checklist is ticked. An item with no checklist passes, unless its type has a list here; then the list must be added and ticked first."),
        scopeLine(SHARED_NOTE),
        editor<ChecklistDraft>("checklists", () => app.settings.shared.checklists ?? {}, (s, ctx) => h("div.set-list", null,
          types.map(({ type, level }) => {
            const list = s[type] ?? [];
            const base = `ck:${type}`;
            const addRow = (): void => { s[type] = [...list, ""]; ctx.redraw(`${base}:${list.length}`); };
            const listCtx: EditCtx = { changed: ctx.changed, redraw: (k) => { if (!list.length) delete s[type]; ctx.redraw(k); } };
            return h("div.set-card", null,
              h("div.set-card-head", null, typeMark(ws, type), h("b", null, type), h("span.small.muted", null, level),
                h("span.spacer"), list.length ? h("span.small.muted", null, `${list.length} item${list.length === 1 ? "" : "s"}`) : null),
              list.length ? h("div.set-rows", null, list.map((text, k) => h("div.set-row", null,
                h("input.input", {
                  value: text, placeholder: "Something to tick, like \"Tests pass\"", maxlength: 200, "aria-label": `${type} checklist item ${k + 1}`, "data-fk": `${base}:${k}`,
                  title: "One thing to tick on every new checklist of this type",
                  oninput: (e: Event) => { list[k] = (e.target as HTMLInputElement).value; ctx.changed(); },
                  onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); addRow(); } },
                }),
                rowTools(list, k, listCtx, "item", base))))
                : h("p.small.muted", null, "No list: items of this type start without a checklist."),
              h("div.set-actions", null, h("button.btn.small", { title: `Add an item to the team's checklist for ${type}`, "data-fk": `${base}:add`, onclick: addRow }, icon("plus", 12), "Add item")));
          })),
        async (s) => {
          const out: ChecklistDraft = {};
          for (const [t, l] of Object.entries(s)) { const c = cleanList(l); if (c.length) out[t] = c; }
          await app.actions.logged("Settings: team checklists changed", { type: "Settings", title: "Checklists" }, () => app.settings.saveShared({ checklists: out }));
          const n = Object.keys(out).length;
          return n ? `Checklists saved for ${n} type${n === 1 ? "" : "s"}` : "Checklists removed";
        }, undefined, ["checklists"]));
    }

    // ---------------- Standard tasks ----------------

    function tasksTab(): HTMLElement {
      const levels = ws.process.levels;
      const parents = levels.flatMap((l) => {
        const child = levels.find((c) => c.rank === l.rank + 1);
        return child ? l.types.map((t) => ({ type: t, child })) : [];
      });
      // parents of the requirement level first: standard tasks under stories are the usual case
      parents.sort((a, b) => Number(b.child.kind === "task") - Number(a.child.kind === "task"));
      const pf = ws.process.fields;
      const activities = [...new Set([...ws.items.values()].map((x) => x.fields[pf.activity]).filter((v): v is string => typeof v === "string" && v !== ""))].sort();
      const listId = "set-activity-values";
      return h("div", null,
        h("p.set-intro", null, "Standard tasks are the child work a team adds under almost every story, such as \"Write tests\" or \"Update documentation\". In a story's details panel, \"Add standard tasks\" creates the ones that are not there yet (a child with the same title counts as there). A new story can get them at once too."),
        scopeLine(SHARED_NOTE),
        h("datalist", { id: listId }, activities.map((a) => h("option", { value: a }))),
        editor<TasksDraft>("tasks", () => app.settings.shared.childTemplates ?? {}, (s, ctx) => h("div.set-list", null,
          parents.map(({ type, child }) => {
            const list = s[type] ?? [];
            const isTask = child.kind === "task";
            const what = isTask ? "task" : child.defaultType.toLowerCase();
            const base = `tp:${type}`;
            const addRow = (): void => { s[type] = [...list, { title: "" }]; ctx.redraw(`${base}:${list.length}`); };
            const listCtx: EditCtx = { changed: ctx.changed, redraw: (k) => { if (!list.length) delete s[type]; ctx.redraw(k); } };
            const hasActivity = isTask && child.types.some((t) => { const fs = ws.process.types[t]?.fields; return !fs || fs.includes(pf.activity); });
            return h("div.set-card", null,
              h("div.set-card-head", null, typeMark(ws, type), h("b", null, type), h("span.small.muted", null, `${child.name} under it`),
                h("span.spacer"), list.length ? h("span.small.muted", null, `${list.length} standard ${list.length === 1 ? what : child.name.toLowerCase()}`) : null),
              list.length ? h("div.set-rows", null, list.map((t, k) => h("div.set-row.set-tpl", null,
                h("input.input.set-tpl-title", {
                  value: t.title, placeholder: "Title, like \"Write tests\"", maxlength: 255, "aria-label": `${type}: title of standard ${what} ${k + 1}`, "data-fk": `${base}:${k}`,
                  title: `The title of the ${what} to add`,
                  oninput: (e: Event) => { t.title = (e.target as HTMLInputElement).value; ctx.changed(); },
                  onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); addRow(); } },
                }),
                child.types.length > 1 ? select([{ value: "", label: `${child.defaultType} (default)` }, ...child.types.filter((x) => x !== child.defaultType).map((x) => ({ value: x, label: x }))],
                  t.type ?? "", (v) => { if (v) t.type = v; else delete t.type; ctx.changed(); }, { title: "The work item type to create", "aria-label": "Type" }) : null,
                hasActivity ? h("input.input.set-tpl-activity", {
                  value: t.activity ?? "", placeholder: "Activity", list: listId, "aria-label": "Activity",
                  title: "The task's activity (like Development, Testing, Documentation); empty leaves it unset",
                  oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v.trim()) t.activity = v; else delete t.activity; ctx.changed(); },
                }) : null,
                isTask ? h("input.input.set-tpl-hours", {
                  type: "number", min: 0, step: 0.5, value: t.remaining ?? "", placeholder: "Hours", "aria-label": "Remaining work in hours",
                  title: "Remaining work in hours; empty leaves it unset",
                  oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v !== "" && Number(v) >= 0) t.remaining = Number(v); else delete t.remaining; ctx.changed(); },
                }) : null,
                rowTools(list, k, listCtx, what, base))))
                : h("p.small.muted", null, `No standard ${child.name.toLowerCase()} for this type.`),
              h("div.set-actions", null,
                h("button.btn.small", { title: `Add a standard ${what} for this type`, "data-fk": `${base}:add`, onclick: addRow }, icon("plus", 12), `Add ${what}`),
                !list.length && isTask ? h("button.btn.small", {
                  title: `Start with: ${EXAMPLE_TASKS.map((x) => x.title).join(", ")} (nothing is on until you save)`,
                  onclick: () => { s[type] = EXAMPLE_TASKS.map((x) => ({ ...x })); ctx.redraw(`${base}:0`); },
                }, icon("sparkle", 12), "Examples") : null));
          })),
        async (s) => {
          const out: TasksDraft = {};
          for (const [t, l] of Object.entries(s)) { const c = cleanTemplates(l); if (c.length) out[t] = c; }
          await app.actions.logged("Settings: standard tasks changed", { type: "Settings", title: "Standard tasks" }, () => app.settings.saveShared({ childTemplates: out }));
          const n = Object.keys(out).length;
          return n ? `Standard tasks saved for ${n} type${n === 1 ? "" : "s"}` : "Standard tasks removed";
        }, (s) => {
          for (const [t, l] of Object.entries(s)) {
            const keys = l.map((x) => titleKey(x.title));
            const k = keys.findIndex((x, i) => x && keys.indexOf(x) !== i);
            if (k >= 0) return { message: `${t}: two standard tasks are called "${l[k].title.trim()}". Titles must differ.`, key: `tp:${t}:${k}` };
          }
          return null;
        }, ["childTemplates"]));
    }

    // ---------------- Menu & bars, Cards, Columns, My settings: yours, applied at once ----------------

    /** a small checkbox with its name: the compact way to show what shows (applies at once) */
    const tick = (label: string, on: boolean, title: string, set: (v: boolean) => void, fk: string, lead?: Node | null): HTMLElement => {
      const input = h("input", { type: "checkbox", checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }) as HTMLInputElement;
      input.dataset.fk = fk;
      return h("label.set-pick", { title }, input, lead ?? null, h("span", null, label));
    };
    /** a setting with its icon, its name and a description of what it does: a checkbox that applies at once */
    const opt = (o: { label: string; icon?: string; desc: string; on: boolean; fk: string; lead?: Node | null; set: (v: boolean) => void }): HTMLElement => {
      const input = h("input", { type: "checkbox", checked: o.on, onchange: (e: Event) => o.set((e.target as HTMLInputElement).checked) }) as HTMLInputElement;
      input.dataset.fk = o.fk;
      return h("label.set-opt", { title: o.desc },
        input, h("span.set-opt-icon", null, o.lead ?? (o.icon ? icon(o.icon, 18) : "")),
        h("span.set-opt-text", null, h("b", null, o.label), h("span.small.muted", null, o.desc)));
    };
    const appliesAtOnce = (): HTMLElement => h("span.set-badge", { title: "No Save needed: each box applies when you change it" }, icon("check", 12), "Applies at once");
    const personalBadge = (): HTMLElement => h("span.set-badge.personal", { title: "Only yours: nobody else's view changes" }, icon("people", 12), "Yours");
    /** a card with a title, a line that says what it is, and its content */
    const card = (title: string, intro: string, ...content: Child[]): HTMLElement =>
      h("div.set-card", null, h("div.set-card-head", null, h("h3", null, title), appliesAtOnce(), personalBadge()), h("p.small.muted", null, intro), ...content);
    /** a card that draws again when one of its boxes changes, keeping the focus */
    const live = (make: () => HTMLElement): HTMLElement => {
      const box = h("div");
      const paint = (): void => { const back = keepFocus(box); box.replaceChildren(make()); back(); };
      (box as HTMLElement & { paint?: () => void }).paint = paint;
      paint();
      return box;
    };

    /** Which menu titles (the view tabs) show: drawn like the top bar, a small checkbox on each. */
    function menuCard(): HTMLElement {
      const paint = (): void => { box.paint(); };
      const box = live(() => {
        const off = blocksOff();
        return card("Menu titles", "Tick the pages that get a title in the top menu, drawn here as in the bar. The page you are on always keeps its title; a page without one is still reachable by its address (and under More). A page's own description shows when you point at its title.",
          h("div.set-menu", null, getTabBlocks().map((b) => tick(b.label, !off.has(b.id), b.title, (v) => { setBlockShown(b.id, v); paint(); }, `blk:${b.id}`, b.icon ? icon(b.icon, 14) : null))));
      }) as HTMLElement & { paint: () => void };
      return box;
    }

    /** One group of the bars (top bar or page bar): each control with its icon and what it does. */
    function barGroupCard(g: BlockGroup, intro: string): HTMLElement {
      const paint = (): void => { box.paint(); };
      const box = live(() => {
        const off = blocksOff();
        return card(g.name, intro, h("div.set-opts", null, g.blocks.map((b) => opt({ label: b.label, icon: b.icon, desc: b.desc ?? b.title, on: !off.has(b.id), fk: `blk:${b.id}`, set: (v) => { setBlockShown(b.id, v); paint(); } }))));
      }) as HTMLElement & { paint: () => void };
      return box;
    }

    function extrasCard(): HTMLElement {
      const paint = (): void => { box.paint(); };
      const box = live(() => {
        const off = blocksOff();
        return card("Little crosses", "A tiny × can hide any tab or control: it appears in the corner while the pointer is on it, and one click hides what it sits on. Everything it hides is listed on this tab, so nothing is lost.",
          h("div.set-opts", null,
            opt({ label: "Little × on hover", icon: "close", desc: "Show the tiny × in the corner of a tab or control while the pointer is on it. Switch it off if you click there by accident.", on: !crossesHidden(), fk: "blk:crosses", set: (v) => { setCrossesHidden(!v); paint(); } })),
          h("div.set-actions", null,
            h("button.btn.small", { type: "button", disabled: off.size === 0, title: "Show every title and control again (the little crosses and the boxes above stay as they are)", onclick: () => { resetBlocks(); paint(); box.parentElement?.dispatchEvent(new Event("settings-redraw", { bubbles: true })); } }, icon("eye", 13), "Show everything")));
      }) as HTMLElement & { paint: () => void };
      return box;
    }

    function menuTab(): HTMLElement {
      const wrap = h("div", null,
        h("p.set-intro", null, "Choose what shows in the top bar and in the bar above every page. Everything shows by default; what you switch off here is only switched off for you, and the Settings gear always stays. Point at a title or control anywhere to see what it does."),
        h("div.set-list", null, menuCard(),
          barGroupCard(BLOCK_GROUPS[0], "The line at the very top: the team and style at the left, then the page titles, then these buttons at the right end."),
          barGroupCard(BLOCK_GROUPS[1], "The bar above each page. People and Filter always come first; what does not fit the width moves under the ⋯ button at its end. Controls that belong to one page only show on that page."),
          extrasCard()));
      // "Show everything" changes all the boxes above: draw the tab again
      wrap.addEventListener("settings-redraw", () => { const back = keepFocus(pane); drawPane(); back(); });
      return wrap;
    }

    /** What the Board's cards, Feature list and Epic boxes show: yours, applied at once. */
    function cardsTab(): HTMLElement {
      const req = ws.requirementLevel();
      const feat = ws.process.levels.find((l) => l.rank === req.rank - 1);
      const epic = feat ? ws.process.levels.find((l) => l.rank === feat.rank - 1) : undefined;
      const low = req.defaultType.toLowerCase();
      const group = (title: string, intro: string, build: (o: ReturnType<typeof readBoardOpts>, sw: (label: string, ic: string, on: boolean, desc: string, set: (v: boolean) => void) => HTMLElement) => (HTMLElement | null)[]): HTMLElement =>
        live(() => {
          const box = h("div");
          const o = readBoardOpts();
          const repaint = (): void => { const w = box.parentElement as (HTMLElement & { paint?: () => void }) | null; w?.paint?.(); };
          const sw = (label: string, ic: string, on: boolean, desc: string, set: (v: boolean) => void): HTMLElement =>
            opt({ label, icon: ic, desc, on, fk: `disp:${label}`, set: (v) => { set(v); repaint(); } });
          const c = card(title, intro, h("div.set-opts", null, ...build(o, sw)));
          box.append(c);
          return box;
        });
      return h("div", null,
        h("p.set-intro", null, `Choose what the Board draws on its cards and around them. These are yours only (kept in your own storage, so they follow you to another browser) and apply the next time the Board draws; the Taskboard and the story map follow them too. Point at a ${low} card, a tag or the age mark on the Board to see what it shows.`),
        h("div.set-list", null,
          group("On cards", `What each ${low} card shows besides its title.`, (o, sw) => [
            sw("Counts", "pr", o.counts, "The bar of tasks (and pull requests) done, and the pull request number, at the foot of a card. Switch off for shorter cards.", (v) => saveBoardOpts({ counts: v })),
            sw("Tags", "tag", o.tags, "The tags of a story, on its card and on the taskboard's story rows.", (v) => saveBoardOpts({ tags: v })),
            sw("Tag colours", "sparkle", o.tagColors, "Draw every tag in a colour of its own, everywhere tags show; click a tag to choose another colour for it.", (v) => saveBoardOpts({ tagColors: v })),
            sw("Urgency bars", "flow", o.urgency, "Five small bars on the right edge of a story, lit from the bottom like a phone's charge: how urgent it is by its priority, how long it waits, its sprint, its deadline and what waits for it (what counts: Settings > Priority). Point at the bars for the sum.", (v) => saveBoardOpts({ urgency: v })),
            sw("New mark", "clock", o.newMark, "A green “new” instead of 0d in the age of what was created today.", (v) => saveBoardOpts({ newMark: v })),
            sw("Numbers", "link", o.ids, `The ${low}'s number above its title on the card, to quote it in a chat.`, (v) => saveBoardOpts({ ids: v })),
            feat ? sw("Parents", "back", o.parents, `The ${feat.defaultType} a ${low} belongs to, above its title (also on the taskboard's rows).`, (v) => saveBoardOpts({ parents: v })) : null,
          ]),
          group(`${feat?.name ?? "Features"} and ${epic?.name ?? "Epics"}`, `The list at the left of the Board that joins ${low} cards to the work above them.`, (o, sw) => [
            epic && feat ? sw(epic.name, "roadmap", o.epics, `Group the ${feat.defaultType} list in ${epic.defaultType} boxes (on the story map: under their ${epic.defaultType}). Switching it off ungroups; the eye on a box does the same.`, (v) => saveBoardOpts(v ? { epics: true, features: true } : { epics: false })) : null,
            feat ? sw(feat.name, "tree", o.features, `The ${feat.defaultType} list and the lines from it to the cards. Switching it off gives the columns the full width.`, (v) => saveBoardOpts({ features: v, epics: v ? o.epics : false })) : null,
            feat ? sw("Empty", "filter", o.empty, `Also list open ${feat.name} that have no ${low} yet, so they can be planned from the Board.`, (v) => saveBoardOpts({ empty: v })) : null,
          ])));
    }

    /** Which Board columns show, and which pull requests count on cards: yours, applied at once. */
    function columnsTab(): HTMLElement {
      const req = ws.requirementLevel();
      return h("div", null,
        h("p.set-intro", null, "Choose which columns the Board shows. The columns come from the team's board (or from the states, see Project board); a hidden column keeps its cards, they just are not drawn. On the Board, the eye on a column title hides it and a grey arrow next to it brings it back; this list does the same."),
        h("div.set-list", null, live(() => {
          const o = readBoardOpts(boardScope(ws));
          const cols = boardColumns(ws.process, req, ws.board, app.settings.shared.boardMode === "states" || !ws.board?.columnField ? "states" : "columns");
          const box = h("div");
          const kindText = (k: string): string => (k === "incoming" ? "The column new work lands in. Hidden by default: it is the backlog's front door." : k === "outgoing" ? "The column of finished work. Hidden by default; what was closed lately shows here." : "A working column.");
          box.append(card("Board columns", "Each column with its colour. Tick the ones you want to see.", h("div.set-opts", null, cols.map((c) => opt({
            label: c.name, desc: kindText(c.kind), on: !columnHidden(o, c), fk: `disp:${c.name}`,
            lead: h("i.set-dot", { style: { background: c.color } }), set: (v) => { saveBoardOpts(columnShownPatch(readBoardOpts(boardScope(ws)), c, v), boardScope(ws)); },
          })))));
          return box;
        }) as HTMLElement),
        h("div.set-list", null, live(() => {
          const o = readBoardOpts();
          const box = h("div");
          const c = card("Pull requests on cards", "The pull request number at the foot of a card counts the pull requests linked to the story and to its tasks, each once; abandoned ones are left out.",
            h("label.set-field", null, h("span", null, icon("pr", 14), "Which ones count"),
              select<PrShow>([{ value: "all", label: "All (completed of all)" }, { value: "open", label: "Open" }, { value: "completed", label: "Completed" }], o.prs,
                (v) => { saveBoardOpts({ prs: v }); }, { "data-fk": "disp:prs", title: "All shows “completed of all” (2/3); Open counts the ones still waiting; Completed counts the merged ones", "aria-label": "Pull requests that count on cards" }),
              h("p.small.muted", null, o.counts ? "Shown when Counts is on (Cards tab)." : "Counts is off (Cards tab), so no number shows on cards at the moment.")));
          box.append(c);
          return box;
        })));
    }

    /** Back to the defaults for everything that is only yours (not the team's settings, not the AI key). */
    function resetCard(): HTMLElement {
      const btn = h("button.btn.danger", { type: "button", onclick: () => void reset() }, "Reset my settings to defaults") as HTMLButtonElement;
      async function reset(): Promise<void> {
        const drafts = draftTabs();
        const ok = await confirm("Reset my settings?",
          h("div", null,
            h("p", null, "Everything you chose for yourself goes back to the defaults: the Board's switches and hidden columns, the bars and tabs you switched off, filters, column widths, the colour theme and your own working style."),
            h("p.muted", null, `The team's settings (rules, checklists, board columns…), your AI key and the team you picked stay.${drafts.length ? ` Unsaved changes on ${drafts.map((t) => t.label).join(", ")} are lost.` : ""}`)),
          "Reset", true);
        if (!ok) return;
        btn.disabled = true;
        try {
          await resetPrefs();
          if (Object.keys(app.settings.user.styles ?? {}).length) await app.settings.saveUser({ styles: {} });
        } catch (e) {
          btn.disabled = false;
          toast(`Could not reset all of it: ${errorText(e)}`, { kind: "error" });
          return;
        }
        discardDrafts();
        location.reload();
      }
      return h("div.set-card", null,
        h("div.set-card-head", null, h("h3", null, "My settings"), h("span.set-badge", { title: "Only yours: nobody else's view changes" }, icon("people", 12), "Personal")),
        h("p.small.muted", null, "Go back to the defaults for everything on this tab that applies only to you, and for your filters, widths, theme and working style. The page loads again."),
        h("div.col-pop-acts", null, btn));
    }
    function mineTab(): HTMLElement {
      return h("div", null,
        h("p.set-intro", null, "Everything that is only yours is kept in your own storage in Azure DevOps (readable only by you), so it follows you to another browser: the menu and bar choices, the Board's switches and hidden columns, the filters of each page, column widths, the colour theme, your working style, the tag colours and the tab you left each page on."),
        h("div.set-list", null, resetCard()));
    }


    function boardTab(): HTMLElement {
      const saved = (): BoardDraft => { const s = app.settings.shared; return { boardMode: s.boardMode, closedDays: s.closedDays, staleDays: s.staleDays }; };
      return h("div", null,
        h("p.set-intro", null, "Settings of the project's board that everyone shares: where the columns come from, how much closed work is read, and when work counts as stale. They apply to the whole project once saved."),
        h("div.set-card-head.set-sub", null, h("h3", null, "For the project"), h("span.set-badge.save", { title: "These change only when you press Save (or Ctrl+S)" }, "Save to apply")),
        scopeLine(SHARED_NOTE),
        editor<BoardDraft>("board", saved, (s, ctx) => h("div.set-list", null,
          h("div.set-card", null,
            h("div.set-field", null, h("span", null, "Board columns"),
              segmented<BoardDraft["boardMode"]>([
                { value: "columns", label: "Team board columns", title: "Columns as set up on the team's board in Azure DevOps (with their limits)" },
                { value: "states", label: "States", title: "One column per state of the work item types" },
              ], s.boardMode, (v) => { s.boardMode = v; ctx.changed(); }),
              h("p.small.muted", null, ws.board ? `This team's board has ${ws.board.columns.length} columns: ${ws.board.columns.map((c) => c.name).join(", ")}.` : "This team has no board columns set up, so states are used."))),
          h("div.set-card", null,
            h("label.set-field", null, h("span", null, "Closed work to load (days)"),
              h("input.input.set-num", {
                type: "number", min: 1, max: 365, value: s.closedDays, title: "How many days of closed work the dashboard reads (Closed column, recent work). More days read more items.", "data-fk": "board:closed",
                oninput: (e: Event) => { s.closedDays = clampInt((e.target as HTMLInputElement).value, 1, 365, s.closedDays); ctx.changed(); },
                // what is kept, when the typed number was out of range or empty
                onchange: (e: Event) => { (e.target as HTMLInputElement).value = String(s.closedDays); },
              }),
              h("p.small.muted", null, "After Save the team's work is read again with the new range."))),
          h("div.set-card", null,
            h("label.set-field", null, h("span", null, "Stale after (days)"),
              h("input.input.set-num", {
                type: "number", min: 1, max: 365, value: s.staleDays, title: "An open item with no change for this many days is marked stale", "data-fk": "board:stale",
                oninput: (e: Event) => { s.staleDays = clampInt((e.target as HTMLInputElement).value, 1, 365, s.staleDays); ctx.changed(); },
                onchange: (e: Event) => { (e.target as HTMLInputElement).value = String(s.staleDays); },
              }),
              h("p.small.muted", null, "An open item with no change for this many days is marked stale.")))),
        async (s) => {
          await app.actions.logged("Settings: board options changed", { type: "Settings", title: "Board" }, () => app.settings.saveShared({ ...s }));
          return readAgainIfNeeded() ? `Saved. Reading closed work of the last ${s.closedDays} days…` : "Board settings saved for the project";
        }, undefined, ["boardMode", "closedDays", "staleDays"]));
    }

    // ---------------- Team: who counts as a member ----------------

    function teamTab(): HTMLElement {
      const key = ws.team;
      const saved = (): TeamPeople => { const t = app.settings.shared.teamPeople?.[key]; return { off: [...(t?.off ?? [])], extra: [...(t?.extra ?? [])] }; };
      const members = [...ws.members].sort((a, b) => a.displayName.localeCompare(b.displayName));
      const isMember = (p: Person): boolean => members.some((m) => personKey(m) === personKey(p));
      return h("div", null,
        h("p.set-intro", null, `Azure DevOps lists everyone who has access to ${ws.team} as a member, also people who only need access (a stakeholder, a manager, a service account). Here you fine-tune who really counts as a member: untick the ones who do not, and add people who work with the team but are not listed.`),
        h("p.set-intro", null, "The team list is used for: the pull requests of the team (the ones its members wrote or review), who is in a Scheduler turn or draw, the people in the sprint capacity table and in the calendar's days off. People assigned to work still show on the Board and in the person chips either way."),
        scopeLine("Shared by the team: anyone who can open this page may change it. Press Save to apply."),
        editor<TeamPeople>("team", saved, (s, ctx) => {
          const offSet = new Set(s.off);
          const counted = members.filter((m) => !offSet.has(m.uniqueName.toLowerCase())).length + s.extra.length;
          const row = (p: Person, extra: boolean): HTMLElement => {
            const on = extra || !offSet.has(p.uniqueName.toLowerCase());
            return h("label.set-member", { class: [!on && "off"], title: extra ? `${p.displayName} was added by hand to this team` : on ? `${p.displayName} counts as a member of ${ws.team}. Untick if they only have access.` : `${p.displayName} is listed by Azure DevOps but does not count as a member here. Tick to count them again.` },
              extra ? h("button.icon-btn.small", { type: "button", "aria-label": `Take ${p.displayName} out of the team`, title: `Take ${p.displayName} out of the added people`, onclick: () => { s.extra = s.extra.filter((x) => personKey(x) !== personKey(p)); ctx.redraw(); } }, icon("close", 12))
                : h("input", { type: "checkbox", checked: on, "data-fk": `tm:${p.uniqueName}`, onchange: (e: Event) => {
                  const k = p.uniqueName.toLowerCase();
                  s.off = (e.target as HTMLInputElement).checked ? s.off.filter((x) => x !== k) : [...new Set([...s.off, k])];
                  ctx.redraw(`tm:${p.uniqueName}`);
                } }),
              avatar(ws.api, p, 24), h("span.set-member-name", null, h("b", null, p.displayName), h("span.small.muted", null, p.uniqueName !== p.displayName ? p.uniqueName : "")),
              extra ? h("span.small.muted", null, "added") : null);
          };
          const addable = ws.people().filter((p) => !isMember(p) && !s.extra.some((x) => personKey(x) === personKey(p)));
          return h("div.set-list", null,
            h("div.set-card", null,
              h("div.set-card-head", null, h("h3", null, `Members of ${ws.team}`), h("span.small.muted", null, `${counted} count as members`)),
              members.length ? h("div.set-members", null, members.map((m) => row(m, false)))
                : h("p.small.muted", null, "Azure DevOps did not list any members for this team (or they could not be read). You can still add people below.")),
            h("div.set-card", null,
              h("div.set-card-head", null, h("h3", null, "Added people"), h("span.small.muted", null, "People who work with the team but are not on its member list")),
              s.extra.length ? h("div.set-members", null, s.extra.map((p) => row(p, true))) : h("p.small.muted", null, "Nobody added."),
              h("div.set-actions", null, h("button.btn.small", { type: "button", disabled: !addable.length, "data-fk": "tm:add",
                title: addable.length ? "Pick someone who appears on the team's work or in the project and add them to this team's list" : "Everyone who appears on the team's work is already on the list",
                onclick: (e: Event) => personPicker(ws.api, e.currentTarget as Element, addable, undefined, (p) => { if (p) { s.extra = [...s.extra, p]; ctx.redraw("tm:add"); } }, { allowNone: false }) }, icon("plus", 12), "Add a person"))));
        },
        async (s) => {
          const all = { ...(app.settings.shared.teamPeople ?? {}) };
          if (s.off.length || s.extra.length) all[key] = { off: s.off, extra: s.extra }; else delete all[key];
          await app.actions.logged("Settings: team members changed", { type: "Settings", title: "Team" }, () => app.settings.saveShared({ teamPeople: all }));
          ws.setTeamTweaks(app.settings.shared.teamPeople?.[key]);
          return `Saved: ${ws.teamMembers().length} people count as members of ${ws.team}`;
        }, undefined, ["teamPeople"]));
    }

    // ---------------- Priority: what counts in a story's urgency ----------------

    function priorityTab(): HTMLElement {
      const saved = (): UrgencyWeights => ({ ...app.settings.shared.urgency });
      const factors: { key: keyof UrgencyWeights; label: string; icon: string; desc: string }[] = [
        { key: "own", label: "Its own priority", icon: "warn", desc: "The story's Priority field: 1 counts fully, 2 three quarters, 3 half, 4 a quarter, none nothing." },
        { key: "feature", label: "The Feature's priority", icon: "tree", desc: "The priority of the Feature above the story (the Epic's when the Feature has none), by the same scale." },
        { key: "waiting", label: "How long it waits", icon: "clock", desc: "Days since it was created while it is not started, else days in its state. Rises slowly up to the stale days (Project board tab), then steeply, and is full two stale periods later." },
        { key: "sprint", label: "End of its sprint", icon: "sprint", desc: "Grows over the last 14 days of the sprint it is in, full on the last day. A story outside a sprint adds nothing here." },
        { key: "blocking", label: "Items waiting for it", icon: "deps", desc: "Open items that depend on it (their predecessor is this story): a third of the way to full for each, full at three." },
        { key: "value", label: "Its value for the size", icon: "roadmap", desc: "The priority score of the Backlog (business value, time criticality and risk reduction over size) against the best story of the team. Off by default; works only when the process has those fields." },
      ];
      return h("div", null,
        h("p.set-intro", null, "Every story gets an urgency from 0 to 100, drawn as five small bars on its right edge (100 is five bars, 20 is one). It is worked out live on your screen from the factors below and never written to Azure DevOps. The weights are relative: they are scaled to add up to 100, so only their proportions matter; a weight of 0 leaves a factor out."),
        h("p.set-intro", null, "A deadline (the due date, else the target date) adds on top: up to the number of points set below, nothing until it is within its horizon, rising the closer it comes and full once it has passed. Stories with a deadline also show in the Calendar."),
        scopeLine(SHARED_NOTE),
        editor<UrgencyWeights>("priority", saved, (s, ctx) => {
          const total = factors.reduce((t, f) => t + (s[f.key] as number), 0);
          const num = (key: keyof UrgencyWeights, min: number, max: number, label: string): HTMLInputElement => h("input.input.set-num", {
            type: "number", min, max, step: 1, value: s[key], "aria-label": label, "data-fk": `urg:${key}`,
            oninput: (e: Event) => { s[key] = clampInt((e.target as HTMLInputElement).value, min, max, s[key] as number); ctx.changed(); },
            onchange: (e: Event) => { (e.target as HTMLInputElement).value = String(s[key]); ctx.redraw(`urg:${key}`); },
          }) as HTMLInputElement;
          return h("div.set-list", null,
            h("div.set-card", null,
              h("div.set-card-head", null, h("h3", null, "What counts"), h("span.small.muted", null, total ? "Share of the weighted part, in percent" : "All weights are 0: no story gets an urgency")),
              h("div.set-opts", null, factors.map((f) => h("label.set-opt.set-weight", { title: f.desc },
                h("span.set-opt-icon", null, icon(f.icon, 18)),
                h("span.set-opt-text", null, h("b", null, f.label), h("span.small.muted", null, f.desc)),
                h("span.set-weight-box", null, num(f.key, 0, 100, `Weight of ${f.label}`), h("span.small.muted", null, total ? `${Math.round((100 * (s[f.key] as number)) / total)}%` : "–")))))),
            h("div.set-card", null,
              h("div.set-card-head", null, h("h3", null, "Deadlines")),
              h("div.set-opts", null,
                h("label.set-opt.set-weight", { title: "How many points a deadline that is here or has passed adds to the score, on top of the weighted part. 0 switches deadlines off." },
                  h("span.set-opt-icon", null, icon("calendar", 18)),
                  h("span.set-opt-text", null, h("b", null, "A deadline adds up to"), h("span.small.muted", null, "Points (of 100) added when the deadline is today or passed; half as much half way into the horizon. The score stops at 100.")),
                  h("span.set-weight-box", null, num("deadlineMax", 0, 100, "Points a deadline adds"), h("span.small.muted", null, "points"))),
                h("label.set-opt.set-weight", { title: "A deadline starts to count this many days before it." },
                  h("span.set-opt-icon", null, icon("clock", 18)),
                  h("span.set-opt-text", null, h("b", null, "It starts to count"), h("span.small.muted", null, "Days ahead of the deadline from which it adds points, growing every day.")),
                  h("span.set-weight-box", null, num("deadlineDays", 1, 365, "Days ahead"), h("span.small.muted", null, "days"))))),
            h("div.set-actions", null, h("button.btn.small", { type: "button", title: "Put the suggested weights back (not saved until you press Save)", onclick: () => { Object.assign(s, DEFAULT_URGENCY); ctx.redraw(); } }, icon("undo", 12), "Suggested weights")));
        },
        async (s) => {
          await app.actions.logged("Settings: priority weights changed", { type: "Settings", title: "Priority" }, () => app.settings.saveShared({ urgency: cleanUrgency(s) }));
          return "Priority weights saved for the project";
        }, undefined, ["urgency"]));
    }

    // ---------------- Strategy ----------------

    function strategyTab(): HTMLElement {
      const top = ws.portfolioLevels()[0];
      // the example tag follows the prefix as it is typed
      const example = h("span", null);
      const showExample = (prefix: string): void => { example.textContent = `"${prefix.trim() || "Pillar:"}Growth"`; };
      showExample(app.settings.shared.pillarTagPrefix);
      return h("div", null,
        h("p.set-intro", null, `Pillars group the ${top?.name.toLowerCase() ?? "Epics"} on the Strategy page. An ${top?.defaultType ?? "Epic"} belongs to a pillar by its tag (for example `, example, ") or by a choice made on its card there."),
        scopeLine(SHARED_NOTE),
        editor<PillarDraft>("strategy", () => pillarDraft(app), (s, ctx) => {
          showExample(s.prefix);
          return pillarEditor(app, s, { ...ctx, changed: () => { showExample(s.prefix); ctx.changed(); } });
        }, (s) => savePillars(app, s), checkPillars, ["pillars", "pillarTagPrefix", "epicPillars"]));
    }

    // ---------------- AI help ----------------

    function aiTab(): HTMLElement {
      const cur = (): AiSettings => app.settings.user.ai;
      /** Would the saved key be sent somewhere else (another provider or host) with this draft? */
      const keyMoves = (s: AiDraft): boolean => {
        const prev = cur();
        return keyTarget(prev.provider, prev.endpoint) !== keyTarget(s.provider, s.provider === "openai" ? s.endpoint : prev.endpoint);
      };
      const saved = (): AiDraft => ({ provider: cur().provider, model: cur().model, endpoint: cur().endpoint, newKey: "", removeKey: false });
      const result = h("div.set-ai-result", { role: "status" });
      return h("div", null,
        h("p.set-intro", null, "AI help writes drafts (descriptions, acceptance criteria, tasks) and answers questions about the board. Your key is kept in this extension's storage in Azure DevOps, readable only by you, and sent only to the provider you pick. Text the AI writes is never saved without your click."),
        scopeLine("Personal: only you see and use these settings.", true),
        editor<AiDraft>("ai", saved, (s, ctx) => {
          const savedKey = cur().apiKey;
          const keyInfo = (): string => s.removeKey ? "The saved key will be removed when you save."
            : savedKey && keyMoves(s) && !s.newKey ? "The provider or address changed: type the key again. The saved key is not sent to a new place; it is removed when you save."
            : savedKey ? `A key is saved, ending with …${savedKey.slice(-4)}. Type a new one to replace it.` : "No key saved yet.";
          const keyNote = h("span", null, keyInfo());
          const modelCtl = s.provider === "anthropic"
            ? select([...ANTHROPIC_MODELS.map((m) => ({ value: m.id, label: m.label })), ...(s.model && !ANTHROPIC_MODELS.some((m) => m.id === s.model) ? [{ value: s.model, label: s.model }] : [])],
              s.model || ANTHROPIC_MODELS[0].id, (v) => { s.model = v; ctx.changed(); }, { title: "Which Claude model answers", "aria-label": "Model" })
            : h("input.input", {
              value: s.model, placeholder: "gpt-4.1-mini", title: "The model name. For Azure OpenAI the deployment is in the address, so this may stay empty.", "aria-label": "Model",
              oninput: (e: Event) => { s.model = (e.target as HTMLInputElement).value.trim(); ctx.changed(); },
            });
          return h("div.set-list", null,
            h("div.set-card", null,
              h("label.set-field", null, h("span", null, "Provider"),
                select<AiSettings["provider"]>([
                  { value: "none", label: "None (AI help off)" },
                  { value: "anthropic", label: "Claude by Anthropic" },
                  { value: "openai", label: "OpenAI-compatible (OpenAI, Azure OpenAI, local server)" },
                ], s.provider, (v) => {
                  s.provider = v;
                  if (v === "anthropic" && !ANTHROPIC_MODELS.some((m) => m.id === s.model)) s.model = ANTHROPIC_MODELS[0].id;
                  if (v === "openai" && ANTHROPIC_MODELS.some((m) => m.id === s.model)) s.model = "";
                  ctx.redraw();
                }, { title: "Who answers. None turns AI help off.", "aria-label": "Provider", "data-fk": "ai:provider" })),
              s.provider !== "none" ? [
                h("label.set-field", null, h("span", null, "Key"),
                  h("input.input", {
                    type: "password", autocomplete: "off", spellcheck: "false", value: s.newKey,
                    placeholder: savedKey && !s.removeKey ? `Saved, ends with …${savedKey.slice(-4)}` : s.provider === "anthropic" ? "sk-ant-…" : "Your key",
                    title: "Your own API key. It is never shown again in full.", "aria-label": "API key",
                    oninput: (e: Event) => { s.newKey = (e.target as HTMLInputElement).value.trim(); if (s.newKey) s.removeKey = false; keyNote.textContent = keyInfo(); ctx.changed(); },
                  }),
                  h("span.small.muted.set-keyinfo", null, keyNote,
                    savedKey && !s.removeKey ? h("button.btn.link.small", { title: "Remove the saved key when you save", onclick: (e: Event) => { e.preventDefault(); s.removeKey = true; s.newKey = ""; ctx.redraw(); } }, "Remove key") : null)),
                h("label.set-field", null, h("span", null, "Model"), modelCtl),
                s.provider === "openai" ? h("label.set-field", null, h("span", null, "Address", help("Leave empty for OpenAI itself. For Azure OpenAI paste your deployment's chat completions address, like https://NAME.openai.azure.com/openai/deployments/DEPLOYMENT/chat/completions?api-version=2024-10-21 (the key then goes in the api-key header). For a server on your own machine (Ollama, LM Studio) use its address, like http://localhost:11434/v1/chat/completions; a key may be empty there.")),
                  h("input.input", {
                    value: s.endpoint, placeholder: "https://api.openai.com/v1/chat/completions", title: "The chat completions address: empty for OpenAI, your Azure OpenAI deployment, or a local server",
                    "aria-label": "Address", "data-fk": "ai:endpoint", oninput: (e: Event) => { s.endpoint = (e.target as HTMLInputElement).value.trim(); keyNote.textContent = keyInfo(); ctx.changed(); },
                  }),
                  h("span.small.muted", null, "Empty for OpenAI. Azure OpenAI: your deployment's chat completions address. A local server: its address (no key needed).")) : null,
              ] : null),
            h("div.set-card", null,
              h("div.set-test", null,
                h("button.btn", {
                  title: "Send one short question to the saved provider and show the answer",
                  onclick: (e: Event) => {
                    if (drafts.ai) { toast("Save first: Test uses the saved settings.", { kind: "error" }); return; }
                    if (!app.ai.enabled) { result.replaceChildren(h("span.err", null, "AI help is off: pick a provider and save a key first.")); return; }
                    result.replaceChildren(h("span.muted", null, "Asking…"));
                    void busy(e.currentTarget as HTMLButtonElement, async () => {
                      try {
                        const text = await app.ai.ask("You check that a connection works. Answer in one short line.", [{ role: "user", content: "Say hello in five words or fewer." }], { maxTokens: 60 });
                        result.replaceChildren(h("span.ok", null, icon("check", 14), " It works. Answer: "), h("q", null, String(text).trim().slice(0, 200)));
                      } catch (err) {
                        const msg = err instanceof TypeError
                          ? `Could not reach the AI service (${err.message}). Check the address, your network, and that the service accepts calls from a browser.`
                          : errorText(err);
                        result.replaceChildren(h("span.err", null, icon("warn", 14), " ", msg));
                      }
                    });
                  },
                }, icon("sparkle", 14), "Test"),
                h("span.small.muted", null, "Uses the saved settings and sends one short question.")),
              result));
        }, async (s) => {
          const prev = cur();
          // a saved key goes only where it was saved for: a new provider or address needs the key typed again
          const dropped = !s.removeKey && !s.newKey && Boolean(prev.apiKey) && keyMoves(s);
          const apiKey = s.removeKey || dropped ? "" : s.newKey || prev.apiKey;
          const model = s.provider === "anthropic" ? (s.model || ANTHROPIC_MODELS[0].id) : s.model;
          await app.settings.saveUser({ ai: { provider: s.provider, apiKey, model, endpoint: s.provider === "openai" ? s.endpoint : prev.endpoint } });
          if (dropped) return s.provider === "none" ? "AI help is off. The saved key was removed." : "Saved. The saved key was removed because the provider or address changed: type the key again.";
          return s.provider === "none" ? "AI help is off" : apiKey || s.provider === "openai" ? "AI settings saved (only for you)" : "Saved. Add a key to turn AI help on.";
        }, (s) => {
          const p = s.provider === "openai" ? endpointProblem(s.endpoint) : null;
          return p ? { message: p, key: "ai:endpoint" } : null;
        }));
    }

    function drawPane(): void {
      saveNow = null;
      const tabs: Record<Tab, () => HTMLElement> = {
        menu: menuTab, cards: cardsTab, columns: columnsTab, team: teamTab, priority: priorityTab, rules: rulesTab, checklists: checklistsTab, tasks: tasksTab, board: boardTab, strategy: strategyTab, ai: aiTab, mine: mineTab,
      };
      pane.replaceChildren(tabs[tab]());
    }

    drawTabs();
    drawPane();
    // a tab picked by click or keyboard keeps the focus after the view drew again
    if (focusTab) { focusTab = false; tabBar.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus({ preventScroll: true }); }

    return {
      update(_changed, why) {
        if (state.saving) return;
        if (why === "settings" || why === "load") { const back = keepFocus(pane); drawTabs(); drawPane(); back(); }
      },
      unmount() {
        // unsaved drafts stay in `drafts` so a tab switch keeps them
        document.removeEventListener("keydown", onKey);
      },
    };
  },
};
