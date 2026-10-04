import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ServerProviderSkill, SkillsError } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type * as SkillLibrary from "../skills/SkillLibrary.ts";
import {
  applySkillOverlayToCatalog,
  claudeSkillOverlayQuery,
  codexSkillOverlayAdditionalContext,
  codexSkillOverlayThreadConfig,
  makeSkillOverlayResolver,
  type PreparedSkillOverlay,
  prepareSkillOverlay,
  privateSkillInvocationText,
} from "./ProviderSkillOverlay.ts";

const ROOT = "/work/app";
const PRIVATE = "/t3/skill-projects/abc/skills";

const overlay = (
  input: Partial<Omit<PreparedSkillOverlay, "instructions">> & {
    readonly instructions?: Partial<PreparedSkillOverlay["instructions"]>;
  } = {},
): PreparedSkillOverlay => ({
  key: "key",
  projectRoot: ROOT,
  skills: [
    {
      name: "review",
      description: "Review a change",
      directory: `${PRIVATE}/review`,
      skillFile: `${PRIVATE}/review/SKILL.md`,
      userInvocable: true,
      modelInvocable: true,
    },
  ],
  disabledRepoSkills: [
    {
      name: "deploy",
      directory: `${ROOT}/.claude/skills/deploy`,
      skillFile: `${ROOT}/.claude/skills/deploy/SKILL.md`,
    },
  ],
  ...input,
  instructions: {
    mode: "inherit",
    content: null,
    path: "/t3/skill-projects/abc/AGENTS.md",
    ...input.instructions,
  },
});

const native = (skill: Partial<ServerProviderSkill> & { readonly name: string }) =>
  ({ path: `${ROOT}/.claude/skills/${skill.name}/SKILL.md`, enabled: true, ...skill }) as const;

