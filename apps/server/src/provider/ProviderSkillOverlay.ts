/**
 * ProviderSkillOverlay - a project's private skills and instructions, applied
 * to the agents T3 launches there and nowhere else.
 *
 * `SkillLibrary.resolveProjectOverlay` says what the project changes. This
 * module turns that into what Claude Code and Codex consume, without writing
 * to the repository or to any provider config file:
 *
 * - Repository skills the user disabled are switched off natively: Claude Code
 *   by name in flag-level `skillOverrides`, Codex by SKILL.md path in the
 *   thread's `skills.config`. Every private skill name is switched off the
 *   same way, by name in both, so a private copy is the only one the agent
 *   sees. A name rule also hides a user-level skill of that name.
 * - Private skills are not registered with either provider. T3 lists them in
 *   the agent's context with their SKILL.md paths, the lazy-loading contract
 *   native skills follow, and turns an explicit `$name` mention into an
 *   instruction to read that file. Provider-only frontmatter such as
 *   `allowed-tools`, `model`, or `context: fork` does not apply to them.
 * - Instruction `replace` and `off` stop the provider loading the
 *   repository's instruction files (`claudeMdExcludes` rooted at the project,
 *   Codex `project_doc_max_bytes = 0`) while user-level files still load.
 *   `append` and `replace` add the private text to the agent's context.
 *
 * `prepareSkillOverlay` does the bounded filesystem reads once per use; the
 * builders below it are pure, so each provider's projection is testable.
 *
 * @module provider/ProviderSkillOverlay
 */
import * as NodeCrypto from "node:crypto";

import type { ServerProviderSkill, SkillProjectInstructionMode } from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Schema from "effect/Schema";

import * as SkillLibrary from "../skills/SkillLibrary.ts";
import { parseSkillFrontmatter } from "./Drivers/ClaudeSkills.ts";

/** Private skills listed to the agent; more stay usable through `$name`. */
const MAX_LISTED_SKILLS = 100;
const MAX_DESCRIPTION_CHARS = 300;
/** Frontmatter sits at the top; a larger SKILL.md keeps its name only. */
const MAX_FRONTMATTER_FILE_BYTES = 256_000;
/** Codex's own default `project_doc_max_bytes`. Longer text points at the file. */
const MAX_INSTRUCTION_CHARS = 32_000;
/** Codex truncates one additional-context entry at about 1,000 tokens. */
const CODEX_CONTEXT_CHUNK_CHARS = 3_000;

export interface OverlaySkill {
  readonly name: string;
  readonly description: string | undefined;
  readonly directory: string;
  readonly skillFile: string;
  /** `user-invocable: false`: only the agent may start it. */
  readonly userInvocable: boolean;
  /** `disable-model-invocation: true`: only an explicit mention starts it. */
  readonly modelInvocable: boolean;
}

export interface PreparedSkillOverlay {
  /** Changes whenever anything a provider would apply changes. */
  readonly key: string;
  readonly projectRoot: string;
  readonly skills: ReadonlyArray<OverlaySkill>;
  /** Repository skills the user disabled, resolved through symlinks when present. */
  readonly disabledRepoSkills: ReadonlyArray<{
    readonly name: string;
    readonly directory: string;
    readonly skillFile: string;
  }>;
  readonly instructions: {
    readonly mode: SkillProjectInstructionMode;
    readonly content: string | null;
    readonly path: string;
  };
}

/** Never fails: an unreadable overlay applies nothing and is logged. */
export type SkillOverlayResolver = (cwd: string) => Effect.Effect<PreparedSkillOverlay | undefined>;

