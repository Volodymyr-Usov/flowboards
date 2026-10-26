// A smoke test of the built page on the demo data: every page loads without errors at three widths, and the
// main things people do still work (bars, crosses, Settings, column eye and arrows, a new task typed in
// place, Close and Back in the details panel, reset). Nothing is written to Azure DevOps (it is the demo).
//
//   npm run build && node tools/qa-demo.mjs        (PLAYWRIGHT = path of the playwright module, CHROMIUM = browser)
//
// Exit code 1 when a check fails; every check prints one line.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const page_url = (hash) => pathToFileURL(resolve("dist/index.html")).href + `?demo#${hash}`;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`); if (!ok) failed++; };
const open = async (w, hash = "board") => {
  const page = await browser.newPage({ viewport: { width: w, height: 800 } });
  page.errs = [];
  page.on("pageerror", (e) => page.errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.errs.push(m.text().slice(0, 140)); });
  await page.goto(page_url(hash));
  await page.waitForTimeout(1500);
  return page;
};

// 1. every page, three widths: no errors, no sideways scroll, the top bar stays one line
const VIEWS = ["board", "tree", "roadmap", "deps", "calendar", "scheduler", "sprint", "retro", "poker", "flow", "prs", "strategy", "health", "tags", "recycle", "settings", "about"];
for (const w of [1800, 1000, 700]) {
  const page = await open(w);
  const bad = [];
  for (const v of VIEWS) {
    await page.evaluate((x) => { location.hash = "#" + x; }, v);
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({ hs: document.documentElement.scrollWidth > innerWidth + 1, top: document.querySelector(".topbar").getBoundingClientRect().height }));
    if (r.hs || r.top > 60) bad.push(`${v}${r.hs ? " sideways" : ""}${r.top > 60 ? " tall" : ""}`);
  }
  check(`every page at ${w}px: no sideways scroll, one-line top bar`, !bad.length, bad.join(", "));
  check(`every page at ${w}px: no console errors`, !page.errs.length, [...new Set(page.errs)].join(" | "));
  await page.close();
}

// 2. the top bar: team, style, then the tabs; short tab names
{
  const page = await open(1800);
  const order = await page.evaluate(() => [...document.querySelector(".topbar").children].map((e) => e.className.split(" ")[0]).join(","));
  check("top bar order: lead (team, style), tabs, tools", /^top-lead,tabs/.test(order), order);
  const tabs = (await page.locator(".tab").allTextContents()).map((t) => t.trim());
  check("short tab names", tabs.includes("Recycle") && tabs.includes("Pull") && tabs.includes("Dependency") && !tabs.includes("Recycle Bin"));
  const w = await page.locator(".team-btn").evaluate((e) => e.getBoundingClientRect().width);
  check("team button is 140px wide", Math.round(w) === 140, String(w));
  await page.close();
}

// 3. the page bar: People first, then Filter; the tiny cross hides a control; Settings brings it back
{
  const page = await open(1800, "tree");
  const first = await page.evaluate(() => { const r = (s) => document.querySelector(s)?.getBoundingClientRect().left ?? 1e9; return [r('[data-blk="people"]'), r('[data-blk="filters"]'), r('[data-blk="search"]')]; });
  check("page bar: People, then Filter, then Search", first[0] < first[1] && first[1] < first[2], first.map(Math.round).join(" < "));
  const b = await page.locator("[data-blk=excel]").boundingBox();
  const cross = () => page.locator("[data-blk=excel]").evaluate((e) => getComputedStyle(e, "::after").opacity);
  await page.mouse.move(b.x - 300, b.y + 200);
  await page.waitForTimeout(300);
  check("the cross is hidden until you point at the control", Number(await cross()) === 0);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(300);
  check("the cross shows while the pointer is on the control", Number(await cross()) > 0.5);
  await page.mouse.click(b.x + b.width, b.y);
  await page.waitForTimeout(300);
  check("the cross hides Excel", !(await page.locator("[data-blk=excel]").isVisible()));
  await page.evaluate(() => { location.hash = "#settings"; });
  await page.waitForTimeout(800);
  await page.locator('label:has(input[data-fk="blk:excel"])').click();
  check("Settings brings Excel back", await page.locator("[data-blk=excel]").isVisible());
  await page.locator('label:has(input[data-fk="blk:crosses"])').click();
  check("Hide crosses", await page.evaluate(() => document.body.classList.contains("no-xs")));
  await page.locator(".top-set").click();
  await page.waitForTimeout(400);
  check("the gear again leaves Settings", !page.url().endsWith("#settings"));
  await page.close();
}

