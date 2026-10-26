// The person's own fill colours for the Board: the Epic box, the Feature card and the story card
// (Settings > Cards > Colours). A colour is blended into the theme's own fill by a strength, so one
// choice works in light and dark; from half strength on, the text turns dark or light to stay readable.
// No page code here except applyFills, which sets the CSS variables the Board's styles read.

export type FillPart = "epic" | "feature" | "story";

export interface Fill {
  /** "#rrggbb" */
  color: string;
  /** how much of the colour, in percent (10–100); the rest is the theme's own fill */
  strength: number;
}

export type Fills = Partial<Record<FillPart, Fill>>;

export const FILL_PARTS: FillPart[] = ["epic", "feature", "story"];

/** The theme's own fill of each part (the CSS variable the Board uses without a choice). */
export const THEME_FILL: Record<FillPart, string> = {
  epic: "var(--epic-soft)",
  feature: "var(--feat)",
  story: "var(--card, var(--panel-2))",
};

/** The CSS variable a choice is put in, and the class that turns on its text colours. */
const VAR: Record<FillPart, string> = { epic: "--fill-epic", feature: "--fill-feat", story: "--fill-story" };

export const DEFAULT_STRENGTH = 35;

const HEX = /^#[0-9a-f]{6}$/i;

/** A saved choice, checked: a colour "#rrggbb" and a strength from 10 to 100 (in steps of 5); null when unusable. */
export function cleanFill(v: unknown): Fill | null {
  if (!v || typeof v !== "object") return null;
  const f = v as { color?: unknown; strength?: unknown };
  if (typeof f.color !== "string" || !HEX.test(f.color)) return null;
  const n = typeof f.strength === "number" && Number.isFinite(f.strength) ? f.strength : DEFAULT_STRENGTH;
  return { color: f.color.toLowerCase(), strength: Math.min(100, Math.max(10, Math.round(n / 5) * 5)) };
}

/** Every saved choice, checked. */
export function cleanFills(v: unknown): Fills {
  const out: Fills = {};
  if (!v || typeof v !== "object") return out;
  for (const p of FILL_PARTS) {
    const f = cleanFill((v as Record<string, unknown>)[p]);
    if (f) out[p] = f;
  }
  return out;
}

/** The CSS fill of a part: the colour blended into the theme's own fill. */
export function fillCss(part: FillPart, f: Fill): string {
  return f.strength >= 100 ? f.color : `color-mix(in srgb, ${f.color} ${f.strength}%, ${THEME_FILL[part]})`;
}

/** Relative luminance of "#rrggbb" (0 black … 1 white), as WCAG counts it. */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * The text colours on a strong fill (half strength or more), so text stays readable in both themes:
 * dark text on a light colour, light text on a dark one. Null below half strength: the theme's text stays.
 */
export function inkFor(f: Fill): { ink: string; muted: string } | null {
  if (f.strength < 50) return null;
  return luminance(f.color) > 0.179 ? { ink: "#141a24", muted: "#3d4656" } : { ink: "#f4f6fa", muted: "#cfd5df" };
}

/** Put the choices into the page: CSS variables on the document, and a class per part with its own text colours. */
export function applyFills(fills: Fills, root: HTMLElement = document.documentElement): void {
  for (const p of FILL_PARTS) {
    const f = fills[p];
    const v = VAR[p];
    if (f) root.style.setProperty(v, fillCss(p, f));
    else root.style.removeProperty(v);
    const ink = f ? inkFor(f) : null;
    if (ink) { root.style.setProperty(`${v}-ink`, ink.ink); root.style.setProperty(`${v}-muted`, ink.muted); }
    else { root.style.removeProperty(`${v}-ink`); root.style.removeProperty(`${v}-muted`); }
    root.classList.toggle(`fill-${p}-ink`, Boolean(ink));
  }
}
