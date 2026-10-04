/**
 * Skills management contract.
 *
 * Each environment keeps one canonical skill library under its T3 home.
 * Provider skill folders link back to it one skill at a time, so the user's
 * other skills, Codex's `.system` folder, and plugin folders stay untouched.
 *
 * Project customization defaults to private state outside the checkout that
 * only T3 agents see. `mode: "shared"` reads and writes the repository's own
 * skill and instruction files instead, and callers must pass it on every
 * request: the server never falls back to it.
 *
 * Snapshots carry metadata only. File contents travel through the read RPCs.
 *
 * @module skills
 */
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The folder name of a library skill. A leading dot is rejected so names can
 * never address `.system` or the library's own bookkeeping files.
 */
export const SkillName = TrimmedNonEmptyString.check(Schema.isPattern(SKILL_NAME_PATTERN));
export type SkillName = typeof SkillName.Type;

export const SkillProjectMode = Schema.Literals(["local", "shared"]);
export type SkillProjectMode = typeof SkillProjectMode.Type;

/**
 * Which skills a request is about. No `projectPath` means the global library.
 * With a `projectPath`, `mode` defaults to `"local"`: private, outside the
 * checkout, T3 agents only. `"shared"` targets files inside the repository.
 */
export const SkillScope = Schema.Struct({
  projectPath: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(SkillProjectMode),
});
export type SkillScope = typeof SkillScope.Type;

/**
 * How private project instructions combine with the repository's own
 * instruction files for T3 agents:
 * - `inherit`: repository instructions apply unchanged; local text is kept but unused.
 * - `append`: repository instructions, then the local text.
 * - `replace`: the local text instead of the repository instructions.
 * - `off`: neither.
 */
export const SkillProjectInstructionMode = Schema.Literals(["inherit", "append", "replace", "off"]);
export type SkillProjectInstructionMode = typeof SkillProjectInstructionMode.Type;

/**
 * - `managed`: lives in a T3 library and is editable there.
 * - `unmanaged`: a provider or repository folder. Read-only until imported,
 *   except repository skills in shared mode.
 * - `plugin`: installed by a provider plugin. Read-only, never moved.
 * - `system`: shipped with the provider, such as Codex's `.system`. Read-only.
 */
export const SkillOwnership = Schema.Literals(["managed", "unmanaged", "plugin", "system"]);
export type SkillOwnership = typeof SkillOwnership.Type;

/** One place a provider finds a skill. Several origins can share one physical folder. */
export const SkillOrigin = Schema.Struct({
  providers: Schema.Array(ProviderDriverKind),
  /** The provider skill folder that was scanned. */
  rootPath: Schema.String,
  /** The skill's path inside that folder, before following symlinks. */
  entryPath: Schema.String,
  /** The link text when `entryPath` is a symlink. */
  symlinkTarget: Schema.optional(Schema.String),
  /** True when the symlink points at a library copy, which T3 may remove. */
  ownedLink: Schema.Boolean,
});
export type SkillOrigin = typeof SkillOrigin.Type;

export const SkillConflictReason = Schema.Literals(["duplicateName", "replacedByLocal"]);
export type SkillConflictReason = typeof SkillConflictReason.Type;

/** Another entry with the same name. Which copy a provider loads depends on its precedence. */
export const SkillConflict = Schema.Struct({
  entryId: Schema.String,
  path: Schema.String,
  reason: SkillConflictReason,
});
export type SkillConflict = typeof SkillConflict.Type;

export const SkillLinkTargetState = Schema.Literals(["linked", "available", "occupied"]);
export type SkillLinkTargetState = typeof SkillLinkTargetState.Type;

export const SkillPathKind = Schema.Literals(["directory", "file", "symlink"]);
export type SkillPathKind = typeof SkillPathKind.Type;

