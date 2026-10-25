// Strategy: Strategy pillars, their Epics and Features, with work closed per month.
// Pillars are kept in the shared settings; an Epic belongs to a pillar by a tag ("Pillar:Growth")
// or by a choice made here (kept in the extension's settings, not in Azure DevOps).
// The months chart reads the requirement items closed in the last 12 months (history, queried here).
import type { View } from "../app/context.ts";
import type { Level, WorkItem } from "../api/types.ts";
import { byOrder, isClosed, isRemoved, statesOf } from "../core/model.ts";
import { prefs } from "../core/settings.ts";
import type { Pillar } from "../core/settings.ts";
import { h, icon, rafThrottle, svg } from "../ui/dom.ts";
import { createItem } from "../ui/create.ts";
import { avatar, busy, confirm, empty, errorText, itemPicker, popup, stateMark, toast, toggle, typeMark } from "../ui/kit.ts";
import { pageBar } from "../ui/pagebar.ts";
import { checkPillars, editPillarsDialog, pillarDraft, savePillarsKept } from "./pillareditor.ts";
import { newId } from "./ruleeditor.ts";
import type { PillarLike } from "./strategylogic.ts";
import {
  countByMonth, derivePillars, findAncestor, monthKeys, monthsStart, monthsStartTime, NO_PILLAR, NONE_VALUE, pillarColor, pillarNamesFromTags, SERIES_TOKENS,
  pillarOfEpic, pillarSource, progressOf, stateMismatch, sumRows,
} from "./strategylogic.ts";

const BATCH = 200;
const MONTHS = 12;

/** What was typed in a pillar's form and not saved, by project and pillar ("new" for Add pillar); kept while the app runs. */
const formDrafts = new Map<string, { name: string; description: string; color?: string }>();

interface History {
  loading: boolean;
  error: string;
  at: number;
  /** items read for the history: closed requirement items, their parents, closed Features */
  items: Map<number, WorkItem>;
  closedReq: number[];
}

function chunks<T>(list: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

const monthLabel = (key: string, withYear = true): string => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, withYear ? { month: "short", year: "numeric" } : { month: "short" });
};

/** A small bar chart: one bar per month, tooltip per bar. */
function monthBars(row: number[], months: string[], color: string, what: string): HTMLElement {
  const bw = 9, gap = 2, H = 30;
  const max = Math.max(1, ...row);
  const total = row.reduce((a, b) => a + b, 0);
  const W = months.length * (bw + gap) - gap;
  const chart = svg("svg", { class: "st-bars", width: W, height: H + 1, viewBox: `0 0 ${W} ${H + 1}`, role: "img", "aria-label": `${what}: ${total} closed in ${months.length} months` },
    svg("line", { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, class: "st-base" }),
    months.map((m, i) => {
      const v = row[i] ?? 0;
      const bh = v ? Math.max(2, Math.round((v / max) * (H - 2))) : 0;
      const x = i * (bw + gap);
      const r = Math.min(2, bh / 2);
      const y = H - bh;
      const d = bh ? `M${x} ${H}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + bw - r}Q${x + bw} ${y} ${x + bw} ${y + r}V${H}Z` : "";
      return svg("g", { class: "st-bar" },
        svg("title", null, `${monthLabel(m)}: ${v} closed`),
        svg("rect", { x: x - 1, y: 0, width: bw + 2, height: H, class: "st-hit" }),
        d ? svg("path", { d, style: `fill:${color}` }) : null);
    }));
  return h("div.st-chart", { title: `${what}: requirement items closed per month, last ${months.length} months` },
    chart,
    h("div.st-chart-cap", null, h("span", null, monthLabel(months[0], false)), h("b", null, `${total} closed`), h("span", null, monthLabel(months[months.length - 1], false))));
}

function progressBar(done: number, total: number, label: string): HTMLElement {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return h("div.st-prog", { title: `${done} of ${total} ${label} done (${pct}%)` },
    h("div.st-prog-track", null, h("div.st-prog-fill", { style: { width: pct + "%" } })),
    h("span.small.muted", null, `${done}/${total} ${label}`));
}

