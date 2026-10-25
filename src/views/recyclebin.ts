// Recycle Bin: the project's deleted work items, with who deleted them and when. Restore brings one
// (or the ticked ones) back with their fields and links; Undo deletes them again.
import type { App, View } from "../app/context.ts";
import type { DeletedItem } from "../api/types.ts";
import { daysSince, fmtDate, fmtDays, inTeamAreas } from "../core/model.ts";

export { inTeamAreas };
import { h, icon } from "../ui/dom.ts";
import { avatar, confirm, empty, failed, spinner, typeMark } from "../ui/kit.ts";
import { pageBar } from "../ui/pagebar.ts";
import { sortable } from "../ui/sortable.ts";
import { prefs } from "../core/settings.ts";
import { segmented } from "../ui/kit.ts";

/** Does a deleted item match the words typed (id, title, type, who deleted it)? */
export function binMatch(d: DeletedItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `#${d.id} ${d.id} ${d.title} ${d.type} ${d.deletedBy?.displayName ?? ""} ${d.deletedBy?.uniqueName ?? ""}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Rows drawn at first, and added by each "Show more" */
export const BIN_PAGE = 100;

export const recycleBinView: View = {
  id: "recycle",
  title: "Recycle Bin",
  tab: "Recycle",
  icon: "trash",
  group: "check",
  about: "Deleted work items of the project: who deleted them and when. Restore brings them back with their fields and links.",
  mount(el, app: App) {
    const ws = app.ws;
    const ro = app.actions.readOnly;
    let list: DeletedItem[] | null = null;
    let error: unknown = null;
    let stopped = false;
    let token = 0;
    const picked = new Set<number>();
    // which deleted items: this team's (the default) or the whole project's; the area of each is read one by one, newest first, only as far as needed
    type Scope = "team" | "all";
    const SCOPE_KEY = "recycle.scope";
    let scope: Scope = prefs.get<Scope>(SCOPE_KEY, "team") === "all" ? "all" : "team";
    const areas = new Map<number, string | null>(); // null: could not be read
    const asking = new Set<number>();
    let limit = BIN_PAGE;
    const teamAreas = ws.settings.areas;
    const body = h("div.rb");
    const status = h("span.small.muted");
    const bar = pageBar(app, { search: { placeholder: "Search title, type, #id, who deleted it…", title: "Show only deleted items with these words", label: "Search the Recycle Bin", onChange: () => { limit = BIN_PAGE; draw(); } } });
    const restoreSel = h("button.btn", { type: "button", disabled: true, onclick: () => void restore([...picked]) }, icon("undo", 14), "Restore ticked") as HTMLButtonElement;
    const reread = h("button.btn", { type: "button", title: "Read the Recycle Bin again", onclick: () => void load() }, icon("refresh", 14), "Read again");
    const scopePick = segmented<Scope>([
      { value: "team", label: "My team", title: `Only items that were in ${ws.team}'s areas` },
      { value: "all", label: "Project", title: "Every deleted item of the project" },
    ], scope, (v) => { scope = v; prefs.set(SCOPE_KEY, v); limit = BIN_PAGE; draw(); });
    if (teamAreas.length) bar.line2.append(scopePick);
    if (!ro) bar.line2.append(restoreSel);
    bar.line2.append(reread);
    bar.end.append(status);
    const binUrl = `${app.api.ctx.orgUrl}${encodeURIComponent(ws.project)}/_workitems/recyclebin`;
    const note = h("p.small.muted.rb-note", null,
      "Deleted work items of the whole project stay here until someone deletes them for good in Azure DevOps. Restore brings an item back with its fields and links. ",
      h("a", { href: binUrl, target: "_blank", rel: "noopener" }, "Open in Azure DevOps"));
    el.append(bar.el, note, body);

    async function load(): Promise<void> {
      const mine = ++token;
      list = null;
      error = null;
      areas.clear();
      limit = BIN_PAGE;
      draw();
      try {
        const got = await app.api.deletedItems(ws.project);
        if (stopped || mine !== token) return;
        list = got;
      } catch (e) {
        if (stopped || mine !== token) return;
        error = e;
      }
      for (const id of [...picked]) if (!list?.some((d) => d.id === id)) picked.delete(id);
      draw();
    }

    async function restore(ids: number[]): Promise<void> {
      if (!list || !ids.length) return;
      const items = list.filter((d) => ids.includes(d.id));
      if (items.length > 1 && !(await confirm(`Restore ${items.length} items?`, "They come back with their fields and links.", "Restore"))) return;
      const done = await app.actions.restoreDeleted(items);
      if (stopped) return;
      list = list.filter((d) => !done.includes(d.id));
      for (const id of done) picked.delete(id);
      draw();
    }

    function draw(): void {
      restoreSel.disabled = !picked.size;
      restoreSel.lastChild!.textContent = picked.size ? `Restore ticked (${picked.size})` : "Restore ticked";
      if (error) { status.textContent = ""; body.replaceChildren(failed(error, () => void load())); return; }
      if (!list) { status.textContent = ""; body.replaceChildren(spinner("Reading the Recycle Bin…")); return; }
      const q = bar.search.query();
      const byTeam = scope === "team" && teamAreas.length > 0;
      const matching = list.filter((d) => binMatch(d, q));
      const mine = byTeam ? matching.filter((d) => { const a = areas.get(d.id); return typeof a === "string" && inTeamAreas(a, teamAreas); }) : matching;
      const shown = mine.slice(0, limit);
      const unread = byTeam ? matching.filter((d) => !areas.has(d.id)).length : 0;
      status.textContent = byTeam
        ? `${mine.length} of ${list.length} deleted · ${ws.team}${unread ? ` · reading areas… ${unread} left` : ""}`
        : q ? `${matching.length} of ${list.length}` : `${list.length} deleted`;
      if (!list.length) { body.replaceChildren(empty("The Recycle Bin is empty", "Work items deleted in this project show here, so they can be restored.")); return; }
      if (!shown.length) {
        if (unread) { body.replaceChildren(spinner(`Finding the items of ${ws.team}…`)); readAreas(matching, shown.length); return; }
        body.replaceChildren(empty("Nothing matches", byTeam ? `No deleted item of ${ws.team}${q ? " matches" : ""}. Choose “Project” to see every deleted item.` : "Change or clear the search."));
        return;
      }
      const all = h("input", {
        type: "checkbox", "aria-label": "Tick all shown", title: "Tick all shown",
        checked: shown.every((d) => picked.has(d.id)),
        onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; for (const d of shown) on ? picked.add(d.id) : picked.delete(d.id); draw(); },
      });
      const rows = shown.map((d) => {
        const days = daysSince(d.deletedDate);
        return h("tr", { dataset: { id: d.id } },
          ro ? null : h("td", null, h("input", {
            type: "checkbox", checked: picked.has(d.id), "aria-label": `Tick #${d.id} ${d.title}`,
            onchange: (e: Event) => { (e.target as HTMLInputElement).checked ? picked.add(d.id) : picked.delete(d.id); draw(); },
          })),
          h("td.mono.muted", null, `#${d.id}`),
          h("td", null, h("span.rb-type", null, typeMark(ws, d.type), d.type)),
          h("td.rb-title", null, d.title || h("span.muted", null, "(no title)")),
          h("td", null, d.deletedBy ? h("span.rb-who", null, avatar(ws.api, d.deletedBy, 20), d.deletedBy.displayName) : h("span.muted", null, "–")),
          h("td", { dataset: { sort: d.deletedDate }, title: fmtDate(d.deletedDate, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) },
            d.deletedDate ? (days < 1 ? "today" : `${fmtDays(days)} ago`) : "–"),
          ro ? null : h("td.rb-act", null, h("button.btn.small", { type: "button", onclick: () => void restore([d.id]), title: `Restore #${d.id}` }, icon("undo", 12), "Restore")));
      });
      const table = h("table.data.rb-table", null,
        h("thead", null, h("tr", null,
          ro ? null : h("th", { "data-xl-skip": "" }, all),
          h("th", null, "ID"), h("th", null, "Type"), h("th", null, "Title"), h("th", null, "Deleted by"), h("th", null, "Deleted"),
          ro ? null : h("th", { "data-xl-skip": "" }))),
        h("tbody", null, rows));
      const more = mine.length > shown.length || (byTeam && unread)
        ? h("div.rb-more", null,
          mine.length > shown.length ? h("button.btn", { type: "button", onclick: () => { limit += BIN_PAGE; draw(); } }, `Show ${Math.min(BIN_PAGE, mine.length - shown.length)} more`) : null,
          h("span.small.muted", null, `${shown.length} of ${mine.length}${byTeam && unread ? " so far" : ""} shown, newest first`))
        : null;
      body.replaceChildren(h("div.rb-scroll", null, sortable(table, "recycle")), more ?? "");
      if (byTeam) readAreas(matching, shown.length);
    }

    /** Read the areas of the next deleted items (newest first, eight at a time) until the rows to show are found. */
    function readAreas(matching: DeletedItem[], have: number): void {
      if (have >= limit) return;
      const next = matching.filter((d) => !areas.has(d.id) && !asking.has(d.id)).slice(0, 8);
      if (!next.length) return;
      for (const d of next) asking.add(d.id);
      void Promise.all(next.map(async (d) => {
        try { areas.set(d.id, (await app.api.deletedArea(ws.project, d.id)) ?? null); } catch { areas.set(d.id, null); }
        asking.delete(d.id);
      })).then(() => { if (!stopped) draw(); });
    }

    void load();
    return {
      unmount() { stopped = true; },
    };
  },
};
