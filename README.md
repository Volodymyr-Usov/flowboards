# Flowboards for Azure DevOps

A free, open-source Azure DevOps extension: one page under **Boards** that shows a team's work in many
ways and lets you change it in place — a story map board, backlog tree, roadmap, dependencies, calendar, a
**Scheduler** that creates the team's recurring stories, sprint planning, flow metrics and forecast, pull requests,
health checks and tag tidying.

Code and issues: <https://github.com/Volodymyr-Usov/flowboards>. Made by Volodymyr Usov: [usovvova.com](https://usovvova.com).
To try it without installing, run `node tools/dev.mjs`: the same extension on made-up data in your browser.

![The board, in dark mode](images/screens/board-dark.png)

**The board, in dark mode.** Pick a Feature and its stories light up, joined to it by lines, with its details open on the right: stories, dependencies and pull requests. Flowboards follows Azure DevOps's light or dark theme.

- No libraries and no framework. TypeScript, built by Node alone into one HTML file (about 150 KB zipped).
- Runs inside Azure DevOps with your own sign-in. Nothing to host, no token to paste.
- Works with every process: Agile, Scrum, Basic, CMMI and inherited ones.
- Light and dark, following Azure DevOps.

## The five things teams notice first

1. **"When will it be done?" as a date with a likelihood.** A Monte Carlo forecast from the team's real pace ("85% likely by 14 Nov"), and a "likely done by" date on every Feature and Epic of the Roadmap, red when it will probably miss its target.
2. **A board that tells the story, and how urgent it is.** A story map and a board with stories joined to their Feature, days in the column, task progress, pull requests, tags in colour and five small **urgency bars** on the right edge of every story: how important it is, how long it waits, how near its sprint's end and its deadline are, and what waits for it (you set what counts).
3. **Rules that live in the columns.** What a story needs before it enters a column ("Ready needs a description", "Active needs a task") is set once; the ⚠ on a card says which rule it still misses, a move that breaks a rule stops and offers to fix what is missing right there.
4. **A Story Scheduler for recurring stories.** The team writes its routine work once (a weekly review, a sprint kick-off, a release checklist) and the stories appear by themselves, in the sprint and board column you choose, with their tasks. Owners rotate or are drawn at random; missed ones are made later, up to a week back.
5. **Flow metrics and pull request times, for your team, without setup.** Throughput, cycle time, work-in-progress age, cumulative flow, a forecast, and how long pull requests wait for approval and take to merge, for any period you choose, counting your team's work and nobody else's.

## Everything it does