export const prepareSkillOverlay = Effect.fn("prepareSkillOverlay")(function* (
  overlay: SkillLibrary.ProjectSkillOverlay,
): Effect.fn.Return<PreparedSkillOverlay, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const skills: Array<OverlaySkill> = [];
  for (const skill of overlay.skills) {
    const skillFile = path.join(skill.path, "SKILL.md");
    const info = yield* fileSystem.stat(skillFile).pipe(Effect.orElseSucceed(() => undefined));
    if (info?.type !== "File") continue;
    const contents =
      Number(info.size) > MAX_FRONTMATTER_FILE_BYTES
        ? undefined
        : yield* fileSystem.readFileString(skillFile).pipe(Effect.orElseSucceed(() => undefined));
    const frontmatter = contents === undefined ? undefined : parseSkillFrontmatter(contents);
    // Claude Code refuses a skill whose frontmatter does not parse; so does T3.
    if (frontmatter?.kind === "malformed") continue;
    const parsed = frontmatter?.kind === "parsed" ? frontmatter : undefined;
    skills.push({
      name: skill.name,
      description: parsed?.description,
      directory: skill.path,
      skillFile,
      userInvocable: parsed?.userInvocable !== false,
      modelInvocable: parsed?.userInvocationOnly !== true,
    });
  }

  const disabledRepoSkills: Array<PreparedSkillOverlay["disabledRepoSkills"][number]> = [];
  for (const entry of overlay.suppressedRepoSkills) {
    if (entry.reason !== "disabled" || entry.path === null) continue;
    // Codex reports canonical paths; a missing folder keeps its stated path.
    const directory = yield* fileSystem
      .realPath(entry.path)
      .pipe(Effect.orElseSucceed(() => entry.path!));
    disabledRepoSkills.push({
      name: entry.name,
      directory,
      skillFile: path.join(directory, "SKILL.md"),
    });
  }

  const instructions = {
    mode: overlay.instructions.mode,
    content: overlay.instructions.content,
    path: overlay.instructions.path,
  };
  const hash = NodeCrypto.createHash("sha256").update(overlay.projectRoot);
  for (const skill of skills) {
    hash.update(
      `\0skill\0${skill.name}\0${skill.skillFile}\0${skill.description ?? ""}\0${skill.userInvocable}\0${skill.modelInvocable}`,
    );
  }
  for (const skill of disabledRepoSkills) {
    hash.update(`\0disabled\0${skill.name}\0${skill.skillFile}`);
  }
  hash.update(`\0instructions\0${instructions.mode}\0${instructions.path}\0`);
  if (instructions.content !== null) hash.update(instructions.content);
  const key = hash.digest("hex").slice(0, 16);
  return { key, projectRoot: overlay.projectRoot, skills, disabledRepoSkills, instructions };
});

/**
 * Wrap the backend resolver for adapters: prepare the overlay and turn every
 * failure into "no overlay", so a broken private folder never fails a turn.
 */
