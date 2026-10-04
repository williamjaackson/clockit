/**
 * Skills management state shared by web and mobile.
 *
 * Each environment owns its own skill library, so every query and command is
 * addressed to one environment and one explicit scope. Snapshots carry
 * metadata only; file contents are read on demand and never cached in atoms.
 *
 * @module state/skills
 */
import {
  PROVIDER_DISPLAY_NAMES,
  SkillName,
  SkillsError,
  WS_METHODS,
  type EnvironmentId,
  type ProviderDriverKind,
  type SkillEntry,
  type SkillProjectMode,
  type SkillScope,
  type SkillsListInput,
  type SkillsSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  request,
  type EnvironmentRpcInput,
  type EnvironmentRpcSuccess,
  type EnvironmentUnaryRpcTag,
} from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  environmentRpcKey,
} from "./runtime.ts";

/** What the user picked in the scope selector. Project scopes always carry an explicit mode. */
export type SkillsScopeSelection =
  | { readonly kind: "global" }
  | {
      readonly kind: "project";
      readonly projectPath: string;
      readonly mode: SkillProjectMode;
    };

export const GLOBAL_SKILLS_SCOPE: SkillsScopeSelection = { kind: "global" };

/** The wire scope for a selection. Shared mode is only ever sent when the selection says so. */
export function skillScope(selection: SkillsScopeSelection): SkillScope {
  return selection.kind === "global"
    ? {}
    : { projectPath: selection.projectPath, mode: selection.mode };
}

/** Identifies one environment and scope, for discarding stale responses and drafts. */
export function skillsScopeKey(
  environmentId: EnvironmentId | null,
  selection: SkillsScopeSelection,
): string {
  return JSON.stringify([environmentId, skillScope(selection)]);
}

export interface SkillsTarget {
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
}

export interface SkillsView {
  readonly snapshot: SkillsSnapshot | null;
  /** True while the scan runs, including a manual refresh over an older snapshot. */
  readonly isLoading: boolean;
  /** Why the last scan failed, already pulled out of its `Cause`. A previous snapshot may still be shown. */
  readonly error: unknown;
}

/**
 * A snapshot and when it was taken, on one counter shared by scans and
 * mutations. A scan takes its number when it starts and a mutation when its
 * answer arrives, so a scan that started before a mutation finished always
 * loses to it, however late it completes.
 */
interface NumberedSnapshot {
  readonly snapshot: SkillsSnapshot;
  readonly generation: number;
}

const EMPTY_SKILLS_VIEW: SkillsView = { snapshot: null, isLoading: false, error: null };

export const EMPTY_SKILLS_VIEW_ATOM = Atom.make(EMPTY_SKILLS_VIEW).pipe(
  Atom.withLabel("environment-data:skills:empty"),
);

