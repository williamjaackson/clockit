# Skills and instructions

Open **Skills** from the sidebar, next to Usage, from the command palette, or from the **Skills**
button on **Settings → Providers**. On mobile it is in **Settings**, right after Usage. Bind `skills.open` in **Settings → Keybindings** if you want a
shortcut. It has no default.

Each environment keeps its own skills. Pick the environment at the top of the page, then pick
**Global** or one of that environment's projects.

## Global skills

T3 keeps one skill library per environment and links each skill into the provider folders you
choose, such as Claude Code's `~/.claude/skills`. T3 never touches the other skills in those
folders.

- **New skill** creates a folder with a `SKILL.md`. The description tells agents when to load it.
- Skills found in provider folders show as **Not in library**. **Import** copies the whole
  folder, scripts included. The original stays where it was, so providers then see two skills
  with the same name, and each provider decides which one wins. Give the copy a new name, or
  choose **Adopt the original and link it** to move the original to Recovery and link the copy
  in its place.
- Plugin and built-in skills are read-only. Import a copy to change one.
- **Provider links** shows each provider folder. If something else already uses the path, T3
  shows the exact path and asks before moving it to Recovery.
- Disabling a library skill removes its links. Enabling it puts them back where the path is
  still free.

Use the filter to find skills that are not linked, symlinked, outside the library, from plugins,
disabled, or sharing a name with another skill.

## Instructions

The **Instructions** tab edits one global instructions file. Import an existing provider file,
like `~/.claude/CLAUDE.md`, to start from it, then link it to each provider so they all read the
same text.

## Project skills

A project opens in **Private to T3**. Changes are stored outside the repository and apply only to
Claude Code and Codex agents you run in T3 Code. Terminal agents, teammates, and other providers
don't see them.

- T3 lists your private skills to the agent with the path of each `SKILL.md`, and the agent reads
  the file when a task matches. Mentioning one with `$name` tells the agent to use it.
- A private skill switches off any repository or user skill with the same name, so the agent only
  sees your copy. Turning a repository skill off works the same way.
- Claude Code picks up changes on its next turn. Codex picks up new private skills and instructions
  on its next turn, but turning a skill off only takes effect in a new thread or after the thread
  reloads.
- Private skills are plain files to the agent, so provider-only frontmatter such as
  `allowed-tools` or `context: fork` may not apply.

For private instructions, choose whether they add to the repository's `AGENTS.md` or `CLAUDE.md`,
replace them, or turn project instructions off.

Switch to **Repository files** to edit the project's own skill folders, `AGENTS.md`, and
`CLAUDE.md`. These edits change files in the checkout, so terminal agents and teammates see them
once you commit. T3 asks once per project before the first switch.

Claude Code doesn't read `.agents/skills` or `AGENTS.md`. Under **Repository links**, link a skill
into `.claude/skills` or turn `CLAUDE.md` into a link to `AGENTS.md`, so every tool reads the same
files. T3 adds relative symlinks you can commit, and only when you ask: saving or creating a skill
never links it. If something already sits at the path, T3 names it and asks before moving it to
Recovery.

## Recovery

Archived skills and anything T3 moved aside to make room for a link go to **Recovery**. Restore
puts an item back. Delete removes it for good.

## Unsaved edits

If a file changed on disk after you opened it, saving stops and keeps your draft. Copy what you
need, then reload the file. T3 asks before discarding unsaved edits when you switch skills,
projects, or environments, refresh, or enable, disable, or archive the skill you're editing. If the
skill, project, or environment disappears while you have unsaved edits, the editor stays open so
you can copy them.
