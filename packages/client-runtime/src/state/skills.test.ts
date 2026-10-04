import {
  ProviderDriverKind,
  SkillsError,
  type SkillEntry,
  type SkillsSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  canResetSection,
  discoverableSkills,
  findScopeLibraryEntry,
  invocationNameClashes,
  newSkillContent,
  providerSyncNames,
  sharedProfileNotice,
  skillAdoptionPlan,
  skillAgentProviders,
  skillBulkEntries,
  skillLinkAction,
  skillProviderReach,
  skillProviderSwitches,
  skillReachLabel,
  skillScope,
  skillSections,
  skillsFailureMessage,
  skillsScopeKey,
  skillToggle,
  validateNewSkillName,
} from "./skills.ts";

function entry(overrides: Partial<SkillEntry> & Pick<SkillEntry, "name">): SkillEntry {
  return {
    id: `managed:${overrides.name}`,
    scope: "global",
    ownership: "managed",
    enabled: true,
    path: `/home/me/.t3/skills/${overrides.name}`,
    providers: [],
    origins: [],
    conflicts: [],
    links: [],
    editable: true,
    ...overrides,
  };
}

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const cursor = ProviderDriverKind.make("cursor");
const opencode = ProviderDriverKind.make("opencode");
const grok = ProviderDriverKind.make("grok");

const GLOBAL_SCOPE = { kind: "global", libraryPath: "/home/me/.t3/skills" } as const;
const PRIVATE_SCOPE = {
  kind: "project",
  mode: "local",
  projectRoot: "/repo",
  libraryPath: "/home/me/.t3/skill-projects/abc/skills",
} as const;
const SHARED_SCOPE = {
  kind: "project",
  mode: "shared",
  projectRoot: "/repo",
  libraryPath: "/repo/.agents/skills",
} as const;

function support(
  provider: ProviderDriverKind,
  options: { readonly enabled?: boolean; readonly scanned?: boolean } = {},
): SkillsSnapshot["providers"][number] {
  return {
    provider,
    scanned: options.scanned ?? true,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    globalRoots: [],
    projectRoots: [],
    linkTargetIds: [],
    instructionTargetIds: [],
    limitations: [],
  };
}

function makeSnapshot(
  scope: SkillsSnapshot["scope"],
  entries: ReadonlyArray<SkillEntry>,
  extra: Partial<SkillsSnapshot> = {},
): SkillsSnapshot {
  return {
    scope,
    entries,
    linkTargets: [],
    providers: [],
    instructions: { canonicalPath: "/x/AGENTS.md", canonicalExists: false, files: [], links: [] },
    recovery: [],
    warnings: [],
    ...extra,
  };
}

const inherited = (name: string, overrides: Partial<SkillEntry> = {}) =>
  entry({
    id: `inherited:${name}`,
    name,
    editable: false,
    globallyEnabled: true,
    projectDisabled: false,
    ...overrides,
  });
const repository = (name: string, overrides: Partial<SkillEntry> = {}) =>
  entry({
    id: `repo-${name}`,
    name,
    scope: "project",
    ownership: "unmanaged",
    editable: false,
    path: `/repo/.claude/skills/${name}`,
    projectDisabled: false,
    ...overrides,
  });
const privateSkill = (name: string, overrides: Partial<SkillEntry> = {}) =>
  entry({ name, scope: "project", ...overrides });