export function createSkillsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  let generation = 0;
  const nextGeneration = () => ++generation;

  // Rescan whenever a view mounts. Scans are cheap metadata walks, and another
  // scope's mutation (enabling a global skill, say) can change this one.
  const list = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:skills:list",
    staleTimeMs: 0,
    execute: (input: SkillsListInput) =>
      Effect.suspend(() => {
        const startedAt = nextGeneration();
        return request(WS_METHODS.skillsList, input).pipe(
          Effect.map((snapshot): NumberedSnapshot => ({ snapshot, generation: startedAt })),
        );
      }),
  });
  const listTarget = (target: SkillsTarget) =>
    list({ environmentId: target.environmentId, input: { scope: target.scope } });
  const targetKey = (target: SkillsTarget) =>
    environmentRpcKey({ environmentId: target.environmentId, input: { scope: target.scope } });

  // Mutations answer with a fresh snapshot. Holding it beside the query avoids
  // a second scan; only a scan started after it replaces it.
  const mutatedAtom = Atom.family((_key: string) =>
    Atom.make<NumberedSnapshot | null>(null).pipe(
      Atom.withLabel("environment-data:skills:mutated"),
    ),
  );

  const viewFamily = Atom.family((key: string) =>
    Atom.make((get): SkillsView => {
      const [environmentId, input] = JSON.parse(key) as [EnvironmentId, SkillsListInput];
      const result = get(list({ environmentId, input }));
      const mutated = get(mutatedAtom(key));
      const scanned = Option.getOrNull(AsyncResult.value(result));
      const latest =
        mutated !== null && (scanned === null || mutated.generation > scanned.generation)
          ? mutated
          : scanned;
      return {
        snapshot: latest?.snapshot ?? null,
        isLoading: result.waiting || (result._tag === "Initial" && latest === null),
        error:
          result._tag === "Failure" && !Cause.hasInterruptsOnly(result.cause)
            ? Cause.squash(result.cause)
            : null,
      };
    }).pipe(Atom.withLabel(`environment-data:skills:view:${key}`)),
  );

  const applySnapshot = (
    registry: AtomRegistry.AtomRegistry,
    target: SkillsTarget,
    snapshot: SkillsSnapshot | null,
  ) => {
    if (snapshot === null) {
      // Starts after the mutation finished, so it sees the change.
      registry.refresh(listTarget(target));
      return;
    }
    registry.set(mutatedAtom(targetKey(target)), { snapshot, generation: nextGeneration() });
  };

  // Filesystem changes on one environment run in order, so a quick toggle
  // cannot land before the save it followed.
  const mutationScheduler = createAtomCommandScheduler();
  const mutation = <TTag extends EnvironmentUnaryRpcTag>(options: {
    readonly label: string;
    readonly tag: TTag;
    readonly scope: (input: EnvironmentRpcInput<TTag>) => SkillScope;
    readonly snapshot: (result: EnvironmentRpcSuccess<TTag>) => SkillsSnapshot | null;
  }) =>
    createEnvironmentCommand(runtime, {
      label: options.label,
      scheduler: mutationScheduler,
      concurrency: {
        mode: "serial",
        key: (target: { readonly environmentId: EnvironmentId }) => target.environmentId,
      },
      execute: (input: EnvironmentRpcInput<TTag>, registry, environmentId) =>
        request(options.tag, input).pipe(
          Effect.tap((result) =>
            Effect.sync(() =>
              applySnapshot(
                registry,
                { environmentId, scope: options.scope(input) },
                options.snapshot(result),
              ),
            ),
          ),
        ),
    });

  const withSnapshot = (result: { readonly snapshot: SkillsSnapshot }) => result.snapshot;

  return {
    view: (target: SkillsTarget) => viewFamily(targetKey(target)),
    /** Rescans one scope. The new scan replaces any snapshot a mutation returned once it lands. */
    refresh: (registry: AtomRegistry.AtomRegistry, target: SkillsTarget) => {
      registry.refresh(listTarget(target));
    },
    read: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:read",
      tag: WS_METHODS.skillsRead,
    }),
    readInstructions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:read-instructions",
      tag: WS_METHODS.skillsReadInstructions,
    }),
    save: mutation({
      label: "environment-data:skills:save",
      tag: WS_METHODS.skillsSave,
      scope: (input) => input.scope,
      snapshot: withSnapshot,
    }),
    import: mutation({
      label: "environment-data:skills:import",
      tag: WS_METHODS.skillsImport,
      scope: (input) => input.scope,
      snapshot: withSnapshot,
    }),
    setEnabled: mutation({
      label: "environment-data:skills:set-enabled",
      tag: WS_METHODS.skillsSetEnabled,
      scope: (input) => input.scope,
      snapshot: withSnapshot,
    }),
    archive: mutation({
      label: "environment-data:skills:archive",
      tag: WS_METHODS.skillsArchive,
      scope: (input) => input.scope,
      snapshot: withSnapshot,
    }),
    restore: mutation({
      label: "environment-data:skills:restore",
      tag: WS_METHODS.skillsRestore,
      scope: (input) => input.scope,
      snapshot: withSnapshot,
    }),
    deleteRecovery: mutation({
      label: "environment-data:skills:delete-recovery",
      tag: WS_METHODS.skillsDeleteRecovery,
      scope: (input) => input.scope,
      snapshot: (snapshot) => snapshot,
    }),
    // A link request without a scope is about the global library.
    link: mutation({
      label: "environment-data:skills:link",
      tag: WS_METHODS.skillsLink,
      scope: (input) => input.scope ?? {},
      snapshot: withSnapshot,
    }),
    unlink: mutation({
      label: "environment-data:skills:unlink",
      tag: WS_METHODS.skillsUnlink,
      scope: (input) => input.scope ?? {},
      snapshot: withSnapshot,
    }),
    saveInstructions: mutation({
      label: "environment-data:skills:save-instructions",
      tag: WS_METHODS.skillsSaveInstructions,
      scope: (input) => input.scope,
      snapshot: () => null,
    }),
    importInstructions: mutation({
      label: "environment-data:skills:import-instructions",
      tag: WS_METHODS.skillsImportInstructions,
      scope: (input) => input.scope,
      snapshot: () => null,
    }),
    updateProjectSettings: mutation({
      label: "environment-data:skills:update-project-settings",
      tag: WS_METHODS.skillsUpdateProjectSettings,
      scope: (input) => ({ projectPath: input.projectPath, mode: "local" }),
      snapshot: (snapshot) => snapshot,
    }),
  };
}

export type SkillsEnvironmentAtoms = ReturnType<typeof createSkillsEnvironmentAtoms>;

export type SkillEntryFilter =
  | "all"
  | "library"
  | "unlinked"
  | "symlinked"
  | "unmanaged"
  | "plugin"
  | "conflicts"
  | "disabled";

export const SKILL_ENTRY_FILTERS: ReadonlyArray<{
  readonly value: SkillEntryFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All skills" },
  { value: "library", label: "In library" },
  { value: "unlinked", label: "Not linked" },
  { value: "symlinked", label: "Symlinked" },
  { value: "unmanaged", label: "Not in library" },
  { value: "plugin", label: "Plugins and built-in" },
  { value: "conflicts", label: "Name conflicts" },
  { value: "disabled", label: "Disabled" },
];