/** Whether one link target holds T3's link, nothing, or something T3 must not overwrite. */
export const SkillLinkStatus = Schema.Struct({
  targetId: Schema.String,
  path: Schema.String,
  state: SkillLinkTargetState,
  /** What occupies the path when `state` is `occupied`. */
  occupant: Schema.optional(SkillPathKind),
  /**
   * `linked` only: the path already reaches the canonical copy without a link
   * of T3's own, for example because the whole provider folder links to the
   * library. Linking is a no-op and unlinking leaves it alone.
   */
  inherited: Schema.optional(Schema.Boolean),
});
export type SkillLinkStatus = typeof SkillLinkStatus.Type;

export const SkillEntryScope = Schema.Literals(["global", "project"]);
export type SkillEntryScope = typeof SkillEntryScope.Type;

/** One physical skill folder, with every provider location that reaches it. */
export const SkillEntry = Schema.Struct({
  /**
   * Library skills use `managed:<name>`, which survives enabling and
   * disabling. Other entries hash their physical path.
   */
  id: Schema.String,
  /** The folder name. Library requests address skills by it. */
  name: TrimmedNonEmptyString,
  /**
   * The name providers load the skill under: `name` from the SKILL.md
   * frontmatter, else the folder name. Duplicate and override checks use it.
   */
  invocationName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  scope: SkillEntryScope,
  ownership: SkillOwnership,
  enabled: Schema.Boolean,
  /** The physical skill folder after following symlinks. */
  path: Schema.String,
  providers: Schema.Array(ProviderDriverKind),
  origins: ForwardCompatibleArray(SkillOrigin),
  conflicts: ForwardCompatibleArray(SkillConflict),
  /**
   * Link state per entry in the snapshot's `linkTargets`. Enabled global
   * library skills, and repository skills in `.agents/skills` in shared mode.
   */
  links: ForwardCompatibleArray(SkillLinkStatus),
  editable: Schema.Boolean,
  pluginId: Schema.optional(Schema.String),
});
export type SkillEntry = typeof SkillEntry.Type;

/**
 * A provider skill folder T3 can link skills into, one symlink per skill.
 * Global snapshots list user-level folders. Shared project snapshots list
 * repository folders whose provider does not read `.agents/skills`.
 */
export const SkillLinkTarget = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  providers: Schema.Array(ProviderDriverKind),
});
export type SkillLinkTarget = typeof SkillLinkTarget.Type;

/** What T3 knows about one provider's skills and instructions on this environment. */
export const SkillProviderSupport = Schema.Struct({
  provider: ProviderDriverKind,
  /** False when T3 can only show what the provider reports itself. */
  scanned: Schema.Boolean,
  globalRoots: Schema.Array(Schema.String),
  /** Folders relative to a project root. */
  projectRoots: Schema.Array(Schema.String),
  linkTargetIds: Schema.Array(Schema.String),
  instructionTargetIds: Schema.Array(Schema.String),
  limitations: Schema.Array(Schema.String),
});
export type SkillProviderSupport = typeof SkillProviderSupport.Type;

export const SkillInstructionFileKind = Schema.Literals(["provider", "repository"]);
export type SkillInstructionFileKind = typeof SkillInstructionFileKind.Type;

/** An instruction file a provider reads, such as `~/.codex/AGENTS.md` or a repository `CLAUDE.md`. */
export const SkillInstructionFile = Schema.Struct({
  id: Schema.String,
  kind: SkillInstructionFileKind,
  path: Schema.String,
  providers: Schema.Array(ProviderDriverKind),
  exists: Schema.Boolean,
  /** True when the file is T3's symlink to the canonical instructions. */
  ownedLink: Schema.Boolean,
});
export type SkillInstructionFile = typeof SkillInstructionFile.Type;

export const SkillInstructionsSummary = Schema.Struct({
  /** Where this scope's canonical instructions live. Shared mode points into the repository. */
  canonicalPath: Schema.String,
  canonicalExists: Schema.Boolean,
  files: ForwardCompatibleArray(SkillInstructionFile),
  /** Global and shared project scopes: link state per instruction target. */
  links: ForwardCompatibleArray(SkillLinkStatus),
  /** Project scopes only. */
  mode: Schema.optional(SkillProjectInstructionMode),
  /**
   * Project local scope only, and always `true`: T3 cannot yet keep global
   * instructions away from every provider in one project.
   */
  globalInstructionsEnabled: Schema.optional(Schema.Boolean),
});
export type SkillInstructionsSummary = typeof SkillInstructionsSummary.Type;

