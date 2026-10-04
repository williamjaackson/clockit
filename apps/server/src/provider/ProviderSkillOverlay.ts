/**
 * ProviderSkillOverlay - a project's private skills and instructions, applied
 * to the agents T3 launches there and nowhere else.
 *
 * `SkillLibrary.resolveProjectOverlay` says what the project changes. This
 * module turns that into what Claude Code and Codex consume, without writing
 * to the repository or to any provider config file:
 *
 * - Repository skills the user disabled are switched off natively: Claude Code
 *   by folder name (and frontmatter name) in flag-level `skillOverrides`,
 *   Codex by SKILL.md path in the thread's `skills.config`. Every private
 *   skill's invocation name is switched off too, by name in both, so a private
 *   copy is the only one the agent sees. A name rule also hides a user-level
 *   skill of that name.
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
 * Claude Code merges flag-level settings into the user's own: verified in
 * CLI 2.1.285, arrays such as `claudeMdExcludes` are unioned and objects such
 * as `skillOverrides` merge by key, so the user's exclusions and overrides
 * still apply.
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
import * as Schema from "effect/Schema";

import * as SkillLibrary from "../skills/SkillLibrary.ts";
import { parseSkillFrontmatter } from "./Drivers/ClaudeSkills.ts";
import { ProviderDriverError } from "./Errors.ts";

/** Private skills listed to the agent; more stay usable through `$name`. */
const MAX_LISTED_SKILLS = 100;
const MAX_DESCRIPTION_CHARS = 300;
/** A larger private SKILL.md is not offered, since its flags go unchecked. */
const MAX_FRONTMATTER_FILE_BYTES = 256_000;
/** Codex's own default `project_doc_max_bytes`. Longer text points at the file. */
const MAX_INSTRUCTION_BYTES = 32_768;
/**
 * Codex truncates one additional-context entry at about 1,000 tokens. A token
 * covers at least one byte, so this bound holds for any script.
 */
const CODEX_CONTEXT_CHUNK_BYTES = 900;

export interface OverlaySkill {
  /** Frontmatter `name`, else the folder name: what `$name` and Codex use. */
  readonly name: string;
  readonly folderName: string;
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
    /** Invocation name. */
    readonly name: string;
    /** Folder name, which Claude Code names a skill by. */
    readonly folderName: string;
    readonly directory: string;
    readonly skillFile: string;
  }>;
  /**
   * Native skills a private skill takes over: its invocation name, plus the
   * folder names of repository copies. Kept even when the private SKILL.md
   * could not be read, so the native copy stays off as the user asked.
   */
  readonly replaced: {
    readonly names: ReadonlyArray<string>;
    readonly folderNames: ReadonlyArray<string>;
  };
  readonly instructions: {
    readonly mode: SkillProjectInstructionMode;
    readonly content: string | null;
    readonly path: string;
  };
}

/**
 * The project has private settings T3 could not read. Turns and catalogs
 * fail with it rather than run with the user's switches silently lost.
 */