export function makeSkillOverlayResolver(
  library: Pick<SkillLibrary.SkillLibrary["Service"], "resolveProjectOverlay">,
  services: { readonly fileSystem: FileSystem.FileSystem; readonly path: Path.Path },
): SkillOverlayResolver {
  return (cwd) =>
    library.resolveProjectOverlay(cwd).pipe(
      Effect.flatMap((overlay) =>
        Option.isNone(overlay) ? Effect.undefined : prepareSkillOverlay(overlay.value),
      ),
      Effect.provideService(FileSystem.FileSystem, services.fileSystem),
      Effect.provideService(Path.Path, services.path),
      Effect.catch((cause) =>
        Effect.logWarning("Could not resolve private project skills; applying none.", {
          cwd,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );
}

/**
 * The resolver a driver hands its adapter, or `undefined` when this server
 * runs without a skill library, in which case nothing changes anywhere.
 */
export const skillOverlayResolverFromContext = Effect.gen(function* () {
  const library = yield* Effect.serviceOption(SkillLibrary.SkillLibrary);
  if (Option.isNone(library)) return undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return makeSkillOverlayResolver(library.value, { fileSystem, path });
});

const replacesRepositoryInstructions = (overlay: PreparedSkillOverlay) =>
  overlay.instructions.mode === "replace" || overlay.instructions.mode === "off";

function boundedInstructionText(overlay: PreparedSkillOverlay): string | undefined {
  const { mode, content, path } = overlay.instructions;
  if ((mode !== "append" && mode !== "replace") || content === null || !content.trim()) {
    return undefined;
  }
  const body =
    content.length > MAX_INSTRUCTION_CHARS
      ? `${content.slice(0, MAX_INSTRUCTION_CHARS)}\n\n[Truncated. Read the rest from ${path}.]`
      : content;
  const lead =
    mode === "replace"
      ? `These are this project's instructions, kept privately in T3 Code at ${path}. They replace the instruction files in the repository, which are not loaded. Follow them as you would an AGENTS.md file.`
      : `These project instructions are kept privately in T3 Code at ${path}, outside the repository. They add to the repository's own instruction files. Follow them as you would an AGENTS.md file.`;
  return `${lead}\n\n${body.trim()}`;
}

function privateSkillCatalogText(overlay: PreparedSkillOverlay): string | undefined {
  const listed = overlay.skills.filter((skill) => skill.modelInvocable);
  if (listed.length === 0) return undefined;
  const lines = listed.slice(0, MAX_LISTED_SKILLS).map((skill) => {
    const description =
      skill.description === undefined
        ? ""
        : `: ${
            skill.description.length > MAX_DESCRIPTION_CHARS
              ? `${skill.description.slice(0, MAX_DESCRIPTION_CHARS)}...`
              : skill.description
          }`.replaceAll(/\s+/g, " ");
    return `- ${skill.name}${description} (file: ${skill.skillFile})`;
  });
  const more =
    listed.length > MAX_LISTED_SKILLS
      ? `\n- ...and ${listed.length - MAX_LISTED_SKILLS} more in the folder that holds these.`
      : "";
  return [
    "These skills are private to this project and managed by T3 Code. They are not in your native skill list, and a same-named native skill is switched off in their favor.",
    "When a task matches a skill's description, read its SKILL.md with your file tools before doing anything else, then follow it. Resolve relative paths in a skill against the folder that holds its SKILL.md.",
    "",
    `${lines.join("\n")}${more}`,
  ].join("\n");
}

/** Names of private skills the user explicitly mentions with `$name`, in order. */
function mentionedPrivateSkills(
  text: string,
  overlay: PreparedSkillOverlay,
): ReadonlyArray<OverlaySkill> {
  const byName = new Map(
    overlay.skills.filter((skill) => skill.userInvocable).map((skill) => [skill.name, skill]),
  );
  const mentioned = new Map<string, OverlaySkill>();
  for (const match of text.matchAll(SKILL_MENTION_PATTERN)) {
    const skill = byName.get(match[2] ?? "");
    if (skill) mentioned.set(skill.name, skill);
  }
  return [...mentioned.values()];
}

/**
 * The instruction that stands in for a native skill invocation when the user
 * mentions a private skill. `undefined` when the prompt mentions none.
 */
export function privateSkillInvocationText(
  text: string,
  overlay: PreparedSkillOverlay | undefined,
): string | undefined {
  if (overlay === undefined) return undefined;
  const skills = mentionedPrivateSkills(text, overlay);
  if (skills.length === 0) return undefined;
  return skills
    .map(
      (skill) =>
        `The user invoked the private project skill \`${skill.name}\`. Read ${skill.skillFile} now and follow it for this request. Resolve relative paths in it against ${skill.directory}.`,
    )
    .join("\n");
}

/** Skill names Claude Code must not resolve natively in this project. */
export function claudeSuppressedSkillNames(
  overlay: PreparedSkillOverlay | undefined,
): ReadonlySet<string> {
  if (overlay === undefined) return new Set();
  return new Set([
    ...overlay.skills.map((skill) => skill.name),
    // Claude Code identifies a skill by its folder name.
    ...overlay.disabledRepoSkills.map((skill) => skill.name),
  ]);
}

/** Characters picomatch reads as glob syntax in a literal path prefix. */
const GLOB_SYNTAX = /[*?[\]{}]|[!@+](?=\()/;

export type ClaudeSkillOverlayQuery =
  | {
      readonly _tag: "Applied";
      /** Merged into the query's flag-level settings. */
      readonly settings: {
        readonly skillOverrides?: Readonly<Record<string, "off">>;
        readonly claudeMdExcludes?: ReadonlyArray<string>;
      };
      readonly appendSystemPrompt: string | undefined;
    }
  | { readonly _tag: "Unsupported"; readonly detail: string };

/**
 * Claude Code options for an overlay. `claudeMdExcludes` patterns are rooted
 * at the project, so the user's own `<config dir>/CLAUDE.md` and rules still
 * load; a config dir inside the project, or a project path picomatch would read
 * as a glob, cannot be excluded precisely and is refused.
 */
export function claudeSkillOverlayQuery(
  overlay: PreparedSkillOverlay,
  claudeConfigDir: string,
  path: Pick<Path.Path, "relative" | "isAbsolute">,
): ClaudeSkillOverlayQuery {
  const names = [...claudeSuppressedSkillNames(overlay)].toSorted();
  let claudeMdExcludes: Array<string> | undefined;
  if (replacesRepositoryInstructions(overlay)) {
    const root = overlay.projectRoot.replaceAll("\\", "/").replace(/\/$/, "");
    const configRelative = path.relative(overlay.projectRoot, claudeConfigDir);
    if (
      configRelative === "" ||
      (!configRelative.startsWith("..") && !path.isAbsolute(configRelative))
    ) {
      return {
        _tag: "Unsupported",
        detail: `Claude's config folder ${claudeConfigDir} is inside ${overlay.projectRoot}, so T3 cannot hide the repository's CLAUDE.md files without hiding yours. Set project instructions to Inherit or Append.`,
      };
    }
    if (GLOB_SYNTAX.test(root)) {
      return {
        _tag: "Unsupported",
        detail: `The project path ${overlay.projectRoot} contains characters Claude Code reads as a file pattern, so T3 cannot hide its CLAUDE.md files. Set project instructions to Inherit or Append.`,
      };
    }
    claudeMdExcludes = [
      `${root}/**/CLAUDE.md`,
      `${root}/**/CLAUDE.local.md`,
      `${root}/**/.claude/rules/**`,
    ];
  }
  const instructionText = boundedInstructionText(overlay);
  const catalogText = privateSkillCatalogText(overlay);
  const appendSystemPrompt = [
    instructionText === undefined ? "" : `# Private project instructions\n\n${instructionText}`,
    catalogText === undefined ? "" : `# Private project skills\n\n${catalogText}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    _tag: "Applied",
    settings: {
      ...(names.length === 0
        ? {}
        : { skillOverrides: Object.fromEntries(names.map((name) => [name, "off" as const])) }),
      ...(claudeMdExcludes === undefined ? {} : { claudeMdExcludes }),
    },
    appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt : undefined,
  };
}

/** True when Codex launch args already set `skills.config`, which a thread override would replace. */
export function codexLaunchArgsSetSkillsConfig(launchArgs: string): boolean {
  return /(?:^|[\s"'=])skills\.config\s*=/.test(launchArgs);
}

/**
 * Per-thread Codex config for an overlay. Codex reads it at `thread/start`,
 * `thread/fork`, and when `thread/resume` loads a thread; an already loaded
 * thread keeps what it started with.
 */
export function codexSkillOverlayThreadConfig(
  overlay: PreparedSkillOverlay,
): Readonly<Record<string, Schema.Json>> {
  const rules = [
    ...overlay.disabledRepoSkills.map((skill) => ({ path: skill.skillFile, enabled: false })),
    ...overlay.skills.map((skill) => ({ name: skill.name, enabled: false })),
  ];
  return {
    ...(rules.length === 0 ? {} : { "skills.config": rules }),
    // Codex loads the user's AGENTS.md first and spends this budget on the
    // project's files only, so zero drops exactly the repository's.
    ...(replacesRepositoryInstructions(overlay) ? { project_doc_max_bytes: 0 } : {}),
  };
}

function chunk(text: string): ReadonlyArray<string> {
  const chunks: Array<string> = [];
  let rest = text;
  while (rest.length > CODEX_CONTEXT_CHUNK_CHARS) {
    const cut = rest.lastIndexOf("\n", CODEX_CONTEXT_CHUNK_CHARS);
    const end = cut > CODEX_CONTEXT_CHUNK_CHARS / 2 ? cut : CODEX_CONTEXT_CHUNK_CHARS;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Codex turn context for an overlay, split under the per-entry token cap. */
export function codexSkillOverlayAdditionalContext(
  overlay: PreparedSkillOverlay | undefined,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  if (overlay === undefined) return {};
  const entries: Record<string, V2TurnStartParams__AdditionalContextEntry> = {};
  const add = (key: string, text: string | undefined) => {
    if (text === undefined) return;
    chunk(text).forEach((value, index) => {
      entries[index === 0 ? key : `${key}_${index + 1}`] = { kind: "application", value };
    });
  };
  add("t3_project_instructions", boundedInstructionText(overlay));
  add("t3_private_skills", privateSkillCatalogText(overlay));
  return entries;
}

/**
 * A provider's native skill list as T3 agents in this project see it. Native
 * skills the overlay switches off stay listed as disabled, like any
 * `skillOverrides` entry, unless a private skill takes their name; private
 * skills are added at their T3 path.
 */
export function applySkillOverlayToCatalog(
  skills: ReadonlyArray<ServerProviderSkill>,
  overlay: PreparedSkillOverlay | undefined,
  provider: "claudeAgent" | "codex",
): ReadonlyArray<ServerProviderSkill> {
  if (overlay === undefined) return skills;
  const privateNames = new Set(overlay.skills.map((skill) => skill.name));
  const claudeOff = claudeSuppressedSkillNames(overlay);
  const codexOffPaths = new Set(overlay.disabledRepoSkills.map((skill) => skill.skillFile));
  const native = skills.flatMap((skill) => {
    if (privateNames.has(skill.name)) return [];
    const off =
      provider === "claudeAgent" ? claudeOff.has(skill.name) : codexOffPaths.has(skill.path);
    return [off ? { ...skill, enabled: false } : skill];
  });
  const added = overlay.skills.map((skill): ServerProviderSkill => ({
    name: skill.name,
    path: skill.skillFile,
    enabled: true,
    scope: "local",
    ...(skill.description === undefined ? {} : { description: skill.description }),
    ...(skill.modelInvocable ? {} : { userInvocationOnly: true }),
    ...(skill.userInvocable ? {} : { userInvocable: false }),
  }));
  return [...native, ...added].toSorted((left, right) => left.name.localeCompare(right.name));
}
