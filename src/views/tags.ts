// Tags: tidy the project's tags (likely duplicates, unused by the team, rarely used): count, rename,
// merge and delete them.
import type { App, View } from "../app/context.ts";
import type { Tag } from "../api/types.ts";
import { duplicateTagGroups, replaceTag } from "../core/health.ts";
import { prefs } from "../core/settings.ts";
import { h } from "../ui/dom.ts";
import { undoAll } from "../ui/actions.ts";
import { keepFocus } from "../ui/focuskeep.ts";
import { sortable } from "../ui/sortable.ts";
import { confirm, dialog, empty, errorText, menu, segmented, spinner, toast } from "../ui/kit.ts";
import { pageBar } from "../ui/pagebar.ts";
import { tagChip } from "../ui/tagchip.ts";
import { runLimited } from "./prlogic.ts";

type TagFilter = "dups" | "unused" | "rare" | "all";

/** Tags used on this many of the team's items or fewer are "rarely used". */
const RARE = 2;
/** Duplicate groups this small are counted in the project at once; at most this many tags per page view. */
const AUTO_GROUP = 4;
const AUTO_MAX = 40;
/** Rows (or duplicate groups) drawn at first, and added by each "Show more" */
const PAGE = 100;

const lower = (s: string): string => s.toLowerCase();
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

export const tagsView: View = {
  id: "tags",
  title: "Tags",
  icon: "tag",
  group: "check",
  about: "Tidy the project's tags: likely duplicates, tags the team does not use, and rarely used ones. Count, rename, merge or delete them.",
  mount(el, app) {
    const pane = h("div.au-pane");
    const bar = pageBar(app, { search: { placeholder: "Find a tag", title: "Show only tags containing this text", label: "Find a tag", onChange: () => tags.redraw() } });
    const tags = tagsAudit(app, pane, bar.search.query);
    el.append(bar.el, pane);
    tags.start();
    return {
      update() { tags.redraw(); },
      unmount() { tags.stop(); },
    };
  },
};

// ---------- tags ----------

