// Start: inside Azure DevOps, connect to the host and use the person's own sign-in;
// anywhere else (or with ?demo in the address), run on the demo data.
import type { Api } from "./api/api.ts";
import { DEMO, DemoApi } from "./api/demo.ts";
import { readOnlyApi } from "./api/readonly.ts";
import { RestApi } from "./api/rest.ts";
import { applyTheme, hostIsDark, savedTheme, startApp } from "./app/app.ts";
import { prefs, syncPrefs } from "./core/settings.ts";
import type { SavedTeams } from "./core/teampick.ts";
import { countOpenStories, isOversized, savedTeamFor, withChoice } from "./core/teampick.ts";
import type { HostContext } from "./host/sdk.ts";
import { connect, getAccessToken, hostLog, inFrame, notifyFailed, notifyLoaded, onThemeChanged } from "./host/sdk.ts";
import { h } from "./ui/dom.ts";
import { spinner } from "./ui/kit.ts";
import { teamChooser } from "./ui/teampicker.ts";

async function boot(): Promise<void> {
  applyTheme(savedTheme());
  const params = new URLSearchParams(location.search);
  let host: HostContext | null = null;
  if (inFrame() && !params.has("demo")) {
    try {
      host = await connect();
      notifyLoaded(); // the frame is ours now; data follows with its own loading state
    } catch (e) {
      // served by the Marketplace inside Azure DevOps: say why, never fall back to made-up data
      if (/vsassets.io$|gallerycdn|visualstudio.com$/.test(location.hostname)) {
        throw new Error(`Could not connect to Azure DevOps: ${(e as Error)?.message ?? e}. Messages: ${hostLog.join(" | ") || "none"}`);
      }
      console.warn("No Azure DevOps host; using the demo data.", e);
    }
  }

  let api: Api;
  let project: string;
  let team: string;
  if (host) {
    const extensionId = host.extension?.publisherId && host.extension?.extensionId ? `${host.extension.publisherId}.${host.extension.extensionId}` : undefined;
    api = new RestApi({
      orgName: host.host.name,
      orgUrl: host.collectionUri,
      me: { id: host.user.id, displayName: host.user.displayName, uniqueName: host.user.name, descriptor: host.user.descriptor, imageUrl: host.user.imageUrl },
      demo: false,
      extensionId,
    }, getAccessToken);
    // the person's screen choices from their own Azure DevOps storage, so they follow them to any browser
    // ?readonly: the choices are read, never written back
    if (extensionId) await syncPrefs(params.has("readonly") ? readOnlyApi(api) : api).catch((e) => console.warn("Screen choices not read from Azure DevOps", e));
    applyTheme(savedTheme(), hostIsDark(host));
    onThemeChanged((t) => applyTheme(savedTheme(), hostIsDark({ ...host!, theme: t })));
    const key = `team:${host.host.name}`;
    const saved = prefs.get<SavedTeams>(key, {});
    project = host.project?.name ?? saved.project ?? "";
    if (!project) project = (await api.projects())[0]?.name ?? "";
    // a team just picked with the team button opens once, also in another project
    if (saved.next) { project = saved.next.project; prefs.set(key, withChoice(saved, project, saved.next.team)); }
    team = saved.next?.team ?? savedTeamFor(saved, project) ?? "";
    if (!team) {
      // no team saved for this project: ask, unless the host's team is one of yours and not too big
      ({ project, team } = await firstTeam(params.has("readonly") ? readOnlyApi(api) : api, project, host.team?.name));
      prefs.set(key, withChoice(prefs.get<SavedTeams>(key, {}), project, team));
    }
  } else {
    api = new DemoApi();
    const key = "team:fabrikam-demo";
    const saved = prefs.get<SavedTeams>(key, {});
    project = saved.next?.project ?? saved.project ?? DEMO.project;
    team = saved.next?.team ?? saved.team ?? DEMO.team;
    if (saved.next) prefs.set(key, withChoice(saved, project, team));
  }

  // ?readonly turns every change off: for looking at real data safely
  const readOnly = params.has("readonly");
  await startApp(readOnly ? readOnlyApi(api) : api, host, project, team, { readOnly });
}

/**
 * The first open in a project: the host's team opens directly when it is one of the person's teams and
 * holds at most 500 open stories; otherwise a page asks which team to open.
 */
async function firstTeam(api: Api, project: string, hostTeam: string | undefined): Promise<{ project: string; team: string }> {
  const root = document.getElementById("app")!;
  let note = "";
  if (hostTeam) {
    root.replaceChildren(h("div.boot", null, spinner("Finding your teams…")));
    const mine = await api.teams(project, { mine: true }).catch(() => []);
    if (mine.some((t) => t.name === hostTeam)) {
      const n = await countOpenStories(api, project, hostTeam).catch(() => -1);
      if (n >= 0 && !isOversized(n)) return { project, team: hostTeam };
      if (n >= 0) note = `${hostTeam} covers ${n.toLocaleString()} open stories (its area is probably the whole project). Choose a smaller team for a clearer board.`;
    }
  }
  return new Promise((resolve) => {
    const chooser = teamChooser({ api, project, team: hostTeam, page: true, onPick: (p, t) => resolve({ project: p, team: t }) });
    root.replaceChildren(h("div.choose-page", null,
      h("h2", null, "Choose a team"),
      h("p.muted", null, "Pick the team whose work you want to see. It is kept in this browser; change it later with the team button at the right end of the second line."),
      note ? h("p.choose-note", { role: "alert" }, note) : null,
      chooser.el));
    chooser.focus();
  });
}

boot().catch((e) => {
  console.error(e);
  notifyFailed(String((e as Error)?.message ?? e));
  document.getElementById("app")!.replaceChildren(h("div.empty.error", null, h("h3", null, "The dashboard could not start"), h("p", null, String((e as Error)?.message ?? e))));
});
