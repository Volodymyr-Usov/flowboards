// The frame around the views: the top bar (the view tabs on the left; the team picker, theme, Excel,
// Copy and settings on the right) and the area where the chosen view draws. Lines 2 and 3 belong to
// each view (src/ui/pagebar.ts). One Workspace per page load; picking another team reloads the page on that team.
import type { Api } from "../api/api.ts";
import type { HostContext } from "../host/sdk.ts";
import { Ai } from "../core/ai.ts";
import { ChangeLog } from "../core/changelog.ts";
import { prefs, resetLayout, Settings } from "../core/settings.ts";
import type { SavedTeams } from "../core/teampick.ts";
import { isOversized, openStoryCount, withChoice } from "../core/teampick.ts";
import { Workspace } from "../core/workspace.ts";
import { Writer } from "../core/writes.ts";
import { Actions } from "../ui/actions.ts";
import { h, icon } from "../ui/dom.ts";
import { confirm, errorText, failed, menu, popup, spinner, toast, closePopup } from "../ui/kit.ts";
import { teamChooser } from "../ui/teampicker.ts";
import { pageBar } from "../ui/pagebar.ts";
import { resizeTablesIn } from "../ui/resizable.ts";
import { styleButton } from "../ui/stylebutton.ts";
import { createPanel } from "../ui/panel.ts";
import { setImageHost } from "../ui/sanitize.ts";
import { copyRows, copyRowsOf, excelDialog, excelIcon, shownTables, tableSheets } from "../ui/tableexport.ts";
import type { Sheet } from "../ui/xlsx.ts";
import { getService } from "../host/sdk.ts";
import { VIEWS } from "../views/index.ts";
import { discardDrafts, draftTabs, initDrafts, onDraftsChange } from "../views/settings.ts";
import type { App, View, ViewHandle } from "./context.ts";
import { startScheduler } from "./scheduler.ts";
import { StyleService } from "./style.ts";
import { tabOrder } from "../core/workstyle.ts";
import { installHints } from "../ui/hints.ts";
import { applyBlocks, blk, installCrosses, onBlocksChange, setTabBlocks, tabOff } from "../ui/blocks.ts";
import { scopeFilters } from "../ui/filterbar.ts";

export type Theme = "auto" | "light" | "dark";

/** The person's colour choice: like Azure DevOps (light or dark as set there) unless they chose otherwise (kept in this browser). */
export const THEME_KEY = "colorTheme";
export function savedTheme(): Theme { return prefs.get<Theme>(THEME_KEY, "auto"); }
const THEME_LABEL: Record<Theme, string> = { dark: "Dark", auto: "Like Azure DevOps", light: "Light" };
const THEME_ICON: Record<Theme, string> = { dark: "moon", auto: "contrast", light: "sun" };