export class SkillOverlayError extends Schema.TaggedError<SkillOverlayError>()(
  "SkillOverlayError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** `undefined` when the project has no private customization. */
export type SkillOverlayResolver = (
  cwd: string,
) => Effect.Effect<PreparedSkillOverlay | undefined, SkillOverlayError>;

export const prepareSkillOverlay = Effect.fn("prepareSkillOverlay")(function* (
  overlay: SkillLibrary.ProjectSkillOverlay,
): Effect.fn.Return<PreparedSkillOverlay, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const skills: Array<OverlaySkill> = [];
  const skipped: Array<string> = [];
  for (const skill of overlay.skills) {
    const skillFile = path.join(skill.path, "SKILL.md");
    const info = yield* fileSystem.stat(skillFile).pipe(Effect.orElseSucceed(() => undefined));
    const contents =
      info?.type !== "File" || Number(info.size) > MAX_FRONTMATTER_FILE_BYTES
        ? undefined
        : yield* fileSystem.readFileString(skillFile).pipe(Effect.orElseSucceed(() => undefined));
    const frontmatter = contents === undefined ? undefined : parseSkillFrontmatter(contents);
    // Claude Code refuses a skill whose frontmatter does not parse; so does T3.
    // An unread file could hide a manual-only flag, so it is not offered either.
    if (contents === undefined || frontmatter?.kind === "malformed") {
      skipped.push(skillFile);
      continue;
    }
    const parsed = frontmatter?.kind === "parsed" ? frontmatter : undefined;
    skills.push({
      name: skill.invocationName ?? skill.name,
      folderName: skill.name,
      description: parsed?.description,
      directory: skill.path,
      skillFile,
      userInvocable: parsed?.userInvocable !== false,
      modelInvocable: parsed?.userInvocationOnly !== true,
    });
  }
  if (skipped.length > 0) {
    yield* Effect.logWarning(
      "Private project skills with an unreadable or oversized SKILL.md are not offered; their names stay switched off.",
      { skipped },
    );
  }

  const disabledRepoSkills: Array<PreparedSkillOverlay["disabledRepoSkills"][number]> = [];
  const replacedNames = new Set(overlay.skills.map((skill) => skill.invocationName ?? skill.name));
  const replacedFolderNames = new Set<string>();
  for (const entry of overlay.suppressedRepoSkills) {
    if (entry.reason === "replaced") {
      replacedNames.add(entry.name);
      if (entry.path !== null) {
        replacedFolderNames.add(entry.folderName ?? path.basename(entry.path));
      }
      continue;
    }
    if (entry.path === null) continue;
    // Codex reports canonical paths; a missing folder keeps its stated path.
    const stated = entry.path;
    const directory = yield* fileSystem.realPath(stated).pipe(Effect.orElseSucceed(() => stated));
    disabledRepoSkills.push({
      name: entry.name,
      folderName: entry.folderName ?? path.basename(stated),
      directory,
      skillFile: path.join(directory, "SKILL.md"),
    });
  }
  const replaced = {
    names: [...replacedNames].toSorted(),
    folderNames: [...replacedFolderNames].toSorted(),
  };

  const instructions = {
    mode: overlay.instructions.mode,
    content: overlay.instructions.content,
    path: overlay.instructions.path,
  };
  const hash = NodeCrypto.createHash("sha256").update(overlay.projectRoot);
  for (const skill of skills) {
    hash.update(
      `\0skill\0${skill.name}\0${skill.folderName}\0${skill.skillFile}\0${skill.description ?? ""}\0${skill.userInvocable}\0${skill.modelInvocable}`,
    );
  }
  for (const skill of disabledRepoSkills) {
    hash.update(`\0disabled\0${skill.name}\0${skill.folderName}\0${skill.skillFile}`);
  }
  hash.update(`\0replaced\0${replaced.names.join("\0")}\0\0${replaced.folderNames.join("\0")}`);
  hash.update(`\0instructions\0${instructions.mode}\0${instructions.path}\0`);
  if (instructions.content !== null) hash.update(instructions.content);
  const key = hash.digest("hex").slice(0, 16);
  return {
    key,
    projectRoot: overlay.projectRoot,
    skills,
    disabledRepoSkills,
    replaced,
    instructions,
  };
});

/**
 * Wrap the backend resolver for adapters and catalogs. A project without
 * private settings resolves to `undefined`; a project whose settings cannot be
 * read fails, because applying nothing would quietly re-enable the repository
 * skills and instruction files the user switched off.
 */
export function makeSkillOverlayResolver(
  library: Pick<SkillLibrary.SkillLibrary["Service"], "resolveProjectOverlay">,
  services: { readonly fileSystem: FileSystem.FileSystem; readonly path: Path.Path },
): SkillOverlayResolver {
  return (cwd) =>
    library.resolveProjectOverlay(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new SkillOverlayError({
            detail: `T3 could not read this project's private skill settings${
              cause.path === undefined ? "" : ` at ${cause.path}`
            } (${cause.detail}) and will not start the agent without them. Fix or remove that file, then try again.`,
            cause,
          }),
      ),
      Effect.flatMap((overlay) =>
        Option.isNone(overlay) ? Effect.undefined : prepareSkillOverlay(overlay.value),
      ),
      Effect.provideService(FileSystem.FileSystem, services.fileSystem),
      Effect.provideService(Path.Path, services.path),
    );
}