// 4. the Board: column eye and arrows; a new task typed in place; Close and Back
{
  const page = await open(1800);
  await page.getByRole("radio", { name: "Board", exact: true }).click();
  await page.waitForTimeout(800);
  const heads = () => page.$$eval(".col-head", (h) => h.map((x) => x.dataset.col));
  const n0 = (await heads()).length;
  await page.locator('.col-head[data-col="Active"] .col-eye').click();
  await page.waitForTimeout(400);
  check("the eye hides a column and arrows appear", (await heads()).length === n0 - 1 && (await page.locator(".col-reveal").count()) >= 2);
  await page.locator(".col-reveal.right").first().click();
  await page.waitForTimeout(400);
  check("an arrow brings it back", (await heads()).length === n0);

  const card = page.locator(".card", { has: page.locator(".c-bar") }).first();
  const id = await card.getAttribute("data-id");
  await card.locator(".add").click();
  await page.waitForTimeout(500);
  check("+ on a story: the task list opens and the cursor is in the new task", await page.evaluate(() => document.activeElement?.classList.contains("draft-task")));
  await page.keyboard.type("QA task one");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  check("Enter saves and starts another", await page.evaluate(() => document.activeElement?.classList.contains("draft-task") && !document.activeElement.value));
  await page.keyboard.type("QA task two");
  await page.mouse.click(1500, 700);
  await page.waitForTimeout(1200);
  const titles = await page.locator(`.card[data-id="${id}"] .m-title`).allTextContents();
  check("a click elsewhere saves the typed task", titles.includes("QA task one") && titles.includes("QA task two"), titles.join(", "));

  await page.locator(`.card[data-id="${id}"] .c-title`).click();
  await page.waitForTimeout(700);
  await page.locator(".child-list .item-link").first().click();
  await page.waitForTimeout(500);
  check("opening a task shows a Back arrow", (await page.locator(".ph-back").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check("Esc goes back to the story", await page.locator(".panel-head .ph-top .mono").first().textContent().then((t) => t.includes(id)));
  await page.locator(".close-item").click();
  await page.waitForTimeout(1000);
  check("Close closes the story and the panel", await page.locator(".panel").isHidden());
  check("no console errors on the Board flows", !page.errs.length, [...new Set(page.errs)].join(" | "));
  await page.close();
}

// 5. a new Feature holds its place in the Epic box until the form is closed
{
  const page = await open(1800);
  await page.getByRole("radio", { name: "Board", exact: true }).click();
  await page.waitForTimeout(800);
  const box = page.locator(".epic-box").first();
  await box.locator(".epic-head .add").click();
  await page.waitForTimeout(600);
  check("a new Feature's place shows while its form is open", (await box.locator(".feat.feat-new").count()) === 1);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(500);
  check("Cancel takes it away", (await box.locator(".feat.feat-new").count()) === 0);
  await page.close();
}

// 6. the Scheduler: a schedule is saved, its first story is made by the engine, Make now works, delete asks first
{
  const page = await open(1800, "scheduler");
  await page.getByRole("button", { name: "New schedule" }).first().click();
  await page.waitForTimeout(400);
  await page.getByRole("textbox", { name: "Name of the schedule" }).fill("QA weekly");
  await page.getByRole("textbox", { name: "Title of the story" }).fill("QA review {date}");
  await page.locator(".sch-f select", { has: page.locator("option[value=outlook]") }).selectOption("outlook");
  await page.waitForTimeout(300);
  check("the form previews when the schedule fires", /Next|due today/.test(await page.locator(".sch-form").innerText()));
  await page.locator(".sch-f select", { has: page.locator("option[value=custom]") }).selectOption("custom");
  await page.getByRole("button", { name: /New Task/ }).click();
  await page.keyboard.type("Prepare");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Send");
  check("the task list is a list of rows; Enter adds the next row", (await page.locator(".sch-tasks .child-list li").count()) === 2);
  await page.locator(".sch-f select", { has: page.locator("option[value^='fixed:']") }).selectOption({ index: 4 });
  await page.locator(".sch-f select", { has: page.locator("option", { hasText: "Where a new story starts" }) }).selectOption({ index: 2 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(800);
  check("a saved schedule shows as a card", (await page.locator(".v-scheduler .sch-card").count()) === 1);
  await page.waitForTimeout(7500);
  const card_text = await page.locator(".v-scheduler .sch-card").innerText();
  check("the engine made the due story once", /Last made\s+#\d+/.test(card_text), card_text.replace(/\s+/g, " ").slice(0, 400));
  check("the card tells the sprint, the starting column and the tasks", /2 own tasks/.test(card_text) && /starts in/.test(card_text));
  await page.evaluate(() => { location.hash = "#calendar"; });
  await page.waitForTimeout(1200);
  check("the Calendar shows scheduled stories as small icons", (await page.locator(".v-calendar .cal-sched").count()) > 0);
  await page.locator(".v-calendar .cal-sched").first().click();
  await page.waitForTimeout(800);
  check("an icon opens its schedule", page.url().includes("#scheduler") && (await page.locator(".v-scheduler .sch-card.focus").count()) === 1);
  await page.locator(".v-scheduler .sch-card button[aria-label='Delete the schedule']").click();
  await page.waitForTimeout(300);
  await page.locator(".backdrop button", { hasText: "Delete" }).last().click();
  await page.waitForTimeout(800);
  check("deleting removes the card", (await page.locator(".v-scheduler .sch-card").count()) === 0);
  check("no console errors on the Scheduler flows", !page.errs.length, [...new Set(page.errs)].join(" | "));
  await page.close();
}

// 7. tags in colour, the new mark, the Taskboard's extras, the bin on a task, the panel's blue keys
{
  const page = await open(1800);
  // the New column on: the Board's choices are kept per team ("ado-dashboard:board:<project>/<team>"), the old key is read once
  await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k === "ado-dashboard:board" || k.startsWith("ado-dashboard:board:"));
    for (const k of new Set(["ado-dashboard:board", ...keys])) {
      let v = {};
      try { v = JSON.parse(localStorage.getItem(k) ?? "{}") ?? {}; } catch { v = {}; }
      localStorage.setItem(k, JSON.stringify({ ...v, incoming: true }));
    }
  });
  await page.reload();
  await page.waitForTimeout(1500);
  await page.getByRole("radio", { name: "Board", exact: true }).click();
  await page.waitForTimeout(800);
  check("tags are drawn in colour", (await page.locator("button.tag.tg").count()) > 0);
  const before = await page.locator("button.tag.tg").first().evaluate((e) => e.style.getPropertyValue("--tg"));
  await page.locator("button.tag.tg").first().click();
  await page.locator(".tg-sw").nth(before === "var(--s7)" ? 1 : 6).click();
  await page.waitForTimeout(300);
  const after = await page.locator("button.tag.tg").first().evaluate((e) => e.style.getPropertyValue("--tg"));
  check("a click on a tag picks another colour", before !== after, `${before} -> ${after}`);
  await page.locator("[data-blk=new] button, button[data-blk=new]").first().click();
  await page.waitForTimeout(400);
  await page.locator(".backdrop").getByRole("textbox").first().fill("QA new story");
  await page.locator(".backdrop").getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForTimeout(1200);
  check("what was created today shows a green new", (await page.locator(".new-mark").count()) >= 1);
  check("the panel's Close is a dark blue key", await page.locator(".panel .close-item").evaluate((e) => /gradient/.test(getComputedStyle(e).backgroundImage)));
  await page.keyboard.press("Escape");
  await page.locator(".card .c-bar").first().click();
  await page.waitForTimeout(400);
  const bins = await page.locator(".mini .child-del").count();
  await page.locator(".mini .child-del").first().click();
  await page.locator(".backdrop button", { hasText: "Delete" }).last().click();
  await page.waitForTimeout(800);
  check("the bin left of a task deletes it after asking", (await page.locator(".mini .child-del").count()) === bins - 1);
  await page.getByRole("radio", { name: "Taskboard", exact: true }).click();
  await page.waitForTimeout(1500);
  const tb = await page.evaluate(() => ({ sc: document.querySelectorAll(".tb-story .clock").length, tc: document.querySelectorAll(".tb-task .clock").length, pr: document.querySelectorAll(".tb-story .c-pr").length, bin: document.querySelectorAll(".tb-task .child-del").length, pts: document.querySelectorAll(".tb-story .c-pts").length }));
  check("the Taskboard shows age, pull requests, points and the bin", tb.sc > 0 && tb.tc > 0 && tb.pr > 0 && tb.bin > 0 && tb.pts > 0, JSON.stringify(tb));
  check("no console errors on these flows", !page.errs.length, [...new Set(page.errs)].join(" | "));
  await page.close();
}

// 8. Recycle: the team's items by default, the whole project one click away
{
  const page = await open(1800, "recycle");
  await page.waitForTimeout(1500);
  check("Recycle starts on My team and lists its items", (await page.locator(".rb-table tbody tr").count()) > 0 && (await page.locator(".segmented [aria-checked=true], .segmented .on").first().innerText()).includes("My team"));
  await page.locator(".segmented").getByText("Project", { exact: true }).click();
  await page.waitForTimeout(500);
  check("Project shows every deleted item", (await page.locator(".rb-table tbody tr").count()) > 0);
  check("no console errors on the Recycle page", !page.errs.length, [...new Set(page.errs)].join(" | "));
  await page.close();
}

// 8b. Reset layout, the Backlog's 150 rows, the Flow's custom period, the author's photo
{
  const page = await open(1800, "board");
  check("a Reset icon sits next to Settings", (await page.locator(".top-reset").count()) === 1);
  await page.evaluate(() => { location.hash = "#tree"; });
  await page.waitForTimeout(1200);
  const rows = await page.locator("tr.tree-row").count();
  check("the Backlog draws at most 150 rows", rows <= 150 + 50, String(rows));
  await page.evaluate(() => { location.hash = "#flow"; });
  await page.waitForTimeout(1200);
  await page.locator(".flow-period").getByText("Custom", { exact: true }).click();
  await page.waitForTimeout(400);
  await page.locator(".flow-weeks").fill("8");
  await page.locator(".flow-weeks").press("Tab");
  await page.waitForTimeout(1200);
  check("Flow has a Custom period with its own weeks", (await page.locator(".flow-weeks").inputValue()) === "8" && (await page.locator("body").innerText()).includes("8 weeks"));
  await page.evaluate(() => { location.hash = "#about"; });
  await page.waitForTimeout(600);
  check("About shows the author (photo or initials)", (await page.locator(".ab-author .ab-photo").count()) === 1);
  check("no console errors on these pages", !page.errs.some((e) => !/author\.jpg|Failed to load resource/.test(e)), [...new Set(page.errs)].join(" | "));
  await page.close();
}

// 9. Tags and Health start on My team too; the whole project is one deliberate click away
{
  for (const [view, label] of [["tags", "Whole project"], ["health", "All loaded"]]) {
    const page = await open(1800, view);
    await page.waitForTimeout(1200);
    const seg = page.locator(".segmented", { has: page.getByText("My team", { exact: true }) });
    check(`${view}: starts on My team`, (await seg.count()) === 1 && (await seg.locator("[aria-checked=true], .on").first().innerText()).includes("My team"));
    await seg.getByText(label, { exact: true }).click();
    await page.waitForTimeout(500);
    check(`${view}: ${label} switches without errors`, !page.errs.length, [...new Set(page.errs)].join(" | "));
    await page.close();
  }
}

// 10. later features: Settings tabs, urgency bars, rules driving the ⚠ with Fix and move, a task dragged onto a card, Split and Follow-up,
//     the team's pull requests, Flow's scope note and pull request card
{
  const page = await open(1600, "settings");
  for (const t of ["menu", "cards", "columns", "team", "priority", "rules", "checklists", "tasks", "board", "strategy", "mine"]) {
    await page.evaluate((x) => { location.hash = "#settings?tab=" + x; }, t);
    await page.waitForTimeout(350);
    if (!(await page.locator(`.set-tab[data-tab="${t}"][aria-selected=true]`).count()) || !(await page.locator(".set-pane > *").count())) check(`Settings tab ${t} draws`, false);
  }
  check("Settings: all eleven tabs draw", !page.errs.length, [...new Set(page.errs)].join(" | "));
  await page.evaluate(() => { location.hash = "#settings?tab=rules"; });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /suggested/i }).first().click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(800);
  await page.evaluate(() => { location.hash = "#board"; });
  await page.waitForTimeout(1000);
  await page.getByRole("radio", { name: "Board", exact: true }).click();
  await page.waitForTimeout(1200);
  check("urgency bars show on stories", (await page.locator(".card .urg").count()) > 0);
  check("the ⚠ follows the column rules and names the rule", /Rule of/.test((await page.locator(".card .warn-mark").first().getAttribute("title")) ?? ""));
  await page.locator(".top-warn").click();
  await page.waitForTimeout(400);
  check("the top bar switch hides the ⚠", (await page.locator(".card .warn-mark").count()) === 0);
  await page.locator(".top-warn").click();
  await page.waitForTimeout(400);
  const card = page.locator('.col[data-col="Active"] .card:has(.warn-mark)').first();
  await card.locator(".c-title").click();
  await page.waitForTimeout(800);
  check("the story's details have Split and Follow-up", (await page.locator(".panel .ph-tool").count()) === 2);
  await page.locator('.panel select[aria-label="Column"]').selectOption({ label: "Review (Resolved)" });
  await page.waitForTimeout(1000);
  check("a blocked move offers to fix what is missing", (await page.locator(".backdrop .rule-fill").count()) === 1 && /Fix and move/.test(await page.locator(".backdrop").innerText()));
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(500);
  // a task dragged from the panel onto another story's card
  const rows = page.locator(".panel .child-list li.drag-task");
  if (await rows.count()) {
    const taskId = (await rows.first().locator(".item-link .mono").innerText()).replace("#", "");
    const dstId = await page.locator(".card").nth(8).getAttribute("data-id");
    await page.evaluate(({ taskId, dstId }) => {
      const li = [...document.querySelectorAll(".panel .child-list li.drag-task")].find((x) => x.textContent.includes("#" + taskId));
      const dt = new DataTransfer();
      li.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const c = document.querySelector(`.card[data-id="${dstId}"]`);
      c.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      c.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, { taskId, dstId });
    await page.waitForTimeout(1500);
    check("a task dragged onto a card opens its tasks with the moved one in bold", (await page.locator(`.card[data-id="${dstId}"] .mini.moved`).count()) === 1);
  }
  // Follow-up
  await page.evaluate(() => { location.hash = "#board"; });
  await page.locator('.panel .ph-tool[aria-label="Follow-up"]').click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1200);
  check("Follow-up makes a story (a message with Undo)", /Follow-up made/.test((await page.locator(".toast").allInnerTexts()).join(" ")));
  check("no console errors on these flows", !page.errs.length, [...new Set(page.errs)].join(" | "));
  await page.close();
}
{
  const page = await open(1600, "prs");
  await page.waitForTimeout(2200);
  check("Pull requests: My team and Everyone are on the bar", (await page.locator(".segmented:visible", { has: page.getByText("My team", { exact: true }) }).count()) === 1);
  await page.evaluate(() => { location.hash = "#flow"; });
  await page.waitForTimeout(3500);
  check("Flow says whose work it counts", /Phoenix Team only/.test(await page.locator(".flow-scope-note").innerText()));
  check("Flow has the pull request times card", (await page.locator(".flow-prs .flow-tile").count()) >= 5);
  check("no console errors on Pull requests and Flow", !page.errs.length, [...new Set(page.errs)].join(" | "));
  await page.close();
}

// 11. reset my settings
{
  const page = await open(1800, "settings");
  await page.locator('label:has(input[data-fk="blk:copy"])').click();
  await page.evaluate(() => { location.hash = "#settings?tab=mine"; });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Reset my settings to defaults" }).click();
  await page.waitForTimeout(400);
  await page.locator(".backdrop button", { hasText: "Reset" }).last().click();
  await page.waitForTimeout(2500);
  check("reset brings the defaults back", await page.locator("[data-blk=copy]").isVisible());
  await page.close();
}

await browser.close();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