/** An enabled global library skill that no provider folder links to yet. */
export function isUnlinkedLibrarySkill(entry: SkillEntry): boolean {
  return (
    entry.ownership === "managed" &&
    entry.scope === "global" &&
    entry.enabled &&
    !entry.links.some((link) => link.state === "linked")
  );
}

function matchesFilter(entry: SkillEntry, filter: SkillEntryFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "library":
      return entry.ownership === "managed";
    case "unlinked":
      return isUnlinkedLibrarySkill(entry);
    case "symlinked":
      return entry.origins.some((origin) => origin.symlinkTarget !== undefined);
    case "unmanaged":
      return entry.ownership === "unmanaged";
    case "plugin":
      return entry.ownership === "plugin" || entry.ownership === "system";
    case "conflicts":
      return entry.conflicts.length > 0;
    case "disabled":
      return !entry.enabled;
  }
}

export function providerDisplayName(provider: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

/** Filters by category, then matches every search word against name, description, or provider. */
export function filterSkillEntries(
  entries: ReadonlyArray<SkillEntry>,
  options: { readonly query: string; readonly filter: SkillEntryFilter },
): ReadonlyArray<SkillEntry> {
  const words = options.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter((entry) => matchesFilter(entry, options.filter))
    .filter((entry) => {
      if (words.length === 0) return true;
      const haystack = [
        entry.name,
        entry.description ?? "",
        ...entry.providers.flatMap((provider) => [provider, providerDisplayName(provider)]),
      ]
        .join("\n")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
        left.path.localeCompare(right.path),
    );
}

const isSkillName = Schema.is(SkillName);

/** Names already used in the library that this scope creates and imports into. */
export function scopeLibraryNames(snapshot: SkillsSnapshot): string[] {
  return snapshot.entries
    .filter((entry) => entry.ownership === "managed" && entry.scope === snapshot.scope.kind)
    .map((entry) => entry.name);
}

/**
 * The skill a create or import just wrote into this scope's library: a library
 * skill by name, or in shared mode the repository folder of that name.
 */
export function findScopeLibraryEntry(snapshot: SkillsSnapshot, name: string): SkillEntry | null {
  const libraryPath = snapshot.scope.libraryPath;
  const inLibrary = (entryPath: string) =>
    entryPath.length === libraryPath.length + 1 + name.length &&
    entryPath.startsWith(libraryPath) &&
    entryPath.endsWith(name);
  return (
    snapshot.entries.find(
      (entry) =>
        (entry.ownership === "managed" &&
          entry.scope === snapshot.scope.kind &&
          entry.name === name) ||
        entry.origins.some(
          (origin) => origin.symlinkTarget === undefined && inLibrary(origin.entryPath),
        ),
    ) ?? null
  );
}

/**
 * Checks a new library skill name. Names compare case-insensitively because
 * the default macOS filesystem does.
 */
export function validateNewSkillName(
  name: string,
  existingNames: ReadonlyArray<string>,
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a name.";
  if (!isSkillName(trimmed)) {
    return "Use up to 128 letters, numbers, dots, dashes, or underscores, starting with a letter or number.";
  }
  const lower = trimmed.toLowerCase();
  if (existingNames.some((existing) => existing.toLowerCase() === lower)) {
    return `A skill named ${trimmed} already exists here.`;
  }
  return null;
}

/**
 * The starting `SKILL.md` for a new skill. Values are written as JSON strings,
 * which YAML reads as double-quoted scalars, so names like `true` or `1.0` and
 * descriptions with colons stay plain strings.
 */
export function newSkillContent(input: {
  readonly name: string;
  readonly description: string;
}): string {
  const name = input.name.trim();
  const description = input.description.trim().replace(/\s+/g, " ");
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${name}`,
    "",
    "",
  ].join("\n");
}

export const isSkillsError = Schema.is(SkillsError);

export function isSkillsRevisionConflict(error: unknown): error is SkillsError {
  return isSkillsError(error) && error.reason === "revisionConflict";
}

/**
 * A short message for a failed skills request, naming any paths that blocked
 * it. Takes the error itself or the `Cause` that carries it.
 */
export function skillsFailureMessage(error: unknown, fallback = "Try again."): string {
  const failure = Cause.isCause(error) ? Cause.squash(error) : error;
  if (isSkillsError(failure)) {
    return failure.conflictPaths?.length
      ? `${failure.detail} ${failure.conflictPaths.join(", ")}`
      : failure.detail;
  }
  if (failure instanceof Error && failure.message.trim().length > 0) return failure.message;
  return fallback;
}

/**
 * What private project changes do. The T3 server applies them when it starts
 * Claude Code and Codex agents; nothing in the checkout or provider config
 * changes, so terminal agents never see them.
 */
export const PRIVATE_PROJECT_SUPPORT_NOTICE =
  "Private changes apply only to Claude Code and Codex agents you run in T3 Code, not to terminal agents, teammates, or other providers. Private skills are listed to the agent, and a same-named repository or user skill is switched off in their favor. Claude Code picks up changes on its next turn, or once its background tasks finish. Codex picks up new skills and instructions on its next turn, but turning a skill off needs a new thread or a reloaded one. Agents read private skills as plain files, so provider-only settings such as allowed-tools or context: fork may not apply.";