describe("skillSections", () => {
  it("lists only T3's skills in My skills and offers user skills to take over", () => {
    const snapshot = makeSnapshot(GLOBAL_SCOPE, [
      entry({ name: "review", description: "Review pull requests" }),
      entry({ id: "u1", name: "notes", ownership: "unmanaged" }),
      entry({ id: "p1", name: "pdf", ownership: "plugin", pluginId: "docs" }),
      entry({ id: "s1", name: "imagegen", ownership: "system" }),
    ]);
    const sections = skillSections(snapshot, { query: "", filter: "all" });
    expect(sections.map((section) => [section.id, section.entries.map((e) => e.name)])).toEqual([
      ["mine", ["review"]],
    ]);
    expect(discoverableSkills(snapshot).map((e) => e.name)).toEqual(["notes"]);
  });

  it("keeps an empty My skills section so the page can point at existing skills", () => {
    const sections = skillSections(makeSnapshot(GLOBAL_SCOPE, []), { query: "", filter: "all" });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.entries).toEqual([]);
  });

  it("groups a project into inherited, repository, and private skills", () => {
    const snapshot = makeSnapshot(PRIVATE_SCOPE, [
      inherited("review"),
      inherited("legacy", { enabled: false, globallyEnabled: false }),
      repository("deploy"),
      privateSkill("notes"),
    ]);
    const sections = skillSections(snapshot, { query: "", filter: "all" });
    expect(sections.map((section) => [section.id, section.entries.map((e) => e.name)])).toEqual([
      ["inherited", ["review"]],
      ["repository", ["deploy"]],
      ["private", ["notes"]],
    ]);
    expect(sections[0]?.offInMySkills).toBe(1);
    expect(sections[0]?.all.map((e) => e.name)).toEqual(["legacy", "review"]);

    const revealed = skillSections(snapshot, {
      query: "",
      filter: "all",
      showOffInMySkills: true,
    });
    expect(revealed[0]?.entries.map((e) => e.name)).toEqual(["legacy", "review"]);
  });

  it("searches names, frontmatter names, descriptions, and agents", () => {
    const snapshot = makeSnapshot(GLOBAL_SCOPE, [
      entry({ name: "review", description: "Review pull requests", providers: [claude] }),
      entry({ name: "ship", invocationName: "deploy-prod", providers: [codex] }),
    ]);
    const names = (query: string) =>
      skillSections(snapshot, { query, filter: "all" })[0]?.entries.map((e) => e.name);
    expect(names("pull")).toEqual(["review"]);
    expect(names("deploy")).toEqual(["ship"]);
    expect(names("codex ship")).toEqual(["ship"]);
    expect(names("codex review")).toEqual([]);
  });
});

describe("skillToggle", () => {
  it("never offers a switch for plugin, built-in, unmanaged user, or repository-file skills", () => {
    expect(skillToggle(entry({ name: "a", ownership: "plugin" }), GLOBAL_SCOPE)).toBeNull();
    expect(skillToggle(entry({ name: "a", ownership: "system" }), GLOBAL_SCOPE)).toBeNull();
    expect(skillToggle(entry({ name: "a", ownership: "unmanaged" }), GLOBAL_SCOPE)).toBeNull();
    expect(skillToggle(repository("a"), SHARED_SCOPE)).toBeNull();
  });

  it("can't switch an inherited skill on in a project while it is off in My skills", () => {
    const toggle = skillToggle(
      inherited("a", { enabled: false, globallyEnabled: false }),
      PRIVATE_SCOPE,
    );
    expect(toggle?.checked).toBe(false);
    expect(toggle?.disabledReason).toContain("My skills");
  });

  it("locks a skill a private skill replaces", () => {
    const replaced = repository("a", {
      enabled: false,
      conflicts: [{ entryId: "managed:a", path: "/p/a", reason: "replacedByLocal" }],
    });
    expect(skillToggle(replaced, PRIVATE_SCOPE)?.disabledReason).not.toBeNull();
    expect(
      skillToggle(inherited("b", { projectDisabled: true, enabled: false }), PRIVATE_SCOPE),
    ).toEqual({ checked: false, disabledReason: null });
  });
});

describe("skillBulkEntries and canResetSection", () => {
  const entries = [
    inherited("on"),
    inherited("off-here", { enabled: false, projectDisabled: true }),
    inherited("off-globally", { enabled: false, globallyEnabled: false }),
  ];

  it("switches only skills that can change and are not already there", () => {
    const ids = (enabled: boolean) =>
      skillBulkEntries(entries, PRIVATE_SCOPE, enabled).map((e) => e.id);
    expect(ids(true)).toEqual(["inherited:off-here"]);
    expect(ids(false)).toEqual(["inherited:on"]);
  });

  it("offers a reset only when the project switched something off", () => {
    const [section] = skillSections(makeSnapshot(PRIVATE_SCOPE, entries), {
      query: "",
      filter: "all",
    });
    expect(section && canResetSection(section)).toBe(true);
    const [clean] = skillSections(makeSnapshot(PRIVATE_SCOPE, [inherited("on")]), {
      query: "",
      filter: "all",
    });
    expect(clean && canResetSection(clean)).toBe(false);
  });
});

