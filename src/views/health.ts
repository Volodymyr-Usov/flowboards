// Health: Checks: work without a parent, owner, description or estimate, stale work, mismatched states.
// The checks themselves are pure functions in core/health.ts; this file draws them and offers quick fixes.
import type { View } from "../app/context.ts";
import type { WorkItem } from "../api/types.ts";
import type { CheckInfo, CustomCheck, CustomFix, Finding, Severity } from "../core/health.ts";
import { CHECK_BY_ID, CHECKS, findingKey, firstStateIn, runChecks, runCustomChecks } from "../core/health.ts";
import type { Filter } from "../core/filters.ts";
import { BASE_PROPS, fieldProps } from "../core/filters.ts";
import { textMatch } from "../core/filters.ts";
import { inTeamAreas, isOpen, levelOf, parentLevel } from "../core/model.ts";
import { prefs } from "../core/settings.ts";
import { h, icon, svg } from "../ui/dom.ts";
import { keepFocus } from "../ui/focuskeep.ts";
import type { Writer } from "../core/writes.ts";
import { filterBar, peopleStrip, processFieldNames } from "../ui/filterbar.ts";
import { pageBar } from "../ui/pagebar.ts";
import type { Sheet } from "../ui/xlsx.ts";
import { avatar, confirm, dialog, empty, help, itemLink, itemPicker, personPicker, segmented, select, toast, toggle } from "../ui/kit.ts";
import { newDocId } from "../core/teamstore.ts";
import { orderedStates } from "../core/model.ts";

type GroupBy = "check" | "item";
/** Rows drawn per group at first, and added by each "Show more" */
const ROW_LIMIT = 100;

/** A check as the page shows it: built in, or added by the team. */
interface Check { id: string; title: string; about: string; severity: Severity; builtin?: CheckInfo; custom?: CustomCheck }

/** An eye with a line through it: "hide" (the × looked like delete). */
function eyeOff(size = 14): SVGElement {
  return svg("svg", { class: "icon", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" },
    svg("path", { d: "M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-2.9 3.4M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2" }));
}

const SEV_NAME: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };
/** The severity dot, with its name for screen readers. */
const sevDot = (s: Severity): HTMLElement => h(`span.hl-sev.${s}`, { title: `Severity: ${s}` }, h("span.sr-only", null, `${SEV_NAME[s]} severity`));

const fixLabel = (f: CustomFix): string => f.kind === "assign" ? "Assign an owner" : f.kind === "state" ? `Move to ${f.state}` : f.kind === "field" ? `Set ${f.field.split(".").pop()} to "${f.value}"` : "Open it";