describe("ProviderSkillOverlay", () => {
  it.effect("reads private skill metadata and resolves disabled repository folders", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skill-overlay-" });
      const write = (relative: string, content: string) =>
        Effect.gen(function* () {
          const file = path.join(root, relative);
          yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
          yield* fileSystem.writeFileString(file, content);
        });
      yield* write(
        "private/manual/SKILL.md",
        "---\ndescription: Manual\ndisable-model-invocation: yes\n---\n",
      );
      yield* write("private/agent-only/SKILL.md", "---\nuser-invocable: false\n---\n");
      yield* write("private/broken/SKILL.md", "---\ndescription: [unclosed\n---\n");
      yield* write("shared/deploy/SKILL.md", "# deploy\n");
      yield* fileSystem.makeDirectory(path.join(root, "repo/.agents/skills"), { recursive: true });
      yield* fileSystem.symlink(
        path.join(root, "shared/deploy"),
        path.join(root, "repo/.agents/skills/deploy"),
      );
      const realRoot = yield* fileSystem.realPath(root);
      const backendOverlay = (content: string): SkillLibrary.ProjectSkillOverlay => ({
        projectRoot: path.join(root, "repo"),
        privateRoot: path.join(root, "private-root"),
        skillRoot: path.join(root, "private"),
        skills: ["manual", "agent-only", "broken"].map((name) => ({
          name,
          path: path.join(root, "private", name),
        })),
        suppressedRepoSkills: [
          {
            name: "deploy",
            path: path.join(root, "repo/.agents/skills/deploy"),
            reason: "disabled",
          },
          { name: "manual", path: null, reason: "replaced" },
        ],
        instructions: {
          mode: "append",
          content,
          path: path.join(root, "AGENTS.md"),
          globalInstructionsEnabled: true,
        },
        provenance: { manifestPath: path.join(root, "manifest.json") },
      });

      const prepared = yield* prepareSkillOverlay(backendOverlay("Be brief."));
      assert.deepEqual(
        prepared.skills.map(({ name, userInvocable, modelInvocable, description }) => ({
          name,
          userInvocable,
          modelInvocable,
          description,
        })),
        [
          { name: "manual", userInvocable: true, modelInvocable: false, description: "Manual" },
          {
            name: "agent-only",
            userInvocable: false,
            modelInvocable: true,
            description: undefined,
          },
        ],
      );
      assert.deepEqual(prepared.disabledRepoSkills, [
        {
          name: "deploy",
          directory: path.join(realRoot, "shared/deploy"),
          skillFile: path.join(realRoot, "shared/deploy/SKILL.md"),
        },
      ]);
      const edited = yield* prepareSkillOverlay(backendOverlay("Be thorough."));
      assert.notEqual(edited.key, prepared.key);
      assert.equal((yield* prepareSkillOverlay(backendOverlay("Be brief."))).key, prepared.key);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("applies nothing when the backend overlay fails to resolve", () =>
    Effect.gen(function* () {
      const resolver = makeSkillOverlayResolver(
        {
          resolveProjectOverlay: () =>
            Effect.fail(new SkillsError({ reason: "filesystem", detail: "Unreadable." })),
        },
        { fileSystem: yield* FileSystem.FileSystem, path: yield* Path.Path },
      );
      assert.isUndefined(yield* resolver(ROOT));
      const none = makeSkillOverlayResolver(
        { resolveProjectOverlay: () => Effect.succeedNone },
        { fileSystem: yield* FileSystem.FileSystem, path: yield* Path.Path },
      );
      assert.isUndefined(yield* none(ROOT));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("lists a private skill at the same path an explicit mention reads", () => {
    const prepared = overlay();
    const catalog = applySkillOverlayToCatalog(
      [
        native({ name: "review", scope: "project" }),
        native({ name: "deploy", scope: "project" }),
        native({ name: "lint", scope: "user", path: "/home/me/.claude/skills/lint/SKILL.md" }),
      ],
      prepared,
      "claudeAgent",
    );
    assert.deepEqual(catalog, [
      native({ name: "deploy", scope: "project", enabled: false }),
      native({ name: "lint", scope: "user", path: "/home/me/.claude/skills/lint/SKILL.md" }),
      {
        name: "review",
        path: `${PRIVATE}/review/SKILL.md`,
        enabled: true,
        scope: "local",
        description: "Review a change",
      },
    ]);
    const invocation = privateSkillInvocationText("please $review this", prepared);
    assert.include(invocation, `Read ${catalog[2]!.path} now`);
    assert.include(invocation, `against ${PRIVATE}/review`);
  });

  it("matches Codex originals by canonical SKILL.md path, not name", () => {
    const prepared = overlay({
      disabledRepoSkills: [
        {
          name: "deploy",
          directory: `${ROOT}/.agents/skills/deploy`,
          skillFile: `${ROOT}/.agents/skills/deploy/SKILL.md`,
        },
      ],
    });
    const catalog = applySkillOverlayToCatalog(
      [
        { name: "deploy", path: `${ROOT}/.agents/skills/deploy/SKILL.md`, enabled: true },
        { name: "deploy", path: "/home/me/.agents/skills/deploy/SKILL.md", enabled: true },
        { name: "review", path: `${ROOT}/.agents/skills/review/SKILL.md`, enabled: true },
      ],
      prepared,
      "codex",
    );
    assert.deepEqual(
      catalog.map(({ path, enabled }) => [path, enabled]),
      [
        [`${ROOT}/.agents/skills/deploy/SKILL.md`, false],
        ["/home/me/.agents/skills/deploy/SKILL.md", true],
        [`${PRIVATE}/review/SKILL.md`, true],
      ],
    );
    assert.strictEqual(applySkillOverlayToCatalog(catalog, undefined, "codex"), catalog);
  });

  it("invokes only user-invocable private skills that the prompt names", () => {
    const prepared = overlay({
      skills: [
        ...overlay().skills,
        {
          name: "agent-only",
          description: undefined,
          directory: `${PRIVATE}/agent-only`,
          skillFile: `${PRIVATE}/agent-only/SKILL.md`,
          userInvocable: false,
          modelInvocable: true,
        },
      ],
    });
    assert.isUndefined(privateSkillInvocationText("$agent-only and $lint and $5", prepared));
    assert.isUndefined(privateSkillInvocationText("$review", undefined));
    assert.include(privateSkillInvocationText("€review now", prepared), "`review`");
  });

  it.effect(
    "switches off private and disabled names and excludes only repository instruction files",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherit = claudeSkillOverlayQuery(overlay(), "/home/me/.claude", path);
        assert.deepEqual(inherit, {
          _tag: "Applied",
          settings: { skillOverrides: { deploy: "off", review: "off" } },
          appendSystemPrompt: inherit._tag === "Applied" ? inherit.appendSystemPrompt : "",
        });
        assert.include(
          inherit._tag === "Applied" ? inherit.appendSystemPrompt : "",
          `- review: Review a change (file: ${PRIVATE}/review/SKILL.md)`,
        );
        assert.notInclude(
          inherit._tag === "Applied" ? inherit.appendSystemPrompt : "",
          "Private project instructions",
        );

        const replace = claudeSkillOverlayQuery(
          overlay({ instructions: { mode: "replace", content: "Use tabs." } }),
          "/home/me/.claude",
          path,
        );
        assert.equal(replace._tag, "Applied");
        if (replace._tag !== "Applied") return;
        assert.deepEqual(replace.settings.claudeMdExcludes, [
          `${ROOT}/**/CLAUDE.md`,
          `${ROOT}/**/CLAUDE.local.md`,
          `${ROOT}/**/.claude/rules/**`,
        ]);
        assert.include(replace.appendSystemPrompt, "Use tabs.");

        const off = claudeSkillOverlayQuery(
          overlay({
            skills: [],
            disabledRepoSkills: [],
            instructions: { mode: "off", content: "x" },
          }),
          "/home/me/.claude",
          path,
        );
        assert.deepEqual(off, {
          _tag: "Applied",
          settings: {
            claudeMdExcludes: [
              `${ROOT}/**/CLAUDE.md`,
              `${ROOT}/**/CLAUDE.local.md`,
              `${ROOT}/**/.claude/rules/**`,
            ],
          },
          appendSystemPrompt: undefined,
        });

        assert.equal(
          claudeSkillOverlayQuery(
            overlay({ instructions: { mode: "off" } }),
            `${ROOT}/.claude`,
            path,
          )._tag,
          "Unsupported",
        );
        assert.equal(
          claudeSkillOverlayQuery(
            overlay({ projectRoot: "/work/[app]", instructions: { mode: "replace" } }),
            "/home/me/.claude",
            path,
          )._tag,
          "Unsupported",
        );
        // A glob-like path only matters when instruction files must be excluded.
        assert.equal(
          claudeSkillOverlayQuery(overlay({ projectRoot: "/work/[app]" }), "/home/me/.claude", path)
            ._tag,
          "Applied",
        );
      }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("keeps manual-only private skills out of the model's catalog", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const prepared = overlay({
        disabledRepoSkills: [],
        skills: [{ ...overlay().skills[0]!, modelInvocable: false }],
      });
      const query = claudeSkillOverlayQuery(prepared, "/home/me/.claude", path);
      assert.deepEqual(query, {
        _tag: "Applied",
        settings: { skillOverrides: { review: "off" } },
        appendSystemPrompt: undefined,
      });
      assert.deepEqual(codexSkillOverlayAdditionalContext(prepared), {});
      assert.include(privateSkillInvocationText("$review", prepared), "SKILL.md");
    }).pipe(Effect.provide(Path.layer)),
  );

  it("builds Codex thread config that drops only repository instruction files", () => {
    assert.deepEqual(codexSkillOverlayThreadConfig(overlay()), {
      "skills.config": [
        { path: `${ROOT}/.claude/skills/deploy/SKILL.md`, enabled: false },
        { name: "review", enabled: false },
      ],
    });
    assert.deepEqual(
      codexSkillOverlayThreadConfig(
        overlay({ skills: [], disabledRepoSkills: [], instructions: { mode: "replace" } }),
      ),
      { project_doc_max_bytes: 0 },
    );
    assert.deepEqual(
      codexSkillOverlayThreadConfig(
        overlay({ skills: [], disabledRepoSkills: [], instructions: { mode: "append" } }),
      ),
      {},
    );
  });

  it("splits long Codex context under the per-entry cap and keeps every line", () => {
    const content = Array.from({ length: 400 }, (_, index) => `Rule ${index}: keep it short.`).join(
      "\n",
    );
    const context = codexSkillOverlayAdditionalContext(
      overlay({ instructions: { mode: "append", content } }),
    );
    const instructionKeys = Object.keys(context).filter((key) =>
      key.startsWith("t3_project_instructions"),
    );
    assert.isAbove(instructionKeys.length, 1);
    assert.deepEqual(instructionKeys.slice(0, 2), [
      "t3_project_instructions",
      "t3_project_instructions_2",
    ]);
    for (const entry of Object.values(context)) {
      assert.equal(entry.kind, "application");
      assert.isAtMost(entry.value.length, 3_000);
    }
    const joined = instructionKeys.map((key) => context[key]!.value).join("\n");
    assert.include(joined, "Rule 0: keep it short.");
    assert.include(joined, "Rule 399: keep it short.");
    assert.include(context.t3_private_skills!.value, `${PRIVATE}/review/SKILL.md`);
    assert.deepEqual(codexSkillOverlayAdditionalContext(undefined), {});
  });
});