describe("skillProviderReach", () => {
  const providers = [
    support(claude, { enabled: true }),
    support(codex, { enabled: true }),
    support(cursor, { enabled: true }),
    support(opencode, { enabled: false }),
    support(grok, { enabled: true, scanned: false }),
  ];

  it("lists only enabled agents that read skill folders", () => {
    expect(skillAgentProviders(makeSnapshot(GLOBAL_SCOPE, [], { providers }))).toEqual([
      claude,
      codex,
      cursor,
    ]);
  });

  it("falls back to the agents that already read the skill when the server doesn't say", () => {
    const snapshot = makeSnapshot(GLOBAL_SCOPE, [], {
      providers: [support(claude), support(codex), support(cursor)],
    });
    expect(skillAgentProviders(snapshot)).toBeNull();
    const reach = skillProviderReach(entry({ name: "a", providers: [codex] }), snapshot);
    expect(reach).toEqual([{ provider: codex, on: true, pending: false }]);
  });

  it("marks agents that syncing would add, but not excluded or occupied folders", () => {
    const snapshot = makeSnapshot(GLOBAL_SCOPE, [], {
      providers,
      linkTargets: [
        { id: "claude", path: "/home/me/.claude/skills", providers: [claude] },
        { id: "agents", path: "/home/me/.agents/skills", providers: [codex, cursor] },
      ],
    });
    const skill = entry({
      name: "a",
      providers: [claude],
      links: [
        { targetId: "claude", path: "/home/me/.claude/skills/a", state: "linked" },
        {
          targetId: "agents",
          path: "/home/me/.agents/skills/a",
          state: "available",
          syncPending: true,
        },
      ],
    });
    expect(skillProviderReach(skill, snapshot)).toEqual([
      { provider: claude, on: true, pending: false },
      { provider: codex, on: false, pending: true },
      { provider: cursor, on: false, pending: true },
    ]);
    expect(providerSyncNames(makeSnapshot(GLOBAL_SCOPE, [skill]))).toEqual(["a"]);

    const occupied = entry({
      name: "b",
      links: [
        {
          targetId: "agents",
          path: "/home/me/.agents/skills/b",
          state: "occupied",
          occupant: "directory",
          syncPending: true,
        },
      ],
    });
    const excluded = entry({
      name: "c",
      links: [
        {
          targetId: "agents",
          path: "/home/me/.agents/skills/c",
          state: "available",
          excluded: true,
        },
      ],
    });
    expect(providerSyncNames(makeSnapshot(GLOBAL_SCOPE, [occupied, excluded]))).toEqual([]);
  });

  it("keeps other agents on when a project switches an inherited skill off for T3", () => {
    const snapshot = makeSnapshot(PRIVATE_SCOPE, [], { providers });
    const reach = skillProviderReach(
      inherited("a", { enabled: false, projectDisabled: true, providers: [claude, codex, cursor] }),
      snapshot,
    );
    expect(reach.map((item) => [item.provider, item.on])).toEqual([
      [claude, false],
      [codex, false],
      [cursor, true],
    ]);
    expect(skillReachLabel(reach)).toBe("Cursor");

    const globallyOff = skillProviderReach(
      inherited("b", { enabled: false, globallyEnabled: false, providers: [] }),
      snapshot,
    );
    expect(skillReachLabel(globallyOff)).toBe("No agents");
  });

  it("gives private skills to the agents T3 starts and nobody else", () => {
    const snapshot = makeSnapshot(PRIVATE_SCOPE, [], { providers });
    const reach = skillProviderReach(privateSkill("a"), snapshot);
    expect(reach.map((item) => [item.provider, item.on])).toEqual([
      [claude, true],
      [codex, true],
      [cursor, false],
    ]);
  });
});

