# Architecture

A free Azure DevOps extension: one hub page under **Boards** with many views of a team's work.
No runtime libraries, no framework, no Microsoft extension SDK. TypeScript source, built by Node alone.

```
Azure DevOps page ──(postMessage handshake, token)──▶ src/host/sdk.ts
                                                       │
src/main.ts ── RestApi (real, the person's token) ─────┤  or DemoApi (made-up data, outside Azure DevOps)
     │                                                 ▼
src/app/app.ts ── Workspace (one team's work, kept current by polling every 30 s)
     │             Settings (shared rules and pillars; personal AI key)   ChangeLog   Ai
     │             Actions → Writer (every write: rules, revision check, change log, Undo)
     ▼
src/views/*.ts ── one file per view (Board, Backlog, Roadmap, …), drawing with src/ui/*
```

## Folders

| Folder | What |
|---|---|
| `src/host/sdk.ts` | Our own client for the Azure DevOps host (handshake, token, theme, "loaded"). |
| `src/api/` | `api.ts` the `Api` interface every call goes through; `rest.ts` Azure DevOps REST; `demo.ts` demo data with the same interface; `normalize.ts` raw JSON → app shapes; `wiql.ts` queries; `types.ts` shared types. |
| `src/core/` | No page code. `workspace.ts` the loaded team; `model.ts` pure helpers; `rules.ts` move rules; `writes.ts` all writes; `filters.ts` filter logic shared by every page; `teampick.ts` the team chooser's lists, the team saved per project, the check for a team too big (more than 500 open stories); `checklist.ts` checklists per work item (shared storage); `templates.ts` standard child tasks; `settings.ts`; `changelog.ts`; `ai.ts`; `urgency.ts` the urgency score and its bars (pure; weights in the shared settings); `scheduler.ts` the Scheduler's rules (when a schedule is due, titles, who gets the story, where it goes; pure); `schedrun.ts` the Scheduler's claims (one story per occurrence, also when answers are lost, a tab sleeps or clocks differ; pure, storage passed in); `scope.ts` what counts as the team's own work (its areas); `timeaxis.ts` days and planning dates (pure); `workstyle.ts` the team's working style (Scrum, Kanban, Scrumban): the guess, the team's choice in shared storage, the layout and tab order it gives (the page's copy is `app/style.ts`). Pure logic gets a unit test in `test/`. |
| `src/ui/` | Page parts shared by views: `dom.ts` (`h()`, `svg()`, `icon()`), `kit.ts` (toast, dialog, popup, menu, avatar, pickers, switches…), `pagebar.ts` (lines 2 and 3 of every page: the Search | Ask AI field, then filters and buttons; person chips and switches), `filterbar.ts` (the filters every page shares: filter bar, person chips; logic in `core/filters.ts`), `tableexport.ts` (Excel and Copy: the sheets of a page, the "Download as Excel" dialog), `teampicker.ts` (the team chooser: first page and team button popup), `panel.ts` (details panel), `create.ts` (new item form), `actions.ts` (writes with messages and Undo), `aihelp.ts`, `askai.ts`, `sanitize.ts`, `tagchip.ts` (tag chips in colour and the palette), `hints.ts` (a tooltip for any control that has none),  `deleteask.ts` (delete a task after asking). |
| `src/app/` | `app.ts` the frame (top bar: team, style, tabs and "More" on the left; theme, Excel, Copy, About, settings on the right) and routing; `context.ts` the `App`, `View`, `ViewHandle` types; `scheduler.ts` the Scheduler's engine (claims, makes the due stories; started once by `app.ts`); `prtimes.ts` completed pull requests of a period and their first approvals, kept in the team's storage, and the team filter for pull requests. |
| `src/views/` | One `<id>.ts` per view, optional `<id>.css`. `index.ts` lists them in tab order. Helpers without a tab of their own: `childcounts.ts` (children of shown parents that are not loaded, for progress counts), the `*logic.ts` and `*model.ts` files (pure). |
| `src/styles/` | Shared CSS: tokens (light and dark), frame, controls, panel. |
| `tools/` | `build.mjs` (one HTML file), `dev.mjs` (local server), `package.mjs` (the .vsix). |
| `test/` | `node --test` unit tests (`*.test.ts`), run by Node's own TypeScript support. |

## Rules for code (the build checks most of them)

- **Only erasable TypeScript**: no `enum`, no `namespace`, no constructor parameter properties. Node strips the types.
- Imports are relative, end in `.ts`, are named (no default export), and have **no cycles**. Type-only imports use `import type`.
- An exported `let` is never reassigned (the build joins modules; importers keep the first value). Share state in objects.
- No libraries, no network calls except Azure DevOps (through `Api`) and the AI provider (through `Ai`).
- Text from Azure DevOps or AI that may contain HTML goes through `sanitize()`. Never set `innerHTML` with it.
- Planning dates (start, target, due, days off) are days, not moments: write them with `planIso(day)` (local midnight, as Azure DevOps's own date picker does) and read them with `planDay`/`planKey` from `src/core/timeaxis.ts`. Never write UTC midnight or compare `iso.slice(0, 10)`.
- Edits send what the person started from (`from` / `expect`), so a teammate's newer change is refused, never overwritten. Undo does the same.
- The team's storage is named by the project's and the team's ids (`core/teamstore.ts`), never by names alone: a rename must not lose data. Shared storage is readable by everyone in the organization who has the extension: never keep secrets there.
- Views never write to Azure DevOps directly: use `app.actions.*` (rules, revision check, change log, Undo, messages).
- Views never keep their own copy of work items: read `app.ws`, redraw in `update()`.
- Colors only from the CSS tokens in `src/styles/00-base.css` (`--panel`, `--ink`, `--muted`, `--line`, `--accent`, `--ok`, `--warn`, `--bad`, `--s1`…`--s8` for series), so light and dark both work. View CSS classes start with the view id (`.tree-…`), or nest under `.v-<id>`.
- Words on screen are plain and short. Every control has a `title` that says what it does.
- Work with any process (Agile, Scrum, Basic, CMMI, custom): never hard-code "User Story", "Active" or a field name. Use `ws.process.levels` (portfolio levels, requirement level, task level), `orderedStates()`, categories (`Proposed`, `InProgress`, `Resolved`, `Completed`, `Removed`) and `ws.process.fields` (order, effort, remaining…).

## A view

```ts
export const treeView: View = {
  id: "tree", title: "Backlog", /* tab: "Short" (optional) */ icon: "tree", group: "plan", about: "What it shows and how to use it (the tab's tooltip).",
  mount(el, app, params) {           // el is empty; draw into it
    const bar = pageBar(app, { search: { placeholder, title, onChange: () => draw() } }); // or pageBar(app): nothing to search
    bar.line2.append(fb.el, newBtn);          // after the field: filters, then buttons
    bar.end.append(count);                    // the right end: counts, status
    bar.line3.append(people.el, closedSwitch); // person chips, then switches (people.el and fb.el are placed first by CSS order)
    el.append(bar.el, body);                  // the bar first, built once
    const draw = () => { … bar.search.words() … };
    draw();
    return {
      update(changed, why) { draw(); },      // items changed (poll, a write, settings)
      select(id) { … },                       // the details panel shows this item (or null)
      unmount() { … },                        // remove document listeners and timers
      exportSheets() { … },                   // optional: what Excel and Copy take (default: every table shown)
    };
  },
};
```

There is no page title: the tab is the name. Excel and Copy in the top bar are off ("Nothing on this page to export") when the page has no rows.

What a view gets in `app` (see `src/app/context.ts`):

- `app.ws` — `Workspace`: `items` (Map id → `WorkItem`), `process`, `settings` (team areas, working days, backlog iteration), `iterations`, `board` (team board columns), `members`, `people()`, `children(id)`, `ancestors(item)`, `ofLevel(level)`, `requirementLevel()`, `taskLevel()`, `portfolioLevels()`, `currentIteration()`, `withRelations(ids)` (reads links: dependencies, pull requests), `itemUrl(id)`, `project`, `team`, `projectId`, `api`.
  Only the team's open items and those closed in the last 30 days are loaded. For history (metrics) query yourself: `app.api.query(project, spec)` then `app.api.items(project, ids)`.
- `app.actions` — `setField`, `setFields`, `move(id, {state} | {column})`, `reparent`, `reorder(id, previousId, nextId)`, `assign`, `addDependency`, `removeDependency`, `create`, `comment`, `addStandardChildren(parentId, template)`, `checklists` (read) and `changeChecklist(id, change, what)`.
- `app.openItem(id)` opens the details panel; `app.navigate(viewId, params)`.
- `app.settings.shared` (rules, pillars, staleDays, closedDays, boardMode, checklists, childTemplates) and `app.settings.saveShared(patch)`; `app.settings.user.ai`.
- `app.log` — every write reports here (no longer stored; the Change log page was removed); `app.ai` — AI help (`enabled`, `ask()`).
- `src/ui/kit.ts`: `toast`, `dialog`, `confirm`, `popup`, `menu`, `avatar`, `personPicker`, `itemPicker`, `typeMark`, `stateMark`, `itemLink`, `toggle`, `select`, `segmented`, `spinner`, `empty`, `failed`, `help`, `busy`. `src/ui/create.ts`: `createItem(app, { types, parentId, iteration })`.
- Shared CSS classes: `.page-bar` (from `pageBar()`), `.toolbar`, `.card-box`, `.grid-cards`, `.stat`, `table.data`, `.btn`, `.btn.primary`, `.btn.small`, `.chip`, `.tag`, `.input`, `.muted`, `.small`, `.mono`.

## Commands

```
node tools/build.mjs         # dist/index.html (one file)
node tools/dev.mjs           # http://127.0.0.1:4320/ demo; /host.html?org=…&project=…&team=… real data via az login
npm test                     # unit tests
npm run typecheck            # TypeScript check (downloads the compiler with npx; not a dependency)
node tools/package.mjs       # dist/*.vsix for the Marketplace
npm run qa:demo              # smoke test of the built page on the demo data (needs Playwright)
```
