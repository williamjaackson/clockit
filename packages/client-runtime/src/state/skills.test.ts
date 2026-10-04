import { ProviderDriverKind, type SkillEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterSkillEntries,
  newSkillContent,
  skillScope,
  skillsScopeKey,
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

describe("filterSkillEntries", () => {
  const entries = [
    entry({
      name: "review",
      description: "Review pull requests",
      providers: [claude],
      links: [{ targetId: "claude", path: "/home/me/.claude/skills/review", state: "linked" }],
    }),
    entry({ name: "deploy", providers: [codex], links: [] }),
    entry({
      id: "abc",
      name: "pdf",
      ownership: "plugin",
      editable: false,
      providers: [claude],
      conflicts: [{ entryId: "def", path: "/elsewhere/pdf", reason: "duplicateName" }],
    }),
    entry({ id: "ghi", name: "old", ownership: "unmanaged", enabled: false }),
  ];

  it("matches every search word against name, description, and provider", () => {
    expect(
      filterSkillEntries(entries, { query: "pull", filter: "all" }).map((e) => e.name),
    ).toEqual(["review"]);
    expect(
      filterSkillEntries(entries, { query: "codex deploy", filter: "all" }).map((e) => e.name),
    ).toEqual(["deploy"]);
    expect(filterSkillEntries(entries, { query: "codex review", filter: "all" })).toEqual([]);
  });

  it("narrows to library skills that no provider links to", () => {
    expect(
      filterSkillEntries(entries, { query: "", filter: "unlinked" }).map((e) => e.name),
    ).toEqual(["deploy"]);
  });

  it("groups plugin sources, conflicts, and disabled skills", () => {
    expect(filterSkillEntries(entries, { query: "", filter: "plugin" }).map((e) => e.name)).toEqual(
      ["pdf"],
    );
    expect(
      filterSkillEntries(entries, { query: "", filter: "conflicts" }).map((e) => e.name),
    ).toEqual(["pdf"]);
    expect(
      filterSkillEntries(entries, { query: "", filter: "disabled" }).map((e) => e.name),
    ).toEqual(["old"]);
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
