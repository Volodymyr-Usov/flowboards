// The team chooser: a project list, a search box, then "Your teams" and "All teams". Used as the first
// page (no team saved yet) and in the popup of the team button. Teams are read at once, next to the
// projects; when the project changes, only the latest answer counts. Arrows and Enter work from the box.
import type { Api } from "../api/api.ts";
import type { Team } from "../api/types.ts";
import { teamGroups } from "../core/teampick.ts";
import { h } from "./dom.ts";
import { errorText } from "./kit.ts";

export interface TeamChooserOpts {
  api: Api;
  project: string;
  /** the team open now (marked in the list) */
  team?: string;
  onPick: (project: string, team: string) => void;
  /** the full page (first open) rather than the popup */
  page?: boolean;
}

let uid = 0;

export function teamChooser(o: TeamChooserOpts): { el: HTMLElement; focus: () => void } {
  const id = `tc${++uid}`;
  let project = o.project;
  let all: Team[] = [];
  let mine: Team[] = [];
  let mineFailed = "";
  let state: "loading" | "ready" | "error" = "loading";
  let error = "";
  let active = 0;
  let asked = 0;

  const projSel = h("select.input.tc-project", { "aria-label": "Project", title: "The project whose teams are listed" }, h("option", { value: project }, project));
  const projNote = h("div.small.muted.tc-note");
  const search = h("input.input.tc-search", {
    type: "search", placeholder: "Search teams", "aria-label": "Search teams", autocomplete: "off",
    role: "combobox", "aria-controls": `${id}-list`, "aria-expanded": "true", title: "Type part of a team's name or description; arrows and Enter pick one",
  });
  const status = h("div.tc-status", { role: "status" });
  const list = h("div.tc-list", { id: `${id}-list`, role: "listbox", "aria-label": "Teams" });

  const options = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>(".tc-team")];
  const setActive = (i: number): void => {
    const opts = options();
    if (!opts.length) { search.removeAttribute("aria-activedescendant"); return; }
    active = Math.max(0, Math.min(i, opts.length - 1));
    opts.forEach((x, k) => x.setAttribute("aria-selected", String(k === active)));
    search.setAttribute("aria-activedescendant", opts[active].id);
    opts[active].scrollIntoView({ block: "nearest" });
  };

  function render(): void {
    if (state === "loading") {
      status.replaceChildren(h("span.spin"), `Reading the teams of ${project}…`);
      list.replaceChildren();
      return;
    }
    if (state === "error") {
      status.replaceChildren(h("span.warn-text", null, `The teams of ${project} could not be read: ${error}`), " ",
        h("button.btn.small", { type: "button", onclick: () => void load(project) }, "Try again"));
      list.replaceChildren();
      return;
    }
    const groups = teamGroups(all, mine, search.value);
    const query = search.value.trim();
    status.replaceChildren(
      !all.length ? "This project has no teams." : !groups.length ? `No team matches “${query}”.` : `${all.length} team${all.length === 1 ? "" : "s"}${query ? `, ${groups.reduce((n, g) => n + g.teams.length, 0)} shown` : ""}`,
      mineFailed ? h("span.warn-text", null, ` Your own teams could not be read: ${mineFailed}`) : "");
    let k = 0;
    list.replaceChildren(...groups.map((g) => h("div.tc-group", { role: "group", "aria-label": g.title },
      h("div.tc-head", null, g.title, h("span.muted", null, ` ${g.teams.length}`)),
      g.teams.map((t) => {
        const now = project === o.project && t.name === o.team;
        return h(`div.tc-team${now ? ".now" : ""}`, {
          id: `${id}-o${k++}`, role: "option", "aria-selected": "false", dataset: { team: t.name },
          title: now ? `${t.name} is open now` : `Open ${t.name}`,
        }, h("span.tc-name", null, t.name, now ? h("span.tc-now", null, "open now") : null),
        t.description ? h("span.tc-desc", null, t.description) : null);
      }))));
    setActive(0);
  }

  async function load(p: string): Promise<void> {
    const mineNow = ++asked;
    state = "loading";
    render();
    const [a, m] = await Promise.allSettled([o.api.teams(p), o.api.teams(p, { mine: true })]);
    if (mineNow !== asked) return; // the project changed meanwhile
    if (a.status === "rejected") { state = "error"; error = errorText(a.reason); render(); return; }
    all = a.value;
    mine = m.status === "fulfilled" ? m.value : [];
    mineFailed = m.status === "rejected" ? errorText(m.reason) : "";
    state = "ready";
    render();
  }

  const pick = (el: HTMLElement | undefined): void => { if (el?.dataset.team) o.onPick(project, el.dataset.team); };

  list.addEventListener("click", (e) => pick((e.target as HTMLElement).closest<HTMLElement>(".tc-team") ?? undefined));
  list.addEventListener("mousemove", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".tc-team");
    if (el) { const i = options().indexOf(el); if (i !== active) setActive(i); }
  });
  search.addEventListener("input", () => render());
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); setActive(options().length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); pick(options()[active]); }
  });
  projSel.addEventListener("change", () => { project = projSel.value; search.value = ""; void load(project); });

  // projects and teams are read side by side
  void load(project);
  o.api.projects().then((ps) => {
    if (!ps.some((p) => p.name === project)) ps = [{ id: "", name: project }, ...ps];
    projSel.replaceChildren(...ps.map((p) => h("option", { value: p.name, selected: p.name === project }, p.name)));
  }, (e) => { projNote.textContent = `Other projects could not be read: ${errorText(e)}`; });

  const el = h(`div.team-chooser${o.page ? ".tc-page" : ""}`, null,
    h("label.tc-field", null, h("span", null, "Project"), projSel), projNote,
    h("label.tc-field", null, h("span", null, "Team"), search),
    status, list);
  return { el, focus: () => search.focus() };
}