export const strategyView: View = {
  id: "strategy",
  title: "Strategy",
  icon: "strategy",
  group: "measure",
  about: "Strategy pillars, their Epics and Features. Bars show the requirement items closed per month in the last 12 months.",
  mount(el, app) {
    const ws = app.ws;
    let showClosed = prefs.get<boolean>("strategy:closed", false);
    let selected: number | null = null;
    let loadSeq = 0;
    const hist: History = { loading: false, error: "", at: 0, items: new Map(), closedReq: [] };

    // nothing to search here: the field asks AI; buttons on line 2, "Show closed" on line 3
    const bar = pageBar(app);
    const status = h("div.st-status", { role: "status" });
    bar.end.append(status);
    const heads = h("div.st-heads");
    const graph = h("div.st-graph");
    const wrap = h("div.st-wrap", null, heads, graph);
    el.append(bar.el, wrap);

    const levels = (): { top?: Level; feat?: Level; req: Level } => {
      const p = ws.portfolioLevels();
      return { top: p[0], feat: p[1], req: ws.requirementLevel() };
    };

    /** Thrown when a newer read (or leaving the page) makes this one useless. */
    const STALE = new Error("stale");

    async function readItems(ids: number[], stale: () => boolean): Promise<WorkItem[]> {
      const out: WorkItem[] = [];
      for (const part of chunks(ids, BATCH)) {
        if (stale()) throw STALE;
        out.push(...(await app.api.items(ws.project, part)));
      }
      return out;
    }

    async function loadHistory(): Promise<void> {
      const seq = ++loadSeq;
      // no portfolio level: nothing to show the history on
      if (!levels().top) { hist.loading = false; return; }
      const stale = (): boolean => seq !== loadSeq;
      hist.loading = true;
      hist.error = "";
      drawStatus();
      try {
        const { top, feat, req } = levels();
        const closedStates = statesOf(ws.process, req.types, ["Completed"]);
        const areas = ws.settings.areas.length ? ws.settings.areas : undefined;
        const ids = closedStates.length
          ? await app.api.query(ws.project, { types: req.types, areas, states: closedStates, closedAfter: monthsStart(Date.now(), MONTHS) })
          : [];
        const items = new Map<number, WorkItem>();
        for (const it of await readItems(ids, stale)) items.set(it.id, it);
        const closedReq = [...items.keys()];
        // parents (Features, Epics) that are not loaded: read them, level by level
        for (let depth = 0; depth < ws.process.levels.length; depth++) {
          const missing = [...new Set([...items.values()].map((i) => i.parent).filter((p): p is number => !!p && !ws.items.has(p) && !items.has(p)))];
          if (!missing.length) break;
          const got = await readItems(missing, stale);
          for (const it of got) items.set(it.id, it);
          if (!got.length) break;
        }
        // closed Features under the Epics (the team's work keeps only recent closed items)
        if (top && feat) {
          const epicIds = [...new Set([...ws.items.values(), ...items.values()].filter((i) => top.types.includes(i.type)).map((i) => i.id))];
          const fids: number[] = [];
          for (const part of chunks(epicIds, BATCH)) {
            if (stale()) throw STALE;
            fids.push(...(await app.api.query(ws.project, { types: feat.types, parents: part })));
          }
          const need = [...new Set(fids)].filter((id) => !ws.items.has(id) && !items.has(id));
          for (const it of await readItems(need, stale)) items.set(it.id, it);
        }
        if (seq !== loadSeq) return;
        hist.items = items;
        hist.closedReq = closedReq;
        hist.at = Date.now();
      } catch (e) {
        if (seq !== loadSeq) return;
        hist.error = errorText(e);
      } finally {
        if (seq === loadSeq) {
          hist.loading = false;
          draw();
        }
      }
    }

    function drawStatus(): void {
      status.replaceChildren(
        hist.loading ? h("span.st-spin", null, h("span.spin"), "Reading the work closed in the last 12 months…")
          : hist.error ? h("span.err", null, icon("warn", 14), ` Could not read the closed work: ${hist.error}`)
          : hist.at ? h("span", { title: "Progress counts open items and those closed in the last 12 months." }, `Closed work read at ${new Date(hist.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`) : "");
    }

    /** The Epics on the page (closed ones read for the history too): a rename keeps them in their pillar. */
    let epicsNow: WorkItem[] = [];

    function drawToolbar(derived: boolean, pillars: PillarLike[]): void {
      bar.line3.replaceChildren(
        toggle("Show closed", showClosed, (v) => { showClosed = v; prefs.set("strategy:closed", v); draw(); }, "Show closed Epics and Features too"));
      // pillars found only in tags are saved by the first change (gear, Add pillar or here)
      bar.line2.replaceChildren(
        app.actions.readOnly ? h("span.small.muted", { title: "Read-only: nothing can be changed here" }, "Read-only") : "",
        h("button.btn", {
          disabled: app.actions.readOnly,
          title: app.actions.readOnly ? "Read-only: pillars cannot be changed here" : "Reorder the strategy pillars and set the tag prefix; also add, rename, recolour or remove them (shared by the project)",
          onclick: () => void editPillarsDialog(app, derived ? pillars : undefined, epicsNow),
        }, icon("settings", 14), "Edit pillars"));
    }

    /** Save pillars and say how many Epics a rename kept; the message offers Undo. */
    async function saveAndTell(draft: ReturnType<typeof pillarDraft>): Promise<void> {
      const r = await savePillarsKept(app, draft, epicsNow);
      toast(r.message, { kind: "ok", undo: r.undo });
    }

    /** Put an Epic in a pillar by hand (kept in this extension's settings). Pillars found only in tags are saved with it. */
    async function setEpicPillar(epic: WorkItem, pillar: PillarLike, pillars: PillarLike[]): Promise<void> {
      const shared = app.settings.shared;
      const before = { ...shared.epicPillars };
      const patch = { epicPillars: { ...before, [String(epic.id)]: pillar.id }, ...(shared.pillars.length ? {} : { pillars: pillars.map((p) => ({ id: p.id, name: p.name, ...(p.color ? { color: p.color } : {}) })) }) };
      await busy(null, async () => {
        await app.actions.logged("Settings: Epic pillar changed", { type: "Settings", title: "Pillars" }, () => app.settings.saveShared(patch));
        toast(`#${epic.id} is now in "${pillar.name}" (kept in this extension; Azure DevOps is not changed)`, {
          kind: "ok",
          undo: () => {
            const next = { ...app.settings.shared.epicPillars };
            const was = before[String(epic.id)];
            if (was) next[String(epic.id)] = was; else delete next[String(epic.id)];
            return app.actions.logged("Settings: Epic pillar change undone", { type: "Settings", title: "Pillars" }, () => app.settings.saveShared({ epicPillars: next }));
          },
        });
      });
    }

    const openCard = (id: number) => ({
      role: "button", tabindex: 0, dataset: { id },
      onclick: (e: MouseEvent) => { if (!(e.target as Element).closest("select, a, button")) app.openItem(id); },
      onkeydown: (e: KeyboardEvent) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); app.openItem(id); } },
    });

    /** Add a pillar, or change one: name, description and colour in a small form by its card. Saved for the project. */
    function pillarForm(anchor: HTMLElement, id: string | null, shown: PillarLike[]): void {
      const shared = app.settings.shared;
      // pillars still found only in tags are saved with the first change, so they can be edited the same way
      const draft = pillarDraft(app, shared.pillars.length ? undefined : shown);
      const cur = id ? draft.pillars.find((x) => x.id === id) : undefined;
      const p: Pillar = cur ? cur : { id: newId("p"), name: "", color: SERIES_TOKENS[draft.pillars.length % SERIES_TOKENS.length] };
      // typed before and not saved (closed by a click outside, Esc or a resize): start from that
      const key = `${ws.project}:${id ?? "new"}`;
      const orig = { name: p.name, description: p.description ?? "", color: p.color };
      const kept = formDrafts.get(key);
      if (kept) p.color = kept.color;
      const name = h("input.input", { value: kept?.name ?? p.name, placeholder: "For example: Security", "aria-label": "Pillar name" }) as HTMLInputElement;
      const desc = h("textarea.input", { rows: 2, value: kept?.description ?? p.description ?? "", placeholder: "What belongs here (optional). Ctrl+Enter saves", "aria-label": "Description" }) as HTMLTextAreaElement;
      let finished = false;
      const keepDraft = (): void => {
        const now = { name: name.value, description: desc.value, color: p.color };
        if (finished || (now.name === orig.name && now.description === orig.description && now.color === orig.color)) formDrafts.delete(key);
        else formDrafts.set(key, now);
      };
      const keptNote = kept ? h("p.small.st-kept", null, "Your unsaved changes from before. ",
        h("button.btn.link.small", { type: "button", title: "Throw away the unsaved changes and show the saved pillar", onclick: () => {
          name.value = orig.name; desc.value = orig.description; p.color = orig.color;
          for (const b of swatches.children) b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.token === p.color));
          formDrafts.delete(key); keptNote?.remove(); name.focus();
        } }, "Discard")) : null;
      const swatches = h("div.pe-palette", null, SERIES_TOKENS.map((t, k) => h("button.pe-swatch", {
        type: "button", style: { background: `var(${t})` }, title: `Colour ${k + 1}`, "aria-label": `Colour ${k + 1}`, "aria-pressed": String(p.color === t), dataset: { token: t },
        onclick: (e: Event) => { p.color = t; for (const b of swatches.children) b.setAttribute("aria-pressed", String(b === e.currentTarget)); },
      })));
      const msg = h("p.small.err");
      const save = async (): Promise<void> => {
        p.name = name.value.trim();
        p.description = desc.value.trim() || undefined;
        if (!cur) draft.pillars.push(p);
        const why = checkPillars(draft);
        if (why) { msg.textContent = why; if (!cur) draft.pillars.pop(); return; }
        try { await saveAndTell(draft); finished = true; formDrafts.delete(key); close(); } catch (e) { msg.textContent = `Not saved: ${errorText(e)}`; if (!cur) draft.pillars.pop(); }
      };
      const remove = async (): Promise<void> => {
        if (!cur || !(await confirm(`Remove the pillar "${cur.name}"?`, `Its ${levels().top?.name.toLowerCase() ?? "Epics"} move to "No pillar" (their tags in Azure DevOps stay).`, "Remove", true))) return;
        draft.pillars = draft.pillars.filter((x) => x.id !== cur.id);
        try { await saveAndTell(draft); finished = true; formDrafts.delete(key); close(); } catch (e) { msg.textContent = `Not removed: ${errorText(e)}`; }
      };
      name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } });
      desc.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } });
      const close = popup(anchor, h("div.col-pop.st-pform", null,
        h("h3", null, cur ? "Change the pillar" : "Add a pillar"),
        keptNote,
        name, desc,
        h("div.small.muted", null, "Colour"), swatches,
        h("p.small.muted", null, `${levels().top?.name ?? "Epics"} join it by the tag "${shared.pillarTagPrefix || "Pillar:"}${p.name || "<name>"}" or by the pillar picked on their card. Saved for the whole project.`),
        msg,
        h("div.col-pop-acts", null,
          h("button.btn.primary.small", { type: "button", onclick: () => void save() }, cur ? "Save" : "Add"),
          cur ? h("button.btn.small.danger", { type: "button", onclick: () => void remove() }, "Remove") : null)), { onClose: keepDraft });
      name.focus();
    }

    function draw(): void {
      const { top, feat, req } = levels();
      const shared = app.settings.shared;
      const prefix = shared.pillarTagPrefix || "Pillar:";
      const months = monthKeys(Date.now(), MONTHS);

      // every item known: history first, the team's loaded items win
      const all = new Map<number, WorkItem>(hist.items);
      for (const it of ws.items.values()) all.set(it.id, it);
      const parentOf = (id: number): number | undefined => all.get(id)?.parent;
      const kids = new Map<number, WorkItem[]>();
      for (const it of all.values()) {
        if (!it.parent || isRemoved(it)) continue;
        let l = kids.get(it.parent);
        if (!l) kids.set(it.parent, (l = []));
        l.push(it);
      }
      const isTop = (id: number): boolean => !!top && top.types.includes(all.get(id)?.type ?? "");
      const isFeat = (id: number): boolean => !!feat && feat.types.includes(all.get(id)?.type ?? "");

      const allEpics = top ? [...all.values()].filter((i) => top.types.includes(i.type) && !isRemoved(i)).sort(byOrder) : [];
      const derived = !shared.pillars.length;
      const pillars: PillarLike[] = derived ? derivePillars(allEpics.map((e) => e.tags), prefix) : shared.pillars;
      epicsNow = allEpics;
      drawToolbar(derived, pillars);
      drawStatus();

      if (!top) {
        heads.replaceChildren();
        graph.replaceChildren(empty("No portfolio level", "This team's process has no Epics or other portfolio level above the requirements."));
        return;
      }

      // requirement items and where they belong
      const reqItems = [...all.values()].filter((i) => req.types.includes(i.type) && !isRemoved(i));
      const epicOf = new Map<number, number | undefined>();
      const featOf = new Map<number, number | undefined>();
      for (const r of reqItems) {
        epicOf.set(r.id, findAncestor(r.id, parentOf, isTop));
        if (feat) featOf.set(r.id, findAncestor(r.id, parentOf, isFeat));
      }
      const underEpic = new Map<number, WorkItem[]>();
      const underFeat = new Map<number, WorkItem[]>();
      for (const r of reqItems) {
        const e = epicOf.get(r.id);
        if (e) { let l = underEpic.get(e); if (!l) underEpic.set(e, (l = [])); l.push(r); }
        const f = featOf.get(r.id);
        if (f) { let l = underFeat.get(f); if (!l) underFeat.set(f, (l = [])); l.push(r); }
      }

      // closed per month: the history, kept current with the team's loaded items
      const since = monthsStartTime(Date.now(), MONTHS);
      const closed = new Map<number, WorkItem>();
      for (const id of hist.closedReq) { const it = all.get(id); if (it) closed.set(id, it); }
      for (const it of reqItems) {
        if (!ws.items.has(it.id)) continue;
        if (isClosed(it) && it.closed && Date.parse(it.closed) >= since) closed.set(it.id, it);
        else if (!isClosed(it)) closed.delete(it.id);
      }
      const byEpic = countByMonth([...closed.values()].map((i) => ({ closed: i.closed, group: epicOf.get(i.id) })), months);

      // Epics by pillar
      const groups = new Map<string, WorkItem[]>(pillars.map((p) => [p.id, []]));
      groups.set(NO_PILLAR, []);
      for (const e of allEpics) groups.get(pillarOfEpic(e.id, e.tags, pillars, shared.epicPillars, prefix))!.push(e);

      const levelWord = (l: Level | undefined, fallback: string): string => l?.name ?? fallback;
      heads.replaceChildren(
        h("div", { title: "Strategy pillars of the project" }, "Pillars"),
        h("div", { title: `${levelWord(top, "Epics")}, by pillar` }, levelWord(top, "Epics")),
        feat ? h("div", { title: `${feat.name} under each ${top.defaultType}` }, feat.name) : h("div"));

      const bands: HTMLElement[] = [];
      const wires: { from: number | string; to: number; color: string }[] = [];
      const pillarList: (PillarLike & { none?: boolean })[] = [...pillars];
      if (groups.get(NO_PILLAR)!.length) pillarList.push({ id: NO_PILLAR, name: "No pillar", none: true, description: `${top.name} without a pillar tag (${prefix}…) and without a pillar set here.` });

      pillarList.forEach((p, pi) => {
        const epicsAll = groups.get(p.id) ?? [];
        const color = p.none ? "var(--s8)" : pillarColor(p.color, pi);
        const shown = epicsAll.filter((e) => showClosed || !isClosed(e));
        const row = sumRows(epicsAll.map((e) => byEpic.get(e.id)), months.length);
        const pkey = "p:" + p.id;
        const pillarCard = h("div.st-card.st-pillar", { dataset: { key: pkey }, style: { "--pc": color }, class: p.none ? "st-none" : "" },
          h("div.st-ptitle", null, h("span.st-dot"), h("h3", null, p.name),
            !p.none && !app.actions.readOnly ? h("button.icon-btn.small.st-pedit", { type: "button", title: `Rename, describe, recolour or remove "${p.name}"`, "aria-label": `Change ${p.name}`, onclick: (ev: Event) => { ev.stopPropagation(); pillarForm(ev.currentTarget as HTMLElement, p.id, pillars); } }, icon("settings", 13)) : null),
          p.description ? h("p.st-desc", null, p.description) : null,
          h("div.small.muted", { title: `${top.name} in this pillar (closed ones included)` }, `${epicsAll.length} ${epicsAll.length === 1 ? top.defaultType : top.name}`),
          monthBars(row, months, color, p.name));

        const erows = shown.map((e) => {
          wires.push({ from: pkey, to: e.id, color });
          const below = [...(kids.get(e.id) ?? []), ...(underEpic.get(e.id) ?? [])];
          const mismatch = stateMismatch(e.category, below.map((b) => b.category));
          const prog = progressOf(underEpic.get(e.id) ?? []);
          const features = feat ? (kids.get(e.id) ?? []).filter((k) => feat.types.includes(k.type)).sort(byOrder) : [];
          const fOpen = features.filter((f) => !isClosed(f)).length;
          const shownF = features.filter((f) => showClosed || !isClosed(f));
          const src = pillarSource(e.id, shared.epicPillars, pillars);
          const tagPillar = pillarOfEpic(e.id, e.tags, pillars, {}, prefix);
          const tagName = pillars.find((x) => x.id === tagPillar)?.name;
          const tagNames = pillarNamesFromTags(e.tags, prefix);
          const sel = h("select.input.st-psel", {
            disabled: app.actions.readOnly,
            title: app.actions.readOnly ? "Read-only: the pillar cannot be changed here" : "Pillar of this Epic. A choice here is kept in this extension's settings for the project; Azure DevOps (tags and fields) is not changed.",
            "aria-label": "Pillar",
            onchange: (ev: Event) => {
              const v = (ev.target as HTMLSelectElement).value;
              const next = { ...app.settings.shared.epicPillars };
              if (v) next[String(e.id)] = v;
              else delete next[String(e.id)];
              void busy(null, async () => {
                await app.actions.logged("Settings: Epic pillar changed", { type: "Settings", title: "Pillars" }, () => app.settings.saveShared({ epicPillars: next }));
                toast(`Pillar of #${e.id} saved in this extension (Azure DevOps is not changed)`, { kind: "ok" });
              });
            },
          },
          h("option", { value: "", selected: src === "tag" }, tagName ? `By tag: ${tagName}` : tagNames.length ? `By tag: ${tagNames[0]} (no such pillar)` : "By tag: none"),
          pillars.map((x) => h("option", { value: x.id, selected: src === "manual" && shared.epicPillars[String(e.id)] === x.id }, x.name)),
          h("option", { value: NONE_VALUE, selected: src === "none" }, "No pillar"));

          const epicCard = h("div.st-card.st-epic", { ...openCard(e.id), title: `Open #${e.id} ${e.title}`, style: { "--pc": color }, class: [isClosed(e) && "st-closed", selected === e.id && "sel"] },
            h("div.st-title", null, typeMark(ws, e.type), h("span.mono.muted", null, "#" + e.id), " ", h("span.t", null, e.title)),
            h("div.st-meta", null, stateMark(ws, e),
              mismatch ? h("span.st-warn", { title: mismatch, "aria-label": mismatch }, icon("warn", 13), "Check state") : null,
              e.assignedTo ? avatar(app.api, e.assignedTo, 18) : null),
            progressBar(prog.done, prog.total, req.name.toLowerCase()),
            feat ? h("div.small.muted", { title: `${feat.name}: open / all (closed ones included)` }, `${feat.name}: ${fOpen} open / ${features.length}`) : null,
            monthBars(byEpic.get(e.id) ?? months.map(() => 0), months, color, e.title),
            h("div.st-pick", null, h("span.small.muted", null, "Pillar"), sel));

          const fcol = h("div.st-feats", null, shownF.map((f) => {
            wires.push({ from: e.id, to: f.id, color });
            const fp = progressOf(underFeat.get(f.id) ?? []);
            return h("div.st-card.st-feat", { ...openCard(f.id), title: `Open #${f.id} ${f.title}`, class: [isClosed(f) && "st-closed", selected === f.id && "sel"] },
              h("div.st-title", null, typeMark(ws, f.type), h("span.mono.muted", null, "#" + f.id), " ", h("span.t", null, f.title)),
              h("div.st-meta", null, stateMark(ws, f), h("span.spacer"), avatar(app.api, f.assignedTo, 18, { title: f.assignedTo ? `Owner: ${f.assignedTo.displayName}` : "No owner" })),
              progressBar(fp.done, fp.total, req.name.toLowerCase()));
          }), feat && !shownF.length ? h("div.st-nofeat.small.muted", null, features.length ? `${features.length} closed ${feat.name.toLowerCase()} hidden` : `No ${feat.name.toLowerCase()}`) : null);
          return h("div.st-erow", null, epicCard, feat ? fcol : null);
        });
        bands.push(h("section.st-band", { style: { "--pc": color } },
          h("div.st-pcell", null, pillarCard),
          h("div.st-ecol", null, erows.length ? erows : h("div.st-noepic.small.muted", null, epicsAll.length ? `${epicsAll.length} closed ${top.name.toLowerCase()} hidden` : `No ${top.name.toLowerCase()} in this pillar yet. Tag an ${top.defaultType} with "${prefix}${p.name}" or pick the pillar on its card.`,
            !epicsAll.length && !p.none && !app.actions.readOnly ? h("div.st-addepic", null,
              h("button.btn.small", {
                type: "button", title: `Put an existing ${top.defaultType} in "${p.name}" (kept in this extension's settings; Azure DevOps is not changed)`,
                onclick: (ev: Event) => itemPicker(ws, ev.currentTarget as Element, (w) => top.types.includes(w.type) && !isClosed(w) && !isRemoved(w), (w) => { if (w) void setEpicPillar(w, p, pillars); },
                  { placeholder: `Find an ${top.defaultType} by title or number` }),
              }, icon("plus", 12), `Add ${top.defaultType}…`),
              h("button.btn.small", {
                type: "button", title: `Create a new ${top.defaultType} with the tag "${prefix}${p.name}"`,
                onclick: () => void newEpic(top, p, prefix),
              }, `New ${top.defaultType}`)) : null))));
      });

      const svgEl = svg("svg", { class: "st-wires", "aria-hidden": "true" });
      if (!allEpics.length) {
        graph.replaceChildren(empty(`No ${top.name.toLowerCase()}`, `This team has no ${top.name.toLowerCase()} yet. Strategy pillars group them; their ${feat?.name.toLowerCase() ?? "children"} show on the right.`));
        return;
      }
      // a pillar is added right here, under the last one
      const addCard = !app.actions.readOnly
        ? h("div.st-band.st-addband", null, h("div.st-pcell", null, h("button.st-card.st-addp", { type: "button", title: "Add a strategy pillar for the project", onclick: (ev: Event) => pillarForm(ev.currentTarget as HTMLElement, null, pillars) }, icon("plus", 16), "Add pillar")))
        : "";
      graph.replaceChildren(svgEl, ...bands, addCard,
        derived ? h("p.small.muted.st-note", null, pillars.length
          ? `These pillars come from the tags "${prefix}…" on the ${top.name.toLowerCase()}. Change one with its gear to keep them all as the project's pillars, with descriptions and colors.`
          : `No pillars yet. Add one with "Add pillar" below, or tag ${top.name.toLowerCase()} with "${prefix}<pillar name>".`) : "");
      wireState.list = wires;
      drawWires();
    }

    /** A new Epic in a pillar: the create form, then the pillar's tag added to what was typed. */
    async function newEpic(top: Level, p: PillarLike, prefix: string): Promise<void> {
      const made = await createItem(app, { types: top.types });
      if (!made) return;
      const tag = `${prefix}${p.name}`;
      if (made.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
      await app.actions.saveTyped(made.id, "System.Tags", [...made.tags, tag].join("; "));
    }

    const wireState: { list: { from: number | string; to: number; color: string }[] } = { list: [] };
    const drawWires = rafThrottle(() => {
      const svgEl = graph.querySelector<SVGSVGElement>("svg.st-wires");
      if (!svgEl) return;
      const g = graph.getBoundingClientRect();
      svgEl.setAttribute("width", String(graph.scrollWidth));
      svgEl.setAttribute("height", String(graph.scrollHeight));
      const find = (k: number | string): Element | null => graph.querySelector(typeof k === "number" ? `.st-card[data-id="${k}"]` : `.st-card[data-key="${CSS.escape(k)}"]`);
      const paths: SVGElement[] = [];
      for (const w of wireState.list) {
        const a = find(w.from)?.getBoundingClientRect();
        const b = find(w.to)?.getBoundingClientRect();
        if (!a || !b) continue;
        const x1 = a.right - g.left, y1 = a.top - g.top + Math.min(a.height / 2, 28);
        const x2 = b.left - g.left, y2 = b.top - g.top + Math.min(b.height / 2, 28);
        const dx = Math.max(16, (x2 - x1) / 2);
        paths.push(svg("path", { d: `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`, style: `stroke:${w.color}`, dataset: { to: w.to } }));
      }
      svgEl.replaceChildren(...paths);
    });
    const ro = new ResizeObserver(() => drawWires());
    ro.observe(graph);

    const redraw = rafThrottle(() => draw());
    draw();
    void loadHistory();

    return {
      update() { redraw(); },
      select(id) {
        selected = id;
        for (const c of graph.querySelectorAll<HTMLElement>(".st-card[data-id]")) c.classList.toggle("sel", Number(c.dataset.id) === id);
      },
      unmount() {
        loadSeq++;
        ro.disconnect();
      },
    };
  },
};
