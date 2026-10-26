// About Flowboards: what it is, the version, who made it, where the code is, what it is connected to,
// and what happens to your data. Opened with the (i) button in the top bar, next to Settings.
import type { App, View } from "../app/context.ts";
import { AI_FEATURES } from "../core/ai.ts";
import type { Child } from "../ui/dom.ts";
import { h, icon } from "../ui/dom.ts";
import { pageBar } from "../ui/pagebar.ts";

/** where the code lives, and who wrote it */
export const REPO = "https://github.com/Volodymyr-Usov/flowboards";
export const AUTHOR = { name: "Volodymyr Usov", url: "https://usovvova.com" };
/** the website: what Flowboards does, a live demo on made-up data, and what it adds to Azure DevOps */
export const WEBSITE = { home: "https://flowboards.dev/", demo: "https://flowboards.dev/demo/", features: "https://flowboards.dev/features/" };

/** The author's small photo: images/author.jpg, else images/author.png, from the package (nothing is fetched from the web); initials when neither is there. */
function authorPhoto(): HTMLElement {
  const initials = h("span.ab-photo.ab-initials", { "aria-hidden": "true" }, AUTHOR.name.split(" ").map((w) => w[0]).join(""));
  const files = ["../images/author.jpg", "../images/author.png"];
  let next = 1;
  const img = h("img.ab-photo", { src: files[0], alt: AUTHOR.name, width: 64, height: 64, onerror: () => { if (next < files.length) img.src = files[next++]; else img.replaceWith(initials); } }) as HTMLImageElement;
  return img;
}

export const aboutView: View = {
  id: "about",
  title: "About",
  icon: "info",
  group: "check",
  about: "What Flowboards is, its version, who made it, where its code is, and what happens to your data.",
  mount(el, app: App) {
    const gen = document.head.querySelector<HTMLMetaElement>('meta[name="generator"]')?.content ?? "";
    const version = gen.replace(/^\S+\s+/, "") || "unknown";
    const ctx = app.api.ctx;
    const ws = app.ws;
    const row = (label: string, value: Child): HTMLElement => h("div.ab-row", null, h("span.muted", null, label), h("span", null, value));
    const link = (href: string, text: Child, title: string): HTMLElement => h("a", { href, target: "_blank", rel: "noopener", title }, text);
    el.append(pageBar(app).el, h("div.ab", null,
      h("section.card-box.ab-hero", null,
        h("img.ab-icon", { src: "../images/icon.png", alt: "", width: 56, height: 56, onerror: (e: Event) => (e.target as HTMLElement).remove() }),
        h("div", null,
          h("h1", null, "Flowboards"),
          h("p", null, "A team's work in one place inside Azure DevOps: board, taskboard and story map, backlog, roadmap, dependencies, calendar, story scheduler, sprint, flow, pull requests, strategy, health and tags. Free and open source."),
          h("p.small.muted", null, "Version ", h("span.mono", null, version)),
          h("div.ab-actions", null,
            h("a.btn.primary", { href: WEBSITE.home, target: "_blank", rel: "noopener", title: "Open the Flowboards website: flowboards.dev" }, icon("external", 14), "flowboards.dev"),
            h("a.btn", { href: WEBSITE.demo, target: "_blank", rel: "noopener", title: "Open the live demo on flowboards.dev: made-up data, safe to try, nothing to install" }, icon("external", 14), "Live demo"),
            h("a.btn", { href: WEBSITE.features, target: "_blank", rel: "noopener", title: "What Flowboards adds to Azure DevOps, on flowboards.dev" }, icon("external", 14), "What it adds to Azure DevOps")))),
      h("section.card-box.ab-author", null,
        authorPhoto(),
        h("div", null,
          h("h3", null, "Made by"),
          h("p", null, link(AUTHOR.url, AUTHOR.name, "The author's site"), " · ", link(AUTHOR.url, AUTHOR.url.replace(/^https?:\/\//, ""), "The author's site")))),
      h("section.card-box", null,
        h("h3", null, "Code, questions and ideas"),
        h("p", null, "Flowboards is open source under the MIT license. The code, the issues and the change history are on GitHub."),
        h("div.ab-actions", null,
          h("a.btn", { href: REPO, target: "_blank", rel: "noopener", title: "Open the source code on GitHub" }, icon("external", 14), "GitHub repository"),
          h("a.btn", { href: REPO + "/issues", target: "_blank", rel: "noopener", title: "Report a problem or ask for a feature on GitHub" }, icon("external", 14), "Report a problem or an idea"))),
      h("section.card-box", null,
        h("h3", null, "Connected to"),
        row("Data", ctx.demo ? "Demo: made-up data, outside Azure DevOps. Changes stay in this browser tab." : "Live: your Azure DevOps organization, with your own permissions."),
        row("Organization", ctx.demo ? ctx.orgName : link(ctx.orgUrl, ctx.orgName, "Open the organization in Azure DevOps")),
        row("Project", ws.project),
        row("Team", ws.team),
        row("Signed in as", `${ctx.me.displayName}${ctx.me.uniqueName && ctx.me.uniqueName !== ctx.me.displayName ? ` (${ctx.me.uniqueName})` : ""}`)),
      h("section.card-box", null,
        h("h3", null, "Privacy"),
        h("ul.ab-list", null,
          h("li", null, "Flowboards runs in your browser, inside Azure DevOps, with your own sign-in. It has no server."),
          h("li", null, "Your data stays in your Azure DevOps organization: settings, rules, checklists, schedules, retros, poker votes and your own screen choices are kept in this extension's storage there."),
          h("li", null, "The team's part of that storage can be read by people in your organization who have the extension. Retro notes and poker votes are hidden on screen until revealed, not locked away."),
          h("li", null, "It reads code (pull requests) but never changes it."),
          h("li", null, "No tracking and no telemetry: nothing is sent anywhere else."),
          AI_FEATURES ? h("li", null, "AI help is off unless you add your own key. Then only the text you ask about goes to the provider you picked.") : null))));
    return {};
  },
};