- **Plan:** Board (columns, taskboard, story map), Backlog tree (first 150 rows, then more), Roadmap across teams, Dependencies, Calendar (target and due dates, days off, team events, the stories the Scheduler will make), Sprint planning with capacity, burndown and a report, Retro, planning-poker Estimate, the Story Scheduler.
- **Measure:** Flow (throughput, cycle time, age, cumulative flow, Monte Carlo forecast, pull request times, custom periods), Pull requests (the team's by default, with age, reviewers and who they wait on), Strategy pillars.
- **Check:** Health checks with a fix button for each finding (the team's own checks too), Tags (merge, rename, delete, colour), a Recycle tab that restores several items at once. Pages for a big project start on your team and show 100–150 rows at a time.
- **Govern:** rules on moves with inheritance from column to column, checklists (a definition of done), the team's standard tasks in one click, a Team tab that says who really counts as a member.
- **Priority:** the urgency bars, and a Priority tab where the team weighs priority, Feature priority, waiting time, sprint end, blockers, value and deadlines.
- **Extremely flexible:** almost everything on the page can be shown, hidden or moved to taste: every tab, every control of the two bars, every Board column (a small eye and arrows to bring it back), card details, colouring rules, a switch for the ⚠ marks, filters on any property, the working style (Scrum, Kanban, Scrumban). Settings are in tabs, each setting has an icon and a description, your choices are yours alone and one button resets the layout. Pointing at anything tells you what it is.
- **Everywhere:** the same search, person chips and filters on every page; edit in place with autosave and Undo; Excel or Copy for any page; light and dark.
- **Safe to try.** Free and MIT-licensed. Runs in your browser on your own sign-in, with nothing to host. It reads code but never writes it, and your data stays in Azure DevOps.

Azure DevOps's own boards, burndown, velocity and Delivery Plans remain where they are; Flowboards adds to them, it does not replace them.

## Views

| Group | View | What it shows |
|---|---|---|
| Plan | Board | The team's board columns with story cards joined by lines to their Feature; Features grouped by Epic. Drag to change column, priority or parent. Days in column, tasks, pull requests (the story's own and its tasks', each once; count all, open or completed; click for the list with links), what is missing, quick owner, new items. Switch on **Story map**: Features across the top, one row per sprint; drag a card to another row to move it (with its open tasks) to that sprint. Search lifts matching cards; person chips and filters hide the rest. **Tags are drawn in colour** (click a tag to choose another colour; off in Settings), a green **new** marks what was created today (otherwise 0d), and the **Taskboard** carries the same extras as the Board: colouring by age and what is missing, age since created | in column, pull requests, points, the parent Feature (a switch) and a bin on every task. The details panel's buttons (Close, Change, New task…) are dark blue keys; on top of a story it has **Split** (in half, tasks too) and **Follow-up** (a new story with the same description), and its tasks can be dragged onto another story card of the Board. |
| | Backlog | Epics → Features → stories → tasks as a tree with roll-ups; drag to re-parent or reorder; person chips and filters on any property (type, state, owner, tags, sprint, dates, numbers, any field). Draws the first 150 rows with **Show more** (a search that finds fewer than 150 shows them all). A priority score column ("weighted shortest job first": business value + time criticality + risk reduction, divided by size), sorted with one click; shown when the process has these fields. |
| | Roadmap | Epics and Features on a time line with sprints; drag to reschedule; dependency arrows; a "likely done by" date for each, from the team's pace, red when it will probably miss its target. Add other teams, of this project or others, as read-only row groups: arrows between teams, and a red mark where work starts before what it waits for ends. Search and filters. |
| | Dependencies | A graph of what waits for what; blocked work and cycles flagged. Search and filters. |
| | Calendar | Target and due dates, sprint starts and ends, people's days off, team days off and team events; add and remove them in place. Stories the **Scheduler** will make show as small icons on their day (a click opens that schedule). Search, person chips (also for days off) and filters. |
| | Scheduler | The team's recurring stories. A schedule says **when**: on a date; weekly (chosen weekdays, every N weeks); monthly (a day, or the last day; every N months); a date as an **outlook** (the story appears some days ahead and carries the date as its target); at the start, middle or end of every Nth sprint (moved by some days); or at the start or end of a month or quarter. And a **template**: title (with `{date}`, `{day}`, `{week}`, `{month}`, `{quarter}`, `{year}`, `{sprint}`), description, tags, owner (nobody, a person, rotating through the team, or drawn at random), place (backlog, current sprint, next sprint, the sprint of that date, or one chosen sprint), the board column it starts in, and tasks (none, the team's standard tasks, or its own list, edited like a story's Tasks section). Whoever has Flowboards open makes the due stories, one claim per occurrence, so the team never gets doubles; what was missed is made later, up to a week back and never before the schedule existed. Anyone in the team can add, change, pause, run now or delete a schedule. Stories only: tasks are too fine. |
| | Sprint | The sprint goal at the top, edited in place; backlog and sprint side by side, with search, person chips and filters; capacity per person, burndown; at the end of a sprint one button moves unfinished stories to the next sprint, or splits a story so its finished work stays; a one-page sprint report (goal, finished, still open, numbers) to print, save as PDF or download as Excel. |
| | Retro | Sprint retrospectives: notes (anonymous if you like, hidden until revealed), votes, action items that become tasks; the next one opens with the last one's actions. |
| | Estimate | Planning poker: the team votes in secret on a story, all votes show at once, the agreed number is saved to the story. |
| Measure | Flow | Throughput, cycle time, work-in-progress age, cumulative flow (by state or by board column), Monte Carlo forecast, and the pull requests' wait for approval and time to merge (medians, kept in the team's storage). The page says it counts the team only. Period: 4, 12, 26 or 52 weeks, or **Custom** (1 to 156 weeks). |
| | Pull requests | Starts on **My team**: the pull requests its members wrote or were asked to review (who the members are: Settings > Team), one click for everyone; 150 rows at a time with Show more. Open pull requests with age, reviewers and who they wait on; a **Review** / **Open** button that opens it on Azure DevOps's page (approving, merging and abandoning happen there: the dashboard only reads code); a filter by reviewer group; a weekly chart of the wait for the first approval and the time to merge. The stories each one is linked to (a linked task shows as its story); for one with no link, likely stories (a number in the branch, title or description, or a similar title) with a Link button; "New pull request" opens Azure DevOps's own create page. |
| | Strategy | Strategy pillars → Epics → Features with work closed per month; add a pillar with the "Add pillar" card, and change a pillar's name, description and colour (or remove it) with the gear on its card. |
| Check | Health | Work without a parent, owner, description or estimate; stale work; states that do not fit. Person chips and filters. Starts on **My team**'s areas ("All loaded" adds other areas' parents), 100 findings per group at a time. |
| | Tags | Likely duplicate, unused and rare tags: count, rename, merge, delete. Starts on **My team** (the tags the team uses), 100 rows at a time; "Whole project" is one click away. |
| | Recycle Bin (tab "Recycle") | The project's deleted work items: who deleted them and when; search; restore one or several at once (with Undo). Shows **My team**'s items by default (or the whole project), 100 rows at a time with Show more. Tasks can be deleted from a story's details panel (asks first). |