function tagsAudit(app: App, pane: HTMLElement, query: () => string): { start(): void; redraw(): void; stop(): void } {
  const ws = app.ws;
  const project = ws.project;
  let list: Tag[] | null = null;
  let loadError: unknown = null;
  let started = false;
  /** the page was left: nothing more is read for it */
  let stopped = false;
  let filter = prefs.get<TagFilter>("audits-tag-filter", "dups");
  /** the tags the team uses (the default), or every tag of the project: a choice you make on purpose */
  let scope: "team" | "all" = prefs.get<string>("audits-tag-scope", "team") === "all" ? "all" : "team";
  let limit = PAGE;
  /** project-wide counts, read only for tags the person asks about */
  const projectCount = new Map<string, number | "loading">();
  /** renamed here: old name → new name, until the items are read again */
  const renamed = new Map<string, string>();
  /** when the team's items were read at the time of the renames */
  let renamedAt = ws.loadedAt;
  const ro = app.actions.readOnly;
  /** tags counted (or tried) without a click: never asked twice */
  const autoTried = new Set<string>();
  const byNameSort = (): void => { list?.sort((a, b) => a.name.localeCompare(b.name)); };
  /** read the tags again without the spinner (after an Undo): the list stays until the new one is there */
  const reload = async (): Promise<void> => {
    try { list = (await app.api.tags(project)).sort((a, b) => a.name.localeCompare(b.name)); } catch { /* keep what is shown */ }
    if (list) for (const t of list) renamed.delete(lower(t.name));
    redraw();
  };

  const load = async (): Promise<void> => {
    list = null;
    loadError = null;
    redraw();
    try { list = (await app.api.tags(project)).sort((a, b) => a.name.localeCompare(b.name)); } catch (e) { loadError = e; }
    // an old name that exists again is a new tag: stop counting it as the renamed one
    if (list) for (const t of list) renamed.delete(lower(t.name));
    redraw();
  };

  const teamCounts = (): Map<string, number> => {
    const m = new Map<string, number>();
    // the items were read again, so they carry the new names already
    if (ws.loadedAt !== renamedAt) { renamed.clear(); renamedAt = ws.loadedAt; }
    for (const it of ws.items.values()) for (const t of it.tags) {
      const k = lower(renamed.get(lower(t)) ?? t);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };

  /** look-alike groups, worked out again only when the tags or their counts change (not on each key typed) */
  let dupMemo: { key: string; groups: string[][] } | null = null;
  const lookAlikes = (names: string[], counts: Map<string, number>): string[][] => {
    const uses = (n: string): number => counts.get(lower(n)) ?? 0;
    const key = names.map((n) => `${n}\u0001${uses(n)}`).join("\u0000");
    if (dupMemo?.key !== key) dupMemo = { key, groups: duplicateTagGroups(names, uses) };
    return dupMemo.groups;
  };

  const countIn = async (names: string[], quiet = false): Promise<void> => {
    const todo = names.filter((n) => projectCount.get(lower(n)) === undefined);
    if (!todo.length) return;
    if (stopped) return;
    for (const n of todo) projectCount.set(lower(n), "loading");
    redraw();
    let failed: unknown = null;
    await runLimited(todo, 4, async (n) => {
      if (stopped) return;
      try { projectCount.set(lower(n), (await app.api.query(project, { tag: n })).length); } catch (e) { projectCount.delete(lower(n)); failed ??= e; }
    });
    if (failed && !quiet) toast(errorText(failed), { kind: "error" });
    redraw();
  };

  const projectCell = (t: Tag): HTMLElement => {
    const c = projectCount.get(lower(t.name));
    if (c === "loading") return h("span.muted", { title: "Counting…" }, "…");
    if (typeof c === "number") return h("span", { title: "Work items with this tag in the whole project" }, String(c));
    return h("button.btn.link.small", { title: "Count the work items with this tag in the whole project", "data-fk": `count:${t.id}`, onclick: () => void countIn([t.name]) }, "Count");
  };

  // ----- actions -----

  const rename = async (t: Tag): Promise<void> => {
    if (ro) return;
    const input = h("input.input", { value: t.name, "aria-label": "New name", title: "The new name of the tag" });
    const asked = dialog("Rename tag", h("div.form", null,
      h("p", null, "This renames the tag everywhere in the project: on every work item of every team, and in queries that use it."),
      h("label", null, h("span", null, "New name"), input)), [
      { label: "Cancel", value: "" },
      {
        label: "Rename everywhere", primary: true, value: "ok",
        onClick: async () => {
          const name = input.value.trim().replace(/;/g, "");
          if (!name || name === t.name) { input.focus(); return false; }
          const clash = list?.find((x) => x.id !== t.id && lower(x.name) === lower(name));
          if (clash && lower(t.name) !== lower(name)) { toast(`The tag "${clash.name}" exists already. Use "Merge into" instead.`, { kind: "error" }); return false; }
          await app.actions.renameTag(project, t.id, name, t.name);
          if (ws.loadedAt !== renamedAt) { renamed.clear(); renamedAt = ws.loadedAt; }
          renamed.set(lower(t.name), name);
          if (projectCount.has(lower(t.name))) { projectCount.set(lower(name), projectCount.get(lower(t.name))!); projectCount.delete(lower(t.name)); }
          toast(`Renamed "${t.name}" to "${name}". Other views show the new name after the page reloads.`, { kind: "ok" });
          t.name = name;
          byNameSort();
          return true;
        },
      },
    ]);
    // typing replaces the old name
    input.select();
    if ((await asked) === "ok") redraw();
  };

  /**
   * Merge tags into one: on the team's loaded items each is replaced by `into`; a tag no other item
   * has any more is deleted. One message with one Undo puts the items' tags back (a deleted tag
   * comes back with them).
   */
  const merge = async (froms: Tag[], into: Tag): Promise<void> => {
    if (ro) { toast("Read-only: you cannot change work items here.", { kind: "error" }); return; }
    let found: { tag: Tag; ids: number[] }[];
    try { found = await Promise.all(froms.map(async (tag) => ({ tag, ids: await app.api.query(project, { tag: tag.name }) }))); } catch (e) { toast(errorText(e), { kind: "error" }); return; }
    const inTeam = [...new Set(found.flatMap((f) => f.ids.filter((id) => ws.items.has(id))))];
    const outsideOf = (f: { ids: number[] }): number => f.ids.filter((id) => !ws.items.has(id)).length;
    const kept = found.filter((f) => outsideOf(f) > 0);
    const names = froms.map((t) => `"${t.name}"`).join(", ");
    const ok = (await dialog(froms.length === 1 ? `Merge "${froms[0].name}" into "${into.name}"` : `Merge ${froms.length} tags into "${into.name}"`, h("div", null,
      h("p", null, found.map((f) => `${plural(f.ids.length, "work item")} in the project ${f.ids.length === 1 ? "has" : "have"} "${f.tag.name}".`).join(" ")),
      h("ul", null,
        h("li", null, `${plural(inTeam.length, "item")} of the team's loaded work: ${names} ${froms.length === 1 ? "is" : "are"} replaced by "${into.name}".`),
        kept.map((f) => h("li", null, `${plural(outsideOf(f), "item")} outside the team's loaded work keep "${f.tag.name}" (they cannot be changed here), so it is not deleted.`)),
        kept.length < found.length ? h("li", null, `Then ${found.filter((f) => !kept.includes(f)).map((f) => `"${f.tag.name}"`).join(", ")} ${found.length - kept.length === 1 ? "is" : "are"} deleted from the project.`) : null),
      h("p.small.muted", null, "The message afterwards has Undo.")),
    [{ label: "Cancel", value: "" }, { label: inTeam.length ? `Change ${plural(inTeam.length, "item")}` : "Delete the tag", primary: true, value: "ok" }])) === "ok";
    if (!ok) return;
    let failed = 0;
    let firstError: unknown = null;
    const undos: (() => Promise<unknown>)[] = [];
    toast(`Merging: changing ${plural(inTeam.length, "item")}…`);
    await runLimited(inTeam, 4, async (id) => {
      const it = ws.get(id);
      if (!it) return;
      let tags = it.tags;
      for (const f of froms) tags = replaceTag(tags, f.name, into.name);
      try {
        const r = await app.actions.writer.setFields(id, [{ field: "System.Tags", value: tags.join("; ") }]);
        if (r.undo) undos.push(r.undo);
      } catch (e) { failed++; firstError ??= e; }
    });
    const changed = undos.length;
    const gone: Tag[] = [];
    let deleteError: unknown = null;
    if (!failed) {
      for (const f of found) {
        if (outsideOf(f)) continue;
        try { await app.actions.deleteTag(project, f.tag.id, f.tag.name); gone.push(f.tag); } catch (e) { deleteError ??= e; }
      }
    }
    // the list changes in place: no reading again, the scroll and the focus stay
    for (const t of froms) projectCount.delete(lower(t.name));
    projectCount.delete(lower(into.name));
    if (list) list = list.filter((t) => !gone.includes(t));
    redraw();
    // Undo puts every item's tags back; a deleted tag is made again by that
    const all = undoAll(undos);
    const undo = all ? async () => { await all(); await reload(); } : undefined;
    if (failed) toast(`${plural(changed, "item")} changed, ${failed} refused: ${errorText(firstError)}`, { kind: "error", undo });
    else if (deleteError) toast(`${plural(changed, "item")} changed, but a tag could not be deleted: ${errorText(deleteError)}`, { kind: "error", undo });
    else if (kept.length) toast(`${plural(changed, "item")} changed. ${kept.map((f) => `"${f.tag.name}"`).join(", ")} stays on items outside the team.`, { kind: "ok", undo });
    else toast(`Merged ${names} into "${into.name}" (${plural(changed, "item")} changed).`, { kind: "ok", undo });
  };

  const remove = async (t: Tag): Promise<void> => {
    if (ro) return;
    let n: number | null = null;
    try { n = (await app.api.query(project, { tag: t.name })).length; } catch { /* count unknown */ }
    const text = n == null ? `Delete "${t.name}"? It is removed from every work item in the project that has it.`
      : n ? `Delete "${t.name}"? It is removed from the ${plural(n, "work item")} in the project that ${n === 1 ? "has" : "have"} it.`
        : `Delete "${t.name}"? No work item in the project uses it.`;
    if (!(await confirm("Delete tag", text, "Delete", true))) return;
    // the team's items with the tag, to put it back with Undo (others cannot be changed here)
    const had = [...ws.items.values()].filter((it) => it.tags.some((x) => lower(x) === lower(t.name))).map((it) => it.id);
    try {
      await app.actions.deleteTag(project, t.id, t.name);
      projectCount.delete(lower(t.name));
      if (list) list = list.filter((x) => x !== t);
      redraw();
      const others = n != null ? n - had.length : 0;
      const undo = had.length ? async () => {
        // read each item again first: deleting the tag changed it in Azure DevOps
        await runLimited(had, 4, async (id) => {
          const it = await ws.refresh(id);
          if (!it || it.tags.some((x) => lower(x) === lower(t.name))) return;
          await app.actions.writer.setFields(id, [{ field: "System.Tags", value: [...it.tags, t.name].join("; ") }]);
        });
        await reload();
      } : undefined;
      toast(had.length
        ? `Deleted the tag "${t.name}". Undo puts it back on the team's ${plural(had.length, "item")}${others > 0 ? ` (not on the ${others} outside the team)` : ""}.`
        : `Deleted the tag "${t.name}".`, { kind: "ok", undo });
    } catch (e) { toast(errorText(e), { kind: "error" }); }
  };

  // read-only: no Merge, Rename or Delete (counting still works)
  // focus keys: after a change the focus stays on the same button, or the next row's
  const fk = (act: string, t: Tag): Record<string, string> => ({ "data-fk": `${act}:${t.id}`, "data-fg": act, "data-fe": "chips" });
  const actions = (t: Tag, mergeTargets: Tag[]): HTMLElement => ro ? h("span.au-acts") : h("span.au-acts", null,
    mergeTargets.length ? h("button.btn.small", {
      title: `Replace "${t.name}" with another tag on the items, then delete "${t.name}"`, ...fk("merge", t),
      onclick: (e: Event) => {
        const b = e.currentTarget as HTMLElement;
        menu(b, mergeTargets.map((m) => ({ label: m.name, icon: "chevron", onClick: () => { b.focus(); void merge([t], m); } })));
      },
    }, "Merge into…") : null,
    h("button.btn.small", { title: "Rename this tag everywhere in the project", ...fk("rename", t), onclick: () => void rename(t) }, "Rename"),
    h("button.btn.small.danger", { title: "Delete this tag from the project (asks first)", ...fk("delete", t), onclick: () => void remove(t) }, "Delete"));

  const table = (rows: Tag[], counts: Map<string, number>, mergeTargets: (t: Tag) => Tag[]): HTMLElement => sortable(h("table.data.au-table", null,
    h("thead", null, h("tr", null,
      h("th", null, "Tag"),
      h("th.num", { title: "The team's loaded items with this tag" }, "Team items"),
      h("th.num", { title: "Every work item with this tag in the project (counted when you ask)" }, "Project items"),
      h("th", null, ""))),
    h("tbody", null, rows.map((t) => h("tr", null,
      h("td", null, tagChip(t.name, `${t.name}: click to change its colour`)),
      h("td.num", null, String(counts.get(lower(t.name)) ?? 0)),
      h("td.num", null, projectCell(t)),
      h("td", null, actions(t, mergeTargets(t))))))), "au-tags");

  function redraw(): void {
    if (!started) return;
    if (loadError) {
      pane.replaceChildren(h("div.empty.error", null, h("h3", null, "Could not read the tags"), h("p", null, errorText(loadError)),
        h("button.btn", { title: "Read the tags again", onclick: () => void load() }, "Try again")));
      return;
    }
    if (!list) { pane.replaceChildren(spinner("Reading the project's tags…")); return; }
    const back = keepFocus(pane);
    const all = list;
    const counts = teamCounts();
    const byName = new Map(all.map((t) => [t.name, t]));
    const usedByTeam = (t: Tag): boolean => (counts.get(lower(t.name)) ?? 0) > 0;
    // "My team": groups with a tag the team uses, and the tags it uses (unused and rarely used are about the team already)
    const dupGroups = lookAlikes(all.map((t) => t.name), counts).map((g) => g.map((n) => byName.get(n)!)).filter((g) => scope === "all" || g.some(usedByTeam));
    const pool = scope === "all" ? all : all.filter(usedByTeam);
    const unused = all.filter((t) => !counts.get(lower(t.name)));
    const rare = all.filter((t) => { const c = counts.get(lower(t.name)) ?? 0; return c > 0 && c <= RARE; });

    const chips = h("div.au-chips", null, ([
      ["dups", "Likely duplicates", dupGroups.length, "Groups of tags that differ only in case, spaces, hyphens, one letter, or singular and plural"],
      ["unused", "Not used by the team", unused.length, "Tags on none of the team's loaded items (other teams may use them)"],
      ["rare", "Rarely used", rare.length, `Tags on only 1 or ${RARE} of the team's loaded items`],
      ["all", scope === "all" ? "All tags" : "Tags of the team", pool.length, scope === "all" ? "Every tag of the project" : "The tags on the team's loaded items"],
    ] as [TagFilter, string, number, string][]).map(([v, label, n, title]) => h("button.chip", {
      "aria-pressed": String(filter === v), title, "data-fk": v === filter ? "chips" : `chip:${v}`,
      onclick: () => { filter = v; limit = PAGE; prefs.set("audits-tag-filter", v); redraw(); },
    }, label, h("b", null, String(n)))),
    segmented<"team" | "all">([
      { value: "team", label: "My team", title: "Tags the team uses, and duplicate groups that include one of them" },
      { value: "all", label: "Whole project", title: "Every tag of the project, also those no team item has" },
    ], scope, (v) => { scope = v; limit = PAGE; prefs.set("audits-tag-scope", v); redraw(); }));

    const moreRow = (n: number, of: number): HTMLElement => h("div.au-more", null,
      h("button.btn", { title: `Show ${Math.min(PAGE, of - n)} more`, "data-fk": "more", onclick: () => { limit += PAGE; redraw(); } }, `Show ${Math.min(PAGE, of - n)} more`),
      h("span.small.muted", null, `${n} of ${of} shown`));
    const listHost = h("div.au-list");
    const drawList = (): void => {
      const qq = query();
      const ok = (t: Tag): boolean => !qq || lower(t.name).includes(qq);
      let content: HTMLElement | HTMLElement[];
      if (filter === "dups") {
        const found = dupGroups.filter((g) => g.some(ok));
        const groups = found.slice(0, limit);
        // small groups are counted in the whole project at once (a few queries, once each)
        const auto = groups.filter((g) => g.length <= AUTO_GROUP).flatMap((g) => g).filter((t) => !autoTried.has(lower(t.name))).slice(0, Math.max(0, AUTO_MAX - autoTried.size));
        if (auto.length) { for (const t of auto) autoTried.add(lower(t.name)); setTimeout(() => void countIn(auto.map((t) => t.name), true)); }
        content = groups.length ? groups.map((g) => h("section.card-box.au-dup", null,
          h("div.au-dup-head", null,
            h("h3", null, g.map((t) => t.name).join(" · ")),
            h("span.spacer"),
            g.some((t) => projectCount.get(lower(t.name)) === undefined) ? h("button.btn.small", {
              title: "Count how many work items in the project use each of these tags", "data-fk": `countg:${g[0].id}`, "data-fg": "countg", "data-fe": "chips",
              onclick: () => void countIn(g.map((t) => t.name)),
            }, "Count use") : null,
            ro ? null : h("button.btn.small", {
              title: "Keep one of these tags: the others are replaced by it on the items, then deleted", "data-fk": `mergeg:${g[0].id}`, "data-fg": "mergeg", "data-fe": "chips",
              onclick: (e: Event) => {
                const b = e.currentTarget as HTMLElement;
                menu(b, g.map((m) => {
                  const c = projectCount.get(lower(m.name));
                  return { label: typeof c === "number" ? `${m.name} (${plural(c, "item")})` : m.name, icon: "chevron", onClick: () => { b.focus(); void merge(g.filter((x) => x !== m), m); } };
                }));
              },
            }, "Merge group into…")),
          table(g, counts, (t) => g.filter((x) => x !== t))))
          : [empty("No likely duplicates", qq ? "No group matches the search." : scope === "team" ? "No two of the team's tags look alike. Choose “Whole project” to look at every tag." : "No two tags look alike.")];
        if (found.length > groups.length) content = [...content, moreRow(groups.length, found.length)];
      } else {
        const found = (filter === "unused" ? unused : filter === "rare" ? rare : pool).filter(ok);
        const rows = found.slice(0, limit);
        const note = filter === "unused" ? h("p.small.muted", null, "Not on the team's loaded work. Count the project use before you delete one: another team may use it.") : null;
        content = rows.length ? [h("div.card-box", null, note, table(rows, counts, () => [])), ...(found.length > rows.length ? [moreRow(rows.length, found.length)] : [])] : [empty("No tags here", qq ? "No tag matches the search." : undefined)];
      }
      listHost.replaceChildren(...(Array.isArray(content) ? content : [content]));
    };
    drawList();
    pane.replaceChildren(chips, ...(ro ? [h("p.small.muted", null, "Read-only: tags cannot be renamed, merged or deleted here.")] : []), listHost);
    back(pane.querySelector<HTMLElement>("[data-fk=chips]"));
  }

  return {
    start() { if (!started) { started = true; void load(); } },
    redraw,
    stop() { stopped = true; },
  };
}
