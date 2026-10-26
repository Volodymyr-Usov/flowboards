// Dependencies: Which work waits for which, as a graph; flags work blocked by open predecessors.
// Links are Predecessor/Successor relations, read in batches with ws.withRelations. Items linked from
// outside the team are read once and shown dimmed. Layout: src/views/graphlayout.ts.
// The first link of an item is added with "+ Dependency" (two item pickers); later ones also by dragging.
import { REL, relId } from "../api/api.ts";
import type { WorkItem } from "../api/types.ts";
import type { App, View, ViewHandle } from "../app/context.ts";
import { textMatch } from "../core/filters.ts";
import { byOrder, initials, isClosed, isDone, isOpen, isRemoved, levelOf, stateColor, typeColor } from "../core/model.ts";
import { prefs } from "../core/settings.ts";
import { debounce, h, icon, replace, svg } from "../ui/dom.ts";
import { filterBar, peopleStrip, processFieldNames } from "../ui/filterbar.ts";
import { pageBar } from "../ui/pagebar.ts";
import { dialog, empty, failed, itemPicker, menu, segmented, spinner, toast, toggle, typeMark } from "../ui/kit.ts";
import type { Edge } from "./graphlayout.ts";
import { edgeKey, findLoops, layoutGraph, linkProblem as loopOrTwice, reach } from "./graphlayout.ts";
import { dependencyPairs } from "./roadmaplogic.ts";
import { fmtDay, planDay } from "./timeaxis.ts";

const W = 220;
const H = 62;
const COL = 300;
const ROW = 84;
const PAD = 30;
/** the graph opens at least this large, so the text stays readable; pan for the rest */
const MIN_ZOOM = 0.8;

/** The "waits for" links between the loaded items whose links are read. */
function loadedEdges(app: App): Edge[] {
  return dependencyPairs(app.ws.items.values()).map(([from, to]) => ({ from, to }));
}

/**
 * Add "succ waits for pred" after the same checks as dragging on the graph (not itself, not twice,
 * no loop). The link is written on the item that waits, so it must be one of the team's.
 */
export async function addDependencyChecked(app: App, pred: number, succ: number): Promise<boolean> {
  const ws = app.ws;
  if (!ws.items.has(succ)) { toast(`#${succ} is outside the team, so it cannot get a link here.`, { kind: "error" }); return false; }
  await ws.withRelations([pred, succ]).catch(() => undefined);
  const why = loopOrTwice(pred, succ, loadedEdges(app));
  if (why) { toast(why, { kind: "error" }); return false; }
  return !!(await app.actions.addDependency(pred, succ));
}

/** Remove "succ waits for pred", with Undo; from the other end when the item that waits is not the team's. */
export async function removeDependencyAny(app: App, pred: number, succ: number): Promise<void> {
  if (app.ws.items.has(succ) || !app.ws.items.has(pred)) { await app.actions.removeDependency(pred, succ); return; }
  await app.actions.batch(`#${succ} no longer waits for #${pred}`, [{ label: `#${pred}`, run: (w) => w.removeLink(pred, REL.successor, succ) }]);
}

/** Can the item take part in dependencies here (an open portfolio item or story)? */
function linkable(app: App, w: WorkItem): boolean {
  const k = app.ws.levelOf(w)?.kind;
  return (k === "portfolio" || k === "requirement") && !isClosed(w);
}

