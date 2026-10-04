# Skills and instructions

Open **Skills** from the sidebar, next to Usage, or from the command palette. On mobile it is in
**Settings**, right after Usage. Bind `skills.open` in **Settings → Keybindings** if you want a
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
agents you run in T3 Code. Terminal agents and teammates don't see them, and support differs by
provider:

- Claude Code applies private skills, disabled skills, and instructions.
- Codex applies disabled skills and instructions to new threads. It can't load private skills yet.
- Other providers ignore private changes for now.

For private instructions, choose whether they add to the repository's `AGENTS.md` or `CLAUDE.md`,
replace them, or turn project instructions off.

Switch to **Repository files** to edit the project's own skill folders, `AGENTS.md`, and
`CLAUDE.md`. These edits change files in the checkout, so terminal agents and teammates see them
once you commit. T3 asks once per project before the first switch.

## Recovery

Archived skills and anything T3 moved aside to make room for a link go to **Recovery**. Restore
puts an item back. Delete removes it for good.

## Unsaved edits

If a file changed on disk after you opened it, saving stops and keeps your draft. Copy what you
need, then reload the file. T3 asks before discarding unsaved edits when you switch skills,
projects, or environments.