/**
 * - `archivedSkill`: a library skill the user deleted. Restoring puts it back.
 * - `replacedOriginal`: a provider file or folder moved aside so T3 could link
 *   in its place. Restoring removes T3's link and moves the original back.
 */
export const SkillRecoveryKind = Schema.Literals(["archivedSkill", "replacedOriginal"]);
export type SkillRecoveryKind = typeof SkillRecoveryKind.Type;

export const SkillRecoveryEntry = Schema.Struct({
  id: Schema.String,
  kind: SkillRecoveryKind,
  name: Schema.String,
  originalPath: Schema.String,
  itemType: SkillPathKind,
  createdAt: IsoDateTime,
  projectRoot: Schema.optional(Schema.String),
});
export type SkillRecoveryEntry = typeof SkillRecoveryEntry.Type;

export const ResolvedSkillScope = Schema.Struct({
  kind: SkillEntryScope,
  mode: Schema.optional(SkillProjectMode),
  /** The canonical (symlink-free) project root. */
  projectRoot: Schema.optional(Schema.String),
  /**
   * Local mode only: the folder whose private profile this scope reads and
   * edits, the same one T3 agents in `projectRoot` use. It differs from
   * `projectRoot` when the profile belongs to an enclosing folder, or to the
   * primary checkout of a Git worktree (`profileSource: "worktree"`). Changes
   * then apply everywhere that profile does.
   */
  profileRoot: Schema.optional(Schema.String),
  profileSource: Schema.optional(Schema.Literals(["project", "worktree"])),
  /** Where new and imported skills go for this scope. */
  libraryPath: Schema.String,
});
export type ResolvedSkillScope = typeof ResolvedSkillScope.Type;

export const SkillsSnapshot = Schema.Struct({
  scope: ResolvedSkillScope,
  entries: ForwardCompatibleArray(SkillEntry),
  linkTargets: ForwardCompatibleArray(SkillLinkTarget),
  providers: ForwardCompatibleArray(SkillProviderSupport),
  instructions: SkillInstructionsSummary,
  recovery: ForwardCompatibleArray(SkillRecoveryEntry),
  /** Bounded scans and unreadable folders. The snapshot is still usable. */
  warnings: Schema.Array(Schema.String),
});
export type SkillsSnapshot = typeof SkillsSnapshot.Type;

/** A library skill by name, or any listed entry by id. */
export const SkillRef = Schema.Union([
  Schema.Struct({ name: SkillName }),
  Schema.Struct({ entryId: TrimmedNonEmptyString }),
]);
export type SkillRef = typeof SkillRef.Type;

export const SkillsListInput = Schema.Struct({ scope: SkillScope });
export type SkillsListInput = typeof SkillsListInput.Type;

export const SkillsReadInput = Schema.Struct({
  scope: SkillScope,
  skill: SkillRef,
  /** Path relative to the skill folder. Defaults to `SKILL.md`. */
  file: Schema.optional(TrimmedNonEmptyString),
});
export type SkillsReadInput = typeof SkillsReadInput.Type;

export const SkillsReadResult = Schema.Struct({
  entry: SkillEntry,
  file: Schema.String,
  content: Schema.String,
  revision: Schema.String,
  /** Files in the skill folder relative to it, capped. */
  files: Schema.Array(Schema.String),
  filesTruncated: Schema.Boolean,
});
export type SkillsReadResult = typeof SkillsReadResult.Type;

export const SkillsSaveInput = Schema.Struct({
  scope: SkillScope,
  skill: SkillRef,
  file: Schema.optional(TrimmedNonEmptyString),
  content: Schema.String,
  /**
   * The revision the edit started from, or `null` when creating the file.
   * A mismatch fails with `revisionConflict` instead of overwriting.
   */
  expectedRevision: Schema.NullOr(Schema.String),
});
export type SkillsSaveInput = typeof SkillsSaveInput.Type;

