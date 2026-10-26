# Privacy

- The extension runs in your browser, inside Azure DevOps, with your own sign-in. It has no server.
- It reads and changes work items, and reads pull requests, projects, teams and profile pictures, only in the
  organization where it is installed, and only what your own permissions allow.
- Shared settings (rules, checklists, standard tasks, strategy pillars, the Scheduler's schedules and its record of the stories made, who counts as a team member, the priority weights, and the times of the first approvals of completed pull requests), and work item checklists are kept in this extension's storage in your
  Azure DevOps organization. Your personal settings (AI provider and key) are kept there too, readable only
  by you.
- Retrospectives (boards, notes, action items, votes) and planning poker (the story on the table, votes, who has
  the page open) are kept in this extension's storage in your organization too. Notes and votes are hidden on
  screen until the board moves on or the votes are shown, but that storage has no lock per project or team:
  people in the organization who have the extension can read them by technical means. On an anonymous retro
  board notes carry no name. Retro votes are kept without names (each person's votes are filed under a one-way
  hash made with a random value kept in that person's own storage); votes given with an earlier version stay as
  they were saved, by name. Poker votes carry the voter's name. Flowboards has no server, so it cannot keep a real secret.
- Screen choices (switches, filters, theme, which tabs and controls show) are kept in your browser and in your own
  storage in Azure DevOps (readable only by you), so they follow you to another browser. "Reset my settings" in
  Settings clears them.
- There is no telemetry, no analytics and no tracking.
- AI help is not part of this release. When it comes back, it stays off until you add your own key, and
  then sends the text it needs only to the AI provider you chose.