/** The id of the item open in the details panel, from the address (`#board?item=12`), or null. */
export function itemInHash(hash: string): number | null {
  const n = Number(new URLSearchParams(hash.split("?")[1] ?? "").get("item"));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The address with the open item put in (or taken out); the view and its other choices stay. */
export function hashWithItem(hash: string, id: number | null): string {
  const [view, query] = hash.replace(/^#/, "").split("?");
  const q = new URLSearchParams(query ?? "");
  if (id) q.set("item", String(id)); else q.delete("item");
  const s = q.toString();
  return `#${view}${s ? "?" + s : ""}`;
}

export function applyTheme(t: Theme, hostDark?: boolean): void {
  const dark = t === "dark" || (t === "auto" && (hostDark ?? window.matchMedia("(prefers-color-scheme: dark)").matches));
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export async function startApp(api: Api, host: HostContext | null, project: string, team: string, opts: { readOnly?: boolean } = {}): Promise<App> {
  setImageHost(api.ctx.orgUrl);
  const settings = new Settings(api);
  const log = new ChangeLog();
  const root = document.getElementById("app")!;
  root.replaceChildren(h("div.boot", null, spinner(`Loading ${team}…`)));

  await Promise.all([settings.loadUser().catch(() => {}), settings.loadShared(project).catch(() => {})]);
  const ws = new Workspace(api, project, team, { closedDays: settings.shared.closedDays });
  ws.setTeamTweaks(settings.shared.teamPeople?.[team]);
  const writer = new Writer(ws, log, () => settings.shared.rules, api.ctx.me);
  writer.checklistDefaults = (type) => settings.shared.checklists?.[type] ?? [];
  const actions = new Actions(writer);
  actions.readOnly = Boolean(opts.readOnly);
  const ai = new Ai(() => settings.user.ai);
  const style = new StyleService(api, ws, settings, log);

  let current: { view: View; handle: ViewHandle | null; el: HTMLElement } | null = null;
  // tabindex -1: "Skip to content" and a new page move the focus here
  const main = h("main.view-host", { id: "view", tabindex: -1 });
  initDrafts(`${api.ctx.orgName}/${project}`);
  // each team keeps its own filters and person chips
  scopeFilters(project, team, api.ctx.orgName);
  // in Azure DevOps this page is a frame and the browser's address is the host's: the place (view and
  // open item) is copied into the host's hash, and read back from it when the page starts
  type HostNav = { getHash?: () => Promise<string>; replaceHash?: (hash: string) => unknown };
  const hostNav: Promise<HostNav | null> = host ? getService<HostNav>("ms.vss-features.host-navigation-service").catch(() => null) : Promise.resolve(null);
  const mirrorHash = (): void => { void hostNav.then((n) => n?.replaceHash?.(location.hash.replace(/^#/, ""))).catch(() => {}); };
  if (host && !location.hash) {
    const late = new Promise<string>((r) => setTimeout(() => r(""), 1500));
    const got = (await Promise.race([hostNav.then((n) => n?.getHash?.() ?? ""), late]).catch(() => "")).replace(/^#/, "");
    if (/^[a-z]+(\?|$)/i.test(got)) history.replaceState(history.state, "", "#" + got);
  }

  const app: App = {
    api, ws, settings, log, actions, ai, host, style,
    openItem: (id) => panel.open(id),
    openId: () => panel.current(),
    closeItem: () => panel.close(),
    navigate: (view, params = {}) => {
      const q = new URLSearchParams(params).toString();
      const hash = `#${view}${q ? "?" + q : ""}`;
      if (location.hash !== hash) location.hash = hash;
      else void route();
    },
  };
  const panel = createPanel(app);
  actions.onOpen = (id) => panel.open(id);
  // the panel would cover the list: close it first
  actions.onShowBin = () => { panel.close(); app.navigate("recycle"); };
  // the open item is in the address (?item=12): a reload opens it again, and the link can be shared
  const writeItem = (id: number | null): void => {
    if (id || itemInHash(location.hash)) {
      const next = hashWithItem(location.hash || `#${current?.view.id ?? "board"}`, id);
      if (next !== location.hash) history.replaceState(history.state, "", next);
    }
    mirrorHash();
  };
  panel.onChange((id) => { current?.handle?.select?.(id); writeItem(id); });
  /** the item the address asked for at the start: opened once its view is there */
  let itemToOpen = itemInHash(location.hash);
  /** the first page drawn leaves the focus alone: the first Tab then reaches "Skip to content" */
  let shown = false;

  // ---- top bar: the tabs are the names (the Board's icon is the dashboard's mark) ----
  const tabs = h("nav.tabs", { "aria-label": "Views" });
  for (const v of VIEWS) {
    if (v.id === "settings" || v.id === "about") continue;
    const name = h("span", null, v.tab ?? v.title);
    tabs.append(h("a.tab", { href: `#${v.id}`, dataset: { view: v.id }, title: `${v.title}: ${v.about}` }, v.id === "board" ? logo(17) : icon(v.icon, 15), name));
  }
  setTabBlocks(VIEWS.filter((v) => v.id !== "settings" && v.id !== "about").map((v) => ({ id: `tab:${v.id}`, label: v.tab ?? v.title, title: v.about, icon: v.icon })));
  // in a narrow window some tabs fall outside the bar: "More" lists them
  const moreBtn = h("button.tab-more", { type: "button", hidden: true, title: "Views that do not fit in the bar", "aria-haspopup": "menu", "aria-expanded": "false" });
  const updateMore = (): void => {
    // the bar never scrolls: tabs that do not fit leave from the right end into "More", one by one;
    // the Board (the main page) and the open page always stay in the bar
    const all = [...tabs.querySelectorAll<HTMLElement>(".tab")].filter((t) => !("off" in t.dataset));
    for (const t of all) t.classList.remove("over");
    const shown = all;
    const width = new Map(shown.map((t) => [t, t.offsetWidth + 2]));
    let total = shown.reduce((s, t) => s + width.get(t)!, 0);
    const stays = (t: HTMLElement): boolean => t.dataset.view === "board" || t.classList.contains("active");
    for (let i = shown.length - 1; i >= 0 && total > tabs.clientWidth; i--) {
      if (stays(shown[i])) continue;
      shown[i].classList.add("over");
      total -= width.get(shown[i])!;
    }
    // in "More": the tabs that did not fit
    const hidden = all.filter((t) => t.classList.contains("over"));
    moreBtn.hidden = !hidden.length;
    moreBtn.replaceChildren(icon("more", 15), h("span.tm-word", null, "More"), h("span", null, `(${hidden.length})`));
    moreBtn.setAttribute("aria-label", `More views (${hidden.length})`);
    moreBtn.onclick = () => menu(moreBtn, hidden.map((t) => {
      const v = VIEWS.find((x) => x.id === t.dataset.view)!;
      return { label: v.title, icon: v.icon, hint: v.about, onClick: () => app.navigate(v.id) };
    }), "right");
  };
  new ResizeObserver(() => updateMore()).observe(tabs);
  // the tab order follows the team's working style (its own views first, every view stays)
  const orderTabs = (): void => {
    const all = [...tabs.querySelectorAll<HTMLElement>(".tab")];
    const s = style.current().style;
    for (const id of tabOrder(s, VIEWS.map((v) => v.id).filter((id) => all.some((t) => t.dataset.view === id)))) tabs.append(all.find((t) => t.dataset.view === id)!);
    // switched off in Settings > Menu & bars: gone from the bar and from "More" (the open page keeps its tab)
    for (const t of all) { if (tabOff(t.dataset.view!) && !t.classList.contains("active")) t.dataset.off = ""; else delete t.dataset.off; }
    // Settings lists the titles in the order shown
    setTabBlocks([...tabs.querySelectorAll<HTMLElement>(".tab")].map((t) => {
      const v = VIEWS.find((x) => x.id === t.dataset.view)!;
      return { id: `tab:${v.id}`, label: v.tab ?? v.title, title: v.about, icon: v.icon };
    }));
    requestAnimationFrame(updateMore);
  };
  orderTabs();
  onBlocksChange(() => { orderTabs(); applyBlocks(); });
  installCrosses();
  installHints();
  style.onChange(() => { orderTabs(); current?.handle?.update?.(new Set(), "style"); });
  // no status badge: polling runs quietly; when reading fails after the page loaded, a message says so once
  let wasError = false;
  ws.onStatus(() => {
    const err = ws.status === "error";
    if (err && !wasError && ws.loadedAt) toast(`Could not read the latest changes: ${ws.error}. Trying again.`, { kind: "error" });
    wasError = err;
  });

  const teamBtn = h("button.team-btn", { title: `${project} / ${team}: pick another project or team`, onclick: (e: Event) => pickTeam(e.currentTarget as Element) },
    h("span.tp", null, project), h("span.tt", null, team), icon("down", 14));
  // the theme: a small menu of the three choices, the chosen one checked
  const paintTheme = (t: Theme): void => {
    themeBtn.replaceChildren(icon(THEME_ICON[t], 16));
    themeBtn.title = themeTitle(t, hostDark());
    themeBtn.setAttribute("aria-label", `Colour theme: ${THEME_LABEL[t]}`);
  };
  const hostDark = (): boolean => hostIsDark(host) ?? window.matchMedia("(prefers-color-scheme: dark)").matches;
  const themeBtn: HTMLButtonElement = h("button.icon-btn.top-btn.theme-btn", {
    type: "button", "aria-haspopup": "menu", "aria-expanded": "false",
    onclick: () => {
      const now = savedTheme();
      const order: Theme[] = ["auto", "light", "dark"];
      menu(themeBtn, order.map((t) => ({
        label: t === "auto" ? `${THEME_LABEL.auto} (${hostDark() ? "dark" : "light"} now)` : THEME_LABEL[t],
        icon: t === now ? "check" : undefined,
        onClick: () => { prefs.set(THEME_KEY, t); applyTheme(t, hostIsDark(host)); paintTheme(t); themeBtn.focus(); },
      })), "right");
      // a menu of choices: each says whether it is the one chosen; the others keep the check's room
      const items = document.querySelectorAll<HTMLElement>(".popup .menu .menu-item");
      items.forEach((b, k) => {
        b.setAttribute("role", "menuitemradio");
        b.setAttribute("aria-checked", String(order[k] === now));
        if (order[k] !== now) b.prepend(h("span.menu-blank"));
      });
    },
  });
  paintTheme(savedTheme());
  blk("theme", themeBtn);

  // the ⚠ marks (and the colouring by what is missing) can be noisy: this button, left of the theme menu, switches them off and on
  const warnBtn: HTMLButtonElement = h("button.icon-btn.top-btn.top-warn", { type: "button", onclick: () => {
    prefs.set("warn.on", !prefs.get<boolean>("warn.on", true));
    paintWarn();
    document.dispatchEvent(new Event("flowboards:warn"));
  } }) as HTMLButtonElement;
  function paintWarn(): void {
    const on = prefs.get<boolean>("warn.on", true);
    warnBtn.replaceChildren(icon("warn", 16));
    warnBtn.setAttribute("aria-pressed", String(on));
    warnBtn.setAttribute("aria-label", on ? "Warning marks are on: switch them off" : "Warning marks are off: switch them on");
    warnBtn.title = on ? "The ⚠ marks show what a card or Feature still lacks (by the column rules). Click to switch them and the colouring by what is missing off, if they are too noisy." : "The ⚠ marks are off. Click to show them again.";
    warnBtn.classList.toggle("off", !on);
  }
  paintWarn();
  blk("warn", warnBtn);

  // Excel and Copy act on the page shown: its own sheets (the Board's cards), else every table shown
  const NOTHING = "Nothing on this page to export";
  const sheetsNow = (): Sheet[] => {
    const c = current;
    if (!c?.handle) return [];
    if (c.handle.exportSheets) return (c.handle.exportSheets() ?? []).filter((sh) => sh.rows.length > 1);
    return tableSheets(c.el, c.view.title);
  };
  const canExport = (): boolean => {
    const c = current;
    if (!c?.handle) return false;
    return c.handle.exportSheets ? sheetsNow().length > 0 : shownTables(c.el).length > 0;
  };
  const xlBtn = h("button.icon-btn.top-btn", {
    type: "button", "aria-label": "Download this page as Excel",
    onclick: () => { const sh = sheetsNow(); if (sh.length && current) void excelDialog(current.view.title, sh); },
  }, excelIcon(18));
  const copyBtn = h("button.icon-btn.top-btn", {
    type: "button", "aria-label": "Copy this page as a table",
    onclick: () => { const sh = sheetsNow(); if (sh.length) void copyRows(copyRowsOf(sh), sh.length > 1 ? `${sh.length} tables` : undefined); },
  }, icon("copy", 16));
  const paintExport = (): void => {
    const ok = canExport();
    xlBtn.setAttribute("aria-disabled", String(!ok));
    copyBtn.setAttribute("aria-disabled", String(!ok));
    xlBtn.title = ok ? "Download as an Excel file: what this page shows, filters and sorting included" : NOTHING;
    copyBtn.title = ok ? "Copy as a table to paste into Excel: what this page shows" : NOTHING;
  };
  let paintQueued = false;
  const exportWatch = new MutationObserver(() => {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; paintExport(); });
  });
  exportWatch.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "open"] });
  // every table a page draws gets column widths you can drag (kept per page and table)
  let sizeQueued = false;
  new MutationObserver(() => {
    if (sizeQueued) return;
    sizeQueued = true;
    requestAnimationFrame(() => { sizeQueued = false; if (current) resizeTablesIn(current.el, current.view.id); });
  }).observe(main, { childList: true, subtree: true });
  // Settings and About are pages you step out of: the same button again, or Esc, goes back to the page you came from
  let lastMain = "board";
  const toggleOff = (page: string) => (e: Event): void => { if (current?.view.id === page) { e.preventDefault(); app.navigate(lastMain); } };
  const setBtn = h("a.icon-btn.top-btn.top-set", { href: "#settings", onclick: toggleOff("settings") }, icon("settings", 17));
  // unsaved settings: a dot on the gear, which opens the first tab with changes
  const paintGear = (): void => {
    const d = draftTabs();
    setBtn.href = d.length ? `#settings?tab=${d[0].id}` : "#settings";
    setBtn.title = d.length ? `Settings: unsaved changes on ${d.map((t) => t.label).join(", ")}` : "Settings: rules, checklists, standard tasks, strategy pillars, board options";
    setBtn.setAttribute("aria-label", d.length ? "Settings (unsaved changes)" : "Settings");
    setBtn.replaceChildren(icon("settings", 17), d.length ? h("span.top-dot") : "");
  };
  paintGear();
  onDraftsChange(paintGear);
  // a reload or closing the page asks while settings are not saved
  window.addEventListener("beforeunload", (e) => {
    if (!draftTabs().length) return;
    e.preventDefault();
    e.returnValue = "";
  });
  const aboutBtn = h("a.icon-btn.top-btn.top-about", { href: "#about", onclick: toggleOff("about"), title: "About Flowboards: version, author, code on GitHub, privacy", "aria-label": "About" }, icon("info", 17));

  // reset: the layout (bars, tabs, Board switches and columns) back to the default; filters, theme and the team's settings stay
  const resetBtn = h("button.icon-btn.top-btn.top-reset", { type: "button", title: "Reset the layout to the default: the bars, tabs and Board switches you changed (your filters, theme and the team's settings stay)", "aria-label": "Reset the layout",
    onclick: async () => {
      if (!(await confirm("Reset the layout?", h("div", null,
        h("p", null, "The bars, tabs, crosses and the Board's switches, columns and layout go back to the defaults, for you only."),
        h("p.muted", null, "Your filters, colour theme and working style, and the team's settings, stay. The page loads again.")), "Reset", true))) return;
      try { await resetLayout(); } catch (e) { toast(`Could not reset the layout: ${errorText(e)}`, { kind: "error" }); return; }
      location.reload();
    } }, icon("undo", 17));
  blk("excel", xlBtn); blk("copy", copyBtn); blk("reset", resetBtn); blk("about", aboutBtn); blk("team", teamBtn);
  // the first line: the team at the very left, then its working style, then the menu titles; the tools at the right end
  const styleBtn = blk("style", styleButton(app));
  const topTools = h("div.top-tools", null, warnBtn, themeBtn, xlBtn, copyBtn, aboutBtn, resetBtn, setBtn);
  const bar = h("header.topbar", null, h("div.top-lead", null, teamBtn, styleBtn), tabs, moreBtn, topTools);
  paintExport();

  const demoBanner = api.ctx.demo ? h("div.demo-banner", null,
    h("b", null, "Demo data. "), "This page runs outside Azure DevOps on made-up data; changes stay in this browser tab. Install the extension to use it on your own boards.") : null;
  const skip = h("button.skip-link", { type: "button", onclick: () => focusView() }, "Skip to content");
  root.replaceChildren(skip, bar, demoBanner ?? "", main);
  /** the focus goes to the page (not the top bar), without scrolling: the next Tab is the page's first control */
  function focusView(): void { main.focus({ preventScroll: true }); }

  /** The team picker: a project, a search box, your teams and all teams; a click opens the team (the page loads again on it). */
  function pickTeam(anchor: Element): void {
    const chooser = teamChooser({
      api, project, team,
      onPick: async (p, t) => {
        if (p === project && t === team) { closePopup(); return; }
        const d = draftTabs();
        if (d.length) {
          closePopup();
          const ok = await confirm("Unsaved settings", `Settings has unsaved changes on ${d.map((x) => x.label).join(", ")}. Opening ${t} reloads the page and throws them away.`, `Open ${t}`, true);
          if (!ok) return;
          discardDrafts();
        }
        const key = `team:${api.ctx.orgName}`;
        prefs.set(key, withChoice(prefs.get<SavedTeams>(key, {}), p, t, true));
        location.hash = location.hash.split("?")[0];
        location.reload();
      },
    });
    popup(anchor, h("div.team-pick", null, chooser.el), { align: "right" });
    chooser.focus();
  }

  // ---- a team so big its board would be crowded (its area is probably the whole project) ----
  const bigKey = `bigteam:${api.ctx.orgName}/${project}/${team}`;
  let bigShown = false;
  const checkSize = (): void => {
    if (bigShown || !ws.loadedAt || prefs.get(bigKey, false)) return;
    const n = openStoryCount(ws.items.values(), ws.requirementLevel().types);
    if (!isOversized(n)) return;
    bigShown = true;
    const note: HTMLElement = h("div.big-team", { role: "alert" },
      h("span", null, `This team covers ${n.toLocaleString()} open ${ws.requirementLevel().name.toLowerCase()} (its area is probably the whole project). Choose a smaller team for a clearer board.`),
      h("button.btn.small.primary", { type: "button", title: "Pick another team of this project or another one", onclick: (e: Event) => pickTeam(e.currentTarget as Element) }, "Choose a team"),
      h("button.icon-btn.small", { type: "button", title: "Hide this note for this team", "aria-label": "Hide this note", onclick: () => { prefs.set(bigKey, true); note.remove(); } }, icon("close", 14)));
    root.insertBefore(note, main);
  };

  // Esc on Settings or About steps back too (a box being edited, a popup, a dialog or the open panel take Esc first)
  document.addEventListener("keydown", (e) => {
    const page = current?.view.id;
    if (e.key !== "Escape" || e.defaultPrevented || (page !== "settings" && page !== "about")) return;
    if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
    if (document.querySelector(".backdrop, .popup") || document.body.classList.contains("panel-open")) return;
    e.preventDefault();
    app.navigate(lastMain);
  }, true);

  // ---- routing ----
  async function route(): Promise<void> {
    const [hashId, query] = location.hash.replace(/^#/, "").split("?");
    // the Audits page is the Tags page now: old links and saved choices still open it
    const id = hashId === "audits" ? "tags" : hashId;
    const view = VIEWS.find((v) => v.id === id) ?? VIEWS.find((v) => v.id === (prefs.get<string>("view", "board") === "audits" ? "tags" : prefs.get<string>("view", "board"))) ?? VIEWS[0];
    const params = Object.fromEntries(new URLSearchParams(query ?? ""));
    // the open item is the panel's, not the view's: it does not draw the view again
    const asked = itemInHash(location.hash);
    delete params.item;
    if (current?.view === view && JSON.stringify(params) === (current.el.dataset.params ?? "{}")) {
      if (asked && asked !== panel.current()) panel.open(asked);
      else writeItem(panel.current());
      return;
    }
    if (asked) itemToOpen = asked;
    // a page picked in the top bar (or the start) takes the focus; one opened from a dialog or the panel does not
    const fromBar = !document.activeElement || document.activeElement === document.body || bar.contains(document.activeElement);
    current?.handle?.unmount?.();
    closePopup();
    prefs.set("view", view.id);
    if (view.id !== "settings" && view.id !== "about") lastMain = view.id;
    for (const t of tabs.querySelectorAll<HTMLElement>(".tab")) {
      t.classList.toggle("active", t.dataset.view === view.id);
      if (t.dataset.view === view.id) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    }
    orderTabs();
    setBtn.classList.toggle("active", view.id === "settings");
    aboutBtn.classList.toggle("active", view.id === "about");
    if (view.id === "settings") setBtn.setAttribute("aria-current", "page"); else setBtn.removeAttribute("aria-current");
    if (view.id === "about") aboutBtn.setAttribute("aria-current", "page"); else aboutBtn.removeAttribute("aria-current");
    requestAnimationFrame(updateMore);
    const el = h(`div.view.v-${view.id}`, { dataset: { params: JSON.stringify(params) } });
    main.replaceChildren(el);
    current = { view, handle: null, el };
    if (ws.status === "loading" && !ws.loadedAt) {
      el.dataset.wait = "loading";
      el.append(spinner(`Reading ${team} from Azure DevOps…`));
      return;
    }
    if (ws.status === "error" && !ws.loadedAt) {
      // "Try again": the status change below shows "Reading…" and then the view or this message again
      el.dataset.wait = "error";
      el.append(failed(new Error(ws.error), () => void ws.load().catch(() => {})));
      return;
    }
    try {
      const handle = await view.mount(el, app, params);
      if (current?.el === el) {
        current.handle = handle;
        handle.select?.(panel.current());
        // every page has line 2 (the field): a page that draws none gets the plain one
        if (!el.querySelector(".page-bar")) el.prepend(pageBar(app).el);
        paintExport();
        // the view keeps a focus it set itself (Settings: the tab picked)
        if (shown && fromBar && !el.contains(document.activeElement)) main.focus({ preventScroll: true });
        shown = true;
        if (itemToOpen) { const id = itemToOpen; itemToOpen = null; if (panel.current() !== id) panel.open(id); }
        else writeItem(panel.current());
      }
      else handle.unmount?.();
    } catch (e) {
      console.error(e);
      el.replaceChildren(failed(e, () => { current = null; void route(); }));
    }
  }
  window.addEventListener("hashchange", () => void route());

  ws.onChange((changed, why) => {
    if (why === "load") { checkSize(); style.changed(); }
    if (why === "load" && current && !current.handle) { current = null; void route(); return; }
    current?.handle?.update?.(changed, why);
  });
  // until a first load worked, the view waits ("Reading…"): when the load fails it shows the problem
  // with "Try again", and "Reading…" again while a new try runs
  ws.onStatus(() => {
    if (!ws.loadedAt && ws.status !== "live" && current && !current.handle && current.el.dataset.wait !== ws.status) { current = null; void route(); }
  });

  settings.onChange(() => current?.handle?.update?.(new Set(), "settings"));

  void style.load();
  void route();
  // the Scheduler: while this page is open it makes the team's stories that are due (see app/scheduler.ts)
  startScheduler(app);
  // polling runs from the start: it waits until a first load worked (also one from "Try again")
  ws.startPolling(30);
  // until then the page says it could not read: read everything again every 30 seconds
  const firstLoad = setInterval(() => {
    if (ws.loadedAt) { clearInterval(firstLoad); return; }
    if (ws.status === "error" && document.visibilityState === "visible") void ws.load().catch(() => {});
  }, 30_000);
  try {
    await ws.load();
  } catch (e) {
    toast(`Could not read the team's work: ${errorText(e)}`, { kind: "error" });
  }
  return app;
}

export function hostIsDark(host: HostContext | null): boolean | undefined {
  const bg = host?.theme?.["background-color"] ?? host?.theme?.["palette-neutral-0"];
  const rgb = bg ? colorRgb(bg) : undefined;
  if (!rgb) return undefined;
  const [r, g, b] = rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/** Red, green and blue (0-255) of a colour written as #rgb, #rrggbb (with or without alpha), "r, g, b" or rgb(a)(…). */
export function colorRgb(color: string): [number, number, number] | undefined {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((x) => x + x).join("") : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
  }
  const nums = (c.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return nums.length >= 3 ? [nums[0], nums[1], nums[2]] : undefined;
}

/** The dashboard's mark: the Board tab's icon. */
function logo(size: number): SVGElement {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("class", "tab-logo");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<rect x="2" y="3" width="20" height="18" rx="4" fill="var(--accent)"/><path d="M6 8h4M6 12h7M6 16h5" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round"/><circle cx="17" cy="9" r="2" fill="var(--accent-ink)"/><path d="M15 9l-2 3M17 11v4" stroke="var(--accent-ink)" stroke-width="1.5"/>';
  return s;
}

function themeTitle(t: Theme, hostDark: boolean): string {
  const now = t === "auto" ? `like Azure DevOps (${hostDark ? "dark" : "light"} now)` : t === "dark" ? "dark" : "light";
  return `Colours: ${now}. Click to choose.`;
}