export const healthView: View = {
  id: "health",
  title: "Health",
  icon: "health",
  group: "check",
  about: "Checks over the team's loaded work: no parent, owner, description or estimate, stale work, mismatched states. Fix a finding with its button, or hide it when it is not a problem.",
  mount(el, app) {
    const ws = app.ws;
    const ignoreKey = `health-ignored:${ws.project}`;
    const ignored = new Set<string>(prefs.get<string[]>(ignoreKey, []));
    const saveIgnored = (): void => prefs.set(ignoreKey, [...ignored]);
    const state = {
      groupBy: prefs.get<GroupBy>("health-group", "check"),
      showHidden: false,
      /** the team's own items (the default), or every loaded item, also those of other areas shown as parents */
      scope: (prefs.get<string>("health-scope", "team") === "all" ? "all" : "team") as "team" | "all",
      /** rows drawn per group (a group not listed shows ROW_LIMIT) */
      shown: new Map<string, number>(),
      only: new Set<string>(),
      selected: null as number | null,
    };

    // the checks on: built-in ones the team did not turn off, then the team's own (Settings shared by the project)
    const off = (): Set<string> => new Set(app.settings.shared.healthOff ?? []);
    const customs = (): CustomCheck[] => app.settings.shared.healthChecks ?? [];
    const checks = (): Check[] => [
      ...CHECKS.filter((c) => !off().has(c.id)).map((c) => ({ id: c.id as string, title: c.title, about: c.about, severity: c.severity, builtin: c })),
      ...customs().map((c) => ({ id: `c:${c.id}`, title: c.title, about: `${c.message || c.title}. Added by the team; action: ${fixLabel(c.fix).toLowerCase()}.`, severity: c.severity, custom: c })),
    ];
    const checkOf = (id: string): Check | undefined => checks().find((c) => c.id === id);
    const allProps = () => new Map([...BASE_PROPS, ...fieldProps(ws.items.values(), processFieldNames(ws.process))].map((p) => [p.id, p]));
    const inScope = (w: WorkItem | undefined): boolean => !w || state.scope === "all" || inTeamAreas(w.area, ws.settings.areas);
    const compute = (): Finding[] => {
      const on = off();
      const built = runChecks({
        items: ws.items.values(), process: ws.process, staleDays: app.settings.shared.staleDays,
        iterations: ws.iterations, backlogRoot: ws.settings.backlogIteration ?? ws.project, today: Date.now(),
      }).filter((f) => !on.has(f.checkId));
      return [...built, ...runCustomChecks(ws.items.values(), customs(), allProps())].filter((f) => inScope(ws.get(f.itemId)));
    };

    // ---------- quick fixes ----------

    const fixButton = (f: Finding, it: WorkItem): HTMLElement => {
      const b = fixButtonOf(f, it);
      b.dataset.fk = `fx:${findingKey(f)}`;
      b.dataset.fg = "fx";
      return b;
    };
    const fixButtonOf = (f: Finding, it: WorkItem): HTMLElement => {
      const open = (): HTMLElement => h("button.btn.small", { title: "Open the item to fix it", onclick: () => app.openItem(it.id) }, "Open");
      const c = checkOf(f.checkId);
      if (c?.custom) {
        const fx = c.custom.fix;
        if (fx.kind === "state") return h("button.btn.small", { title: `Move to ${fx.state}`, onclick: () => void app.actions.move(it.id, { state: fx.state }) }, fx.state);
        if (fx.kind === "field") return h("button.btn.small", { title: fixLabel(fx), onclick: () => void app.actions.setField(it.id, fx.field, fx.value, `#${it.id}: ${fixLabel(fx)}`) }, "Fix");
        if (fx.kind !== "assign") return open();
      }
      const check = c?.builtin ?? (c?.custom ? { fix: "owner" as const } : CHECK_BY_ID[f.checkId as keyof typeof CHECK_BY_ID]);
      switch (check?.fix) {
        case "owner":
          return h("button.btn.small", {
            title: "Pick who owns this item",
            onclick: (e: Event) => {
              const b = e.currentTarget as HTMLElement;
              personPicker(app.api, b, ws.people(), it.assignedTo, (p) => { b.focus(); if (p) void app.actions.assign(it.id, p.uniqueName); }, { allowNone: false });
            },
          }, "Assign");
        case "parent": {
          const lvl = levelOf(ws.process, it.type);
          const up = lvl ? parentLevel(ws.process, lvl) : undefined;
          if (!up) return open();
          return h("button.btn.small", {
            title: `Pick a parent from ${up.name}`,
            onclick: (e: Event) => {
              const b = e.currentTarget as HTMLElement;
              itemPicker(ws, b, (w) => up.types.includes(w.type) && isOpen(w) && w.id !== it.id,
                (w) => { b.focus(); if (w) void app.actions.reparent(it.id, w.id); }, { placeholder: `Find a parent in ${up.name}` });
            },
          }, "Set parent");
        }
        case "sprint": {
          const cur = ws.currentIteration();
          return h("button.btn.small", {
            title: cur ? `Move to the current sprint (${cur.name})` : "The team has no current sprint",
            disabled: !cur,
            onclick: () => { if (cur) void app.actions.setField(it.id, "System.IterationPath", cur.path, `#${it.id} moved to ${cur.name}`); },
          }, "To current sprint");
        }
        case "close": {
          const st = firstStateIn(ws.process, it.type, "Completed");
          if (!st) return open();
          return h("button.btn.small", { title: `Move to ${st}`, onclick: () => void app.actions.move(it.id, { state: st }) }, "Close");
        }
        case "start": {
          const st = firstStateIn(ws.process, it.type, "InProgress");
          if (!st) return open();
          return h("button.btn.small", { title: `Move the parent to ${st}`, onclick: () => void app.actions.move(it.id, { state: st }) }, "Start");
        }
        default:
          return open();
      }
    };

    /** Hide a finding (in this browser), or show a hidden one again; hiding says so, with Undo. */
    const hideButton = (f: Finding): HTMLElement => {
      const key = findingKey(f);
      const hidden = ignored.has(key);
      const set = (hide: boolean): void => { if (hide) ignored.add(key); else ignored.delete(key); saveIgnored(); draw(); };
      return h("button.btn.small.hl-hide", {
        title: hidden ? "Show this finding again" : "Not a problem: hide this finding (kept in this browser only, not shared with the team)",
        "data-fk": `hd:${key}`, "data-fg": "hd",
        onclick: () => {
          set(!hidden);
          if (!hidden) toast("Finding hidden", { kind: "ok", undo: async () => set(false), timeout: 6000 });
        },
      }, hidden ? icon("undo", 13) : eyeOff(13), hidden ? "Show" : "Hide");
    };

    const row = (f: Finding, showCheck: boolean, showItem: boolean): HTMLElement | null => {
      const it = ws.get(f.itemId);
      if (!it) return null;
      const check = checkOf(f.checkId) ?? { title: "" };
      return h("div.hl-row", { class: [ignored.has(findingKey(f)) && "hidden-f", state.selected === it.id && "sel"], dataset: { id: it.id } },
        sevDot(f.severity),
        showItem ? h("span.hl-item", null, itemLink(ws, it, (w) => app.openItem(w.id))) : null,
        showItem ? avatar(app.api, it.assignedTo, 22, { title: it.assignedTo?.displayName ?? "Nobody owns this" }) : null,
        h("span.hl-msg", null, showCheck ? h("b", null, check.title + ": ") : null, f.message),
        h("span.hl-acts", null, fixButton(f, it), hideButton(f)));
    };

    const limited = (key: string, rows: (HTMLElement | null)[]): HTMLElement[] => {
      const list = rows.filter((r): r is HTMLElement => !!r);
      const n = state.shown.get(key) ?? ROW_LIMIT;
      if (list.length <= n) return list;
      return [...list.slice(0, n), h("div.hl-more", null,
        h("button.btn.small", { title: `Show ${Math.min(ROW_LIMIT, list.length - n)} more of this group`, "data-fk": `more:${key}`, onclick: () => { state.shown.set(key, n + ROW_LIMIT); draw(); } }, `Show ${Math.min(ROW_LIMIT, list.length - n)} more`),
        h("span.small.muted", null, `${n} of ${list.length} shown`))];
    };

    // ---------- Excel and Copy in the top bar: the findings shown ----------

    const sheet = (): Sheet => {
      const sevName = { high: "High", medium: "Medium", low: "Low" } as const;
      return { name: "Health", rows: [
        ["Severity", "Check", "Id", "Type", "Title", "State", "Owner", "Finding"],
        ...visible(compute()).map((f) => {
          const it = ws.get(f.itemId);
          return [sevName[f.severity], checkOf(f.checkId)?.title ?? "", f.itemId, it?.type ?? "", it?.title ?? "", it?.state ?? "", it?.assignedTo?.displayName ?? "", f.message];
        }),
      ], widths: [10, 26, 8, 14, 50, 14, 22, 50] };
    };

    // ---------- page ----------

    // filters on the items with findings: per person (their owner) and on any property
    let findingItems: WorkItem[] = [];
    const fb = filterBar({ key: "health.filters", items: () => ws.items.values(), names: () => processFieldNames(ws.process), onChange: () => draw() });
    const people = peopleStrip({ api: app.api, key: "health.people", items: () => findingItems.filter((w) => fb.test(w)), onChange: () => draw() });
    // line 2: search (the item's text and the finding), filters; line 3: person chips and switches (Excel and Copy in the top bar take the findings shown)
    const bar = pageBar(app, { search: { placeholder: "Search title, tag, owner, id, finding…", title: "Show only the findings whose item or message contains every word", label: "Search the findings", onChange: () => draw() } });
    const shows = (f: Finding): boolean => {
      const it = ws.get(f.itemId);
      if (!it) return !bar.search.words().length;
      return fb.test(it) && people.test(it) && textMatch(bar.search.words(), it, `${checkOf(f.checkId)?.title ?? ""} ${f.message}`);
    };
    const count = h("span.filter-count");

    const body = h("div.hl-body");
    bar.line2.append(fb.el);
    bar.end.append(count);
    bar.line3.append(people.el,
      ...(ws.settings.areas.length ? [segmented<"team" | "all">([
        { value: "team", label: "My team", title: `Only the work of ${ws.team}'s areas` },
        { value: "all", label: "All loaded", title: "Also the work of other areas that the board shows (parents of the team's items)" },
      ], state.scope, (v) => { state.scope = v; prefs.set("health-scope", v); state.shown.clear(); draw(); })] : []),
      segmented<GroupBy>([
        { value: "check", label: "By check", title: "Group the findings by check" },
        { value: "item", label: "By item", title: "Group the findings by work item" },
      ], state.groupBy, (v) => { state.groupBy = v; prefs.set("health-group", v); draw(); }),
      toggle("Show hidden", state.showHidden, (v) => { state.showHidden = v; draw(); }, "Also show the findings you hid (hidden in this browser only)"));
    el.append(bar.el, body);

    const visible = (all: Finding[]): Finding[] => all.filter((f) =>
      (state.showHidden || !ignored.has(findingKey(f))) && (!state.only.size || state.only.has(f.checkId)) && shows(f));

    function draw(): void {
      if (!ws.process) { body.replaceChildren(empty("Health", "The team's work is not loaded yet.")); return; }
      const all = compute();
      const active = all.filter((f) => !ignored.has(findingKey(f)));
      findingItems = [...new Set(active.map((f) => f.itemId))].map((id) => ws.get(id)).filter((w): w is WorkItem => !!w);
      people.refresh();
      const hiddenCount = all.length - active.length;
      const total = [...ws.items.values()].filter(inScope).length;
      const withFindings = new Set(active.map((f) => f.itemId)).size;
      const clean = total - withFindings;
      const pct = total ? Math.round((clean / total) * 100) : 100;

      const counts = new Map<string, number>();
      for (const f of active) counts.set(f.checkId, (counts.get(f.checkId) ?? 0) + 1);

      const score = h("div.card-box.hl-score", null,
        h("div.stat", null,
          h("span.n", null, `${clean} of ${total}`),
          h("span.l", null, "items have no findings", " ", help(`Only the team's loaded work is checked: open items and those closed in the last ${ws.opts.closedDays} days. Stale means in progress and unchanged for more than ${app.settings.shared.staleDays} days (set in Settings).`))),
        h("div.hl-bar", { title: `${pct}% without findings` }, h("i", { style: { width: pct + "%" } })),
        h("div.small.muted", null, `${active.length} findings on ${withFindings} items`, hiddenCount ? ` · ${hiddenCount} hidden in this browser` : ""));

      const chips = h("div.hl-chips", null,
        checks().map((c) => {
          const n = counts.get(c.id) ?? 0;
          const on = state.only.has(c.id);
          return h("button.chip", {
            class: [!n && !on && "zero"], "aria-pressed": String(on), "data-fk": `chip:${c.id}`,
            title: `${c.about} Click to ${on ? "stop filtering by" : "show only"} this check.`,
            onclick: () => { if (on) state.only.delete(c.id); else state.only.add(c.id); draw(); },
          }, sevDot(c.severity), c.title, h("b", null, String(n)));
        }),
        state.only.size ? h("button.btn.link", { title: "Show every check", "data-fk": "showall", "data-fe": "add", onclick: () => { state.only.clear(); draw(); } }, "Show all") : null,
        app.actions.readOnly ? null : h("button.btn.small", { title: "Add a check of your own: the conditions that make an item a finding, and what to do about it (shared with the project)", "data-fk": "add", onclick: () => void editCheck(null) }, icon("plus", 13), "Add check"),
        h("button.btn.small", { title: "Turn the checks on or off, and change or remove the team's own", "data-fk": "checks", onclick: () => void manageChecks() }, icon("settings", 13), "Checks"));

      const list = visible(all);
      const narrowed = fb.active() || people.active() || bar.search.words().length > 0;
      count.textContent = narrowed ? `${list.length} finding${list.length === 1 ? "" : "s"} found.` : "";
      let groups: HTMLElement[];
      if (!list.length) {
        groups = [empty(all.length ? "Nothing to show" : "All good", all.length ? "No findings match the filters." : "No findings in the team's loaded work.")];
      } else if (state.groupBy === "check") {
        groups = checks().map((c) => {
          const fs = list.filter((f) => f.checkId === c.id);
          if (!fs.length) return null;
          const all = app.actions.readOnly ? null : fixAll(c, fs);
          return h("section.card-box.hl-group", null,
            h("div.hl-ghead", null, sevDot(c.severity), h("h3", null, c.title), h("span.muted", null, String(fs.length)), help(c.about),
              all || c.custom ? h("span.spacer") : null,
              all,
              c.custom && !app.actions.readOnly ? h("button.btn.small", { title: "Change this check", "data-fk": `ed:${c.id}`, onclick: () => void editCheck(c.custom!) }, "Edit") : null),
            limited(c.id, fs.map((f) => row(f, false, true))));
        }).filter((x): x is HTMLElement => !!x);
      } else {
        const byItem = new Map<number, Finding[]>();
        for (const f of list) byItem.set(f.itemId, [...(byItem.get(f.itemId) ?? []), f]);
        const rank = { high: 0, medium: 1, low: 2 };
        const entries = [...byItem.entries()].sort((a, b) => b[1].length - a[1].length
          || Math.min(...a[1].map((f) => rank[f.severity])) - Math.min(...b[1].map((f) => rank[f.severity])) || a[0] - b[0]);
        const cards = entries.map(([id, fs]) => {
          const it = ws.get(id);
          if (!it) return null;
          return h("section.card-box.hl-group", { class: [state.selected === id && "sel"], dataset: { id } },
            h("div.hl-ghead", null, itemLink(ws, it, (w) => app.openItem(w.id)), h("span.spacer"),
              avatar(app.api, it.assignedTo, 22, { title: it.assignedTo?.displayName ?? "Nobody owns this" })),
            fs.map((f) => row(f, true, false)));
        });
        groups = limited("items", cards);
      }
      // the focus stays on the same control, or moves to the next finding's when its row went
      const back = keepFocus(body);
      body.replaceChildren(h("div.hl-top", null, score, chips), h("div.hl-groups", null, groups));
      back(body.querySelector<HTMLElement>("[data-fk=checks]"));
    }

    // ---------- the team's own checks ----------

    const saveChecks = async (patch: { healthChecks?: CustomCheck[]; healthOff?: string[] }, what: string): Promise<void> => {
      await app.settings.saveShared(patch);
      toast(what, { kind: "ok" });
    };

    /** Add or change a check: name, what it says, severity, the conditions, and the action on each finding. */
    async function editCheck(existing: CustomCheck | null): Promise<void> {
      const d: CustomCheck = existing ? structuredClone(existing) : {
        id: newDocId("chk"), title: "", message: "", severity: "medium",
        when: [{ prop: "category", op: "none", values: ["Completed", "Removed"] } as Filter], fix: { kind: "open" },
      };
      const title = h("input.input", { value: d.title, placeholder: "For example: Bug without a priority", "aria-label": "Name" }) as HTMLInputElement;
      const message = h("input.input", { value: d.message, placeholder: "What each finding says, for example: Give it a priority", "aria-label": "Message" }) as HTMLInputElement;
      const sev = select<Severity>([{ value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }], d.severity, (v) => { d.severity = v; }, { "aria-label": "Severity" });
      const preview = h("p.small.muted");
      const paintPreview = (): void => {
        const n = d.when.length ? runCustomChecks(ws.items.values(), [d], allProps()).length : 0;
        preview.textContent = d.when.length ? `Matches ${n} of the team's ${ws.items.size} loaded items now.` : "Add at least one condition.";
      };
      const conds = filterBar({ key: "health.edit", items: () => ws.items.values(), names: () => processFieldNames(ws.process), onChange: paintPreview,
        store: { get: () => d.when, set: (f) => { d.when = f; } }, addLabel: "Add condition" });
      // the action offered on each finding
      const states = [...new Set(orderedStates(ws.process, Object.keys(ws.process.types)).map((s) => s.name))];
      const fields = Object.entries(processFieldNames(ws.process)).sort((a, b) => a[1].localeCompare(b[1]));
      const actHost = h("div.hl-act-opts");
      const paintAct = (): void => {
        const fx = d.fix;
        actHost.replaceChildren(
          fx.kind === "state" ? select<string>(states.map((s) => ({ value: s, label: s })), fx.state || states[0], (v) => { d.fix = { kind: "state", state: v }; }, { "aria-label": "State" }) : "",
          fx.kind === "field" ? select<string>(fields.map(([ref, name]) => ({ value: ref, label: `${name} (${ref})` })), fx.field || fields[0]?.[0] || "", (v) => { if (d.fix.kind === "field") d.fix.field = v; }, { "aria-label": "Field" }) : "",
          fx.kind === "field" ? h("input.input", { value: fx.value, placeholder: "Value", "aria-label": "Value", oninput: (e: Event) => { if (d.fix.kind === "field") d.fix.value = (e.target as HTMLInputElement).value; } }) : "");
      };
      const actSel = select<CustomFix["kind"]>([
        { value: "open", label: "Open the item" }, { value: "assign", label: "Assign an owner" },
        { value: "state", label: "Move to a state" }, { value: "field", label: "Set a field to a value" },
      ], d.fix.kind, (v) => {
        d.fix = v === "state" ? { kind: "state", state: states[0] ?? "" } : v === "field" ? { kind: "field", field: fields[0]?.[0] ?? "", value: "" } : { kind: v };
        paintAct();
      }, { "aria-label": "Action" });
      paintAct();
      paintPreview();
      const field = (label: string, ...kids: (HTMLElement | string)[]): HTMLElement => h("label.hl-field", null, h("span", null, label), ...kids);
      const body = h("div.hl-edit", null,
        field("Name", title), field("Message on each finding", message),
        field("Severity", sev),
        h("div.hl-field", null, h("span", null, "An item is a finding when it matches every condition"), conds.el, preview),
        h("div.hl-field", null, h("span", null, "Action on each finding"), h("div.hl-act", null, actSel, actHost)),
        h("p.small.muted", null, "Shared with everyone in the project. Checks look at the team's loaded work: open items and those closed lately."));
      const startState = JSON.stringify(d);
      const typed = (): boolean => JSON.stringify({ ...d, title: title.value.trim(), message: message.value.trim() }) !== startState;
      const save = async (): Promise<boolean> => {
        d.title = title.value.trim();
        d.message = message.value.trim();
        if (!d.title) { toast("Give the check a name.", { kind: "error" }); return false; }
        if (!d.when.length) { toast("Add at least one condition.", { kind: "error" }); return false; }
        if (d.fix.kind === "field" && !d.fix.field) { toast("Pick the field to set.", { kind: "error" }); return false; }
        const list = customs().filter((c) => c.id !== d.id);
        await saveChecks({ healthChecks: existing ? customs().map((c) => (c.id === d.id ? d : c)) : [...list, d] }, existing ? `Check "${d.title}" changed` : `Check "${d.title}" added`);
        return true;
      };
      await dialog(existing ? `Change "${existing.title}"` : "Add a check", body, [
        ...(existing ? [{ label: "Remove", danger: true, value: "rm", onClick: async () => {
          if (!(await confirm(`Remove "${existing.title}"?`, "Its findings disappear for everyone in the project.", "Remove", true))) return false;
          await saveChecks({ healthChecks: customs().filter((c) => c.id !== existing.id) }, `Check "${existing.title}" removed`);
          return true;
        } }] : []),
        { label: "Cancel", value: "" },
        { label: existing ? "Save" : "Add", primary: true, onClick: save },
      ], { wide: true, dirty: typed });
    }

    /** Turn checks on or off (built-in ones) and change or remove the team's own. */
    async function manageChecks(): Promise<void> {
      const offNow = off();
      const ro = app.actions.readOnly;
      const teamList = h("div.hl-mlist");
      const body = h("div.hl-manage", null,
        h("p.small.muted", null, "Shared with everyone in the project."),
        h("h3", null, "Built-in checks"),
        CHECKS.map((c) => h("div.hl-mrow", null,
          toggle(c.title, !offNow.has(c.id), (v) => { if (v) offNow.delete(c.id); else offNow.add(c.id); }, c.about),
          sevDot(c.severity))),
        h("h3", null, "The team's checks"),
        teamList);
      /** the team's checks, drawn again after one was changed or removed in the dialog over this one */
      function paintTeam(): void {
        const back = keepFocus(teamList);
        teamList.replaceChildren(...(customs().length ? customs().map((c) => h("div.hl-mrow", null,
          sevDot(c.severity), h("b", null, c.title), h("span.small.muted", null, fixLabel(c.fix)), h("span.spacer"),
          ro ? null : h("button.btn.small", {
            "data-fk": `chg:${c.id}`, "data-fg": "chg", title: `Change or remove "${c.title}"`,
            onclick: async () => { await editCheck(c); paintTeam(); },
          }, "Change"))) : [h("p.small.muted", null, "None yet: use Add check.")]));
        back(teamList.closest<HTMLElement>(".dialog")?.querySelector<HTMLElement>(".dialog-foot .btn") ?? null);
      }
      paintTeam();
      if (ro) body.querySelectorAll("input").forEach((i) => { (i as HTMLInputElement).disabled = true; });
      await dialog("Checks", body, ro ? [{ label: "Close", value: "" }] : [
        { label: "Cancel", value: "" },
        { label: "Save", primary: true, onClick: async () => { await saveChecks({ healthOff: [...offNow] }, "Checks saved"); } },
      ], { wide: true });
    }

    /**
     * The change a check's fix makes on one item, for "Fix all", or null when each item needs its own
     * choice or a look (open it, pick a parent). `who`: the person picked once for "Assign all".
     */
    const stepFor = (c: Check, id: number, who?: string): ((w: Writer) => ReturnType<Writer["move"]>) | null => {
      const it = ws.get(id);
      if (!it) return null;
      const fx = c.custom?.fix;
      if (fx?.kind === "state") return (w) => w.move(id, { state: fx.state });
      if (fx?.kind === "field") return (w) => w.setFields(id, [{ field: fx.field, value: fx.value }]);
      const kind = fx ? (fx.kind === "assign" ? "owner" : "open") : c.builtin?.fix;
      if (kind === "owner" && who) return (w) => w.setFields(id, [{ field: "System.AssignedTo", value: who }]);
      if (kind === "sprint") { const cur = ws.currentIteration(); return cur ? (w) => w.setFields(id, [{ field: "System.IterationPath", value: cur.path }]) : null; }
      if (kind === "close" || kind === "start") {
        const st = firstStateIn(ws.process, it.type, kind === "close" ? "Completed" : "InProgress");
        return st ? (w) => w.move(id, { state: st }) : null;
      }
      return null;
    };
    /** What "Fix all" does, in words, or null when the check has no fix for all. */
    const allLabel = (c: Check): string | null => {
      const fx = c.custom?.fix;
      if (fx) return fx.kind === "state" || fx.kind === "field" ? fixLabel(fx) : fx.kind === "assign" ? "Assign all to…" : null;
      switch (c.builtin?.fix) {
        case "owner": return "Assign all to…";
        case "sprint": { const cur = ws.currentIteration(); return cur ? `Move to ${cur.name}` : null; }
        case "close": return "Close";
        case "start": return "Start";
        default: return null;
      }
    };

    /** checks whose "Fix all" runs now */
    const fixing = new Set<string>();
    /** Apply a check's fix to every finding shown in its group: asks first, one message and one Undo for all. */
    function fixAll(c: Check, fs: Finding[]): HTMLElement | null {
      const what = allLabel(c);
      if (!what) return null;
      const ids = [...new Set(fs.filter((f) => !ignored.has(findingKey(f))).map((f) => f.itemId))];
      const assign = what.startsWith("Assign");
      const run = async (who?: { uniqueName: string; displayName: string }): Promise<void> => {
        const steps = ids.map((id) => ({ id, run: stepFor(c, id, who?.uniqueName) })).filter((s) => s.run);
        if (!steps.length) { toast("Nothing here can be fixed in one go: open the items one by one.", { kind: "error" }); return; }
        const doing = assign ? `Assign ${steps.length} items to ${who!.displayName}` : `${what} ${steps.length} items`;
        if (!(await confirm(`${doing}?`, `Every item "${c.title}" finds now${steps.length < ids.length ? ` that can be changed here (${ids.length - steps.length} cannot)` : ""}. One Undo in the message puts them all back.`, "Do it"))) return;
        // not disabled while it runs (that would drop the focus): a second click waits for the first
        fixing.add(c.id);
        try {
          const r = await app.actions.batch(`${c.title}: ${assign ? `assigned to ${who!.displayName}` : what.toLowerCase()} (${steps.length} items)`,
            steps.map((s) => ({ label: `#${s.id}`, run: s.run! })));
          if (r.failed.length) toast(`${r.done} done, ${r.failed.length} not: ${r.failed[0].label} ${r.failed[0].error}`, { kind: "error" });
        } finally {
          fixing.delete(c.id);
          // the group may be gone: the next "Fix all", else Checks
          if (document.activeElement === document.body || !document.activeElement?.isConnected) {
            const to = [`[data-fk="fa:${CSS.escape(c.id)}"]`, "[data-fg=fa]", "[data-fk=checks]"].map((s) => body.querySelector<HTMLElement>(s)).find(Boolean);
            to?.focus({ preventScroll: true });
          }
        }
      };
      return h("button.btn.small", {
        title: `${assign ? "Assign every item of this check to one person" : `${what}: all ${ids.length} items of this check`} (asks first; one Undo)`,
        disabled: !ids.length, "data-fk": `fa:${c.id}`, "data-fg": "fa", "data-fe": "checks", "aria-busy": fixing.has(c.id) ? "true" : null,
        onclick: (e: Event) => {
          if (fixing.has(c.id)) return;
          const btn = e.currentTarget as HTMLButtonElement;
          if (!assign) { void run(); return; }
          personPicker(app.api, btn, ws.people(), undefined, (p) => { btn.focus(); if (p) void run(p); }, { allowNone: false });
        },
      }, assign ? "Assign all…" : "Fix all");
    }

    draw();
    return {
      exportSheets: () => { const sh = sheet(); return sh.rows.length > 1 ? [sh] : null; },
      update() { fb.refresh(); draw(); },
      select(id) {
        state.selected = id;
        for (const r of el.querySelectorAll<HTMLElement>("[data-id]")) r.classList.toggle("sel", Number(r.dataset.id) === id);
      },
    };
  },
};

