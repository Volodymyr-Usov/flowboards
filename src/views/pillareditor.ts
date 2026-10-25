// The strategy pillar editor, one for the whole app: Settings → Strategy shows it with Save and Discard,
// and "Edit pillars" on the Strategy page shows it in a dialog. Add, rename, recolour, reorder and remove
// pillars, and set the tag prefix. A pillar keeps its id for good: an Epic's chosen pillar is kept by id.
import type { App } from "../app/context.ts";
import type { Pillar } from "../core/settings.ts";
import { h, icon } from "../ui/dom.ts";
import { dialog, help, popup, toast } from "../ui/kit.ts";
import type { EditCtx } from "./ruleeditor.ts";
import { clone, moveIn, newId, svgArrow } from "./ruleeditor.ts";
import type { PillarLike } from "./strategylogic.ts";
import { derivePillars, keepRenamed, NONE_VALUE, pillarColor, SERIES_TOKENS } from "./strategylogic.ts";

export interface PillarDraft { pillars: Pillar[]; prefix: string }

/** The saved pillars and prefix as a draft to edit; `start` replaces the pillars (e.g. ones found in tags). */
export function pillarDraft(app: App, start?: PillarLike[]): PillarDraft {
  const shared = app.settings.shared;
  const pillars = start ?? shared.pillars;
  return { pillars: clone(pillars).map((p) => ({ id: p.id, name: p.name, ...(p.description ? { description: p.description } : {}), ...(p.color ? { color: p.color } : {}) })), prefix: shared.pillarTagPrefix };
}

/** Why the draft cannot be saved, or null. */
export function checkPillars(s: PillarDraft): string | null {
  const i = s.pillars.findIndex((p) => !p.name.trim());
  if (i >= 0) return `Pillar ${i + 1} needs a name.`;
  const names = s.pillars.map((p) => p.name.trim().toLowerCase());
  const dup = names.find((n, k) => names.indexOf(n) !== k);
  if (dup) return `Two pillars are named "${dup}". Names must differ.`;
  return null;
}

/** Save to the project's shared settings; Epics set by hand to a removed pillar lose that choice. */
export async function savePillars(app: App, s: PillarDraft): Promise<string> {
  return (await savePillarsKept(app, s)).message;
}

/**
 * Save, keeping the Epics of a renamed pillar (or of a new tag prefix): they joined by tag, so they get
 * their pillar by id in the same save. `epics`: the Epics to check (default: the loaded ones).
 * Gives the message and an Undo that puts the old pillars, prefix and choices back.
 */
export async function savePillarsKept(app: App, s: PillarDraft, epics?: { id: number; tags: string[] }[]): Promise<{ message: string; kept: number; undo: () => Promise<void> }> {
  const shared = app.settings.shared;
  const old = { pillars: clone(shared.pillars), pillarTagPrefix: shared.pillarTagPrefix, epicPillars: { ...shared.epicPillars } };
  const top = app.ws.portfolioLevels()[0];
  const list = epics ?? (top ? app.ws.ofLevel(top) : []);
  const prefixBefore = shared.pillarTagPrefix || "Pillar:";
  const prefixAfter = s.prefix.trim() || "Pillar:";
  const pillars = clone(s.pillars).map((p) => ({ ...p, name: p.name.trim() }));
  const before = shared.pillars.length ? shared.pillars : derivePillars(list.map((e) => e.tags), prefixBefore);
  const ids = new Set(pillars.map((p) => p.id));
  const manual = Object.fromEntries(Object.entries(shared.epicPillars).filter(([, v]) => v === NONE_VALUE || ids.has(v)));
  const { epicPillars, kept } = keepRenamed(list, before, pillars, manual, prefixBefore, prefixAfter);
  await app.actions.logged("Settings: strategy pillars changed", { type: "Settings", title: "Pillars" }, () => app.settings.saveShared({ pillars, pillarTagPrefix: prefixAfter, epicPillars }));
  const word = kept.length === 1 ? top?.defaultType ?? "Epic" : top?.name ?? "Epics";
  return {
    message: `Strategy pillars saved for the project${kept.length ? `. ${kept.length} ${word} kept in their pillar (their tags still name the old one)` : ""}`,
    kept: kept.length,
    undo: () => app.actions.logged("Settings: strategy pillars change undone", { type: "Settings", title: "Pillars" }, () => app.settings.saveShared(old)),
  };
}

function swatchPicker(p: Pillar, i: number, ctx: EditCtx): HTMLElement {
  return h("button.pe-swatch", {
    type: "button", style: { background: pillarColor(p.color, i) }, title: "Pick the pillar's color", "aria-label": "Pillar color",
    onclick: (e: Event) => {
      const anchor = e.currentTarget as Element;
      let close = (): void => {};
      close = popup(anchor, h("div.pe-palette", null, SERIES_TOKENS.map((t, k) => h("button.pe-swatch", {
        type: "button", style: { background: `var(${t})` }, title: `Color ${k + 1}`, "aria-label": `Color ${k + 1}`, "aria-pressed": String(p.color === t),
        onclick: () => { p.color = t; close(); ctx.redraw(); },
      }))));
    },
  });
}

