// "Style: Scrum (guess)": how the team works, right after the team button on every page. A click
// shows the guess and why, the team's choice (anyone in the team may change it) and your own.
// The team's choice saves on a click, Enter or Space, never while arrows move through the choices;
// the message after it has Undo.
import type { App } from "../app/context.ts";
import { fmtDate } from "../core/model.ts";
import type { WorkStyle } from "../core/workstyle.ts";
import { STYLES, styleLabel } from "../core/workstyle.ts";
import { h, icon } from "./dom.ts";
import { errorText, popup, select, toast } from "./kit.ts";

export function styleButton(app: App): HTMLElement {
  const btn = h("button.btn.small.style-btn", { type: "button", "aria-haspopup": "dialog", onclick: () => open() });
  const paint = (): void => {
    const st = app.style.current();
    btn.title = `How ${app.ws.team} works: ${st.source === "mine" ? "your own choice" : st.source === "team" ? "the team's choice" : "guessed from the team's sprints and work"}. Click to see or change.`;
    btn.replaceChildren(h("span.muted", null, "Style:"), " ", styleLabel(st.style),
      st.source === "detected" ? h("span.muted", null, " (guess)") : st.source === "mine" ? h("span.muted", null, " (mine)") : "", icon("down", 12));
  };
  app.style.onChange(paint);
  paint();

  function open(): void {
    const svc = app.style;
    const det = svc.detected();
    const box = h("div.col-pop.style-pop");
    const busyMsg = h("p.small", { role: "status" });
    let saving = false;
    /** save, close the popup, give the focus back to the Style button, and offer Undo */
    const run = async (f: () => Promise<void>, done: string, undo: () => Promise<void>): Promise<void> => {
      if (saving) return;
      saving = true;
      busyMsg.textContent = "Saving…";
      try {
        await f();
        close();
        btn.focus();
        toast(done, { kind: "ok", undo });
      } catch (e) { busyMsg.textContent = `Not saved: ${errorText(e)}`; } finally { saving = false; }
    };
    const ro = app.actions.readOnly;
    const team = svc.team?.style;
    const teamText = (v: WorkStyle | null | undefined): string => v ? `Team style set to ${styleLabel(v)}` : `Team style cleared: the guess applies (${styleLabel(det.style)})`;
    const setTeam = (v: WorkStyle | null): void => {
      if (v === (team ?? null)) { close(); btn.focus(); return; }
      const before = team ?? null;
      void run(() => svc.setTeam(v), teamText(v), () => svc.setTeam(before));
    };
    // arrows only move the choice; a click, Enter or Space saves it
    let arrowing = false;
    const choice = (cur: WorkStyle | undefined, none: string): HTMLElement => {
      const radio = (v: WorkStyle | null): HTMLInputElement => h("input", {
        type: "radio", name: "team-style", value: v ?? "", checked: (cur ?? null) === v, disabled: ro,
        // arrow keys fire a click too: that one only moves
        onclick: () => { if (arrowing) { arrowing = false; return; } setTeam(v); },
      }) as HTMLInputElement;
      return h("div.style-choices", {
        role: "radiogroup", "aria-label": "For the team",
        onkeydown: (e: KeyboardEvent) => {
          if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") { arrowing = true; setTimeout(() => { arrowing = false; }); return; }
          const t = e.target as HTMLInputElement;
          if ((e.key === "Enter" || (e.key === " " && t.checked)) && t.type === "radio") { e.preventDefault(); setTeam((t.value || null) as WorkStyle | null); }
        },
      },
      [...STYLES.map((s) => h("label.style-choice", { title: s.about },
        radio(s.value),
        h("span", null, h("b", null, s.label), h("span.small.muted", null, ` ${s.about}`)))),
      h("label.style-choice", null, radio(null), h("span.small", null, none))]);
    };
    const mine = svc.mine() ?? null;
    box.append(
      h("h3", null, `How ${app.ws.team} works`),
      h("p.small.muted", null, `The style sets which board layout opens first and the order of the tabs. Every view stays available. Guess from the team's work: ${styleLabel(det.style)} (${det.why}).`),
      h("b", null, "For the team"),
      h("p.small.muted", null, svc.team ? `Set to ${styleLabel(svc.team.style)} by ${svc.team.byName || svc.team.by}, ${fmtDate(svc.team.at)}. Anyone in the team can change it.` : "Nobody chose yet, so the guess applies. Anyone in the team can choose."),
      choice(team, `Not set: use the guess (${styleLabel(det.style)})`),
      h("label.inline", { title: "Your own style for this team, on any computer; the others keep the team's" }, h("b", null, "For me only"),
        select<WorkStyle | "">([{ value: "", label: "Same as the team" }, ...STYLES.map((s) => ({ value: s.value, label: s.label }))], mine ?? "",
          (v) => void run(() => svc.setMine(v || null), v ? `Your style set to ${styleLabel(v)}` : "Your style follows the team again", () => svc.setMine(mine)))),
      busyMsg);
    const close = popup(btn, box);
    // the focus starts on the team's current choice
    box.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus();
  }
  return btn;
}