![Flow, in light mode](images/screens/flow-light.png)

**Flow, in light mode.** Throughput, cycle time and work-in-progress age of the last 12 weeks, read from the team's own work items.

**The same layout on every page, in two lines.** The top line starts with the **team** (a fixed, narrow button), then the team's working **style**, then the tabs (short names: Pull, Recycle, Dependency; tabs that do not fit go under "More"), and at the right end the colour theme, **Excel**, **Copy**, **Reset** (the layout back to the default), **About** (version, author with a small photo, code, privacy) and **Settings**. The second line starts with the **person chips** and the **Filter** button (the priority controls), then the **Search** field (it filters the page as you type; on the Board it highlights, and Enter shows only the matches), then the page's own buttons and choices. What does not fit the width goes under a **⋯** button at the end of the line. Every tab and control shows a tiny **×** when you point at it, and a click on it hides it; **Settings > Menu & bars** lists them all (menu titles drawn like the top bar, then every control with its icon and a description), **Cards** and **Columns** hold the Board's switches, and **My settings** has **Reset my settings to defaults**. Changes in Azure DevOps show within about 30 seconds by themselves; a message says so if they cannot be read.

**Choosing a team.** The first open in a project asks which team to show: **your teams** first, then **all teams** of the project, with a search box and a project list (a team opens with a click, or with the arrows and Enter). The team Azure DevOps opened goes straight in when it is one of yours and holds at most 500 open stories. The choice is kept in the browser, per project; the team button at the start of the top line opens the same list. A team with more than 500 open stories (its area is probably the whole project) gets a note with **Choose a team**, and the Board stays fast: each column draws its first 50 cards with **Show more** below (story map: 20 per cell, 30 Features at first); search, filters, person chips, Excel and "Pick my next" still use every card.

Also: **the same filters on every page with work items** (person chips: click = only this person, right-click = hide; "Filter" on any property; each page keeps its own in the browser),
**rules on moves** (from one state or column to another: which fields must be filled, what else the item needs, and who alone may make the move),
**checklists** on work items (a "definition of done" to tick in the details panel; the team keeps a default list per work item type, and the rule "Checklist done" can stop a move until every item is ticked),
**standard tasks** (one click adds the team's usual tasks, like "Write tests", under a story; titles already there are skipped),
**Excel and Copy** in the top bar for the page shown (the Board's cards, or every table on the page, one sheet each, as you see them, filters included), and the **details panel** (all fields, description, acceptance criteria, checklist, children, dependencies, pull requests,
comments, history). AI help (drafts and questions with your own key) is switched off in this release and comes later (`AI_FEATURES` in `src/core/ai.ts`).

## Install

From the Visual Studio Marketplace (search "Flowboards"), or build the package yourself:

```
node tools/package.mjs          # dist/<publisher>.flowboards-<version>.vsix
```

Then upload it on your publisher page at <https://marketplace.visualstudio.com/manage> (change
`publisher` in `vss-extension.json` to your own), share it with your organization and install it.
The page appears under **Boards → Flowboards**.

The extension asks for these permissions: work items (read and write), code (read: pull requests),
project and team (read), and graph (read: profile pictures).

## Develop

Node 22.18 or newer. No `npm install` needed.

```
node tools/dev.mjs              # http://127.0.0.1:4320/  — demo data
                                # http://127.0.0.1:4320/host.html?org=ORG&project=PROJECT&team=TEAM
                                #   — real data, signed in with the Azure CLI (az login)
npm test                        # unit tests (Node runs the TypeScript directly)
npm run typecheck               # optional: downloads the TypeScript compiler with npx
node tools/build.mjs            # dist/index.html
node tools/package.mjs          # dist/*.vsix
```

How the code is organized: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Privacy: [docs/PRIVACY.md](docs/PRIVACY.md).

## License

MIT. See [LICENSE](LICENSE).