/**
 * The resolver a driver hands its adapter, or `undefined` when this server
 * runs without a skill library, in which case nothing changes anywhere. The
 * production runtime provides the library to the instance registry, whose
 * captured context every driver is created in.
 */
export const skillOverlayResolverFromContext = Effect.gen(function* () {
  const library = yield* Effect.serviceOption(SkillLibrary.SkillLibrary);
  if (Option.isNone(library)) return undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return makeSkillOverlayResolver(library.value, { fileSystem, path });
});

/**
 * The overlay a workspace catalog applies. Unreadable settings fail the scan,
 * so the catalog never lists switched-off skills as enabled.
 */
export const resolveCatalogSkillOverlay = (
  resolver: SkillOverlayResolver | undefined,
  cwd: string,
  instance: { readonly driver: string; readonly instanceId: string },
): Effect.Effect<PreparedSkillOverlay | undefined, ProviderDriverError> =>
  resolver === undefined
    ? Effect.undefined
    : resolver(cwd).pipe(
        Effect.mapError(
          (error) => new ProviderDriverError({ ...instance, detail: error.detail, cause: error }),
        ),
      );

const replacesRepositoryInstructions = (overlay: PreparedSkillOverlay) =>
  overlay.instructions.mode === "replace" || overlay.instructions.mode === "off";

function boundedInstructionText(overlay: PreparedSkillOverlay): string | undefined {
  const { mode, content, path } = overlay.instructions;
  if ((mode !== "append" && mode !== "replace") || content === null || !content.trim()) {
    return undefined;
  }
  const head = utf8Prefix(content, MAX_INSTRUCTION_BYTES);
  const body =
    head.length < content.length ? `${head}\n\n[Truncated. Read the rest from ${path}.]` : content;
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

/**
 * Skill names Claude Code must not resolve natively in this project. Claude
 * Code names a skill by its folder, so a disabled or replaced repository
 * skill is switched off by folder name; its frontmatter name is switched off
 * too, so no spelling of it reaches the agent.
 */
export function claudeSuppressedSkillNames(
  overlay: PreparedSkillOverlay | undefined,
): ReadonlySet<string> {
  if (overlay === undefined) return new Set();
  return new Set([
    ...overlay.replaced.names,
    ...overlay.replaced.folderNames,
    ...overlay.disabledRepoSkills.flatMap((skill) => [skill.folderName, skill.name]),
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
    // Codex names a skill by its frontmatter `name`.
    ...overlay.replaced.names.map((name) => ({ name, enabled: false })),
  ];
  return {
    ...(rules.length === 0 ? {} : { "skills.config": rules }),
    // Codex loads the user's AGENTS.md first and spends this budget on the
    // project's files only, so zero drops exactly the repository's.
    ...(replacesRepositoryInstructions(overlay) ? { project_doc_max_bytes: 0 } : {}),
  };
}

const utf8Length = (codePoint: number) =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

/** The longest whole-character prefix of `text` within `maxBytes` of UTF-8. */
function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += utf8Length(char.codePointAt(0)!);
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * Split under the per-entry byte bound, at a line break in the back half of
 * a chunk when there is one, and never inside a character.
 */
function chunk(text: string): ReadonlyArray<string> {
  const chunks: Array<string> = [];
  let rest = text;
  while (rest.length > 0) {
    const head = utf8Prefix(rest, CODEX_CONTEXT_CHUNK_BYTES);
    if (head.length === rest.length) {
      chunks.push(rest);
      break;
    }
    const cut = head.lastIndexOf("\n");
    const end = cut > head.length / 2 ? cut : head.length;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n/, "");
  }
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
  // Claude Code lists skills by folder name, Codex by frontmatter name.
  const replaced = new Set(
    provider === "claudeAgent"
      ? [...overlay.replaced.names, ...overlay.replaced.folderNames]
      : overlay.replaced.names,
  );
  const claudeOff = claudeSuppressedSkillNames(overlay);
  const codexOffPaths = new Set(overlay.disabledRepoSkills.map((skill) => skill.skillFile));
  const native = skills.flatMap((skill) => {
    if (replaced.has(skill.name)) return [];
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