export const SkillsSaveResult = Schema.Struct({
  path: Schema.String,
  revision: Schema.String,
  snapshot: SkillsSnapshot,
});
export type SkillsSaveResult = typeof SkillsSaveResult.Type;

export const SkillsImportInput = Schema.Struct({
  scope: SkillScope,
  /** A listed entry. The whole folder is copied, including scripts and assets. */
  entryId: TrimmedNonEmptyString,
  /** Library name for the copy. Defaults to the entry's name. */
  name: Schema.optional(SkillName),
  /**
   * Global scope only: replace the original in its provider folder with a
   * link to the library copy. The original moves to recovery first.
   */
  adoptOriginal: Schema.optional(Schema.Boolean),
});
export type SkillsImportInput = typeof SkillsImportInput.Type;

export const SkillsImportResult = Schema.Struct({
  name: SkillName,
  path: Schema.String,
  recovery: Schema.Array(SkillRecoveryEntry),
  snapshot: SkillsSnapshot,
});
export type SkillsImportResult = typeof SkillsImportResult.Type;

export const SkillsSetEnabledInput = Schema.Struct({
  scope: SkillScope,
  skill: SkillRef,
  enabled: Schema.Boolean,
});
export type SkillsSetEnabledInput = typeof SkillsSetEnabledInput.Type;

export const SkillsSetEnabledResult = Schema.Struct({
  /** Links T3 could not restore because something else now occupies the path. */
  skippedLinks: Schema.Array(Schema.String),
  snapshot: SkillsSnapshot,
});
export type SkillsSetEnabledResult = typeof SkillsSetEnabledResult.Type;

export const SkillsArchiveInput = Schema.Struct({
  scope: SkillScope,
  name: SkillName,
});
export type SkillsArchiveInput = typeof SkillsArchiveInput.Type;

export const SkillsArchiveResult = Schema.Struct({
  recovery: SkillRecoveryEntry,
  snapshot: SkillsSnapshot,
});
export type SkillsArchiveResult = typeof SkillsArchiveResult.Type;

export const SkillsRecoveryInput = Schema.Struct({
  scope: SkillScope,
  recoveryId: TrimmedNonEmptyString,
});
export type SkillsRecoveryInput = typeof SkillsRecoveryInput.Type;

export const SkillsRestoreResult = Schema.Struct({
  restoredPath: Schema.String,
  skippedLinks: Schema.Array(Schema.String),
  snapshot: SkillsSnapshot,
});
export type SkillsRestoreResult = typeof SkillsRestoreResult.Type;

/**
 * What a link request is about: one library skill or the instructions of the
 * request's scope. In shared mode that is a skill in the repository's
 * `.agents/skills` and the repository's `AGENTS.md`.
 */
export const SkillLinkSubject = Schema.Union([
  Schema.Struct({ type: Schema.Literal("skill"), name: SkillName }),
  Schema.Struct({ type: Schema.Literal("instructions") }),
]);
export type SkillLinkSubject = typeof SkillLinkSubject.Type;

export const SkillsLinkInput = Schema.Struct({
  /**
   * Defaults to the global library. A project scope must pass
   * `mode: "shared"`: private project customization never links into the checkout.
   */
  scope: Schema.optional(SkillScope),
  subject: SkillLinkSubject,
  targetIds: Schema.NonEmptyArray(TrimmedNonEmptyString),
  /**
   * Move whatever occupies a target to recovery and link in its place.
   * Without it, any occupied target fails the whole request before anything changes.
   */
  replace: Schema.optional(Schema.Boolean),
});
export type SkillsLinkInput = typeof SkillsLinkInput.Type;

export const SkillsLinkResult = Schema.Struct({
  linked: Schema.Array(Schema.String),
  recovery: Schema.Array(SkillRecoveryEntry),
  snapshot: SkillsSnapshot,
});
export type SkillsLinkResult = typeof SkillsLinkResult.Type;