/** The editor itself: it changes the draft in place and calls ctx.changed() or ctx.redraw(). */
export function pillarEditor(app: App, s: PillarDraft, ctx: EditCtx): HTMLElement {
  const ws = app.ws;
  const top = ws.portfolioLevels()[0];
  const epics = top ? ws.ofLevel(top) : [];
  return h("div.pe-list", null,
    h("div.pe-card", null,
      h("label.pe-field", null, h("span", null, "Tag prefix", help(`An ${top?.defaultType ?? "Epic"} tagged with this prefix and a pillar's name belongs to that pillar. Renaming a pillar means renaming those tags too, or picking the pillar by hand on the Strategy page.`)),
        h("input.input.pe-prefix", {
          value: s.prefix, placeholder: "Pillar:", title: "The start of the tag that names a pillar, such as Pillar:", "aria-label": "Tag prefix",
          oninput: (e: Event) => { s.prefix = (e.target as HTMLInputElement).value; ctx.changed(); },
        }))),
    s.pillars.length ? s.pillars.map((p, i) => h("div.pe-card.pe-pillar", null,
      swatchPicker(p, i, ctx),
      h("div.pe-fields", null,
        h("input.input", {
          value: p.name, placeholder: "Name", title: "The pillar's name (the tag is the prefix plus this name)", "aria-label": "Pillar name",
          oninput: (e: Event) => { p.name = (e.target as HTMLInputElement).value; ctx.changed(); },
        }),
        h("input.input", {
          value: p.description ?? "", placeholder: "What this pillar is for (one sentence)", title: "A sentence shown on the pillar's card", "aria-label": "Pillar description",
          oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v) p.description = v; else delete p.description; ctx.changed(); },
        })),
      h("div.pe-tools", null,
        h("button.icon-btn.small", { type: "button", title: "Move this pillar up", "aria-label": "Move up", disabled: i === 0, onclick: () => { moveIn(s.pillars, i, -1); ctx.redraw(); } }, svgArrow(true)),
        h("button.icon-btn.small", { type: "button", title: "Move this pillar down", "aria-label": "Move down", disabled: i === s.pillars.length - 1, onclick: () => { moveIn(s.pillars, i, 1); ctx.redraw(); } }, svgArrow(false)),
        h("button.icon-btn.small", { type: "button", title: "Remove this pillar (its Epics keep their tags)", "aria-label": "Remove pillar", onclick: () => { s.pillars.splice(i, 1); ctx.redraw(); } }, icon("close", 14)))))
      : h("p.muted.pe-empty", null, "No pillars yet. The Strategy page then makes them from the tags it finds."),
    h("div.pe-actions", null,
      h("button.btn", {
        type: "button", title: "Add a pillar", disabled: app.actions.readOnly,
        onclick: () => { s.pillars.push({ id: newId("p"), name: "", color: SERIES_TOKENS[s.pillars.length % SERIES_TOKENS.length] }); ctx.redraw(); },
      }, icon("plus", 14), "Add pillar"),
      h("button.btn", {
        type: "button", title: `Add a pillar for each "${s.prefix || "Pillar:"}…" tag found on the loaded items`, disabled: app.actions.readOnly,
        onclick: () => {
          const found = derivePillars(epics.map((e) => e.tags), s.prefix || "Pillar:")
            .filter((d) => !s.pillars.some((p) => p.name.trim().toLowerCase() === d.name.toLowerCase()));
          if (!found.length) { toast("No new pillar tags found"); return; }
          // an id already used by a pillar in the list gets a new one
          for (const d of found) s.pillars.push({ id: s.pillars.some((p) => p.id === d.id) ? newId("p") : d.id, name: d.name, color: SERIES_TOKENS[s.pillars.length % SERIES_TOKENS.length] });
          ctx.redraw();
        },
      }, icon("search", 14), "Add from tags")));
}

/**
 * "Edit pillars" as a dialog. `start`: the pillars to begin with when none are saved yet (those found
 * in tags, with their stable ids). True when saved.
 */
export async function editPillarsDialog(app: App, start?: PillarLike[], epics?: { id: number; tags: string[] }[]): Promise<boolean> {
  const ro = app.actions.readOnly;
  const s = pillarDraft(app, app.settings.shared.pillars.length ? undefined : start);
  const slot = h("div");
  const ctx: EditCtx = {
    changed: () => {},
    redraw: () => {
      // keep the scroll place across a redraw
      const scroller = slot.closest(".dialog-body");
      const y = scroller?.scrollTop ?? 0;
      slot.replaceChildren(pillarEditor(app, s, ctx));
      if (scroller) scroller.scrollTop = y;
    },
  };
  ctx.redraw();
  const body = h("div.pe-dialog", null, h("p.small.muted.pe-note", null, "Shared: everyone in this project sees and uses these pillars."), slot);
  const choice = await dialog("Strategy pillars", body, [
    { label: "Cancel", value: "" },
    {
      label: ro ? "Read-only" : "Save", value: "save", primary: true,
      onClick: async () => {
        if (ro) { toast("Read-only: pillars cannot be saved here.", { kind: "error" }); return false; }
        const problem = checkPillars(s);
        if (problem) { toast(problem, { kind: "error" }); return false; }
        const r = await savePillarsKept(app, s, epics);
        toast(r.message, { kind: "ok", undo: r.undo });
        return true;
      },
    },
  ], { wide: true });
  return choice === "save";
}
