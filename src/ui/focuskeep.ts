// Keep the keyboard focus across a redraw. Controls carry data-fk (a key that stays the same for the
// same control after a redraw), optionally data-fg (their group: the next or previous one of the group
// takes the focus when this one is gone) and data-fe (the key to focus when the whole group is gone).

/** Call before a redraw of `root`; call what it gives back after it. */
export function keepFocus(root: HTMLElement): (fallback?: HTMLElement | null) => void {
  const el = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-fk]");
  if (!el || !root.contains(el)) return () => {};
  const fk = el.dataset.fk!;
  const fg = el.dataset.fg;
  const fe = el.dataset.fe;
  const group = fg ? [...root.querySelectorAll<HTMLElement>("[data-fg]")].filter((x) => x.dataset.fg === fg).map((x) => x.dataset.fk!) : [];
  const i = group.indexOf(fk);
  return (fallback) => {
    // focus moved on meanwhile (a dialog, a click elsewhere): leave it there
    const now = document.activeElement;
    if (now && now !== document.body && now.isConnected && now !== el) return;
    const find = (k: string | undefined): HTMLElement | null => (k ? root.querySelector<HTMLElement>(`[data-fk="${CSS.escape(k)}"]`) : null);
    let t = find(fk);
    for (let j = i + 1; !t && j > 0 && j < group.length; j++) t = find(group[j]);
    for (let j = i - 1; !t && j >= 0; j--) t = find(group[j]);
    t ??= find(fe) ?? fallback ?? null;
    t?.focus({ preventScroll: true });
    t?.scrollIntoView?.({ block: "nearest" });
  };
}