export const SkillsUnlinkInput = Schema.Struct({
  /** Same rules as `SkillsLinkInput.scope`. */
  scope: Schema.optional(SkillScope),
  subject: SkillLinkSubject,
  targetIds: Schema.NonEmptyArray(TrimmedNonEmptyString),
});
export type SkillsUnlinkInput = typeof SkillsUnlinkInput.Type;

export const SkillsUnlinkResult = Schema.Struct({
  removed: Schema.Array(Schema.String),
  snapshot: SkillsSnapshot,
});
export type SkillsUnlinkResult = typeof SkillsUnlinkResult.Type;

/** Shared mode only: which repository instruction file to address. */
export const SkillInstructionFileName = Schema.Literals(["AGENTS.md", "CLAUDE.md"]);
export type SkillInstructionFileName = typeof SkillInstructionFileName.Type;

export const SkillsReadInstructionsInput = Schema.Struct({
  scope: SkillScope,
  file: Schema.optional(SkillInstructionFileName),
});
export type SkillsReadInstructionsInput = typeof SkillsReadInstructionsInput.Type;

export const SkillInstructionsDocument = Schema.Struct({
  path: Schema.String,
  exists: Schema.Boolean,
  content: Schema.String,
  /** `null` when the file does not exist yet. */
  revision: Schema.NullOr(Schema.String),
  /** Project local scope only. */
  mode: Schema.optional(SkillProjectInstructionMode),
  globalInstructionsEnabled: Schema.optional(Schema.Boolean),
});
export type SkillInstructionsDocument = typeof SkillInstructionsDocument.Type;

export const SkillsSaveInstructionsInput = Schema.Struct({
  scope: SkillScope,
  file: Schema.optional(SkillInstructionFileName),
  content: Schema.String,
  expectedRevision: Schema.NullOr(Schema.String),
});
export type SkillsSaveInstructionsInput = typeof SkillsSaveInstructionsInput.Type;

export const SkillsImportInstructionsInput = Schema.Struct({
  /** Global or project local. Shared mode already edits the repository file directly. */
  scope: SkillScope,
  /** A file id from the snapshot's `instructions.files`. */
  sourceId: TrimmedNonEmptyString,
  /**
   * Required when canonical instructions already exist: the revision being
   * replaced. Without it an existing canonical file fails with `conflict`.
   */
  expectedRevision: Schema.optional(Schema.NullOr(Schema.String)),
});
export type SkillsImportInstructionsInput = typeof SkillsImportInstructionsInput.Type;

export const SkillsUpdateProjectSettingsInput = Schema.Struct({
  projectPath: TrimmedNonEmptyString,
  instructionMode: Schema.optional(SkillProjectInstructionMode),
  /** Only `true` is accepted. `false` fails with `unsupported`. */
  globalInstructionsEnabled: Schema.optional(Schema.Boolean),
});
export type SkillsUpdateProjectSettingsInput = typeof SkillsUpdateProjectSettingsInput.Type;

export const SkillsErrorReason = Schema.Literals([
  "invalidScope",
  "projectNotFound",
  "invalidName",
  "invalidPath",
  "notFound",
  "conflict",
  "revisionConflict",
  "readOnly",
  "unsupported",
  "filesystem",
]);
export type SkillsErrorReason = typeof SkillsErrorReason.Type;

export class SkillsError extends Schema.TaggedError<SkillsError>()("SkillsError", {
  reason: SkillsErrorReason,
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  path: Schema.optional(Schema.String),
  /** `revisionConflict` only: the revision on disk, `null` when the file is gone. */
  currentRevision: Schema.optional(Schema.NullOr(Schema.String)),
  /** `conflict` only: the paths that blocked the request. */
  conflictPaths: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.path === undefined
      ? `Skills ${this.reason}: ${this.detail}`
      : `Skills ${this.reason}: ${this.detail} (${this.path})`;
  }
}