describe("skillAdoptionPlan", () => {
  it("moves the folder itself and leaves links to it working", () => {
    const plan = skillAdoptionPlan(
      entry({
        id: "u",
        name: "notes",
        ownership: "unmanaged",
        path: "/home/me/.agents/skills/notes",
        origins: [
          {
            providers: [codex],
            rootPath: "/home/me/.agents/skills",
            entryPath: "/home/me/.agents/skills/notes",
            ownedLink: false,
          },
          {
            providers: [claude],
            rootPath: "/home/me/.claude/skills",
            entryPath: "/home/me/.claude/skills/notes",
            symlinkTarget: "../../.agents/skills/notes",
            ownedLink: false,
          },
        ],
      }),
    );
    expect(plan).toEqual({
      moved: ["/home/me/.agents/skills/notes"],
      kept: ["/home/me/.claude/skills/notes"],
      sourceStays: null,
    });
  });

  it("replaces links and leaves a folder outside provider folders alone", () => {
    const plan = skillAdoptionPlan(
      entry({
        id: "u",
        name: "notes",
        ownership: "unmanaged",
        path: "/home/me/dotfiles/notes",
        origins: [
          {
            providers: [claude],
            rootPath: "/home/me/.claude/skills",
            entryPath: "/home/me/.claude/skills/notes",
            symlinkTarget: "/home/me/dotfiles/notes",
            ownedLink: false,
          },
        ],
      }),
    );
    expect(plan).toEqual({
      moved: ["/home/me/.claude/skills/notes"],
      kept: [],
      sourceStays: "/home/me/dotfiles/notes",
    });
  });
});

describe("invocationNameClashes", () => {
  it("compares the name agents load, not the folder name", () => {
    const source = entry({
      id: "u",
      name: "notes",
      invocationName: "Notes",
      ownership: "unmanaged",
    });
    const snapshot = makeSnapshot(GLOBAL_SCOPE, [
      source,
      entry({ name: "notes-2", invocationName: "notes" }),
      entry({ name: "other" }),
      inherited("notes"),
    ]);
    expect(invocationNameClashes(snapshot, source).map((e) => e.name)).toEqual(["notes-2"]);
  });
});

describe("skillLinkAction", () => {
  const status = { targetId: "claude", path: "/home/me/.claude/skills/mine" };

  it("offers no unlink for a link T3 did not make", () => {
    expect(skillLinkAction({ ...status, state: "linked" })).toBe("unlink");
    expect(skillLinkAction({ ...status, state: "linked", inherited: true })).toBeNull();
    expect(skillLinkAction({ ...status, state: "available" })).toBe("link");
    expect(skillLinkAction({ ...status, state: "occupied", occupant: "directory" })).toBe(
      "replace",
    );
  });
});

describe("skillProviderSwitches", () => {
  const targets = [
    { id: "agents", path: "/home/me/.agents/skills", providers: [codex, claude] },
    { id: "codex", path: "/home/me/.codex/skills", providers: [codex] },
    { id: "codex:abc", path: "/work/codex-home/skills", providers: [codex] },
  ];

  it("explains targets that switch several providers, or that T3 must leave alone", () => {
    const [shared, inherited, occupied] = skillProviderSwitches(
      [
        { targetId: "agents", path: "/home/me/.agents/skills/x", state: "available" },
        { targetId: "codex", path: "/home/me/.codex/skills/x", state: "linked", inherited: true },
        {
          targetId: "codex:abc",
          path: "/work/codex-home/skills/x",
          state: "occupied",
          occupant: "directory",
        },
      ],
      targets,
    );
    expect(shared).toMatchObject({ label: "Codex, Claude", on: false, action: "link" });
    expect(shared?.note).toContain("switch together");
    expect(inherited).toMatchObject({ on: true, action: null });
    expect(occupied).toMatchObject({ on: false, action: "replace" });
    expect(occupied?.note).toContain("its own folder");
  });

  it("names the path when two targets read the same providers", () => {
    const rows = skillProviderSwitches(
      [
        { targetId: "codex", path: "/home/me/.codex/skills/x", state: "linked" },
        { targetId: "codex:abc", path: "/work/codex-home/skills/x", state: "available" },
      ],
      targets,
    );
    expect(rows.map((row) => row.note)).toEqual([
      "/home/me/.codex/skills/x",
      "/work/codex-home/skills/x",
    ]);
  });
});

