/**
 * SkillLibrary - canonical skills and instructions for every provider.
 *
 * Layout under the T3 home (`ServerConfig.baseDir`):
 *
 * - `skills/<name>`: enabled global skills, the one source of truth.
 * - `disabled-skills/<name>`: disabled global skills, outside every link.
 * - `instructions/AGENTS.md`: global instructions.
 * - `skill-projects/<hash>/`: private project state, keyed by the canonical
 *   project root. Holds `skills/`, `disabled-skills/`, `AGENTS.md`, and
 *   `manifest.json`. Only T3 agents see it, through `resolveProjectOverlay`.
 *   Agents in a folder use the nearest profile at or above it, and in a Git
 *   worktree the primary checkout's matching folder's as well. Managing a
 *   folder edits that same profile, so a sub-project or worktree without one
 *   of its own edits the one its agents inherit.
 * - `skill-recovery/<id>/`: archived skills and originals moved aside to
 *   make room for a link, each restorable.
 * - `skill-library.json`: links to restore when a disabled skill comes back,
 *   and the targets the user unlinked each skill from.
 *
 * New global skills link into the default targets, which together reach
 * every provider enabled in T3's settings. Syncing providers adds missing
 * default links later, and nothing propagates on its own. Private project
 * profiles inherit the global library and can switch its skills off for T3
 * agents in that project only.
 *
 * Provider folders get one symlink per skill. A link counts as T3's own only
 * when it points straight at the canonical copy, and nothing else is ever
 * overwritten without the caller's explicit `replace` or `adoptOriginal`. A
 * provider folder that already reaches the canonical copy, say because the
 * whole folder links to the library, is left alone in both directions.
 *
 * Shared mode treats the repository's `.agents/skills` and `AGENTS.md` as
 * canonical, and only writes inside the checkout. Linking them into folders
 * such as `.claude/skills` happens only on an explicit link request.
 *
 * Mutations run one at a time. Each journals its filesystem and metadata
 * changes and undoes them in reverse if anything fails, snapshot included,
 * and is announced on `streamChanges` only once it has committed.
 *
 * @module skills/SkillLibrary
 */
import * as NodeCrypto from "node:crypto";

import {
  type ProviderDriverKind,
  type ResolvedSkillScope,
  type SkillConflict,
  type SkillEntry,
  type SkillInstructionFile,
  type SkillInstructionsDocument,
  type SkillInstructionsSummary,
  type SkillLinkStatus,
  type SkillLinkTarget,
  type SkillOrigin,
  type SkillOwnership,
  type SkillProjectInstructionMode as SkillProjectInstructionModeType,
  type SkillRecoveryEntry as SkillRecoveryEntryType,
  type SkillRef,
  type SkillScope,
  type SkillsArchiveInput,
  type SkillsArchiveResult,
  type SkillsErrorReason,
  type SkillsImportInput,
  type SkillsImportInstructionsInput,
  type SkillsImportResult,
  type SkillsLinkInput,
  type SkillsLinkResult,
  type SkillsListInput,
  type SkillsReadInput,
  type SkillsReadInstructionsInput,
  type SkillsReadResult,
  type SkillsRecoveryInput,
  type SkillsReleaseInput,
  type SkillsReleaseResult,
  type SkillsResetProjectInput,
  type SkillsResetProjectResult,
  type SkillsRestoreResult,
  type SkillsSaveInput,
  type SkillsSaveInstructionsInput,
  type SkillsSaveResult,
  type SkillsSetEnabledInput,
  type SkillsSetEnabledManyInput,
  type SkillsSetEnabledResult,
  type SkillsSnapshot,
  type SkillsSyncProvidersInput,
  type SkillsSyncProvidersResult,
  type SkillsUnlinkInput,
  type SkillsUnlinkResult,
  type SkillsUpdateProjectSettingsInput,
  SkillName,
  SkillProjectInstructionMode,
  SkillRecoveryEntry,
  SkillsError,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  globalSkillRoots,
  instructionLinkTargets,
  isProjectSkillFolder,
  planDefaultLinks,
  projectInstructionFiles,
  projectInstructionLinkTargets,
  projectSkillLinkTargets,
  projectSkillRoots,
  providerSupport,
  resolveSkillHomes,
  SHARED_PROJECT_SKILLS_DIR,
  type SkillHomes,
  type SkillLinkTargetSpec,
  skillLinkTargets,
} from "./skillLocations.ts";
import {
  inspectSkillFolder,
  isNotASymlink,
  listSkillDirectory,
  listSkillFiles,
  makeScanBudget,
  type ScanBudget,
  type ScannedSkill,
  scanSkillRoots,
} from "./skillScan.ts";

const MAX_TEXT_BYTES = 2_000_000;
const MAX_RECOVERY_ENTRIES = 1_000;
const MAX_SUPPRESSED_REPO_SKILLS = 1_000;
const MAX_GIT_POINTER_BYTES = 64_000;
const RECOVERY_ID_PATTERN = /^[0-9A-Z]+-[0-9a-f]{8}$/;

