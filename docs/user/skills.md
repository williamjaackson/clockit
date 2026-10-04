# Skills and instructions

Open **Skills** from the sidebar, next to Usage, from the command palette, or from the **Skills**
button on **Settings → Providers**. On mobile it is in **Settings**, right after Usage. Bind `skills.open` in **Settings → Keybindings** if you want a
shortcut. It has no default.

Each environment keeps its own skills. Pick the environment at the top of the page, then pick
**My skills** or one of that environment's projects.

## My skills

My skills is the one set of skills T3 manages for you on this environment. Every agent you've
turned on in **Settings → Providers** gets each skill that's on, so you manage them in one place
instead of once per agent. The icons on each row show which agents have it.

- **+ → New skill** creates a skill with a `SKILL.md`. The description tells agents when to load
  it.
- **+ → Manage existing skills** lists skills already sitting in your agents' folders. **Manage in
  T3** moves one into My skills: agents keep using it from T3's copy, and the original goes to
  Recovery. **Copy only** leaves the original where it is, outside T3, so agents see two skills by
  that name. Agents load a skill by the `name` in its `SKILL.md`, so giving the copy a different
  folder name doesn't change that. Edit the name in the copy's `SKILL.md` to tell them apart.
- Switching a skill off removes T3's copy from every agent. A skill of the same name that T3
  doesn't manage, such as one you copied or one a plugin installed, stays where it is.
- If an agent folder already has a different skill by that name, T3 leaves it alone and that
  agent keeps its own. The skill's page says where.
- When you turn on another agent, skills it doesn't have yet show **Missing from an agent**.
  **Add to all agents** adds them. It never removes or replaces anything.
- **Choose folders**, on a skill's page, adds or removes the skill in one agent folder at a time.
  Codex, Cursor, and OpenCode all read `~/.agents/skills`, so they switch together. A folder you
  switch off stays off when T3 adds skills to new agents.
- Grok and Pi read skills their own way, so T3 can't add skills for them.
- Plugin and built-in skills belong to their plugin or agent, and T3 doesn't list them.

**Stop managing in T3**, in a skill's **⋯** menu, moves the skill out of My skills with your latest
edits. T3 shows where it goes before anything moves, and the agents that use it keep it. A skill
that's off needs a folder you pick, outside every agent's skill folder, so it stays off.

**Archive** moves T3's copy to Recovery instead.

## Instructions

The **Instructions** tab edits one global instructions file. Turn it on for each provider under
**Use with**. A provider that already has its own file, like `~/.claude/CLAUDE.md`, keeps it until
you choose **Import text** to start from it or **Replace…** to move it to Recovery.

## Project skills

A project opens in **Private to T3**. It lists three kinds of skills:

- **From My skills** lists everything in My skills, on by default. Switch one off to hide it from
  Claude and Codex agents you run in T3 for this project. Other agents read My skills directly and
  keep it. A skill that's off in My skills is off here too, and the list hides it unless you choose
  **Show**. To edit one, choose **Edit in My skills**. To change it for this project only, choose
  **Customize**, which makes a private copy.
- **Repository** lists the project's own skill folders. Switching one off hides it from Claude and
  Codex agents in T3. The file stays in the repository, so terminal agents and teammates still see
  it.
- **Private to this project** lists skills stored outside the repository that only Claude and
  Codex agents in T3 see. A private skill replaces any My skills or repository skill with the same name.

Each section's **⋯** menu turns all of its skills on or off. **Reset to default** turns the My
skills or repository section back on. Neither touches private skills.

How these changes reach agents:

- T3 lists your private skills to the agent with the path of each `SKILL.md`, and the agent reads
  the file when a task matches. Mentioning one with `$name` tells the agent to use it.
- Claude picks up changes on its next turn, or once its background tasks finish.
- Codex needs a new or reloaded thread for any change to which repository or user skills, or
  which repository instructions, it loads: turning a skill off, adding a private skill that
  replaces one, or replacing or turning off the repository's instructions. Until then the thread
  keeps its earlier skill setup. Other changes, such as editing a private skill, reach Codex on
  its next turn.
- Changes never reach back into a thread's history. If an agent already read a skill or
  instruction file, it can still act on it until you start a new thread.
- Private skills are plain files to the agent, so provider-only frontmatter such as
  `allowed-tools` or `context: fork` may not apply.

For private instructions, choose whether they add to the repository's `AGENTS.md` or `CLAUDE.md`,
replace them, or turn project instructions off.

Private settings belong to a folder, and every project inside it uses them unless it has its own.
A sub-project or Git worktree with none of its own shows and edits the settings it inherits, and
T3 names the folder they belong to. Changes there apply everywhere that uses them.

Switch to **Repository files** to edit the project's own skill folders, `AGENTS.md`, and
`CLAUDE.md`. These edits change files in the checkout, so terminal agents and teammates see them
once you commit. T3 asks once per project before the first switch.

Claude Code doesn't read `.agents/skills` or `AGENTS.md`. Turn on Claude under **Use with** for a
skill or for the instructions, so every tool reads the same files. T3 adds relative symlinks you
can commit, and only when you ask: saving or creating a skill never adds one. If something already
sits at the path, T3 names it and asks before moving it to Recovery.

## Recovery

Archived skills, and originals T3 moved aside when it took over a skill or instructions file, go to
**Recovery**. Restore puts an item back. Delete removes it for good.

## Unsaved edits

If a file changed on disk after you opened it, saving stops and keeps your draft. Copy what you
need, then reload the file. T3 asks before discarding unsaved edits when you switch skills,
projects, or environments, refresh, or turn on, turn off, archive, or stop managing the skill
you're editing. If the skill, project, or environment disappears while you have unsaved edits, the
editor stays open so you can copy them.