describe("sharedProfileNotice", () => {
  const scope = {
    kind: "project",
    mode: "local",
    projectRoot: "/work/repo/packages/app",
    libraryPath: "/home/me/.t3/skill-projects/abc/skills",
  } as const;

  it("names the folder whose private settings a project edits when it is not the project", () => {
    expect(sharedProfileNotice({ ...scope, profileRoot: scope.projectRoot })).toBeNull();
    expect(
      sharedProfileNotice({ ...scope, profileRoot: "/work/repo", profileSource: "project" }),
    ).toContain("/work/repo,");
    expect(
      sharedProfileNotice({ ...scope, profileRoot: "/main/repo", profileSource: "worktree" }),
    ).toContain("/main/repo in the main checkout");
    expect(sharedProfileNotice({ ...scope, mode: "shared", profileRoot: "/work/repo" })).toBeNull();
  });
});

describe("validateNewSkillName", () => {
  it("rejects names the library cannot store", () => {
    expect(validateNewSkillName("  ", [])).toBe("Enter a name.");
    expect(validateNewSkillName(".system", [])).not.toBeNull();
    expect(validateNewSkillName("two words", [])).not.toBeNull();
  });

  it("treats names that differ only by case as taken", () => {
    expect(validateNewSkillName("Review", ["review"])).toBe(
      "A skill named Review already exists here.",
    );
    expect(validateNewSkillName("review-2", ["review"])).toBeNull();
  });
});

describe("newSkillContent", () => {
  it("quotes values so YAML keeps them as strings", () => {
    expect(newSkillContent({ name: "true", description: "Deploys: staging\n  then prod" })).toBe(
      '---\nname: "true"\ndescription: "Deploys: staging then prod"\n---\n\n# true\n\n',
    );
  });
});

describe("skill scopes", () => {
  it("never sends shared mode unless the selection asks for it", () => {
    expect(skillScope({ kind: "global" })).toEqual({});
    expect(skillScope({ kind: "project", projectPath: "/repo", mode: "local" })).toEqual({
      projectPath: "/repo",
      mode: "local",
    });
  });

  it("keys drafts by environment as well as scope", () => {
    const scope = { kind: "project", projectPath: "/repo", mode: "local" } as const;
    expect(skillsScopeKey(null, scope)).not.toBe(
      skillsScopeKey("env-1" as Parameters<typeof skillsScopeKey>[0], scope),
    );
  });
});

describe("skillsFailureMessage", () => {
  it("reads the skills error out of a failed scan's cause", () => {
    const error = new SkillsError({
      reason: "conflict",
      detail: "Something already exists where the link would go.",
      conflictPaths: ["/repo/CLAUDE.md"],
    });
    expect(skillsFailureMessage(Cause.fail(error))).toBe(
      "Something already exists where the link would go. /repo/CLAUDE.md",
    );
    expect(skillsFailureMessage(Cause.die(new Error("Socket closed")))).toBe("Socket closed");
  });
});

describe("findScopeLibraryEntry", () => {
  const base: Omit<SkillsSnapshot, "scope" | "entries"> = {
    linkTargets: [],
    providers: [],
    instructions: { canonicalPath: "/repo/AGENTS.md", canonicalExists: true, files: [], links: [] },
    recovery: [],
    warnings: [],
  };

  it("finds a shared skill by its folder in the repository library", () => {
    const created = entry({
      id: "hash",
      name: "review",
      scope: "project",
      ownership: "unmanaged",
      path: "/repo/.agents/skills/review",
      origins: [
        {
          providers: [codex],
          rootPath: "/repo/.agents/skills",
          entryPath: "/repo/.agents/skills/review",
          ownedLink: false,
        },
      ],
    });
    const linkedElsewhere = entry({
      id: "other",
      name: "review",
      scope: "project",
      ownership: "unmanaged",
      path: "/repo/.claude/skills/review",
      origins: [
        {
          providers: [claude],
          rootPath: "/repo/.claude/skills",
          entryPath: "/repo/.claude/skills/review",
          ownedLink: false,
        },
      ],
    });
    const snapshot: SkillsSnapshot = {
      ...base,
      scope: {
        kind: "project",
        mode: "shared",
        projectRoot: "/repo",
        libraryPath: "/repo/.agents/skills",
      },
      entries: [linkedElsewhere, created],
    };
    expect(findScopeLibraryEntry(snapshot, "review")?.id).toBe("hash");
    expect(findScopeLibraryEntry(snapshot, "revie")).toBeNull();
  });
});