const LibraryState = Schema.Struct({
  version: Schema.Literal(1),
  /** Link paths a disabled global skill had, keyed by skill name. */
  disabledLinks: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  /**
   * Link paths the user unlinked a global skill from, keyed by skill name.
   * Default links and syncing skip them until the user links them again.
   */
  linkExclusions: Schema.Record(Schema.String, Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
type LibraryState = typeof LibraryState.Type;
const LibraryStateJson = Schema.fromJsonString(LibraryState);

const ProjectManifest = Schema.Struct({
  version: Schema.Literal(1),
  projectRoot: Schema.String,
  /** Repository skill entry paths, relative to the root and `/`-separated. */
  disabledRepoSkills: Schema.Array(Schema.String),
  /**
   * Global library skill names switched off in this project. Kept for names
   * no longer in the library, so a skill that comes back stays off here.
   */
  disabledGlobalSkills: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  instructionMode: SkillProjectInstructionMode,
  /** Kept for files written before it was locked to `true`. Never applied as `false`. */
  globalInstructionsEnabled: Schema.Boolean,
});
type ProjectManifest = typeof ProjectManifest.Type;
const ProjectManifestJson = Schema.fromJsonString(ProjectManifest);

const RecoveryRecord = Schema.Struct({
  ...SkillRecoveryEntry.fields,
  linkPaths: Schema.optional(Schema.Array(Schema.String)),
  wasEnabled: Schema.optional(Schema.Boolean),
  /**
   * `replacedOriginal` only: the canonical path of the link T3 put in the
   * original's place. Restore removes that exact link and nothing else.
   */
  installedLinkTarget: Schema.optional(Schema.String),
});
type RecoveryRecord = typeof RecoveryRecord.Type;
const RecoveryRecordJson = Schema.fromJsonString(RecoveryRecord);

/**
 * What a provider adapter applies for a T3 agent working in a project with
 * private customization. Absent when the project has none.
 *
 * `projectRoot` is the folder in the agent's checkout the profile applies to,
 * the working folder or one above it, and every repository path here is inside
 * it. When a Git worktree inherits its primary checkout's profile,
 * `privateRoot` and `provenance.profileRoot` still name the primary.
 */
export interface ProjectSkillOverlay {
  readonly projectRoot: string;
  readonly privateRoot: string;
  /** Folder of enabled private skills, or `null` when there are none. */
  readonly skillRoot: string | null;
  readonly skills: ReadonlyArray<{
    /** Folder name inside `skillRoot`. */
    readonly name: string;
    readonly path: string;
    /** Frontmatter `name`, else the folder name: what providers load it as. */
    readonly invocationName?: string;
  }>;
  /**
   * Native skills to hide from T3 agents: repository skills, and global
   * library skills the project switched off. `name` is the invocation name,
   * which Codex and the catalog match on; `folderName` is the skill folder,
   * which Claude Code names a skill by. `disabled` entries are skills the
   * user switched off. A global one has the library copy as `path` and every
   * provider path that reaches it as `aliases`, since a provider may report
   * either. `replaced` entries are shadowed by a private skill with the same
   * invocation name: one entry with `path: null` covers the name wherever it
   * is kept, and one entry per repository folder found carries its path and
   * `folderName`.
   */
  readonly suppressedRepoSkills: ReadonlyArray<{
    readonly name: string;
    readonly folderName?: string;
    readonly path: string | null;
    readonly aliases?: ReadonlyArray<string>;
    readonly reason: "disabled" | "replaced";
  }>;
  readonly instructions: {
    readonly mode: SkillProjectInstructionModeType;
    /** Private instruction text, `null` when none was written. */
    readonly content: string | null;
    readonly path: string;
    /** Always `true`; see `SkillsUpdateProjectSettingsInput`. */
    readonly globalInstructionsEnabled: boolean;
  };
  readonly provenance: {
    readonly manifestPath: string;
    /** The project the private profile belongs to. */
    readonly profileRoot?: string;
    /** `worktree` when a Git worktree uses its primary checkout's profile. */
    readonly source?: "project" | "worktree";
  };
}

/**
 * One committed mutation. No `projectRoot` means global state changed, which
 * can affect every project. `profileRoot` is set for private project changes
 * and matches `ProjectSkillOverlay.provenance.profileRoot`: worktrees that
 * use that profile are affected too, not only `projectRoot`.
 */
export interface SkillLibraryChange {
  readonly projectRoot?: string;
  readonly profileRoot?: string;
}

export class SkillLibrary extends Context.Service<
  SkillLibrary,
  {
    readonly list: (input: SkillsListInput) => Effect.Effect<SkillsSnapshot, SkillsError>;
    /** Read any listed skill's file, including read-only ones. */
    readonly read: (input: SkillsReadInput) => Effect.Effect<SkillsReadResult, SkillsError>;
    /** Write a library skill file, or a repository skill file in shared mode. */
    readonly save: (input: SkillsSaveInput) => Effect.Effect<SkillsSaveResult, SkillsError>;
    readonly importSkill: (
      input: SkillsImportInput,
    ) => Effect.Effect<SkillsImportResult, SkillsError>;
    readonly setEnabled: (
      input: SkillsSetEnabledInput,
    ) => Effect.Effect<SkillsSetEnabledResult, SkillsError>;
    /** Switch several skills of one scope together: all of them, or none on failure. */
    readonly setEnabledMany: (
      input: SkillsSetEnabledManyInput,
    ) => Effect.Effect<SkillsSetEnabledResult, SkillsError>;
    /** Clear a private profile's switches for inherited or repository skills. */
    readonly resetProject: (
      input: SkillsResetProjectInput,
    ) => Effect.Effect<SkillsResetProjectResult, SkillsError>;
    /** Add missing default links for enabled global skills. Never removes anything. */
    readonly syncProviders: (
      input: SkillsSyncProvidersInput,
    ) => Effect.Effect<SkillsSyncProvidersResult, SkillsError>;
    /** Move a global skill out of the library, keeping the providers that reach it. */
    readonly release: (
      input: SkillsReleaseInput,
    ) => Effect.Effect<SkillsReleaseResult, SkillsError>;
    /** Move a library skill to recovery, removing only T3's links. */
    readonly archive: (
      input: SkillsArchiveInput,
    ) => Effect.Effect<SkillsArchiveResult, SkillsError>;
    readonly restore: (
      input: SkillsRecoveryInput,
    ) => Effect.Effect<SkillsRestoreResult, SkillsError>;
    /** Permanently delete one recovery item. */
    readonly deleteRecovery: (
      input: SkillsRecoveryInput,
    ) => Effect.Effect<SkillsSnapshot, SkillsError>;
    readonly link: (input: SkillsLinkInput) => Effect.Effect<SkillsLinkResult, SkillsError>;
    readonly unlink: (input: SkillsUnlinkInput) => Effect.Effect<SkillsUnlinkResult, SkillsError>;
    readonly readInstructions: (
      input: SkillsReadInstructionsInput,
    ) => Effect.Effect<SkillInstructionsDocument, SkillsError>;
    readonly saveInstructions: (
      input: SkillsSaveInstructionsInput,
    ) => Effect.Effect<SkillInstructionsDocument, SkillsError>;
    /** Copy a provider or repository instruction file into this scope's canonical file. */
    readonly importInstructions: (
      input: SkillsImportInstructionsInput,
    ) => Effect.Effect<SkillInstructionsDocument, SkillsError>;
    readonly updateProjectSettings: (
      input: SkillsUpdateProjectSettingsInput,
    ) => Effect.Effect<SkillsSnapshot, SkillsError>;
    /**
     * Private customization for the project containing `cwd`. Walks up from
     * its canonical path, nearest folder first, through the same profile
     * locations the management methods use, so a Git worktree gets its
     * primary checkout's profile. `None` when nothing would change. Reads only.
     */
    readonly resolveProjectOverlay: (
      cwd: string,
    ) => Effect.Effect<Option.Option<ProjectSkillOverlay>, SkillsError>;
    /**
     * Every committed mutation, published once the mutation lock is free.
     * Rejected and failed mutations publish nothing, and neither do reads.
     */
    readonly streamChanges: Stream.Stream<SkillLibraryChange>;
  }
>()("t3/skills/SkillLibrary") {}

interface ResolvedScope {
  readonly kind: "global" | "project";
  readonly mode: "local" | "shared" | undefined;
  /** The checkout the request names. Repository paths are relative to it. */
  readonly projectRoot: string | undefined;
  /**
   * The folder in this checkout the profile applies to: `projectRoot` or an
   * enclosing folder. The manifest's repository paths are relative to it,
   * exactly as in the overlay.
   */
  readonly activeRoot: string | undefined;
  /**
   * The folder whose private state this scope uses: `activeRoot`, or the
   * primary checkout's matching folder when `activeRoot` is in a Git worktree.
   */
  readonly profileRoot: string | undefined;
  readonly profileSource: "project" | "worktree" | undefined;
  readonly privateDir: string | undefined;
  /** Enabled library skills: global, private, or the repository's `.agents/skills` when shared. */
  readonly libraryDir: string;
  readonly disabledDir: string | undefined;
}

interface ProfileLocation {
  /** The folder in the checkout the profile applies to. */
  readonly activeRoot: string;
  readonly profileRoot: string;
  readonly source: "project" | "worktree";
}

type PathState =
  | { readonly kind: "missing" }
  | { readonly kind: "symlink"; readonly linkText: string }
  | { readonly kind: "directory" | "file" | "other" };

/**
 * How a link path relates to a canonical copy:
 * - `owned`: T3's own link, pointing straight at it.
 * - `inherited`: reaches it without a link of T3's, through a linked parent
 *   folder or someone else's link. T3 neither adds nor removes anything here.
 */
type LinkState =
  | { readonly kind: "missing" | "owned" | "inherited" }
  | { readonly kind: "occupied"; readonly occupant: "directory" | "file" | "symlink" };

type Journal = Array<Effect.Effect<void, PlatformError.PlatformError | SkillsError>>;

type TargetInfo = SkillLinkTargetSpec & {
  /** Every target folder merged into this one because they are physically one. */
  readonly memberPaths: ReadonlyArray<string>;
  readonly isDefault: boolean;
};

const toLinkTarget = ({ id, path, providers, isDefault }: TargetInfo): SkillLinkTarget => ({
  id,
  path,
  providers,
  ...(isDefault ? { default: true } : {}),
});

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const revisionOf = (content: string) => sha256(content).slice(0, 16);

const skillsError = (
  reason: SkillsErrorReason,
  detail: string,
  extra: {
    readonly path?: string;
    readonly currentRevision?: string | null;
    readonly conflictPaths?: ReadonlyArray<string>;
    readonly cause?: unknown;
  } = {},
) => new SkillsError({ reason, detail, ...extra });

const fsError = (detail: string, path: string) => (cause: unknown) =>
  skillsError("filesystem", detail, { path, cause });

const errorCode = (error: PlatformError.PlatformError) =>
  error.cause instanceof Error && "code" in error.cause ? error.cause.code : undefined;

const decodeSkillName = Schema.decodeUnknownOption(SkillName);

const toRecoveryEntry = ({
  linkPaths: _linkPaths,
  wasEnabled: _wasEnabled,
  installedLinkTarget: _installedLinkTarget,
  ...entry
}: RecoveryRecord): SkillRecoveryEntryType => entry;

const defaultManifest = (projectRoot: string): ProjectManifest => ({
  version: 1,
  projectRoot,
  disabledRepoSkills: [],
  disabledGlobalSkills: [],
  instructionMode: "inherit",
  globalInstructionsEnabled: true,
});

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const hostEnvironment = yield* HostProcessEnvironment;
  const hostPlatform = yield* HostProcessPlatform;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const mutex = yield* Semaphore.make(1);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<SkillLibraryChange>(),
    PubSub.shutdown,
  );

  const baseDir = path.resolve(config.baseDir);
  const libraryDir = path.join(baseDir, "skills");
  const disabledDir = path.join(baseDir, "disabled-skills");
  const instructionsFile = path.join(baseDir, "instructions", "AGENTS.md");
  const projectsDir = path.join(baseDir, "skill-projects");
  const recoveryDir = path.join(baseDir, "skill-recovery");
  const stagingDir = path.join(baseDir, ".skill-staging");
  const libraryStatePath = path.join(baseDir, "skill-library.json");
  /** T3's own storage. Nothing here is ever moved aside as a provider's original. */
  const storageDirs = [
    libraryDir,
    disabledDir,
    path.dirname(instructionsFile),
    projectsDir,
    recoveryDir,
    stagingDir,
  ];

  const globalScope: ResolvedScope = {
    kind: "global",
    mode: undefined,
    projectRoot: undefined,
    activeRoot: undefined,
    profileRoot: undefined,
    profileSource: undefined,
    privateDir: undefined,
    libraryDir,
    disabledDir,
  };

  const isWithin = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const isWithinOrEqual = (parent: string, child: string) =>
    parent === child || isWithin(parent, child);

  const loadHomes: Effect.Effect<SkillHomes> = settingsService.getSettings.pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((settings) =>
      resolveSkillHomes({ settings, environment: hostEnvironment, platform: hostPlatform }),
    ),
    Effect.provideContext(services),
  );

  // ── filesystem primitives ────────────────────────────────────────────

  const pathState = (target: string): Effect.Effect<PathState, SkillsError> =>
    Effect.gen(function* () {
      const link = yield* fileSystem.readLink(target).pipe(
        Effect.asSome,
        Effect.catchIf(isNotASymlink, () => Effect.succeedNone),
      );
      if (Option.isSome(link)) return { kind: "symlink", linkText: link.value } as const;
      const info = yield* fileSystem.stat(target).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
      );
      if (Option.isNone(info)) return { kind: "missing" } as const;
      const type = info.value.type;
      const kind: "directory" | "file" | "other" =
        type === "Directory" ? "directory" : type === "File" ? "file" : "other";
      return { kind };
    }).pipe(Effect.mapError(fsError("Could not inspect a path.", target)));

  const realOrUndefined = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => undefined));

  const realOrResolved = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  /** The path with its parent folder made canonical: where the entry itself lives. */
  const canonicalForm = (target: string) =>
    Effect.map(realOrResolved(path.dirname(target)), (parent) =>
      path.join(parent, path.basename(target)),
    );

  /** Where a symlink points after one hop, resolved the way the OS does. */
  const oneHopTarget = (linkPath: string, linkText: string) =>
    Effect.gen(function* () {
      const parent = yield* realOrResolved(path.dirname(linkPath));
      return yield* canonicalForm(path.resolve(parent, linkText));
    });

  /**
   * Where `target` would land physically: its deepest existing ancestor with
   * every link resolved, plus the missing tail. `undefined` when an existing
   * part cannot be resolved, such as a dangling symlink.
   */
  const physicalLocation = (target: string) =>
    Effect.gen(function* () {
      let existing = path.resolve(target);
      const tail: Array<string> = [];
      while ((yield* pathState(existing)).kind === "missing") {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        tail.unshift(path.basename(existing));
        existing = parent;
      }
      const real = yield* realOrUndefined(existing);
      return real === undefined ? undefined : path.join(real, ...tail);
    });

  /** Fails unless `target` and every existing folder above it stay inside the checkout. */
  const requireInsideProject = (projectRoot: string, target: string) =>
    Effect.gen(function* () {
      const physical = yield* physicalLocation(target);
      if (physical === undefined || !isWithinOrEqual(projectRoot, physical)) {
        return yield* skillsError(
          "readOnly",
          "This path leads outside the project. Shared mode only writes inside the checkout.",
          { path: target },
        );
      }
    });

  const isT3Storage = (target: string) =>
    Effect.gen(function* () {
      const physical = yield* canonicalForm(target);
      for (const directory of storageDirs) {
        if (isWithinOrEqual(yield* canonicalForm(directory), physical)) return true;
      }
      return false;
    });

  const classifyLink = (linkPath: string, canonical: string) =>
    Effect.gen(function* () {
      const state = yield* pathState(linkPath);
      if (state.kind === "missing") return { kind: "missing" } satisfies LinkState;
      const canonicalPhysical = yield* canonicalForm(canonical);
      if (
        state.kind === "symlink" &&
        (yield* oneHopTarget(linkPath, state.linkText)) === canonicalPhysical
      ) {
        return { kind: "owned" } satisfies LinkState;
      }
      // The canonical copy itself seen through a linked parent folder, or a
      // chain of someone else's links that ends there.
      if ((yield* canonicalForm(linkPath)) === canonicalPhysical) {
        return { kind: "inherited" } satisfies LinkState;
      }
      const linkReal = yield* realOrUndefined(linkPath);
      if (linkReal !== undefined && linkReal === (yield* realOrUndefined(canonical))) {
        return { kind: "inherited" } satisfies LinkState;
      }
      return {
        kind: "occupied",
        occupant:
          state.kind === "symlink" ? "symlink" : state.kind === "directory" ? "directory" : "file",
      } satisfies LinkState;
    });

  const isOwnedLink = (linkPath: string, canonical: string) =>
    Effect.map(classifyLink(linkPath, canonical), (state) => state.kind === "owned");

  const movePath = (from: string, to: string) =>
    fileSystem.rename(from, to).pipe(
      Effect.catchIf(
        (error) => errorCode(error) === "EXDEV",
        () =>
          fileSystem
            .copy(from, to)
            .pipe(Effect.andThen(fileSystem.remove(from, { recursive: true }))),
      ),
      Effect.mapError(fsError("Could not move a path.", from)),
    );

  const ensureDir = (directory: string) =>
    fileSystem
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.mapError(fsError("Could not create a folder.", directory)));

  const removePath = (target: string) =>
    fileSystem
      .remove(target, { recursive: true })
      .pipe(Effect.mapError(fsError("Could not remove a path.", target)));

  const createLink = (linkText: string, linkPath: string, journal: Journal) =>
    Effect.gen(function* () {
      yield* ensureDir(path.dirname(linkPath));
      yield* fileSystem
        .symlink(linkText, linkPath)
        .pipe(Effect.mapError(fsError("Could not create a link.", linkPath)));
      journal.push(fileSystem.remove(linkPath));
    });

  const writeText = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideContext(services),
      Effect.mapError(fsError("Could not write a file.", filePath)),
    );

  /** Create a folder inside a transaction; the journal removes the topmost folder it created. */
  const ensureDirJournaled = (directory: string, journal: Journal) =>
    Effect.gen(function* () {
      let createdDir: string | undefined;
      for (let current = directory; ; current = path.dirname(current)) {
        if ((yield* pathState(current)).kind !== "missing") break;
        createdDir = current;
        if (path.dirname(current) === current) break;
      }
      if (createdDir !== undefined) {
        yield* ensureDir(directory);
        journal.push(fileSystem.remove(createdDir, { recursive: true }));
      }
    });

  /**
   * Write a file inside a transaction. The journal puts back its previous
   * bytes, or removes it and the topmost folder this write had to create.
   */
  const writeTextJournaled = (filePath: string, contents: string, journal: Journal) =>
    Effect.gen(function* () {
      yield* ensureDirJournaled(path.dirname(filePath), journal);
      const previous = yield* fileSystem.readFile(filePath).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
        Effect.mapError(fsError("Could not read a file.", filePath)),
      );
      yield* writeText(filePath, contents);
      journal.push(
        Option.isSome(previous)
          ? fileSystem.writeFile(filePath, previous.value)
          : fileSystem.remove(filePath, { force: true }),
      );
    });

  /** Text content, `undefined` when the file is missing. Follows symlinks. */
  const readTextIfExists = (filePath: string) =>
    Effect.gen(function* () {
      const info = yield* fileSystem.stat(filePath).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
        Effect.mapError(fsError("Could not read a file.", filePath)),
      );
      if (Option.isNone(info)) return undefined;
      if (info.value.type !== "File") {
        return yield* skillsError("invalidPath", "The path is not a file.", { path: filePath });
      }
      if (Number(info.value.size) > MAX_TEXT_BYTES) {
        return yield* skillsError("unsupported", "The file is too large to edit here.", {
          path: filePath,
        });
      }
      return yield* fileSystem
        .readFileString(filePath)
        .pipe(Effect.mapError(fsError("Could not read a file.", filePath)));
    });

  /** A small file's text, or `undefined` for anything missing, large, or unreadable. */
  const readSmallText = (filePath: string) =>
    Effect.gen(function* () {
      const info = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => undefined));
      if (info?.type !== "File" || Number(info.size) > MAX_GIT_POINTER_BYTES) return undefined;
      return yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => undefined));
    });

  const checkRevision = (
    filePath: string,
    current: string | undefined,
    expected: string | null,
  ): Effect.Effect<void, SkillsError> => {
    const currentRevision = current === undefined ? null : revisionOf(current);
    return currentRevision === expected
      ? Effect.void
      : Effect.fail(
          skillsError(
            "revisionConflict",
            "The file changed since it was read. Reload it before saving.",
            { path: filePath, currentRevision },
          ),
        );
  };

  /**
   * Undo journaled changes in reverse. Stops at the first step that fails:
   * later steps can delete a recovery folder whose payload only an earlier
   * step would have moved back, and keeping data beats a tidy rollback.
   */
  const rollback = (journal: Journal) =>
    Effect.gen(function* () {
      const steps = journal.toReversed();
      for (const [index, undo] of steps.entries()) {
        const failed = yield* undo.pipe(
          Effect.as(false),
          Effect.catchCause((cause) =>
            Effect.logWarning("Skill library rollback stopped to keep data.", {
              cause,
              skippedSteps: steps.length - index - 1,
            }).pipe(Effect.as(true)),
          ),
        );
        if (failed) return;
      }
    });

  const locked = <A>(effect: Effect.Effect<A, SkillsError>) => mutex.withPermits(1)(effect);

  const changeOf = (scope: ResolvedScope): SkillLibraryChange =>
    scope.projectRoot === undefined
      ? {}
      : scope.mode === "local"
        ? { projectRoot: scope.projectRoot, profileRoot: scope.profileRoot! }
        : { projectRoot: scope.projectRoot };

  /**
   * Run one mutation of `scope` under the lock, undoing its journaled changes
   * when it fails, then announce it. Subscribers hear only about committed
   * changes, and only once the lock is free again. The outcome is recorded as
   * the body exits, so a caller interrupted after the commit still announces
   * it, and one interrupted before it rolls back.
   */
  const mutate = <A>(
    input: SkillScope,
    body: (scope: ResolvedScope, journal: Journal) => Effect.Effect<A, SkillsError>,
  ) =>
    Effect.suspend(() => {
      const journal: Journal = [];
      let committed: SkillLibraryChange | undefined;
      return locked(
        Effect.flatMap(resolveScope(input), (scope) =>
          body(scope, journal).pipe(
            Effect.onExit((exit) => {
              if (Exit.isFailure(exit)) return rollback(journal);
              committed = changeOf(scope);
              return Effect.void;
            }),
          ),
        ),
      ).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            committed === undefined ? Effect.void : PubSub.publish(changes, committed),
          ),
        ),
      );
    });

  // ── persisted state ──────────────────────────────────────────────────

  const readJsonFile = <A>(
    filePath: string,
    decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    Effect.gen(function* () {
      const text = yield* readTextIfExists(filePath);
      if (text === undefined) return Option.none<A>();
      return Option.some(
        yield* decode(text).pipe(
          Effect.mapError(fsError("A skill library file is unreadable.", filePath)),
        ),
      );
    });

  /** Write a metadata file, journaling its previous contents when inside a transaction. */
  const writeJsonFile = <A>(
    filePath: string,
    encode: (value: A) => Effect.Effect<string, Schema.SchemaError>,
    value: A,
    journal?: Journal,
  ) =>
    Effect.gen(function* () {
      const contents = yield* encode(value).pipe(
        Effect.mapError(fsError("Could not encode a skill library file.", filePath)),
      );
      yield* journal === undefined
        ? writeText(filePath, contents)
        : writeTextJournaled(filePath, contents, journal);
    });

  const decodeLibraryState = Schema.decodeUnknownEffect(LibraryStateJson);
  const encodeLibraryState = Schema.encodeEffect(LibraryStateJson);
  const decodeManifest = Schema.decodeUnknownEffect(ProjectManifestJson);
  const encodeManifest = Schema.encodeEffect(ProjectManifestJson);
  const decodeRecovery = Schema.decodeUnknownEffect(RecoveryRecordJson);
  const encodeRecovery = Schema.encodeEffect(RecoveryRecordJson);

  const readLibraryState = readJsonFile(libraryStatePath, decodeLibraryState).pipe(
    Effect.map(
      Option.getOrElse((): LibraryState => ({ version: 1, disabledLinks: {}, linkExclusions: {} })),
    ),
  );
  const writeLibraryState = (state: LibraryState, journal: Journal) =>
    writeJsonFile(libraryStatePath, encodeLibraryState, state, journal);

  const privateDirFor = (projectRoot: string) =>
    path.join(projectsDir, sha256(projectRoot).slice(0, 16));

  const readManifestAt = (privateDir: string) =>
    readJsonFile(path.join(privateDir, "manifest.json"), decodeManifest);

  /** The manifest written for exactly `projectRoot`, if any. */
  const exactManifest = (projectRoot: string) =>
    Effect.map(readManifestAt(privateDirFor(projectRoot)), (found) =>
      Option.isSome(found) && found.value.projectRoot === projectRoot ? found.value : undefined,
    );

  const readManifest = (scope: ResolvedScope) =>
    scope.profileRoot === undefined
      ? Effect.undefined
      : Effect.map(
          exactManifest(scope.profileRoot),
          (manifest) => manifest ?? defaultManifest(scope.profileRoot!),
        );

  const writeManifest = (scope: ResolvedScope, manifest: ProjectManifest, journal: Journal) =>
    writeJsonFile(path.join(scope.privateDir!, "manifest.json"), encodeManifest, manifest, journal);

  /** The manifest marks a project as customized, so write it with any private change. */
  const ensureProjectState = (scope: ResolvedScope, journal: Journal) =>
    Effect.gen(function* () {
      if (scope.mode !== "local" || scope.profileRoot === undefined) return;
      if ((yield* exactManifest(scope.profileRoot)) === undefined) {
        yield* writeManifest(scope, defaultManifest(scope.profileRoot), journal);
      }
    });

  const readRecoveryRecord = (recoveryId: string) =>
    Effect.gen(function* () {
      if (!RECOVERY_ID_PATTERN.test(recoveryId)) {
        return yield* skillsError("invalidPath", "Unknown recovery item.");
      }
      const record = yield* readJsonFile(
        path.join(recoveryDir, recoveryId, "entry.json"),
        decodeRecovery,
      );
      if (Option.isNone(record) || record.value.id !== recoveryId) {
        return yield* skillsError("notFound", "The recovery item no longer exists.");
      }
      return record.value;
    });

  /**
   * Which root a recovery item belongs to: archived private skills to the
   * profile, originals moved aside to the checkout they were in.
   */
  const recoveryOwner = (scope: ResolvedScope, kind: RecoveryRecord["kind"]) =>
    kind === "archivedSkill" ? scope.profileRoot : scope.projectRoot;

  const listRecovery = (scope: ResolvedScope) =>
    Effect.gen(function* () {
      const ids = yield* fileSystem
        .readDirectory(recoveryDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const records: Array<SkillRecoveryEntryType> = [];
      for (const id of ids.toSorted().toReversed().slice(0, MAX_RECOVERY_ENTRIES)) {
        if (!RECOVERY_ID_PATTERN.test(id)) continue;
        const record = yield* readJsonFile(
          path.join(recoveryDir, id, "entry.json"),
          decodeRecovery,
        ).pipe(Effect.orElseSucceed(() => Option.none<RecoveryRecord>()));
        if (
          Option.isSome(record) &&
          record.value.projectRoot === recoveryOwner(scope, record.value.kind)
        ) {
          records.push(toRecoveryEntry(record.value));
        }
      }
      return records;
    });

  /** Move `sourcePath` into a new recovery item, journaling the way back. */
  const moveToRecovery = (
    input: {
      readonly kind: RecoveryRecord["kind"];
      readonly name: string;
      readonly sourcePath: string;
      readonly projectRoot?: string | undefined;
      readonly linkPaths?: ReadonlyArray<string>;
      readonly wasEnabled?: boolean;
      readonly installedLinkTarget?: string;
    },
    journal: Journal,
  ) =>
    Effect.gen(function* () {
      const state = yield* pathState(input.sourcePath);
      if (state.kind === "missing") {
        return yield* skillsError("notFound", "Nothing to move to recovery.", {
          path: input.sourcePath,
        });
      }
      if (input.kind === "replacedOriginal" && (yield* isT3Storage(input.sourcePath))) {
        return yield* skillsError(
          "conflict",
          "This path is inside T3's own skill storage, so T3 will not move it aside.",
          { conflictPaths: [input.sourcePath] },
        );
      }
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);
      const id = `${createdAt.replace(/[^0-9TZ]/g, "")}-${NodeCrypto.randomBytes(4).toString("hex")}`;
      const directory = path.join(recoveryDir, id);
      const payload = path.join(directory, "payload");
      yield* ensureDir(directory);
      journal.push(fileSystem.remove(directory, { recursive: true }));
      yield* movePath(input.sourcePath, payload);
      journal.push(movePath(payload, input.sourcePath));
      const record: RecoveryRecord = {
        id,
        kind: input.kind,
        name: input.name,
        originalPath: input.sourcePath,
        itemType:
          state.kind === "symlink" ? "symlink" : state.kind === "directory" ? "directory" : "file",
        createdAt,
        ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
        ...(input.linkPaths === undefined ? {} : { linkPaths: input.linkPaths }),
        ...(input.wasEnabled === undefined ? {} : { wasEnabled: input.wasEnabled }),
        ...(input.installedLinkTarget === undefined
          ? {}
          : { installedLinkTarget: input.installedLinkTarget }),
      };
      yield* writeJsonFile(path.join(directory, "entry.json"), encodeRecovery, record);
      return record;
    });

  // ── scopes ───────────────────────────────────────────────────────────

  /** `~` and `~/...` against the host user's home, as a shell would. */
  const expandHome = (target: string) => {
    const home = (
      hostPlatform === "win32" ? hostEnvironment.USERPROFILE : hostEnvironment.HOME
    )?.trim();
    return home && (target === "~" || target.startsWith("~/"))
      ? path.join(home, target.slice(1))
      : target;
  };

  const resolveProjectRoot = (projectPath: string) =>
    Effect.gen(function* () {
      const expanded = expandHome(projectPath);
      if (!path.isAbsolute(expanded)) {
        return yield* skillsError("invalidPath", "Project paths must be absolute.", {
          path: projectPath,
        });
      }
      const info = yield* fileSystem.stat(expanded).pipe(Effect.orElseSucceed(() => undefined));
      if (info?.type !== "Directory") {
        return yield* skillsError("projectNotFound", "The project folder does not exist.", {
          path: expanded,
        });
      }
      return yield* fileSystem
        .realPath(expanded)
        .pipe(Effect.mapError(fsError("Could not resolve the project folder.", expanded)));
    });

  /**
   * The primary checkout of the linked Git worktree rooted at `checkoutRoot`,
   * read from the worktree's `.git` file and the `commondir` it points to.
   * `undefined` for primary checkouts, submodules, and bare repositories.
   */
  const primaryCheckoutOf = (checkoutRoot: string) =>
    Effect.gen(function* () {
      const dotGit = path.join(checkoutRoot, ".git");
      if ((yield* pathState(dotGit)).kind !== "file") return undefined;
      const pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec((yield* readSmallText(dotGit)) ?? "");
      if (!pointer?.[1]) return undefined;
      const gitDir = path.resolve(checkoutRoot, pointer[1]);
      const common = (yield* readSmallText(path.join(gitDir, "commondir")))?.trim();
      if (!common) return undefined;
      const commonDir = path.resolve(gitDir, common);
      if (path.basename(commonDir) !== ".git") return undefined;
      const primary = yield* realOrUndefined(path.dirname(commonDir));
      return primary === checkoutRoot ? undefined : primary;
    });

  /**
   * Where private profiles for `start` and each folder above it would live,
   * nearest folder first. A folder's own profile comes first; inside a linked
   * Git worktree, the primary checkout's matching folder follows it. Managing
   * a project and running agents in it both read this, so they always agree.
   */
  const profileLocations = (start: string) =>
    Effect.gen(function* () {
      const ancestors = [start];
      for (let parent = path.dirname(start); parent !== ancestors.at(-1);) {
        ancestors.push(parent);
        parent = path.dirname(parent);
      }
      let worktree: { readonly root: string; readonly primary: string } | undefined;
      for (const directory of ancestors) {
        const primary = yield* primaryCheckoutOf(directory);
        if (primary !== undefined) {
          worktree = { root: directory, primary };
          break;
        }
      }
      return ancestors.flatMap((activeRoot): Array<ProfileLocation> => [
        { activeRoot, profileRoot: activeRoot, source: "project" },
        ...(worktree !== undefined && isWithinOrEqual(worktree.root, activeRoot)
          ? [
              {
                activeRoot,
                profileRoot: path.join(worktree.primary, path.relative(worktree.root, activeRoot)),
                source: "worktree" as const,
              },
            ]
          : []),
      ]);
    });

  /** The nearest profile that exists for `start`, in `profileLocations` order. */
  const existingProfile = (start: string) =>
    Effect.gen(function* () {
      for (const location of yield* profileLocations(start)) {
        const manifest = yield* exactManifest(location.profileRoot);
        if (manifest !== undefined) return { ...location, manifest };
      }
      return undefined;
    });

  /**
   * The profile a project's private customization lives in: the one its T3
   * agents already use, which may belong to an enclosing folder or to the
   * primary checkout. With none yet, the primary checkout's matching folder
   * inside a Git worktree, else the project's own. Editing therefore never
   * swaps the settings agents already get for an empty profile.
   */
  const profileFor = (projectRoot: string) =>
    Effect.gen(function* () {
      const existing = yield* existingProfile(projectRoot);
      if (existing !== undefined) return existing;
      return (yield* profileLocations(projectRoot)).findLast(
        (location) => location.activeRoot === projectRoot,
      )!;
    });

  const resolveScope = (scope: SkillScope) =>
    Effect.gen(function* () {
      if (scope.projectPath === undefined) {
        if (scope.mode !== undefined) {
          return yield* skillsError("invalidScope", "A mode needs a project path.");
        }
        return globalScope;
      }
      const projectRoot = yield* resolveProjectRoot(scope.projectPath);
      const mode = scope.mode ?? "local";
      // Shared mode has no profile; its recovery items belong to the checkout.
      const profile =
        mode === "local"
          ? yield* profileFor(projectRoot)
          : { activeRoot: projectRoot, profileRoot: projectRoot, source: "project" as const };
      const privateDir = privateDirFor(profile.profileRoot);
      return {
        kind: "project",
        mode,
        projectRoot,
        activeRoot: profile.activeRoot,
        profileRoot: profile.profileRoot,
        profileSource: mode === "local" ? profile.source : undefined,
        privateDir,
        libraryDir:
          mode === "shared"
            ? path.join(projectRoot, ...SHARED_PROJECT_SKILLS_DIR)
            : path.join(privateDir, "skills"),
        disabledDir: mode === "shared" ? undefined : path.join(privateDir, "disabled-skills"),
      } satisfies ResolvedScope;
    });

  /**
   * Where a skill's origins sit in the checkout, as the manifest records them:
   * relative to the profile's active root and `/`-separated.
   */
  const repositoryPaths = (
    scope: ResolvedScope,
    origins: ReadonlyArray<{ readonly entryPath: string }>,
  ) => {
    const activeRoot = scope.activeRoot;
    if (activeRoot === undefined) return [];
    return origins
      .filter((origin) => isWithin(activeRoot, origin.entryPath))
      .map((origin) => path.relative(activeRoot, origin.entryPath).replaceAll("\\", "/"));
  };

  const requireNotShared = (scope: ResolvedScope, detail: string) =>
    scope.mode === "shared" ? Effect.fail(skillsError("unsupported", detail)) : Effect.void;

  // ── snapshot ─────────────────────────────────────────────────────────

  /**
   * Link targets with folders that are physically one merged into the first.
   * `memberPaths` keeps every folder merged in, and a merged target is a
   * default when any of them is.
   */
  const distinctTargets = (
    specs: ReadonlyArray<SkillLinkTargetSpec>,
    defaults: ReadonlySet<string> = new Set(),
  ) =>
    Effect.gen(function* () {
      const byPhysical = new Map<string, TargetInfo>();
      for (const spec of specs) {
        const physical = (yield* physicalLocation(spec.path)) ?? path.resolve(spec.path);
        const existing = byPhysical.get(physical);
        byPhysical.set(
          physical,
          existing
            ? {
                ...existing,
                providers: [...new Set([...existing.providers, ...spec.providers])],
                memberPaths: [...existing.memberPaths, spec.path],
                isDefault: existing.isDefault || defaults.has(spec.path),
              }
            : { ...spec, memberPaths: [spec.path], isDefault: defaults.has(spec.path) },
        );
      }
      return [...byPhysical.values()];
    });

  /** Global link targets, with the ones a new skill links into marked. */
  const globalLinkTargets = (homes: SkillHomes) =>
    distinctTargets(
      skillLinkTargets(path, homes),
      new Set(planDefaultLinks(path, homes, { reached: new Set(), excluded: new Set() })),
    );

  /**
   * Every provider skill folder entry named `name` that reaches `canonical`,
   * link targets first, in target order. `owned` entries are T3's own links.
   * Folders that are physically one each appear, with the same `physical`.
   */
  const libraryReaders = (homes: SkillHomes, name: string, canonical: string) =>
    Effect.gen(function* () {
      const targetOrder = skillLinkTargets(path, homes).map((target) => target.path);
      const rank = (folder: string) => {
        const index = targetOrder.indexOf(folder);
        return index === -1 ? targetOrder.length : index;
      };
      const roots = globalSkillRoots(path, homes)
        .filter((root) => root.kind === "skills")
        .toSorted((left, right) => rank(left.path) - rank(right.path));
      const readers: Array<{
        readonly rootPath: string;
        readonly entryPath: string;
        readonly providers: ReadonlyArray<ProviderDriverKind>;
        readonly owned: boolean;
        readonly physical: string;
      }> = [];
      for (const root of roots) {
        const entryPath = path.join(root.path, name);
        const state = yield* classifyLink(entryPath, canonical);
        if (state.kind !== "owned" && state.kind !== "inherited") continue;
        readers.push({
          rootPath: root.path,
          entryPath,
          providers: root.providers,
          owned: state.kind === "owned",
          physical: yield* canonicalForm(entryPath),
        });
      }
      return readers;
    });

  /**
   * Link a global library skill into the default targets it does not reach
   * yet. Targets the user unlinked it from are skipped, and so is any path
   * something else holds: nothing is replaced.
   */
  const applyDefaultLinks = (
    homes: SkillHomes,
    name: string,
    exclusions: ReadonlyArray<string>,
    journal: Journal,
  ) =>
    Effect.gen(function* () {
      const canonical = path.join(libraryDir, name);
      const readers = yield* libraryReaders(homes, name, canonical);
      const planned = planDefaultLinks(path, homes, {
        reached: new Set(readers.map((reader) => reader.rootPath)),
        excluded: new Set(exclusions.map((linkPath) => path.dirname(linkPath))),
      });
      const linked: Array<string> = [];
      const skipped: Array<string> = [];
      for (const folder of planned) {
        const linkPath = path.join(folder, name);
        const state = yield* classifyLink(linkPath, canonical);
        if (state.kind === "missing") {
          yield* createLink(canonical, linkPath, journal);
          linked.push(linkPath);
        } else if (state.kind === "occupied") {
          skipped.push(linkPath);
        }
      }
      return { linked, skipped };
    });

  const linkStatus = (
    target: SkillLinkTargetSpec,
    linkPath: string,
    canonical: string,
  ): Effect.Effect<SkillLinkStatus, SkillsError> =>
    Effect.map(classifyLink(linkPath, canonical), (state): SkillLinkStatus => {
      const base = { targetId: target.id, path: linkPath };
      switch (state.kind) {
        case "missing":
          return { ...base, state: "available" };
        case "owned":
          return { ...base, state: "linked" };
        case "inherited":
          return { ...base, state: "linked", inherited: true };
        case "occupied":
          return { ...base, state: "occupied", occupant: state.occupant };
      }
    });

  /**
   * The global library as a local project scope inherits it: read-only
   * `inherited:<name>` entries. One is on in the project when it is on
   * globally, the project has not switched it off, and no private skill
   * takes its name.
   */
  const inheritedEntries = (
    homes: SkillHomes,
    budget: ScanBudget,
    manifest: ProjectManifest | undefined,
    privateEnabledNames: ReadonlySet<string>,
  ) =>
    Effect.gen(function* () {
      const disabledHere = new Set(manifest?.disabledGlobalSkills ?? []);
      const entries: Array<Omit<SkillEntry, "conflicts">> = [];
      for (const library of [
        { directory: libraryDir, enabled: true },
        { directory: disabledDir, enabled: false },
      ]) {
        for (const name of yield* listSkillDirectory(library.directory, budget)) {
          if (Option.isNone(decodeSkillName(name))) continue;
          const canonical = path.join(library.directory, name);
          if ((yield* pathState(canonical)).kind !== "directory") continue;
          const inspected = yield* inspectSkillFolder(canonical, budget);
          if (!inspected) continue;
          const readers = library.enabled ? yield* libraryReaders(homes, name, canonical) : [];
          const origins = readers.map((reader): SkillOrigin => ({
            providers: reader.providers,
            rootPath: reader.rootPath,
            entryPath: reader.entryPath,
            ownedLink: reader.owned,
          }));
          const invocationName = inspected.frontmatterName ?? name;
          const projectDisabled = disabledHere.has(name);
          entries.push({
            id: `inherited:${name}`,
            name,
            invocationName,
            ...(inspected.description === undefined ? {} : { description: inspected.description }),
            scope: "global",
            ownership: "managed",
            enabled:
              library.enabled && !projectDisabled && !privateEnabledNames.has(invocationName),
            path: inspected.realPath,
            providers: [...new Set(origins.flatMap((origin) => origin.providers))],
            origins,
            links: [],
            editable: false,
            globallyEnabled: library.enabled,
            projectDisabled,
          });
        }
      }
      return entries;
    });

  const buildSnapshot = (scope: ResolvedScope): Effect.Effect<SkillsSnapshot, SkillsError> =>
    Effect.gen(function* () {
      const homes = yield* loadHomes;
      const budget = makeScanBudget();
      const scanned = new Map<string, ScannedSkill>();
      const managed = new Map<
        string,
        { readonly name: string; readonly enabled: boolean; readonly canonical: string }
      >();

      const libraries =
        scope.disabledDir === undefined
          ? []
          : [
              { directory: scope.libraryDir, enabled: true },
              { directory: scope.disabledDir, enabled: false },
            ];
      for (const library of libraries) {
        for (const name of yield* listSkillDirectory(library.directory, budget)) {
          if (Option.isNone(decodeSkillName(name))) continue;
          const canonical = path.join(library.directory, name);
          if ((yield* pathState(canonical)).kind !== "directory") continue;
          const inspected = yield* inspectSkillFolder(canonical, budget);
          if (!inspected) continue;
          scanned.set(inspected.realPath, {
            realPath: inspected.realPath,
            name,
            invocationName: inspected.frontmatterName ?? name,
            description: inspected.description,
            kind: "skills",
            pluginId: undefined,
            origins: [],
          });
          managed.set(inspected.realPath, {
            name,
            enabled: library.enabled,
            canonical: path.join(scope.libraryDir, name),
          });
        }
      }

      const globalRoots = globalSkillRoots(path, homes);
      yield* scanSkillRoots(
        scope.kind === "global" ? globalRoots : projectSkillRoots(path, scope.projectRoot!),
        budget,
        scanned,
      );

      const pluginDirs = yield* Effect.forEach(
        [...homes.codexHomes, ...homes.claudeConfigDirs],
        (home) => realOrResolved(path.join(home, "plugins")),
      );
      const manifest = scope.mode === "local" ? yield* readManifest(scope) : undefined;
      const disabledRepo = new Set(manifest?.disabledRepoSkills ?? []);
      const privateEnabledNames = new Set(
        scope.mode === "local"
          ? [...scanned.values()]
              .filter((skill) => managed.get(skill.realPath)?.enabled)
              .map((skill) => skill.invocationName)
          : [],
      );
      const globalTargets = yield* globalLinkTargets(homes);
      const linkTargets =
        scope.mode === "shared"
          ? yield* distinctTargets(projectSkillLinkTargets(path, scope.projectRoot!))
          : globalTargets;
      const libraryState = scope.kind === "global" ? yield* readLibraryState : undefined;
      const realProjectRoot = scope.projectRoot;

      const drafts: Array<Omit<SkillEntry, "conflicts">> = [];
      for (const skill of scanned.values()) {
        const managedInfo = managed.get(skill.realPath);
        // Shared mode links repository skills kept directly in `.agents/skills`.
        const sharedCanonical =
          scope.mode === "shared"
            ? skill.origins.find(
                (origin) =>
                  origin.symlinkTarget === undefined &&
                  path.dirname(origin.entryPath) === scope.libraryDir,
              )?.entryPath
            : undefined;
        const canonical = managedInfo?.canonical ?? sharedCanonical;
        const canonicalPhysical =
          canonical === undefined ? undefined : yield* canonicalForm(canonical);
        const ownership: SkillOwnership = managedInfo
          ? "managed"
          : skill.kind === "plugin" || pluginDirs.some((dir) => isWithin(dir, skill.realPath))
            ? "plugin"
            : skill.kind === "system"
              ? "system"
              : "unmanaged";
        const origins: Array<SkillOrigin> = [];
        for (const origin of skill.origins) {
          origins.push({
            providers: origin.providers,
            rootPath: origin.rootPath,
            entryPath: origin.entryPath,
            ...(origin.symlinkTarget === undefined ? {} : { symlinkTarget: origin.symlinkTarget }),
            ownedLink:
              canonicalPhysical !== undefined &&
              origin.symlinkTarget !== undefined &&
              (yield* oneHopTarget(origin.entryPath, origin.symlinkTarget)) === canonicalPhysical,
          });
        }
        const repoPaths = repositoryPaths(scope, skill.origins);
        const projectDisabled =
          manifest !== undefined && repoPaths.some((relative) => disabledRepo.has(relative));
        const enabled = managedInfo
          ? managedInfo.enabled
          : manifest === undefined ||
            (!projectDisabled && !privateEnabledNames.has(skill.invocationName));
        const editable =
          managedInfo !== undefined ||
          (scope.mode === "shared" &&
            ownership === "unmanaged" &&
            realProjectRoot !== undefined &&
            isWithin(realProjectRoot, skill.realPath));
        const linkable =
          canonical !== undefined &&
          ((managedInfo?.enabled && scope.kind === "global") || sharedCanonical !== undefined);
        let links: Array<SkillLinkStatus> = [];
        if (linkable) {
          const name = path.basename(canonical);
          const excluded = new Set(libraryState?.linkExclusions[name] ?? []);
          const wanted =
            libraryState === undefined
              ? new Set<string>()
              : new Set(
                  planDefaultLinks(path, homes, {
                    reached: new Set(skill.origins.map((origin) => origin.rootPath)),
                    excluded: new Set([...excluded].map((linkPath) => path.dirname(linkPath))),
                  }),
                );
          links = yield* Effect.forEach(linkTargets, (target) =>
            Effect.map(
              linkStatus(target, path.join(target.path, name), canonical),
              (status): SkillLinkStatus => ({
                ...status,
                ...(excluded.has(status.path) ? { excluded: true } : {}),
                ...(status.state !== "linked" &&
                target.memberPaths.some((folder) => wanted.has(folder))
                  ? { syncPending: true }
                  : {}),
              }),
            ),
          );
        }
        drafts.push({
          id: managedInfo ? `managed:${managedInfo.name}` : sha256(skill.realPath).slice(0, 16),
          name: skill.name,
          invocationName: skill.invocationName,
          ...(skill.description === undefined ? {} : { description: skill.description }),
          scope: scope.kind,
          ownership,
          enabled,
          path: skill.realPath,
          providers: [...new Set(origins.flatMap((origin) => origin.providers))],
          origins,
          links,
          editable,
          ...(skill.pluginId === undefined ? {} : { pluginId: skill.pluginId }),
          ...(scope.mode === "local" && !managedInfo ? { projectDisabled } : {}),
        });
      }
      if (scope.mode === "local") {
        drafts.push(...(yield* inheritedEntries(homes, budget, manifest, privateEnabledNames)));
      }

      // Providers collide on the name they load a skill under, not its folder.
      // In a local project scope, an enabled private skill replaces the rest.
      const invocationNameOf = (draft: Omit<SkillEntry, "conflicts">) =>
        draft.invocationName ?? draft.name;
      const isPrivate = (draft: Omit<SkillEntry, "conflicts">) =>
        scope.mode === "local" && draft.id.startsWith("managed:");
      const byName = new Map<string, Array<Omit<SkillEntry, "conflicts">>>();
      for (const draft of drafts) {
        const key = invocationNameOf(draft);
        byName.set(key, [...(byName.get(key) ?? []), draft]);
      }
      const entries: Array<SkillEntry> = drafts
        .map((draft) => ({
          ...draft,
          conflicts: (byName.get(invocationNameOf(draft)) ?? [])
            .filter((other) => other.id !== draft.id)
            .map((other): SkillConflict => ({
              entryId: other.id,
              path: other.path,
              reason:
                isPrivate(draft) !== isPrivate(other) &&
                privateEnabledNames.has(invocationNameOf(draft))
                  ? "replacedByLocal"
                  : "duplicateName",
            })),
        }))
        .toSorted(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.path.localeCompare(right.path) ||
            left.id.localeCompare(right.id),
        );

      const instructionTargets = instructionLinkTargets(path, homes);
      const instructions = yield* instructionsSummary(scope, instructionTargets, manifest);
      const resolvedScope: ResolvedSkillScope = {
        kind: scope.kind,
        ...(scope.mode === undefined ? {} : { mode: scope.mode }),
        ...(scope.projectRoot === undefined ? {} : { projectRoot: scope.projectRoot }),
        ...(scope.profileSource === undefined
          ? {}
          : { profileRoot: scope.profileRoot!, profileSource: scope.profileSource }),
        libraryPath: scope.libraryDir,
      };
      return {
        scope: resolvedScope,
        entries,
        linkTargets: linkTargets.map(toLinkTarget),
        providers: providerSupport({
          enabledProviders: homes.enabledProviders,
          globalRoots,
          linkTargets: globalTargets,
          instructionTargets,
        }),
        instructions,
        recovery: yield* listRecovery(scope),
        warnings: budget.warnings,
      };
    }).pipe(Effect.provideContext(services));

  const instructionsSummary = (
    scope: ResolvedScope,
    targets: ReadonlyArray<SkillLinkTargetSpec>,
    manifest: ProjectManifest | undefined,
  ): Effect.Effect<SkillInstructionsSummary, SkillsError> =>
    Effect.gen(function* () {
      if (scope.kind === "global") {
        const files: Array<SkillInstructionFile> = [];
        const links: Array<SkillLinkStatus> = [];
        for (const target of targets) {
          const status = yield* linkStatus(target, target.path, instructionsFile);
          links.push(status);
          files.push({
            id: target.id,
            kind: "provider",
            path: target.path,
            providers: target.providers,
            exists: status.state !== "available",
            ownedLink: status.state === "linked" && status.inherited !== true,
          });
        }
        return {
          canonicalPath: instructionsFile,
          canonicalExists: (yield* pathState(instructionsFile)).kind === "file",
          files,
          links,
        };
      }
      const projectRoot = scope.projectRoot!;
      const canonicalPath =
        scope.mode === "shared"
          ? path.join(projectRoot, "AGENTS.md")
          : path.join(scope.privateDir!, "AGENTS.md");
      const links =
        scope.mode === "shared"
          ? yield* Effect.forEach(projectInstructionLinkTargets(path, projectRoot), (target) =>
              linkStatus(target, target.path, canonicalPath),
            )
          : [];
      const files: Array<SkillInstructionFile> = [];
      for (const file of projectInstructionFiles(path, projectRoot)) {
        files.push({
          ...file,
          kind: "repository",
          exists: (yield* pathState(file.path)).kind !== "missing",
          ownedLink: links.some(
            (status) => status.path === file.path && status.state === "linked" && !status.inherited,
          ),
        });
      }
      return {
        canonicalPath,
        canonicalExists: (yield* pathState(canonicalPath)).kind !== "missing",
        files,
        links,
        ...(manifest === undefined
          ? {}
          : { mode: manifest.instructionMode, globalInstructionsEnabled: true }),
      };
    });

  const findEntry = (snapshot: SkillsSnapshot, scope: ResolvedScope, ref: SkillRef) => {
    const entry =
      "entryId" in ref
        ? snapshot.entries.find((candidate) => candidate.id === ref.entryId)
        : scope.mode === "shared"
          ? snapshot.entries.find((candidate) =>
              candidate.origins.some(
                (origin) => origin.entryPath === path.join(scope.libraryDir, ref.name),
              ),
            )
          : snapshot.entries.find((candidate) => candidate.id === `managed:${ref.name}`);
    return entry
      ? Effect.succeed(entry)
      : Effect.fail(skillsError("notFound", "The skill is not listed in this scope."));
  };

  // ── file paths inside a skill ────────────────────────────────────────

  const validateRelativeFile = (file: string) => {
    const segments = file.split("/");
    return file.includes("\\") ||
      path.isAbsolute(file) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
      ? Effect.fail(
          skillsError("invalidPath", "Skill file paths must stay inside the skill folder.", {
            path: file,
          }),
        )
      : Effect.succeed(segments);
  };

  /**
   * A writable file path inside `skillDir`. Refuses symlinked folders and
   * files along the way so a write can never land outside the skill.
   */
  const writableFileWithin = (skillDir: string, segments: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      let current = skillDir;
      for (const [index, segment] of segments.entries()) {
        current = path.join(current, segment);
        const state = yield* pathState(current);
        const last = index === segments.length - 1;
        if (state.kind === "missing") break;
        if (state.kind === "symlink") {
          return yield* skillsError("invalidPath", "Refusing to write through a symlink.", {
            path: current,
          });
        }
        if (last ? state.kind !== "file" : state.kind !== "directory") {
          return yield* skillsError("invalidPath", "The path does not match the skill's files.", {
            path: current,
          });
        }
      }
      return path.join(skillDir, ...segments);
    });

  // ── methods ──────────────────────────────────────────────────────────

  const list: SkillLibrary["Service"]["list"] = (input) =>
    Effect.flatMap(resolveScope(input.scope), buildSnapshot);

  const read: SkillLibrary["Service"]["read"] = (input) =>
    Effect.gen(function* () {
      const scope = yield* resolveScope(input.scope);
      const snapshot = yield* buildSnapshot(scope);
      const entry = yield* findEntry(snapshot, scope, input.skill);
      const file = input.file ?? "SKILL.md";
      const segments = yield* validateRelativeFile(file);
      const target = path.join(entry.path, ...segments);
      const realTarget = yield* fileSystem
        .realPath(target)
        .pipe(
          Effect.mapError(() =>
            skillsError("notFound", "The skill file does not exist.", { path: target }),
          ),
        );
      if (!isWithin(entry.path, realTarget)) {
        return yield* skillsError("invalidPath", "The file resolves outside the skill folder.", {
          path: target,
        });
      }
      const content = yield* readTextIfExists(realTarget);
      if (content === undefined) {
        return yield* skillsError("notFound", "The skill file does not exist.", { path: target });
      }
      const listed = yield* listSkillFiles(entry.path).pipe(Effect.provideContext(services));
      return {
        entry,
        file,
        content,
        revision: revisionOf(content),
        files: listed.files,
        filesTruncated: listed.truncated,
      };
    });

  /** The folder of a library skill by name, whether enabled or disabled. */
  const locateLibrarySkill = (scope: ResolvedScope, name: string) =>
    Effect.gen(function* () {
      for (const directory of [scope.libraryDir, scope.disabledDir]) {
        if (directory === undefined) continue;
        const candidate = path.join(directory, name);
        const state = yield* pathState(candidate);
        if (state.kind === "directory") return candidate;
        if (state.kind !== "missing") {
          return yield* skillsError("invalidPath", "The library entry is not a plain folder.", {
            path: candidate,
          });
        }
      }
      return undefined;
    });

  /**
   * A shared skill's physical folder by name. A symlinked entry counts only
   * when the folder it reaches is inside the checkout.
   */
  const locateSharedSkill = (scope: ResolvedScope, name: string) =>
    Effect.gen(function* () {
      const candidate = path.join(scope.libraryDir, name);
      if ((yield* pathState(candidate)).kind === "missing") return undefined;
      const real = yield* realOrUndefined(candidate);
      if (real === undefined || !isWithin(scope.projectRoot!, real)) {
        return yield* skillsError(
          "readOnly",
          "This skill lives outside the project. Shared mode only writes inside the checkout.",
          { path: candidate },
        );
      }
      if ((yield* pathState(real)).kind !== "directory") {
        return yield* skillsError("invalidPath", "The skill entry is not a folder.", {
          path: candidate,
        });
      }
      return real;
    });

  const save: SkillLibrary["Service"]["save"] = (input) =>
    mutate(input.scope, (scope, journal) =>
      Effect.gen(function* () {
        const file = input.file ?? "SKILL.md";
        const segments = yield* validateRelativeFile(file);
        let skillDir: string;
        if ("name" in input.skill) {
          const located =
            scope.mode === "shared"
              ? yield* locateSharedSkill(scope, input.skill.name)
              : yield* locateLibrarySkill(scope, input.skill.name);
          if (located === undefined && (file !== "SKILL.md" || input.expectedRevision !== null)) {
            return yield* skillsError(
              "notFound",
              "The skill does not exist. Create it by saving SKILL.md with no expected revision.",
            );
          }
          skillDir = located ?? path.join(scope.libraryDir, input.skill.name);
        } else {
          const snapshot = yield* buildSnapshot(scope);
          const entry = yield* findEntry(snapshot, scope, input.skill);
          if (!entry.editable) {
            return yield* skillsError(
              "readOnly",
              entry.ownership === "plugin" || entry.ownership === "system"
                ? "Skills installed by a provider are read-only."
                : entry.id.startsWith("inherited:")
                  ? "This skill belongs to the global library. Edit it there for every project, or import it for a private copy in this one."
                  : "Import this skill into the library to edit it.",
              { path: entry.path },
            );
          }
          skillDir = entry.path;
        }
        const target = yield* writableFileWithin(skillDir, segments);
        if (scope.mode === "shared") yield* requireInsideProject(scope.projectRoot!, target);
        const current = yield* readTextIfExists(target);
        yield* checkRevision(target, current, input.expectedRevision);
        const created = (yield* pathState(skillDir)).kind === "missing";
        yield* writeTextJournaled(target, input.content, journal);
        yield* ensureProjectState(scope, journal);
        // A new global skill is for every enabled provider from the start.
        const defaults =
          created && scope.kind === "global"
            ? yield* applyDefaultLinks(yield* loadHomes, path.basename(skillDir), [], journal)
            : undefined;
        return {
          path: target,
          revision: revisionOf(input.content),
          ...(defaults === undefined ? {} : { skippedLinks: defaults.skipped }),
          snapshot: yield* buildSnapshot(scope),
        };
      }),
    );

  const importSkill: SkillLibrary["Service"]["importSkill"] = (input) =>
    mutate(input.scope, (scope, journal) =>
      Effect.gen(function* () {
        if (input.adoptOriginal && scope.kind !== "global") {
          return yield* skillsError(
            "unsupported",
            "Only global imports can replace the original. Project imports never touch it.",
          );
        }
        const snapshot = yield* buildSnapshot(scope);
        let entry = snapshot.entries.find((candidate) => candidate.id === input.entryId);
        if (entry === undefined && scope.kind === "project") {
          const globalSnapshot = yield* buildSnapshot(globalScope);
          entry = globalSnapshot.entries.find((candidate) => candidate.id === input.entryId);
        }
        if (entry === undefined) {
          return yield* skillsError("notFound", "The skill to import is no longer listed.");
        }
        const source = entry;
        const name = Option.getOrUndefined(decodeSkillName(input.name ?? source.name));
        if (name === undefined) {
          return yield* skillsError(
            "invalidName",
            "This skill's folder name cannot be used in the library. Choose a name.",
          );
        }
        if (input.adoptOriginal && source.ownership !== "unmanaged") {
          return yield* skillsError(
            "readOnly",
            "Only unmanaged skills can be adopted. Provider-installed skills stay where they are.",
            { path: source.path },
          );
        }
        const destination = path.join(scope.libraryDir, name);
        if (scope.mode === "shared") yield* requireInsideProject(scope.projectRoot!, destination);
        const occupied: Array<string> = [];
        for (const candidate of [
          destination,
          scope.disabledDir && path.join(scope.disabledDir, name),
        ]) {
          if (candidate && (yield* pathState(candidate)).kind !== "missing")
            occupied.push(candidate);
        }
        if (occupied.length > 0) {
          return yield* skillsError("conflict", "A skill with this name already exists.", {
            conflictPaths: occupied,
          });
        }

        const staging = path.join(stagingDir, NodeCrypto.randomBytes(8).toString("hex"));
        yield* ensureDir(staging);
        yield* Effect.gen(function* () {
          yield* fileSystem
            .copy(source.path, path.join(staging, name))
            .pipe(Effect.mapError(fsError("Could not copy the skill.", source.path)));
          yield* ensureDir(scope.libraryDir);
          yield* movePath(path.join(staging, name), destination);
          journal.push(fileSystem.remove(destination, { recursive: true }));
        }).pipe(
          Effect.ensuring(fileSystem.remove(staging, { recursive: true }).pipe(Effect.ignore)),
        );

        const recovery: Array<RecoveryRecord> = [];
        if (input.adoptOriginal) {
          // Physical folders first: links that pointed at them then reach the
          // library through the new link and can stay as the user made them.
          const ordered = [
            ...source.origins.filter((origin) => origin.symlinkTarget === undefined),
            ...source.origins.filter((origin) => origin.symlinkTarget !== undefined),
          ];
          const destinationReal = yield* realOrResolved(destination);
          const installedLinkTarget = yield* canonicalForm(destination);
          for (const origin of ordered) {
            // Already reaching the copy, possibly through a link made a moment ago
            // when two provider folders are the same folder.
            if ((yield* realOrResolved(origin.entryPath)) === destinationReal) continue;
            recovery.push(
              yield* moveToRecovery(
                {
                  kind: "replacedOriginal",
                  name,
                  sourcePath: origin.entryPath,
                  installedLinkTarget,
                },
                journal,
              ),
            );
            yield* createLink(destination, origin.entryPath, journal);
          }
        }
        yield* ensureProjectState(scope, journal);
        const defaults =
          scope.kind === "global"
            ? yield* applyDefaultLinks(yield* loadHomes, name, [], journal)
            : undefined;
        return {
          name,
          path: destination,
          recovery: recovery.map(toRecoveryEntry),
          ...(defaults === undefined ? {} : { skippedLinks: defaults.skipped }),
          snapshot: yield* buildSnapshot(scope),
        };
      }),
    );

  /** Remove T3's links to a global skill, journaling their return. */
  const removeOwnedLinks = (name: string, journal: Journal) =>
    Effect.gen(function* () {
      const homes = yield* loadHomes;
      const canonical = path.join(libraryDir, name);
      const removed: Array<string> = [];
      for (const target of skillLinkTargets(path, homes)) {
        const linkPath = path.join(target.path, name);
        if (removed.includes(linkPath) || !(yield* isOwnedLink(linkPath, canonical))) continue;
        yield* removePath(linkPath);
        journal.push(fileSystem.symlink(canonical, linkPath));
        removed.push(linkPath);
      }
      return removed;
    });

  /** Recreate remembered links, skipping any path something else now holds. */
  const restoreLinks = (name: string, linkPaths: ReadonlyArray<string>, journal: Journal) =>
    Effect.gen(function* () {
      const canonical = path.join(libraryDir, name);
      const skipped: Array<string> = [];
      for (const linkPath of linkPaths) {
        const state = yield* classifyLink(linkPath, canonical);
        if (state.kind === "missing") {
          yield* createLink(canonical, linkPath, journal);
        } else if (state.kind === "occupied") {
          skipped.push(linkPath);
        }
      }
      return skipped;
    });

  const setEnabledMany: SkillLibrary["Service"]["setEnabledMany"] = (input) =>
    mutate(input.scope, (scope, journal) =>
      Effect.gen(function* () {
        yield* requireNotShared(
          scope,
          "Shared mode only edits repository files. Switch a repository skill off in local mode.",
        );
        // Resolve and check every ref before changing anything.
        const snapshot = input.skills.some((ref) => "entryId" in ref)
          ? yield* buildSnapshot(scope)
          : undefined;
        const libraryNames = new Set<string>();
        const inheritedNames = new Set<string>();
        const repoPaths = new Set<string>();
        for (const ref of input.skills) {
          if ("name" in ref) {
            libraryNames.add(ref.name);
            continue;
          }
          const entry = yield* findEntry(snapshot!, scope, ref);
          if (entry.id.startsWith("inherited:")) {
            if (input.enabled && entry.globallyEnabled === false) {
              return yield* skillsError(
                "unsupported",
                "This skill is off in the global library, so it is off in every project. Switch it on there first.",
                { path: entry.path },
              );
            }
            inheritedNames.add(entry.name);
          } else if (entry.ownership === "managed") {
            libraryNames.add(entry.name);
          } else if (scope.mode === "local" && entry.ownership === "unmanaged") {
            for (const relative of repositoryPaths(scope, entry.origins)) repoPaths.add(relative);
          } else {
            return yield* skillsError(
              "readOnly",
              entry.ownership === "plugin" || entry.ownership === "system"
                ? "Skills installed by a provider are managed outside T3."
                : "Import this skill into the library to switch it off here.",
              { path: entry.path },
            );
          }
        }

        const moves: Array<{ readonly name: string; readonly from: string; readonly to: string }> =
          [];
        for (const name of libraryNames) {
          const enabledPath = path.join(scope.libraryDir, name);
          const disabledPath = path.join(scope.disabledDir!, name);
          const [from, to] = input.enabled
            ? [disabledPath, enabledPath]
            : [enabledPath, disabledPath];
          const fromState = yield* pathState(from);
          const toState = yield* pathState(to);
          if (fromState.kind === "missing") {
            if (toState.kind === "directory") continue;
            return yield* skillsError("notFound", "The library skill does not exist.", {
              path: from,
            });
          }
          if (toState.kind !== "missing") {
            return yield* skillsError("conflict", "Both an enabled and a disabled copy exist.", {
              conflictPaths: [to],
            });
          }
          moves.push({ name, from, to });
        }

        const skippedLinks: Array<string> = [];
        // Global moves add or drop remembered links; the state is written once.
        const state =
          scope.kind === "global" && moves.length > 0 ? yield* readLibraryState : undefined;
        const disabledLinks = { ...state?.disabledLinks };
        for (const { name, from, to } of moves) {
          yield* ensureDir(path.dirname(to));
          if (state === undefined) {
            yield* movePath(from, to);
            journal.push(movePath(to, from));
          } else if (input.enabled) {
            yield* movePath(from, to);
            journal.push(movePath(to, from));
            skippedLinks.push(...(yield* restoreLinks(name, disabledLinks[name] ?? [], journal)));
            delete disabledLinks[name];
          } else {
            const removed = yield* removeOwnedLinks(name, journal);
            yield* movePath(from, to);
            journal.push(movePath(to, from));
            disabledLinks[name] = removed;
          }
        }
        if (state !== undefined) yield* writeLibraryState({ ...state, disabledLinks }, journal);

        if (inheritedNames.size > 0 || repoPaths.size > 0) {
          const manifest = (yield* readManifest(scope))!;
          const toggle = (current: ReadonlyArray<string>, changed: ReadonlySet<string>) => {
            const next = new Set(current);
            for (const value of changed) {
              if (input.enabled) next.delete(value);
              else next.add(value);
            }
            return [...next].toSorted();
          };
          yield* writeManifest(
            scope,
            {
              ...manifest,
              disabledRepoSkills: toggle(manifest.disabledRepoSkills, repoPaths),
              disabledGlobalSkills: toggle(manifest.disabledGlobalSkills, inheritedNames),
            },
            journal,
          );
        }
        return { skippedLinks, snapshot: yield* buildSnapshot(scope) };
      }),
    );

  const setEnabled: SkillLibrary["Service"]["setEnabled"] = (input) =>
    setEnabledMany({ scope: input.scope, skills: [input.skill], enabled: input.enabled });

  const archive: SkillLibrary["Service"]["archive"] = (input) =>
    mutate(input.scope, (scope, journal) =>
      Effect.gen(function* () {
        yield* requireNotShared(
          scope,
          "Remove repository skills with version control. Shared mode never deletes them.",
        );
        const enabledPath = path.join(scope.libraryDir, input.name);
        const wasEnabled = (yield* pathState(enabledPath)).kind === "directory";
        const sourcePath = wasEnabled ? enabledPath : path.join(scope.disabledDir!, input.name);
        if (!wasEnabled && (yield* pathState(sourcePath)).kind !== "directory") {
          return yield* skillsError("notFound", "The library skill does not exist.", {
            path: enabledPath,
          });
        }
        let linkPaths: ReadonlyArray<string> = [];
        if (scope.kind === "global") {
          const state = yield* readLibraryState;
          linkPaths = wasEnabled
            ? yield* removeOwnedLinks(input.name, journal)
            : (state.disabledLinks[input.name] ?? []);
          if (!wasEnabled) {
            const { [input.name]: _archived, ...remaining } = state.disabledLinks;
            yield* writeLibraryState({ ...state, disabledLinks: remaining }, journal);
          }
        }
        const record = yield* moveToRecovery(
          {
            kind: "archivedSkill",
            name: input.name,
            sourcePath,
            projectRoot: recoveryOwner(scope, "archivedSkill"),
            linkPaths,
            wasEnabled,
          },
          journal,
        );
        return { recovery: toRecoveryEntry(record), snapshot: yield* buildSnapshot(scope) };
      }),
    );

  /**
   * True when the symlink at `linkPath` is the exact link `record` installed.
   * Records from before `installedLinkTarget` existed only match a link to the
   * global library copy or global instructions under their own name.
   */
  const isRecordedLink = (record: RecoveryRecord, linkPath: string, linkText: string) =>
    Effect.gen(function* () {
      const expected =
        record.installedLinkTarget !== undefined
          ? [record.installedLinkTarget]
          : record.projectRoot === undefined
            ? [
                path.join(libraryDir, record.name),
                ...(record.name === "instructions" ? [instructionsFile] : []),
              ]
            : [];
      const actual = yield* oneHopTarget(linkPath, linkText);
      for (const candidate of expected) {
        if (actual === (yield* canonicalForm(candidate))) return true;
      }
      return false;
    });

  const scopedRecord = (scope: ResolvedScope, recoveryId: string) =>
    readRecoveryRecord(recoveryId).pipe(
      Effect.filterOrFail(
        (record) => record.projectRoot === recoveryOwner(scope, record.kind),
        () => skillsError("notFound", "The recovery item belongs to another scope."),
      ),
    );

  const retiredDirFor = (recoveryId: string) => path.join(stagingDir, `restored-${recoveryId}`);

  const restore: SkillLibrary["Service"]["restore"] = (input) =>
    mutate(input.scope, (scope, journal) =>
      Effect.gen(function* () {
        const record = yield* scopedRecord(scope, input.recoveryId);
        const itemDir = path.join(recoveryDir, record.id);
        const retiredDir = retiredDirFor(record.id);
        const payload = path.join(itemDir, "payload");
        let restoredPath: string;
        let skippedLinks: Array<string> = [];
        if (record.kind === "archivedSkill") {
          const privateDir =
            record.projectRoot === undefined ? undefined : privateDirFor(record.projectRoot);
          const enabledDir = privateDir ? path.join(privateDir, "skills") : libraryDir;
          const disabledRoot = privateDir ? path.join(privateDir, "disabled-skills") : disabledDir;
          const enabledPath = path.join(enabledDir, record.name);
          const disabledPath = path.join(disabledRoot, record.name);
          const occupied: Array<string> = [];
          for (const candidate of [enabledPath, disabledPath]) {
            if ((yield* pathState(candidate)).kind !== "missing") occupied.push(candidate);
          }
          if (occupied.length > 0) {
            return yield* skillsError("conflict", "A skill with this name exists again.", {
              conflictPaths: occupied,
            });
          }
          const wasEnabled = record.wasEnabled !== false;
          restoredPath = wasEnabled ? enabledPath : disabledPath;
          yield* ensureDir(path.dirname(restoredPath));
          yield* movePath(payload, restoredPath);
          journal.push(movePath(restoredPath, payload));
          if (privateDir === undefined) {
            const linkPaths = record.linkPaths ?? [];
            if (wasEnabled) {
              skippedLinks = yield* restoreLinks(record.name, linkPaths, journal);
            } else if (linkPaths.length > 0) {
              const state = yield* readLibraryState;
              yield* writeLibraryState(
                {
                  ...state,
                  disabledLinks: { ...state.disabledLinks, [record.name]: linkPaths },
                },
                journal,
              );
            }
          }
        } else {
          restoredPath = record.originalPath;
          const state = yield* pathState(restoredPath);
          if (
            state.kind === "symlink" &&
            (yield* isRecordedLink(record, restoredPath, state.linkText))
          ) {
            yield* removePath(restoredPath);
            journal.push(fileSystem.symlink(state.linkText, restoredPath));
          } else if (state.kind !== "missing") {
            return yield* skillsError(
              "conflict",
              "Something other than T3's link now occupies the original location.",
              { conflictPaths: [restoredPath] },
            );
          }
          yield* ensureDir(path.dirname(restoredPath));
          yield* movePath(payload, restoredPath);
          journal.push(movePath(restoredPath, payload));
        }
        // Retire the item by moving it aside, so a rollback can put it back
        // whole. It is deleted only once everything else has succeeded.
        yield* ensureDir(stagingDir);
        yield* movePath(itemDir, retiredDir);
        journal.push(movePath(retiredDir, itemDir));
        return { restoredPath, skippedLinks, snapshot: yield* buildSnapshot(scope) };
      }),
    ).pipe(
      // Only a committed restore gets here, so the id has been validated.
      Effect.tap(() =>
        fileSystem
          .remove(retiredDirFor(input.recoveryId), { recursive: true })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not clear a restored recovery item.", { cause }),
            ),
          ),
      ),
    );

  const deleteRecovery: SkillLibrary["Service"]["deleteRecovery"] = (input) =>
    locked(
      Effect.gen(function* () {
        const scope = yield* resolveScope(input.scope);
        const record = yield* scopedRecord(scope, input.recoveryId);
        yield* removePath(path.join(recoveryDir, record.id));
        return yield* buildSnapshot(scope);
      }),
    );

  /**
   * The canonical path and per-target link paths for a link request. Global
   * links are absolute. Shared links are relative, so they work in every
   * clone, and both ends must stay inside the checkout.
   */
  const linkPlan = (input: SkillsLinkInput | SkillsUnlinkInput, scope: ResolvedScope) =>
    Effect.gen(function* () {
      if (scope.kind === "project" && scope.mode !== "shared") {
        return yield* skillsError(
          "unsupported",
          "Private project customization stays outside the checkout, so there is nothing to link. Use shared mode to link repository files.",
        );
      }
      const projectRoot = scope.projectRoot;
      const isSkill = input.subject.type === "skill";
      const specs =
        projectRoot === undefined
          ? isSkill
            ? skillLinkTargets(path, yield* loadHomes)
            : instructionLinkTargets(path, yield* loadHomes)
          : isSkill
            ? projectSkillLinkTargets(path, projectRoot)
            : projectInstructionLinkTargets(path, projectRoot);
      const canonical =
        input.subject.type === "skill"
          ? path.join(scope.libraryDir, input.subject.name)
          : projectRoot === undefined
            ? instructionsFile
            : path.join(projectRoot, "AGENTS.md");
      if (projectRoot !== undefined) yield* requireInsideProject(projectRoot, canonical);
      const linkPaths: Array<string> = [];
      const physicalPaths: Array<string> = [];
      for (const targetId of input.targetIds) {
        const target = specs.find((spec) => spec.id === targetId);
        if (target === undefined) {
          return yield* skillsError("notFound", `Unknown link target: ${targetId}.`);
        }
        const linkPath =
          input.subject.type === "skill" ? path.join(target.path, input.subject.name) : target.path;
        if (projectRoot !== undefined) {
          yield* requireInsideProject(projectRoot, path.dirname(linkPath));
        }
        // Two targets can be one folder when a provider folder is itself a link.
        const physical = yield* canonicalForm(linkPath);
        if (!physicalPaths.includes(physical)) {
          physicalPaths.push(physical);
          linkPaths.push(linkPath);
        }
      }
      const linkText = (linkPath: string) =>
        projectRoot === undefined
          ? Effect.succeed(canonical)
          : Effect.gen(function* () {
              const parent =
                (yield* physicalLocation(path.dirname(linkPath))) ?? path.dirname(linkPath);
              return path.relative(parent, yield* canonicalForm(canonical));
            });
      return { canonical, linkPaths, linkText };
    });

  const link: SkillLibrary["Service"]["link"] = (input) =>
    mutate(input.scope ?? {}, (scope, journal) =>
      Effect.gen(function* () {
        const plan = yield* linkPlan(input, scope);
        const { canonical, linkPaths } = plan;
        const canonicalState = yield* pathState(canonical);
        if (input.subject.type === "skill" && canonicalState.kind !== "directory") {
          if (scope.kind === "global") {
            const disabled = yield* pathState(path.join(disabledDir, input.subject.name));
            if (disabled.kind === "directory") {
              return yield* skillsError("unsupported", "Enable the skill before linking it.");
            }
          }
          return yield* skillsError(
            "notFound",
            canonicalState.kind === "symlink"
              ? "Only skills stored directly in the library folder can be linked."
              : "The library skill does not exist.",
            { path: canonical },
          );
        }
        if (input.subject.type === "instructions" && canonicalState.kind !== "file") {
          return yield* skillsError("notFound", "Save the instructions before linking them.", {
            path: canonical,
          });
        }
        const occupied: Array<string> = [];
        const pending: Array<string> = [];
        for (const linkPath of linkPaths) {
          const state = yield* classifyLink(linkPath, canonical);
          if (state.kind === "missing") pending.push(linkPath);
          else if (state.kind === "occupied") {
            occupied.push(linkPath);
            pending.push(linkPath);
          }
        }
        if (occupied.length > 0 && !input.replace) {
          return yield* skillsError(
            "conflict",
            "Something already exists where the link would go. Pass replace to move it to recovery.",
            { conflictPaths: occupied },
          );
        }
        const name = input.subject.type === "skill" ? input.subject.name : "instructions";
        const installedLinkTarget = yield* canonicalForm(canonical);
        const recovery: Array<RecoveryRecord> = [];
        for (const linkPath of pending) {
          if (occupied.includes(linkPath)) {
            recovery.push(
              yield* moveToRecovery(
                {
                  kind: "replacedOriginal",
                  name,
                  sourcePath: linkPath,
                  projectRoot: scope.projectRoot,
                  installedLinkTarget,
                },
                journal,
              ),
            );
          }
          yield* createLink(yield* plan.linkText(linkPath), linkPath, journal);
        }
        // Linking again undoes an earlier unlink, so syncing may use the target.
        if (scope.kind === "global" && input.subject.type === "skill") {
          const state = yield* readLibraryState;
          const excluded = state.linkExclusions[name];
          if (excluded !== undefined) {
            const { [name]: _cleared, ...others } = state.linkExclusions;
            const remaining = excluded.filter((entry) => !linkPaths.includes(entry));
            yield* writeLibraryState(
              {
                ...state,
                linkExclusions: remaining.length > 0 ? { ...others, [name]: remaining } : others,
              },
              journal,
            );
          }
        }
        return {
          linked: linkPaths,
          recovery: recovery.map(toRecoveryEntry),
          snapshot: yield* buildSnapshot(scope),
        };
      }),
    );

  const unlink: SkillLibrary["Service"]["unlink"] = (input) =>
    mutate(input.scope ?? {}, (scope, journal) =>
      Effect.gen(function* () {
        const { canonical, linkPaths } = yield* linkPlan(input, scope);
        const removed: Array<string> = [];
        for (const linkPath of linkPaths) {
          const state = yield* pathState(linkPath);
          if (state.kind !== "symlink" || !(yield* isOwnedLink(linkPath, canonical))) continue;
          yield* removePath(linkPath);
          journal.push(fileSystem.symlink(state.linkText, linkPath));
          removed.push(linkPath);
        }
        // A disabled skill remembers links to restore; forget the unlinked ones.
        // Remember the unlink itself so default links and syncing respect it.
        if (scope.kind === "global" && input.subject.type === "skill") {
          const name = input.subject.name;
          const state = yield* readLibraryState;
          const remembered = state.disabledLinks[name];
          yield* writeLibraryState(
            {
              ...state,
              disabledLinks:
                remembered === undefined
                  ? state.disabledLinks
                  : {
                      ...state.disabledLinks,
                      [name]: remembered.filter((entry) => !linkPaths.includes(entry)),
                    },
              linkExclusions: {
                ...state.linkExclusions,
                [name]: [...new Set([...(state.linkExclusions[name] ?? []), ...linkPaths])],
              },
            },
            journal,
          );
        }
        return { removed, snapshot: yield* buildSnapshot(scope) };
      }),
    );

  const resetProject: SkillLibrary["Service"]["resetProject"] = (input) =>
    mutate({ projectPath: input.projectPath, mode: "local" }, (scope, journal) =>
      Effect.gen(function* () {
        const sections = new Set(input.sections);
        // A project without a profile has nothing to reset, and gets none.
        const manifest = yield* exactManifest(scope.profileRoot!);
        const inherited = sections.has("inherited") ? (manifest?.disabledGlobalSkills ?? []) : [];
        const repository = sections.has("repository") ? (manifest?.disabledRepoSkills ?? []) : [];
        if (manifest !== undefined && (inherited.length > 0 || repository.length > 0)) {
          yield* writeManifest(
            scope,
            {
              ...manifest,
              disabledGlobalSkills: sections.has("inherited") ? [] : manifest.disabledGlobalSkills,
              disabledRepoSkills: sections.has("repository") ? [] : manifest.disabledRepoSkills,
            },
            journal,
          );
        }
        return {
          inherited: [...inherited],
          repository: [...repository],
          snapshot: yield* buildSnapshot(scope),
        };
      }),
    );

  const syncProviders: SkillLibrary["Service"]["syncProviders"] = (input) =>
    mutate({}, (scope, journal) =>
      Effect.gen(function* () {
        let names: ReadonlyArray<string>;
        if (input.names !== undefined) {
          for (const name of input.names) {
            if ((yield* pathState(path.join(libraryDir, name))).kind === "directory") continue;
            return (yield* pathState(path.join(disabledDir, name))).kind === "directory"
              ? yield* skillsError("unsupported", "Switch the skill on before syncing it.")
              : yield* skillsError("notFound", "The library skill does not exist.", {
                  path: path.join(libraryDir, name),
                });
          }
          names = input.names;
        } else {
          const listed = yield* listSkillDirectory(libraryDir, makeScanBudget()).pipe(
            Effect.provideContext(services),
          );
          const found: Array<string> = [];
          for (const name of listed) {
            if (Option.isNone(decodeSkillName(name))) continue;
            if ((yield* pathState(path.join(libraryDir, name))).kind === "directory") {
              found.push(name);
            }
          }
          names = found;
        }
        const homes = yield* loadHomes;
        const state = yield* readLibraryState;
        const linked: Array<string> = [];
        const skippedLinks: Array<string> = [];
        for (const name of names) {
          const result = yield* applyDefaultLinks(
            homes,
            name,
            state.linkExclusions[name] ?? [],
            journal,
          );
          linked.push(...result.linked);
          skippedLinks.push(...result.skipped);
        }
        return { linked, skippedLinks, snapshot: yield* buildSnapshot(scope) };
      }),
    );

  /**
   * What releasing a global skill would do, checked against the filesystem
   * as it is now. Fails rather than cut off a provider that reaches the
   * skill in a way T3 cannot carry over to the new location.
   */
  const releasePlan = (input: SkillsReleaseInput) =>
    Effect.gen(function* () {
      const enabledPath = path.join(libraryDir, input.name);
      const wasEnabled = (yield* pathState(enabledPath)).kind === "directory";
      const canonical = wasEnabled ? enabledPath : path.join(disabledDir, input.name);
      if (!wasEnabled && (yield* pathState(canonical)).kind !== "directory") {
        return yield* skillsError("notFound", "The library skill does not exist.", {
          path: enabledPath,
        });
      }
      const homes = yield* loadHomes;
      const canonicalPhysical = yield* canonicalForm(canonical);
      const readers = wasEnabled ? yield* libraryReaders(homes, input.name, canonical) : [];
      const physicals = new Set(readers.map((reader) => reader.physical));
      // A provider folder that is itself a link into the library, or someone
      // else's link T3 cannot follow to one of its own, would lose the skill.
      const stranded: Array<string> = [];
      for (const reader of readers) {
        if (reader.owned) continue;
        if (reader.physical === canonicalPhysical) {
          stranded.push(reader.entryPath);
          continue;
        }
        const state = yield* pathState(reader.entryPath);
        const next =
          state.kind === "symlink"
            ? yield* oneHopTarget(reader.entryPath, state.linkText)
            : undefined;
        if (next === undefined || !physicals.has(next)) stranded.push(reader.entryPath);
      }
      if (stranded.length > 0) {
        return yield* skillsError(
          "conflict",
          "Some provider folders reach this skill through links T3 cannot move, and would lose it. Remove those links, or switch the skill off and release it to a folder of your choice.",
          { conflictPaths: stranded },
        );
      }
      const owned: Array<(typeof readers)[number]> = [];
      for (const reader of readers) {
        if (reader.owned && !owned.some((other) => other.physical === reader.physical)) {
          owned.push(reader);
        }
      }

      let destination: string;
      if (input.destination !== undefined) {
        const expanded = expandHome(input.destination);
        if (!path.isAbsolute(expanded)) {
          return yield* skillsError("invalidPath", "The destination must be an absolute path.", {
            path: input.destination,
          });
        }
        destination = path.resolve(expanded);
      } else if (!wasEnabled) {
        return yield* skillsError(
          "unsupported",
          "No agent can use a skill that is off, so it has no provider folder to go back to. Choose a folder outside every provider skill folder, or switch it on first.",
        );
      } else if (owned[0] !== undefined) {
        destination = owned[0].entryPath;
      } else {
        destination = path.join(homes.home, ".agents", "skills", input.name);
      }

      const destinationState = yield* classifyLink(destination, canonical);
      if (destinationState.kind !== "missing" && destinationState.kind !== "owned") {
        return yield* skillsError(
          "conflict",
          "Something already exists at the destination. Choose another folder.",
          { conflictPaths: [destination] },
        );
      }
      const parent = yield* physicalLocation(path.dirname(destination));
      if (parent === undefined) {
        return yield* skillsError("invalidPath", "The destination's folder cannot be resolved.", {
          path: destination,
        });
      }
      for (const directory of storageDirs) {
        if (isWithinOrEqual(yield* canonicalForm(directory), parent)) {
          return yield* skillsError(
            "invalidPath",
            "The destination is inside T3's own skill storage.",
            { path: destination },
          );
        }
      }
      if (!wasEnabled) {
        const providerFolders = yield* Effect.forEach(
          globalSkillRoots(path, homes).filter((root) => root.kind === "skills"),
          (root) => Effect.map(physicalLocation(root.path), (physical) => physical ?? root.path),
        );
        if (
          providerFolders.includes(parent) ||
          isProjectSkillFolder(parent) ||
          isProjectSkillFolder(path.dirname(destination))
        ) {
          return yield* skillsError(
            "unsupported",
            "A provider reads this folder, so releasing a skill that is off here would switch it on. Choose a folder outside every provider skill folder.",
            { path: destination },
          );
        }
      }
      const destinationPhysical = path.join(parent, path.basename(destination));
      return {
        wasEnabled,
        canonical,
        destination,
        replacesLink: destinationState.kind === "owned",
        relinked: owned
          .filter((reader) => reader.physical !== destinationPhysical)
          .map((reader) => reader.entryPath),
      };
    });

  const release: SkillLibrary["Service"]["release"] = (input) =>
    input.dryRun
      ? locked(
          Effect.gen(function* () {
            const plan = yield* releasePlan(input);
            return {
              name: input.name,
              destination: plan.destination,
              wasEnabled: plan.wasEnabled,
              relinked: plan.relinked,
              released: false,
              snapshot: yield* buildSnapshot(globalScope),
            };
          }),
        )
      : mutate({}, (scope, journal) =>
          Effect.gen(function* () {
            const plan = yield* releasePlan(input);
            if (plan.replacesLink) {
              const state = yield* pathState(plan.destination);
              if (state.kind === "symlink") {
                yield* removePath(plan.destination);
                journal.push(fileSystem.symlink(state.linkText, plan.destination));
              }
            }
            yield* ensureDirJournaled(path.dirname(plan.destination), journal);
            yield* movePath(plan.canonical, plan.destination);
            journal.push(movePath(plan.destination, plan.canonical));
            for (const linkPath of plan.relinked) {
              const state = yield* pathState(linkPath);
              if (state.kind !== "symlink") continue;
              yield* removePath(linkPath);
              journal.push(fileSystem.symlink(state.linkText, linkPath));
              yield* createLink(plan.destination, linkPath, journal);
            }
            // The name is free in the library again, so it can be adopted back.
            const state = yield* readLibraryState;
            const { [input.name]: _links, ...disabledLinks } = state.disabledLinks;
            const { [input.name]: _excluded, ...linkExclusions } = state.linkExclusions;
            if (_links !== undefined || _excluded !== undefined) {
              yield* writeLibraryState({ ...state, disabledLinks, linkExclusions }, journal);
            }
            return {
              name: input.name,
              destination: plan.destination,
              wasEnabled: plan.wasEnabled,
              relinked: plan.relinked,
              released: true,
              snapshot: yield* buildSnapshot(scope),
            };
          }),
        );

  /** The canonical instruction file for a scope, checked for shared-mode escapes. */
  const instructionsPath = (scope: ResolvedScope, file: string | undefined) =>
    Effect.gen(function* () {
      if (scope.mode !== "shared") {
        if (file !== undefined) {
          return yield* skillsError(
            "invalidScope",
            "Choosing a file applies to shared mode. T3 keeps one instructions file per scope.",
          );
        }
        return scope.kind === "global"
          ? instructionsFile
          : path.join(scope.privateDir!, "AGENTS.md");
      }
      const target = path.join(scope.projectRoot!, file ?? "AGENTS.md");
      yield* requireInsideProject(scope.projectRoot!, target);
      return target;
    });

  const instructionsDocument = (
    scope: ResolvedScope,
    filePath: string,
    content: string | undefined,
  ) =>
    Effect.gen(function* () {
      const manifest = scope.mode === "local" ? yield* readManifest(scope) : undefined;
      return {
        path: filePath,
        exists: content !== undefined,
        content: content ?? "",
        revision: content === undefined ? null : revisionOf(content),
        ...(manifest === undefined
          ? {}
          : { mode: manifest.instructionMode, globalInstructionsEnabled: true }),
      } satisfies SkillInstructionsDocument;
    });

  const readInstructions: SkillLibrary["Service"]["readInstructions"] = (input) =>
    Effect.gen(function* () {
      const scope = yield* resolveScope(input.scope);
      const filePath = yield* instructionsPath(scope, input.file);
      return yield* instructionsDocument(scope, filePath, yield* readTextIfExists(filePath));
    });

  const writeInstructions = (
    scope: ResolvedScope,
    filePath: string,
    content: string,
    journal: Journal,
  ) =>
    Effect.gen(function* () {
      // T3's own files are written in place; a shared-mode symlink such as
      // CLAUDE.md -> AGENTS.md keeps its link and updates the file it names.
      if (scope.mode !== "shared" && (yield* pathState(filePath)).kind === "symlink") {
        return yield* skillsError("invalidPath", "Refusing to write through a symlink.", {
          path: filePath,
        });
      }
      yield* writeTextJournaled(filePath, content, journal);
      yield* ensureProjectState(scope, journal);
    });

  const saveInstructions: SkillLibrary["Service"]["saveInstructions"] = (input) =>
    mutate(input.scope, (scope, journal) =>
      Effect.gen(function* () {
        const filePath = yield* instructionsPath(scope, input.file);
        yield* checkRevision(filePath, yield* readTextIfExists(filePath), input.expectedRevision);
        yield* writeInstructions(scope, filePath, input.content, journal);
        return yield* instructionsDocument(scope, filePath, input.content);
      }),
    );

  const importInstructions: SkillLibrary["Service"]["importInstructions"] = (input) =>
    mutate(input.scope, (scope, journal) =>
      Effect.gen(function* () {
        yield* requireNotShared(scope, "Shared mode edits the repository file directly.");
        const homes = yield* loadHomes;
        const sources =
          scope.kind === "global"
            ? instructionLinkTargets(path, homes)
            : projectInstructionFiles(path, scope.projectRoot!);
        const source = sources.find((candidate) => candidate.id === input.sourceId);
        if (source === undefined) {
          return yield* skillsError("notFound", "Unknown instruction file.");
        }
        const filePath = yield* instructionsPath(scope, undefined);
        if (scope.kind === "global") {
          const state = yield* classifyLink(source.path, filePath);
          if (state.kind === "owned" || state.kind === "inherited") {
            return yield* skillsError(
              "conflict",
              "This file already links to the global instructions.",
              { conflictPaths: [source.path] },
            );
          }
        }
        const content = yield* readTextIfExists(source.path);
        if (content === undefined) {
          return yield* skillsError("notFound", "The instruction file does not exist.", {
            path: source.path,
          });
        }
        const current = yield* readTextIfExists(filePath);
        if (current !== undefined && input.expectedRevision === undefined) {
          return yield* skillsError(
            "conflict",
            "Instructions already exist here. Pass their revision to replace them.",
            { conflictPaths: [filePath] },
          );
        }
        yield* checkRevision(filePath, current, input.expectedRevision ?? null);
        yield* writeInstructions(scope, filePath, content, journal);
        return yield* instructionsDocument(scope, filePath, content);
      }),
    );

  const updateProjectSettings: SkillLibrary["Service"]["updateProjectSettings"] = (input) =>
    mutate({ projectPath: input.projectPath, mode: "local" }, (scope, journal) =>
      Effect.gen(function* () {
        if (input.globalInstructionsEnabled === false) {
          return yield* skillsError(
            "unsupported",
            "Global instructions cannot be switched off for one project yet. Providers read them from their own config, which T3 does not override per project.",
          );
        }
        const manifest = (yield* readManifest(scope))!;
        yield* writeManifest(
          scope,
          {
            ...manifest,
            ...(input.instructionMode === undefined
              ? {}
              : { instructionMode: input.instructionMode }),
            globalInstructionsEnabled: true,
          },
          journal,
        );
        return yield* buildSnapshot(scope);
      }),
    );

  const overlayFor = (
    input: ProfileLocation & { readonly manifest: ProjectManifest; readonly start: string },
  ) =>
    Effect.gen(function* () {
      const { activeRoot, manifest } = input;
      const privateRoot = privateDirFor(input.profileRoot);
      const skillRoot = path.join(privateRoot, "skills");
      const budget = makeScanBudget();
      const skills: Array<{
        readonly name: string;
        readonly path: string;
        readonly invocationName: string;
      }> = [];
      for (const name of yield* listSkillDirectory(skillRoot, budget)) {
        if (Option.isNone(decodeSkillName(name))) continue;
        const skillPath = path.join(skillRoot, name);
        const inspected = yield* inspectSkillFolder(skillPath, budget);
        if (inspected) {
          skills.push({ name, path: skillPath, invocationName: inspected.frontmatterName ?? name });
        }
      }
      type Suppression = ProjectSkillOverlay["suppressedRepoSkills"][number];
      const disabled: Array<Suppression> = [];
      for (const relative of manifest.disabledRepoSkills.slice(0, MAX_SUPPRESSED_REPO_SKILLS)) {
        const segments = relative.split("/");
        if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
          continue;
        }
        const repoPath = path.join(activeRoot, ...segments);
        const inspected = yield* inspectSkillFolder(repoPath, budget);
        disabled.push({
          name: inspected?.frontmatterName ?? path.basename(repoPath),
          folderName: path.basename(repoPath),
          path: repoPath,
          reason: "disabled",
        });
      }
      // Global library skills switched off here, at the library copy and at
      // every provider path that reaches it. One off globally, or gone, has
      // nothing to hide; its name stays in the manifest for when it returns.
      const homes = manifest.disabledGlobalSkills.length > 0 ? yield* loadHomes : undefined;
      for (const name of manifest.disabledGlobalSkills.slice(0, MAX_SUPPRESSED_REPO_SKILLS)) {
        if (homes === undefined || Option.isNone(decodeSkillName(name))) continue;
        const canonical = path.join(libraryDir, name);
        if ((yield* pathState(canonical)).kind !== "directory") continue;
        const inspected = yield* inspectSkillFolder(canonical, budget);
        if (!inspected) continue;
        const readers = yield* libraryReaders(homes, name, canonical);
        disabled.push({
          name: inspected.frontmatterName ?? name,
          folderName: name,
          path: inspected.realPath,
          aliases: [
            ...new Set(readers.flatMap((reader) => [reader.entryPath, reader.physical])),
          ].filter((alias) => alias !== inspected.realPath),
          reason: "disabled",
        });
      }
      // Repository folders a private skill shadows, so providers that name
      // skills by folder can switch off the right one. A profile inherited
      // from an enclosing folder covers the working folder's skills too, as
      // managing that folder shows them.
      const replaced: Array<Suppression> = [];
      if (skills.length > 0) {
        const privateNames = new Set(skills.map((skill) => skill.invocationName));
        const scanned = new Map<string, ScannedSkill>();
        const roots = [...new Set([activeRoot, input.start])];
        yield* scanSkillRoots(
          roots.flatMap((root) => projectSkillRoots(path, root)),
          budget,
          scanned,
        );
        for (const skill of scanned.values()) {
          if (!privateNames.has(skill.invocationName)) continue;
          for (const origin of skill.origins) {
            replaced.push({
              name: skill.invocationName,
              folderName: path.basename(origin.entryPath),
              path: origin.entryPath,
              reason: "replaced",
            });
          }
        }
      }
      if (skills.length === 0 && disabled.length === 0 && manifest.instructionMode === "inherit") {
        return Option.none<ProjectSkillOverlay>();
      }
      const instructionsFilePath = path.join(privateRoot, "AGENTS.md");
      const content = yield* readTextIfExists(instructionsFilePath);
      return Option.some<ProjectSkillOverlay>({
        projectRoot: activeRoot,
        privateRoot,
        skillRoot: skills.length > 0 ? skillRoot : null,
        skills,
        suppressedRepoSkills: [
          ...disabled,
          ...skills.map((skill) => ({
            name: skill.invocationName,
            path: null,
            reason: "replaced" as const,
          })),
          ...replaced.toSorted((left, right) => left.path!.localeCompare(right.path!)),
        ],
        instructions: {
          mode: manifest.instructionMode,
          content: content ?? null,
          path: instructionsFilePath,
          globalInstructionsEnabled: true,
        },
        provenance: {
          manifestPath: path.join(privateRoot, "manifest.json"),
          profileRoot: input.profileRoot,
          source: input.source,
        },
      });
    }).pipe(Effect.provideContext(services));

  const resolveProjectOverlay: SkillLibrary["Service"]["resolveProjectOverlay"] = (cwd) =>
    Effect.gen(function* () {
      const start = yield* realOrUndefined(cwd);
      if (start === undefined) return Option.none();
      const existing = yield* existingProfile(start);
      return existing === undefined ? Option.none() : yield* overlayFor({ ...existing, start });
    });

  return SkillLibrary.of({
    list,
    read,
    save,
    importSkill,
    setEnabled,
    archive,
    restore,
    deleteRecovery,
    link,
    unlink,
    readInstructions,
    saveInstructions,
    importInstructions,
    updateProjectSettings,
    setEnabledMany,
    resetProject,
    syncProviders,
    release,
    resolveProjectOverlay,
    streamChanges: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(SkillLibrary, make);
