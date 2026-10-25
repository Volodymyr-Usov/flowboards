// Every view, in the order of the tabs.
import type { View } from "../app/context.ts";
import { boardView } from "./board.ts";
import { treeView } from "./tree.ts";
import { roadmapView } from "./roadmap.ts";
import { depsView } from "./deps.ts";
import { calendarView } from "./calendar.ts";
import { sprintView } from "./sprint.ts";
import { retroView } from "./retro.ts";
import { pokerView } from "./poker.ts";
import { flowView } from "./flow.ts";
import { prsView } from "./prs.ts";
import { strategyView } from "./strategy.ts";
import { healthView } from "./health.ts";
import { tagsView } from "./tags.ts";
import { settingsView } from "./settings.ts";
import { aboutView } from "./about.ts";
import { recycleBinView } from "./recyclebin.ts";
import { schedulerView } from "./scheduler.ts";

export const VIEWS: View[] = [boardView, treeView, roadmapView, depsView, calendarView, schedulerView, sprintView, retroView, pokerView, flowView, prsView, strategyView, healthView, tagsView, recycleBinView, settingsView, aboutView];