/** The "+ Dependency" dialog: the item that waits, and the item it waits for. Gives the item that waits, once added. */
export async function dependencyDialog(app: App, preset: { succ?: number; pred?: number } = {}): Promise<number | null> {
  const ws = app.ws;
  const start = (id?: number): WorkItem | undefined => { const w = id != null ? ws.get(id) : undefined; return w && linkable(app, w) ? w : undefined; };
  let succ = start(preset.succ);
  let pred = start(preset.pred);
  const note = h("p.small.err", { role: "alert" });
  const pickBtn = (which: "succ" | "pred"): HTMLButtonElement => {
    const b = h("button.btn.dep-pick", { type: "button" }) as HTMLButtonElement;
    const paint = (): void => {
      const w = which === "succ" ? succ : pred;
      b.replaceChildren(...(w ? [typeMark(ws, w.type), h("span.mono.muted", null, `#${w.id}`), h("span.t", null, w.title)] : [h("span.muted", null, "Choose an item…")]));
      b.setAttribute("aria-label", `${which === "succ" ? "This item" : "Waits for"}: ${w ? `#${w.id} ${w.title}` : "not chosen"}`);
    };
    b.addEventListener("click", () => itemPicker(ws, b, (w) => linkable(app, w) && w.id !== (which === "succ" ? pred : succ)?.id, (w) => {
      if (!w) return;
      if (which === "succ") succ = w; else pred = w;
      note.textContent = "";
      paint();
      // after the Enter that picked: focused now, the same key would press this button again
      setTimeout(() => b.focus());
    }));
    paint();
    return b;
  };
  const body = h("div.dep-form", null,
    h("div.dep-row", null, h("span.dep-lbl", null, "This item"), pickBtn("succ")),
    h("div.dep-row", null, h("span.dep-lbl", null, "waits for"), pickBtn("pred")),
    h("p.small.muted", null, "It cannot really start until the other one is done. Both are open Epics, Features or stories of the team."),
    note);
  let made: number | null = null;
  await dialog("Add a dependency", body, [
    { label: "Cancel", value: "" },
    {
      label: "Add", primary: true, onClick: async () => {
        if (!succ || !pred) { note.textContent = "Choose both items."; return false; }
        await ws.withRelations([pred.id, succ.id]).catch(() => undefined);
        const why = loopOrTwice(pred.id, succ.id, loadedEdges(app));
        if (why) { note.textContent = why; return false; }
        if (!(await app.actions.addDependency(pred.id, succ.id))) return false;
        made = succ.id;
      },
    },
  ], { dirty: () => succ?.id !== start(preset.succ)?.id || pred?.id !== start(preset.pred)?.id });
  return made;
}

interface GNode {
  id: number;
  item: WorkItem;
  outside: boolean;
  preds: number[];
  succs: number[];
  problems: string[];
}

interface Graph {
  nodes: Map<number, GNode>;
  edges: Edge[];
  bad: Set<string>;
  cycles: number[][];
}

type Scope = "portfolio" | "all";

export const depsView: View = {
  id: "deps",
  title: "Dependencies",
  tab: "Dependency",
  icon: "deps",
  group: "plan",
  about: "Which work waits for which, as a graph; flags work blocked by open predecessors. Drag from the dot on a card's right edge onto another card to add a link; click an arrow to remove it.",
  mount(el, app): ViewHandle {
    const ws = app.ws;
    let scope = prefs.get<Scope>("deps.scope", "all");
    let onlyProblems = prefs.get("deps.problems", false);
    let selected: number | null = app.openId();
    /** the item to bring into view after the next draw (a link was just added) */
    let pendingFocus: number | null = null;
    let alive = true;
    /** linked items that are not part of the team's loaded work */
    const outside = new Map<number, WorkItem>();
    const missing = new Set<number>();

    // ---- page ----
    const bar = pageBar(app, { search: {
      placeholder: "Search title, tag, owner, id…", label: "Search the dependencies", title: "Show only the items that contain every word, and what they wait for or block",
      onChange: () => draw(false),
    } });
    // filters on any property: matching cards show with what they wait for and what waits for them
    const fb = filterBar({
      key: "deps.filters", names: () => processFieldNames(ws.process),
      items: () => [...ws.items.values(), ...outside.values()].filter((w) => { const k = ws.levelOf(w)?.kind; return k === "portfolio" || k === "requirement"; }),
      onChange: () => { if (!loading) draw(true); },
    });
    // person chips, as on the Backlog and the Sprint
    const people = peopleStrip({
      api: ws.api, key: "deps.people", onChange: () => { if (!loading) draw(true); },
      items: () => [...ws.items.values(), ...outside.values()].filter((w) => { const k = ws.levelOf(w)?.kind; return (k === "portfolio" || k === "requirement") && isOpen(w); }),
    });
    async function addDep(): Promise<void> {
      const made = await dependencyDialog(app, { succ: selected ?? undefined });
      if (made != null) { pendingFocus = made; later(); }
    }
    // line 2: filters and "+ Dependency", the legend at the end; line 3: people, then what shows
    bar.line2.append(fb.el);
    if (!app.actions.readOnly) bar.line2.append(h("button.btn.small", { title: "Add a dependency between two items, also ones without any yet", onclick: () => void addDep() }, icon("plus", 14), "Dependency"));
    bar.end.append(h("span.deps-legend.small.muted", null,
      h("i.deps-lg-line"), "waits for ", h("i.deps-lg-line.bad"), "problem ", h("i.deps-lg-node.outside"), "outside the team"));
    bar.line3.append(people.el,
      segmented<Scope>([
        { value: "portfolio", label: ws.portfolioLevels().map((l) => l.name).join(" and ") || "Portfolio", title: "Show only portfolio items" },
        { value: "all", label: `With ${ws.requirementLevel().name.toLowerCase()}`, title: `Also show ${ws.requirementLevel().name.toLowerCase()}` },
      ], scope, (v) => { scope = v; prefs.set("deps.scope", v); draw(true); }),
      toggle("Only problems", onlyProblems, (v) => { onlyProblems = v; prefs.set("deps.problems", v); draw(true); }, "Show only items with a problem and what causes it"));
    const body = h("div.deps-body");
    el.append(bar.el, body);
    body.append(spinner("Reading the links…"));

    // ---- canvas ----
    const root = svg("g", { class: "deps-root" });
    const edgeLayer = svg("g", { class: "deps-edges" });
    const nodeLayer = svg("g", { class: "deps-nodes" });
    const temp = svg("path", { class: "deps-temp", d: "" });
    root.append(edgeLayer, nodeLayer, temp);
    const marker = (id: string, cls: string): SVGElement => svg("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
      svg("path", { d: "M0 0L10 5L0 10z", class: cls }));
    const canvasSvg = svg("svg", { class: "deps-svg", role: "img", "aria-label": "Dependency graph" },
      svg("defs", null,
        marker("deps-arrow", "deps-head"), marker("deps-arrow-bad", "deps-head bad"), marker("deps-arrow-hot", "deps-head hot"),
        svg("clipPath", { id: "deps-clip" }, svg("rect", { width: W, height: H, rx: 8 }))),
      root);
    const zoomLabel = h("span.deps-zoom-n.small.muted");
    const canvas = h("div.deps-canvas", null, canvasSvg,
      h("div.deps-zoom", null,
        h("button.icon-btn.small", { title: "Zoom in", "aria-label": "Zoom in", onclick: () => zoomAt(1.2) }, icon("plus", 14)),
        zoomLabel,
        h("button.icon-btn.small", { title: "Zoom out", "aria-label": "Zoom out", onclick: () => zoomAt(1 / 1.2) }, h("span.deps-minus", null, "−")),
        h("button.btn.small", { title: "Fit the whole graph in view", onclick: () => fit() }, "Fit")));
    const side = h("aside.deps-side");
    const main = h("div.deps-main", null, canvas, side);

    let graph: Graph = { nodes: new Map(), edges: [], bad: new Set(), cycles: [] };
    let shown: { ids: Set<number>; edges: Edge[] } = { ids: new Set(), edges: [] };
    const nodeEls = new Map<number, SVGElement>();
    const edgeEls: { e: Edge; el: SVGElement; hit: SVGElement }[] = [];
    const pos = new Map<number, { x: number; y: number }>();
    let view = { x: 0, y: 0, k: 1 };
    let fitted = false;

    // ---- data ----
    async function load(): Promise<void> {
      const kinds = new Set(["portfolio", "requirement"]);
      const ids = [...ws.items.values()].filter((i) => isOpen(i) && kinds.has(ws.levelOf(i)?.kind ?? "")).map((i) => i.id);
      await ws.withRelations(ids);
      const linked = new Set<number>();
      for (const it of ws.items.values()) for (const r of it.relations ?? []) {
        if (r.rel !== REL.predecessor && r.rel !== REL.successor) continue;
        const o = relId(r);
        if (o && !ws.items.has(o) && !outside.has(o) && !missing.has(o)) linked.add(o);
      }
      if (linked.size) {
        const got = await ws.api.items(ws.project, [...linked]).catch(() => [] as WorkItem[]);
        for (const g of got) outside.set(g.id, g);
        for (const id of linked) if (!outside.has(id)) missing.add(id);
      }
    }

    function buildGraph(): Graph {
      const nodes = new Map<number, GNode>();
      const seen = new Set<string>();
      const edges: Edge[] = [];
      const node = (id: number): GNode | undefined => {
        let n = nodes.get(id);
        if (n) return n;
        const inTeam = ws.items.get(id);
        const item = inTeam ?? outside.get(id);
        if (!item || isRemoved(item)) return undefined;
        n = { id, item, outside: !inTeam, preds: [], succs: [], problems: [] };
        nodes.set(id, n);
        return n;
      };
      const link = (from: number, to: number): void => {
        const k = `${from}>${to}`;
        if (seen.has(k)) return;
        const a = node(from);
        const b = node(to);
        if (!a || !b) return;
        seen.add(k);
        edges.push({ from, to });
        a.succs.push(to);
        b.preds.push(from);
      };
      for (const it of ws.items.values()) for (const r of it.relations ?? []) {
        const o = relId(r);
        if (!o) continue;
        if (r.rel === REL.predecessor) link(o, it.id);
        else if (r.rel === REL.successor) link(it.id, o);
      }
      // problems
      const bad = new Set<string>();
      const started = (w: WorkItem): boolean => w.category === "InProgress" || isDone(w);
      for (const n of nodes.values()) {
        for (const p of n.preds) {
          const pi = nodes.get(p)!.item;
          if (!isDone(pi) && started(n.item)) {
            n.problems.push(`${isDone(n.item) ? "Done" : "Started"} while #${p} is still ${pi.state}`);
            bad.add(`${p}>${n.id}`);
          }
          // target dates are days without a time: read and show them as days, not local moments
          const pt = planDay(pi.targetDate);
          const st = planDay(n.item.targetDate);
          if (pt != null && st != null && pt > st && !isDone(pi) && !isDone(n.item)) {
            n.problems.push(`#${p} ends ${fmtDay(pt)}, after this one (${fmtDay(st)})`);
            bad.add(`${p}>${n.id}`);
          }
        }
      }
      // every item of a group that waits on itself is in a loop, also those off the one loop shown
      const loops = findLoops([...nodes.keys()], edges);
      const cycles = loops.map((l) => l.cycle);
      for (const { cycle: c, members } of loops) {
        for (const id of members) {
          nodes.get(id)!.problems.push(c.includes(id)
            ? `In a loop: ${c.map((x) => "#" + x).join(" → ")} → #${c[0]}`
            : `In a loop with ${members.filter((x) => x !== id).map((x) => "#" + x).join(", ")}`);
        }
      }
      return { nodes, edges, bad, cycles };
    }

    /** Which nodes and edges to draw with the current filters. */
    function filter(): { ids: Set<number>; edges: Edge[] } {
      const g = graph;
      const kindOf = (n: GNode): string => levelOf(ws.process, n.item.type)?.kind ?? (n.outside ? "other" : "");
      let ids = new Set([...g.nodes.values()].filter((n) => {
        const k = kindOf(n);
        return scope === "portfolio" ? k === "portfolio" : k !== "";
      }).map((n) => n.id));
      const inScope = (e: Edge): boolean => ids.has(e.from) && ids.has(e.to);
      if (onlyProblems) {
        const keep = new Set<number>();
        for (const id of ids) if (g.nodes.get(id)!.problems.length) keep.add(id);
        for (const e of g.edges) if (g.bad.has(edgeKey(e)) && inScope(e)) { keep.add(e.from); keep.add(e.to); }
        ids = keep;
      }
      const words = bar.search.words();
      if (words.length || fb.active() || people.active()) {
        const hits = [...ids].filter((id) => {
          const it = g.nodes.get(id)!.item;
          return fb.test(it) && people.test(it) && textMatch(words, it);
        });
        const { up, down } = adjOf(g.edges.filter(inScope));
        const keep = new Set<number>(hits);
        for (const id of hits) { for (const x of reach(id, up)) keep.add(x); for (const x of reach(id, down)) keep.add(x); }
        ids = new Set([...ids].filter((id) => keep.has(id)));
      }
      const edges = g.edges.filter(inScope).filter((e) => ids.has(e.from) && ids.has(e.to));
      // a node without any drawn link is left out (its partner is filtered away)
      const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
      return { ids: new Set([...ids].filter((id) => linked.has(id) || (onlyProblems && g.nodes.get(id)!.problems.length))), edges };
    }

    function adjOf(edges: Edge[]): { up: Map<number, number[]>; down: Map<number, number[]> } {
      const up = new Map<number, number[]>();
      const down = new Map<number, number[]>();
      for (const e of edges) {
        (down.get(e.from) ?? down.set(e.from, []).get(e.from)!).push(e.to);
        (up.get(e.to) ?? up.set(e.to, []).get(e.to)!).push(e.from);
      }
      return { up, down };
    }

    // ---- drawing ----
    function draw(refit: boolean): void {
      if (!alive) return;
      graph = buildGraph();
      people.refresh();
      if (!graph.edges.length) {
        body.replaceChildren(empty("No dependencies yet",
          "Nothing in this team's open work waits for anything else. Add one here, or open a work item and use “Waits for” or “Blocks” under Dependencies in its panel.",
          app.actions.readOnly ? undefined : { label: "+ Dependency", onClick: () => void addDep() }));
        return;
      }
      if (!main.isConnected) body.replaceChildren(main);
      shown = filter();
      const order = [...shown.ids].map((id) => graph.nodes.get(id)!)
        .sort((a, b) => Number(a.outside) - Number(b.outside) || byOrder(a.item, b.item)).map((n) => n.id);
      const lay = layoutGraph(order, shown.edges);
      pos.clear();
      for (const [id, p] of lay.pos) pos.set(id, { x: PAD + p.col * COL, y: PAD + p.row * ROW });

      nodeEls.clear();
      edgeEls.length = 0;
      const nodeFrag = document.createDocumentFragment();
      for (const id of order) nodeFrag.append(nodeEl(graph.nodes.get(id)!));
      const edgeFrag = document.createDocumentFragment();
      for (const e of shown.edges) {
        const d = edgePath(e);
        const bad = graph.bad.has(edgeKey(e)) || lay.back.has(edgeKey(e));
        const el = svg("path", { class: bad ? "deps-edge bad" : "deps-edge", d, "marker-end": `url(#deps-arrow${bad ? "-bad" : ""})` });
        const hit = svg("path", { class: "deps-edge-hit", d, dataset: { from: e.from, to: e.to } }, svg("title", null, `#${e.to} waits for #${e.from}. Click to open or remove.`));
        edgeFrag.append(el, hit);
        edgeEls.push({ e, el, hit });
      }
      edgeLayer.replaceChildren(edgeFrag);
      nodeLayer.replaceChildren(nodeFrag);
      drawSide();
      if (!shown.ids.size) {
        nodeLayer.append(svg("text", { class: "deps-none", x: PAD, y: PAD + 20 }, "Nothing matches the filters."));
      }
      const focusAfter = pendingFocus != null && pos.has(pendingFocus) ? pendingFocus : null;
      if (focusAfter != null) pendingFocus = null;
      if (refit || !fitted) requestAnimationFrame(() => { fit(MIN_ZOOM); fitted = true; if (focusAfter != null) focusNode(focusAfter); });
      else { applyView(); if (focusAfter != null) focusNode(focusAfter); }
    }

    function nodeEl(n: GNode): SVGElement {
      const it = n.item;
      const p = pos.get(n.id)!;
      const title = it.title.length > 34 ? it.title.slice(0, 32) + "…" : it.title;
      const owner = it.assignedTo;
      const target = planDay(it.targetDate);
      const date = target != null ? `→ ${fmtDay(target, { day: "numeric", month: "short" })}` : "";
      const cls = ["deps-node", n.outside && "outside", n.problems.length && "bad", isDone(it) && "done", n.id === selected && "selected"].filter(Boolean).join(" ");
      const tip = [`#${it.id} ${it.title}`, `${it.type} · ${it.state}${owner ? " · " + owner.displayName : ""}`, n.outside ? "Outside the team" : "", ...n.problems].filter(Boolean).join("\n");
      const g = svg("g", { class: cls, transform: `translate(${p.x},${p.y})`, dataset: { id: n.id }, tabindex: 0, role: "button", "aria-label": `#${it.id} ${it.title}` },
        svg("title", null, tip),
        svg("g", { "clip-path": "url(#deps-clip)" },
          svg("rect", { class: "deps-card", width: W, height: H }),
          svg("rect", { width: 5, height: H, style: { fill: typeColor(ws.process, it.type) } })),
        svg("rect", { class: "deps-frame", width: W, height: H, rx: 8 }),
        svg("text", { class: "deps-id", x: 14, y: 18 }, `#${it.id}`, svg("tspan", { class: "deps-type" }, ` ${it.type}`)),
        svg("text", { class: "deps-title", x: 14, y: 36 }, title),
        svg("circle", { cx: 18, cy: 50, r: 4, style: { fill: stateColor(ws.process, it.type, it.state) } }),
        svg("text", { class: "deps-state", x: 27, y: 54 }, it.state, date ? svg("tspan", { class: n.problems.some((x) => x.includes("ends")) ? "deps-date bad" : "deps-date" }, `  ${date}`) : null),
        n.problems.length ? svg("text", { class: "deps-warn", x: W - 40, y: 18 }, "!") : null,
        owner ? svg("g", { class: "deps-owner" }, svg("circle", { cx: W - 18, cy: H - 16, r: 10 }), svg("text", { x: W - 18, y: H - 12 }, initials(owner.displayName))) : null,
        svg("circle", { class: "deps-handle", cx: W, cy: H / 2, r: 6 }, svg("title", null, "Drag onto another card: that card then waits for this one")));
      nodeEls.set(n.id, g);
      return g;
    }

    function edgePath(e: Edge): string {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2;
      const dx = x2 > x1 ? Math.max(40, (x2 - x1) / 2) : 90;
      return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    }

    function drawSide(): void {
      const g = graph;
      const item = (n: GNode, note: string): HTMLElement => h("li", null,
        h("button.deps-side-item", { title: `Show #${n.id} and open its details`, onclick: () => { focusNode(n.id); app.openItem(n.id); } },
          typeMark(ws, n.item.type), h("span.mono.muted", null, `#${n.id}`), h("span.t", null, n.item.title)),
        h("div.small.muted", null, note));
      const blocked = [...g.nodes.values()].filter((n) => !n.outside && !isDone(n.item) && n.preds.some((p) => !isDone(g.nodes.get(p)!.item)))
        .sort((a, b) => Number(b.item.category === "InProgress") - Number(a.item.category === "InProgress") || byOrder(a.item, b.item));
      const problems = [...g.nodes.values()].filter((n) => n.problems.some((p) => !p.startsWith("In a loop")));
      replace(side,
        g.cycles.length ? h("section.deps-sec.bad", null, h("h3", null, "Loops ", h("span.muted", null, g.cycles.length)),
          h("p.small.muted", null, "These wait for each other, so none can start. Remove one link."),
          h("ul", null, g.cycles.map((c) => h("li.mono.small", null, [...c, c[0]].map((x, i) => [i ? " → " : "", h("button.btn.link", { title: `Show #${x}`, onclick: () => { focusNode(x); app.openItem(x); } }, "#" + x)]))))) : null,
        h("section.deps-sec", null, h("h3", null, "Blocked now ", h("span.muted", null, blocked.length)),
          blocked.length ? h("ul", null, blocked.map((n) => item(n, "Waits for " + n.preds.filter((p) => !isDone(g.nodes.get(p)!.item)).map((p) => `#${p} (${g.nodes.get(p)!.item.state})`).join(", "))))
            : h("p.small.muted", null, "Nothing waits for open work.")),
        problems.length ? h("section.deps-sec", null, h("h3", null, "Problems ", h("span.muted", null, problems.length)),
          h("ul", null, problems.map((n) => item(n, n.problems.filter((p) => !p.startsWith("In a loop")).join("; "))))) : null);
    }

    // ---- view transform: pan and zoom ----
    function applyView(): void {
      root.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
      zoomLabel.textContent = Math.round(view.k * 100) + "%";
    }
    function bounds(): { w: number; h: number } {
      let w = 0, hh = 0;
      for (const p of pos.values()) { w = Math.max(w, p.x + W + PAD); hh = Math.max(hh, p.y + H + PAD); }
      return { w, h: hh };
    }
    /** Show the whole graph; minK keeps cards readable (the rest is reached by panning). */
    function fit(minK = 0.2): void {
      const r = canvas.getBoundingClientRect();
      const b = bounds();
      if (!r.width || !b.w) { view = { x: 0, y: 0, k: 1 }; applyView(); return; }
      const k = Math.max(minK, Math.min(1, r.width / b.w, r.height / b.h));
      // centred across, from the top down: a short graph does not float in the middle of a tall canvas
      view = { k, x: Math.max(0, (r.width - b.w * k) / 2), y: 0 };
      applyView();
    }
    function zoomAt(f: number, cx?: number, cy?: number): void {
      const r = canvas.getBoundingClientRect();
      const px = cx ?? r.width / 2, py = cy ?? r.height / 2;
      const k = Math.max(0.2, Math.min(2.5, view.k * f));
      view.x = px - ((px - view.x) * k) / view.k;
      view.y = py - ((py - view.y) * k) / view.k;
      view.k = k;
      applyView();
    }
    function focusNode(id: number): void {
      const p = pos.get(id);
      if (!p) return;
      const r = canvas.getBoundingClientRect();
      view.x = r.width / 2 - (p.x + W / 2) * view.k;
      view.y = r.height / 2 - (p.y + H / 2) * view.k;
      applyView();
      const el = nodeEls.get(id);
      el?.classList.remove("pulse");
      void (el as SVGGraphicsElement | undefined)?.getBBox?.();
      el?.classList.add("pulse");
    }
    const toGraph = (cx: number, cy: number): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
    };

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = canvas.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      } else {
        view.x -= e.shiftKey ? e.deltaY : e.deltaX;
        view.y -= e.shiftKey ? 0 : e.deltaY;
        applyView();
      }
    }, { passive: false });

    // ---- pointer: pan, link drag, click ----
    let gesture: { kind: "pan" | "link"; id: number; x: number; y: number; vx: number; vy: number; moved: boolean; pointerId: number; target: number | null } | null = null;

    canvasSvg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const t = e.target as Element;
      const handle = t.closest(".deps-handle");
      if (handle) {
        if (app.actions.readOnly) { toast("Read-only: you cannot change work items here.", { kind: "error" }); return; }
        const id = Number(handle.closest<SVGElement>(".deps-node")!.dataset.id);
        gesture = { kind: "link", id, x: e.clientX, y: e.clientY, vx: 0, vy: 0, moved: false, pointerId: e.pointerId, target: null };
        canvas.classList.add("linking");
      } else if (!t.closest(".deps-node, .deps-edge-hit")) {
        gesture = { kind: "pan", id: 0, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, pointerId: e.pointerId, target: null };
        canvas.classList.add("panning");
      } else return;
      e.preventDefault();
      try { canvasSvg.setPointerCapture(e.pointerId); } catch { /* a pointer the browser does not track */ }
      document.addEventListener("keydown", onKey, true);
    });
    canvasSvg.addEventListener("pointermove", (e) => {
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      if (Math.abs(e.clientX - gesture.x) + Math.abs(e.clientY - gesture.y) > 3) gesture.moved = true;
      if (gesture.kind === "pan") {
        view.x = gesture.vx + e.clientX - gesture.x;
        view.y = gesture.vy + e.clientY - gesture.y;
        applyView();
        return;
      }
      const a = pos.get(gesture.id)!;
      const p = toGraph(e.clientX, e.clientY);
      const x1 = a.x + W, y1 = a.y + H / 2;
      temp.setAttribute("d", `M${x1},${y1} C${x1 + 60},${y1} ${p.x - 60},${p.y} ${p.x},${p.y}`);
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<SVGElement>(".deps-node");
      const tid = over ? Number(over.dataset.id) : null;
      if (tid !== gesture.target) {
        if (gesture.target != null) nodeEls.get(gesture.target)?.classList.remove("link-target", "link-no");
        gesture.target = tid;
        if (tid != null && tid !== gesture.id) nodeEls.get(tid)?.classList.add(linkProblem(gesture.id, tid) ? "link-no" : "link-target");
      }
    });
    canvasSvg.addEventListener("pointerup", (e) => {
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      const g = gesture;
      endGesture();
      if (g.kind === "link" && g.target != null && g.target !== g.id) {
        const why = linkProblem(g.id, g.target);
        if (why) toast(why, { kind: "error" });
        else void app.actions.addDependency(g.id, g.target);
      }
    });
    canvasSvg.addEventListener("pointercancel", () => endGesture());
    function onKey(e: KeyboardEvent): void { if (e.key === "Escape" && gesture) { e.stopPropagation(); e.preventDefault(); endGesture(); } }
    function endGesture(): void {
      if (gesture?.target != null) nodeEls.get(gesture.target)?.classList.remove("link-target", "link-no");
      gesture = null;
      temp.setAttribute("d", "");
      canvas.classList.remove("panning", "linking");
      document.removeEventListener("keydown", onKey, true);
    }
    function linkProblem(pred: number, succ: number): string {
      if (pred === succ) return "";
      if (!ws.items.has(succ)) return `#${succ} is outside the team, so it cannot get a link here. Drag the other way, or open it in Azure DevOps.`;
      return loopOrTwice(pred, succ, graph.edges);
    }

    canvasSvg.addEventListener("click", (e) => {
      const t = e.target as Element;
      const hit = t.closest<SVGElement>(".deps-edge-hit");
      if (hit) {
        const from = Number(hit.dataset.from), to = Number(hit.dataset.to);
        menu(hit, [
          { label: `Open #${to} (waits)`, icon: "external", onClick: () => app.openItem(to) },
          { label: `Open #${from} (first)`, icon: "external", onClick: () => app.openItem(from) },
          "-",
          { label: "Remove this dependency", icon: "close", danger: true, disabled: !ws.items.has(to) && !ws.items.has(from) || app.actions.readOnly,
            onClick: () => void removeDependencyAny(app, from, to) },
        ]);
        return;
      }
      const node = t.closest<SVGElement>(".deps-node");
      if (node && !t.closest(".deps-handle")) app.openItem(Number(node.dataset.id));
    });
    canvasSvg.addEventListener("keydown", (e) => {
      const node = (e.target as Element).closest?.<SVGElement>(".deps-node");
      if (node && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); app.openItem(Number(node.dataset.id)); }
    });

    // ---- hover: the whole chain up and down ----
    let hot: number | null = null;
    const setHot = (id: number | null): void => {
      if (id === hot || gesture?.kind === "pan") return;
      hot = id;
      canvas.classList.toggle("hovering", id != null);
      if (id == null) {
        for (const el of nodeEls.values()) el.classList.remove("hl");
        for (const x of edgeEls) { x.el.classList.remove("hl"); x.el.setAttribute("marker-end", `url(#deps-arrow${x.el.classList.contains("bad") ? "-bad" : ""})`); }
        return;
      }
      const { up, down } = adjOf(shown.edges);
      const ups = reach(id, up);
      const downs = reach(id, down);
      const on = new Set([id, ...ups, ...downs]);
      for (const [nid, el] of nodeEls) el.classList.toggle("hl", on.has(nid));
      for (const x of edgeEls) {
        const lit = (x.e.to === id || ups.has(x.e.to)) && ups.has(x.e.from) || (x.e.from === id || downs.has(x.e.from)) && downs.has(x.e.to);
        x.el.classList.toggle("hl", lit);
        x.el.setAttribute("marker-end", `url(#deps-arrow${x.el.classList.contains("bad") ? "-bad" : lit ? "-hot" : ""})`);
      }
    };
    nodeLayer.addEventListener("pointerover", (e) => {
      const n = (e.target as Element).closest<SVGElement>(".deps-node");
      setHot(n ? Number(n.dataset.id) : null);
    });
    nodeLayer.addEventListener("pointerleave", () => setHot(null));

    // ---- life cycle ----
    let loading: Promise<void> | null = null;
    const refresh = async (refit: boolean): Promise<void> => {
      if (loading) await loading;
      loading = load();
      try { await loading; } finally { loading = null; }
      if (!alive) return;
      hot = null;
      draw(refit);
    };
    void refresh(true).catch((e) => { if (alive) body.replaceChildren(failed(e, () => { body.replaceChildren(spinner("Reading the links…")); void refresh(true); })); });
    const later = debounce(() => { void refresh(false).catch((e) => toast(String((e as Error).message ?? e), { kind: "error" })); }, 200);

    return {
      update() { fb.refresh(); later(); },
      select(id) {
        if (selected != null) nodeEls.get(selected)?.classList.remove("selected");
        selected = id;
        if (id != null) nodeEls.get(id)?.classList.add("selected");
      },
      unmount() { alive = false; endGesture(); },
    };
  },
};
