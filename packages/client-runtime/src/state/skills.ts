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
  ProviderDriverKind,
  SkillName,
  SkillsError,
  WS_METHODS,
  type EnvironmentId,
  type ResolvedSkillScope,
  type SkillEntry,
  type SkillInstructionsSummary,
  type SkillLinkStatus,
  type SkillLinkTarget,
  type SkillPathKind,
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
  const serialPerEnvironment = {
    mode: "serial",
    key: (target: { readonly environmentId: EnvironmentId }) => target.environmentId,
  } as const;
  const mutation = <TTag extends EnvironmentUnaryRpcTag>(options: {
    readonly label: string;
    readonly tag: TTag;
    readonly scope: (input: EnvironmentRpcInput<TTag>) => SkillScope;
    readonly snapshot: (result: EnvironmentRpcSuccess<TTag>) => SkillsSnapshot | null;
  }) =>
    createEnvironmentCommand(runtime, {
      label: options.label,
      scheduler: mutationScheduler,
      concurrency: serialPerEnvironment,
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
  const globalScope = (): SkillScope => ({});
  const localProjectScope = (input: { readonly projectPath: string }): SkillScope => ({
    projectPath: input.projectPath,
    mode: "local",
  });

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
    /** All of the skills switch, or none do. */
    setEnabledMany: mutation({
      label: "environment-data:skills:set-enabled-many",
      tag: WS_METHODS.skillsSetEnabledMany,
      scope: (input) => input.scope,
      snapshot: withSnapshot,
    }),
    /** Clears per-project switches. Always the project's private scope. */
    resetProject: mutation({
      label: "environment-data:skills:reset-project",
      tag: WS_METHODS.skillsResetProject,
      scope: localProjectScope,
      snapshot: withSnapshot,
    }),
    syncProviders: mutation({
      label: "environment-data:skills:sync-providers",
      tag: WS_METHODS.skillsSyncProviders,
      scope: globalScope,
      snapshot: withSnapshot,
    }),
    /** Moves a global skill out of the library. Use `releasePreview` to show the plan first. */
    release: mutation({
      label: "environment-data:skills:release",
      tag: WS_METHODS.skillsRelease,
      scope: globalScope,
      snapshot: withSnapshot,
    }),
    /**
     * The plan a release would carry out, as a dry run. It changes nothing, so
     * its snapshot is not published. It queues behind pending mutations so the
     * plan reflects them.
     */
    releasePreview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:release-preview",
      tag: WS_METHODS.skillsRelease,
      scheduler: mutationScheduler,
      concurrency: serialPerEnvironment,
      execute: (input) => request(WS_METHODS.skillsRelease, { ...input, dryRun: true }),
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
      scope: localProjectScope,
      snapshot: (snapshot) => snapshot,
    }),
  };
}

export type SkillsEnvironmentAtoms = ReturnType<typeof createSkillsEnvironmentAtoms>;

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");

/**
 * The providers whose agents T3 starts with a project's private skills and
 * switches. Every other provider reads skill folders on its own.
 */
export const T3_PROJECT_PROVIDERS: ReadonlyArray<ProviderDriverKind> = [CLAUDE, CODEX];

function isPrivateProjectScope(scope: ResolvedSkillScope): boolean {
  return scope.kind === "project" && scope.mode !== "shared";
}

function isSharedProjectScope(scope: ResolvedSkillScope): boolean {
  return scope.kind === "project" && scope.mode === "shared";
}

/**
 * Where an entry belongs on the page:
 * - `mine`: My skills, the global library.
 * - `inherited`: My skills as a project sees them, read-only there.
 * - `repository`: the project's own skill folders.
 * - `private`: the project's private skills.
 *
 * `null` for entries the page leaves out: plugin and built-in skills, which
 * their provider manages, and user skills T3 doesn't manage, which only the
 * "Manage existing" list offers.
 */
export type SkillSectionId = "mine" | "inherited" | "repository" | "private";

export function skillSectionOf(
  entry: SkillEntry,
  scope: ResolvedSkillScope,
): SkillSectionId | null {
  if (entry.ownership === "plugin" || entry.ownership === "system") return null;
  if (scope.kind === "global") return entry.ownership === "managed" ? "mine" : null;
  if (entry.id.startsWith("inherited:")) return isPrivateProjectScope(scope) ? "inherited" : null;
  if (entry.scope !== "project") return null;
  if (entry.ownership === "unmanaged") return "repository";
  return isPrivateProjectScope(scope) ? "private" : null;
}

/** A user skill on this environment that T3 could take over: not managed, not a plugin. */
export function isDiscoverableSkill(entry: SkillEntry, scope: ResolvedSkillScope): boolean {
  return scope.kind === "global" && entry.ownership === "unmanaged" && entry.scope === "global";
}

export function discoverableSkills(snapshot: SkillsSnapshot): ReadonlyArray<SkillEntry> {
  return sortEntries(
    snapshot.entries.filter((entry) => isDiscoverableSkill(entry, snapshot.scope)),
  );
}

export type SkillEntryFilter = "all" | "on" | "off" | "missingAgents" | "conflicts";

/** The filters offered for a scope. Only My skills can be missing from an agent. */
export function skillEntryFilters(scope: ResolvedSkillScope): ReadonlyArray<{
  readonly value: SkillEntryFilter;
  readonly label: string;
}> {
  return [
    { value: "all", label: "All skills" },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
    ...(scope.kind === "global"
      ? [{ value: "missingAgents" as const, label: "Missing from an agent" }]
      : []),
    { value: "conflicts", label: "Duplicate names" },
  ];
}

function matchesFilter(entry: SkillEntry, filter: SkillEntryFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "on":
      return entry.enabled;
    case "off":
      return !entry.enabled;
    case "missingAgents":
      return needsProviderSync(entry);
    case "conflicts":
      return entry.conflicts.some((conflict) => conflict.reason === "duplicateName");
  }
}

function sortEntries(entries: ReadonlyArray<SkillEntry>): ReadonlyArray<SkillEntry> {
  return [...entries].sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.path.localeCompare(right.path),
  );
}

function matchesQuery(entry: SkillEntry, words: ReadonlyArray<string>): boolean {
  if (words.length === 0) return true;
  const haystack = [
    entry.name,
    entry.invocationName ?? "",
    entry.description ?? "",
    ...entry.providers.flatMap((provider) => [provider, providerDisplayName(provider)]),
  ]
    .join("\n")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Filters by category, then matches every search word against name, description, or provider. */
export function filterSkillEntries(
  entries: ReadonlyArray<SkillEntry>,
  options: { readonly query: string; readonly filter: SkillEntryFilter },
): ReadonlyArray<SkillEntry> {
  const words = options.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return sortEntries(
    entries.filter((entry) => matchesFilter(entry, options.filter) && matchesQuery(entry, words)),
  );
}

export interface SkillSection {
  readonly id: SkillSectionId;
  readonly title: string;
  /** What the list shows: filtered, searched, and without skills hidden as off in My skills. */
  readonly entries: ReadonlyArray<SkillEntry>;
  /** Every skill in the section. Bulk switches and resets act on these. */
  readonly all: ReadonlyArray<SkillEntry>;
  /** `inherited` only: skills off in My skills, which the list hides unless asked. */
  readonly offInMySkills: number;
}

const SECTION_TITLES: Record<SkillSectionId, string> = {
  mine: "My skills",
  inherited: "From My skills",
  repository: "Repository",
  private: "Private to this project",
};

const SECTION_ORDER: ReadonlyArray<SkillSectionId> = ["mine", "inherited", "repository", "private"];

/**
 * The page's sections for one snapshot, in display order. My skills always
 * has its section; a project lists only sections that have skills.
 */
export function skillSections(
  snapshot: SkillsSnapshot,
  options: {
    readonly query: string;
    readonly filter: SkillEntryFilter;
    /** Also list skills that are off in My skills, in a project. */
    readonly showOffInMySkills?: boolean;
  },
): ReadonlyArray<SkillSection> {
  const grouped = new Map<SkillSectionId, SkillEntry[]>();
  for (const entry of snapshot.entries) {
    const section = skillSectionOf(entry, snapshot.scope);
    if (section === null) continue;
    grouped.set(section, [...(grouped.get(section) ?? []), entry]);
  }
  return SECTION_ORDER.flatMap((id): SkillSection[] => {
    const all = sortEntries(grouped.get(id) ?? []);
    if (all.length === 0 && !(id === "mine" && snapshot.scope.kind === "global")) return [];
    const offInMySkills = all.filter((entry) => entry.globallyEnabled === false);
    const listed =
      options.showOffInMySkills === true
        ? all
        : all.filter((entry) => entry.globallyEnabled !== false);
    return [
      {
        id,
        title: SECTION_TITLES[id],
        entries: filterSkillEntries(listed, options),
        all,
        offInMySkills: offInMySkills.length,
      },
    ];
  });
}

/**
 * In a project's private view, a private skill and every skill it replaces
 * point at each other with `replacedByLocal`. Only meaningful for inherited
 * and repository entries; on a private one it means the opposite.
 */
function replacedByPrivateSkill(entry: SkillEntry): boolean {
  return entry.conflicts.some((conflict) => conflict.reason === "replacedByLocal");
}

/**
 * A skill's on/off switch. `null` when the scope has none for it: shared
 * mode, plugin and built-in skills, and user skills T3 doesn't manage. A
 * switch with a `disabledReason` shows its state but can't be flipped.
 */
export interface SkillToggleState {
  readonly checked: boolean;
  readonly disabledReason: string | null;
}

export function skillToggle(entry: SkillEntry, scope: ResolvedSkillScope): SkillToggleState | null {
  const section = skillSectionOf(entry, scope);
  if (section === null || isSharedProjectScope(scope)) return null;
  if (section === "inherited" && entry.globallyEnabled === false) {
    return { checked: false, disabledReason: "Off in My skills. Turn it on there first." };
  }
  if ((section === "inherited" || section === "repository") && replacedByPrivateSkill(entry)) {
    return {
      checked: false,
      disabledReason: "A private skill with the same name replaces it in this project.",
    };
  }
  return { checked: entry.enabled, disabledReason: null };
}

/**
 * The skills a section's "Turn all on" or "Turn all off" would switch: those
 * with a working switch that is not already there. Empty when there is
 * nothing to do.
 */
export function skillBulkEntries(
  entries: ReadonlyArray<SkillEntry>,
  scope: ResolvedSkillScope,
  enabled: boolean,
): ReadonlyArray<SkillEntry> {
  return entries.filter((entry) => {
    const toggle = skillToggle(entry, scope);
    return toggle !== null && toggle.disabledReason === null && toggle.checked !== enabled;
  });
}

/** Whether a section has per-project switches that a reset would clear. */
export function canResetSection(section: SkillSection): boolean {
  return (
    (section.id === "inherited" || section.id === "repository") &&
    section.all.some((entry) => entry.projectDisabled === true)
  );
}

/**
 * Providers T3 can give skills to on this environment: switched on in T3's
 * settings, and reading skill folders T3 scans. `null` when the server does
 * not report which providers are switched on.
 */
export function skillAgentProviders(
  snapshot: SkillsSnapshot,
): ReadonlyArray<ProviderDriverKind> | null {
  if (snapshot.providers.every((support) => support.enabled === undefined)) return null;
  return snapshot.providers
    .filter((support) => support.enabled === true && support.scanned)
    .map((support) => support.provider);
}

/** Providers switched on in T3's settings that read skills their own way, so T3 can't add any. */
export function unsupportedSkillProviders(
  snapshot: SkillsSnapshot,
): ReadonlyArray<ProviderDriverKind> {
  return snapshot.providers
    .filter((support) => support.enabled === true && !support.scanned)
    .map((support) => support.provider);
}

/** Whether one agent gets a skill. `pending` means syncing would add it. */
export interface SkillProviderReach {
  readonly provider: ProviderDriverKind;
  readonly on: boolean;
  readonly pending: boolean;
}

function pendingLinks(entry: SkillEntry): ReadonlyArray<SkillLinkStatus> {
  return entry.links.filter(
    (link) => link.syncPending === true && link.excluded !== true && link.state !== "occupied",
  );
}

/**
 * Which agents get a skill, one per provider switched on in T3's settings.
 * A project switch only reaches the agents T3 starts, so other providers keep
 * reading a project-disabled skill. Without settings from the server, only
 * the providers that already read the skill are listed.
 */
export function skillProviderReach(
  entry: SkillEntry,
  snapshot: SkillsSnapshot,
): ReadonlyArray<SkillProviderReach> {
  const providers = skillAgentProviders(snapshot) ?? entry.providers;
  const section = skillSectionOf(entry, snapshot.scope);
  const isT3 = (provider: ProviderDriverKind) => T3_PROJECT_PROVIDERS.includes(provider);
  const pendingProviders = new Set(
    entry.enabled
      ? pendingLinks(entry).flatMap(
          (link) =>
            snapshot.linkTargets.find((target) => target.id === link.targetId)?.providers ?? [],
        )
      : [],
  );
  return providers.map((provider): SkillProviderReach => {
    const reads = entry.providers.includes(provider);
    let on: boolean;
    switch (section) {
      case "private":
        on = entry.enabled && isT3(provider);
        break;
      case "inherited":
        on = entry.globallyEnabled !== false && reads && (entry.enabled || !isT3(provider));
        break;
      case "repository":
        on = reads && (entry.enabled || !isT3(provider) || isSharedProjectScope(snapshot.scope));
        break;
      default:
        on = entry.enabled && reads;
    }
    return { provider, on, pending: !on && pendingProviders.has(provider) };
  });
}

/** Names agents in a list, such as "Claude, Codex, and Cursor". */
export function formatProviderList(providers: ReadonlyArray<ProviderDriverKind>): string {
  const names = providers.map(providerDisplayName);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/** A short accessible summary of `skillProviderReach`, for rows whose icons say the same. */
export function skillReachLabel(reach: ReadonlyArray<SkillProviderReach>): string {
  const on = reach.filter((item) => item.on).map((item) => item.provider);
  if (reach.length === 0) return "No agents use skills here";
  if (on.length === 0) return "No agents";
  if (on.length === reach.length && reach.length > 1) return "All agents";
  return formatProviderList(on);
}

/**
 * An enabled My skills entry that some enabled agent can't see yet, and that
 * syncing would add without removing or replacing anything.
 */
export function needsProviderSync(entry: SkillEntry): boolean {
  return (
    entry.ownership === "managed" &&
    entry.scope === "global" &&
    !entry.id.startsWith("inherited:") &&
    entry.enabled &&
    pendingLinks(entry).length > 0
  );
}

export function providerSyncNames(snapshot: SkillsSnapshot): ReadonlyArray<string> {
  return snapshot.scope.kind === "global"
    ? snapshot.entries.filter(needsProviderSync).map((entry) => entry.name)
    : [];
}

/** Default links syncing skips because something else already sits at the path. */
export function blockedProviderLinks(entry: SkillEntry): ReadonlyArray<SkillLinkStatus> {
  return entry.enabled
    ? entry.links.filter((link) => link.syncPending === true && link.state === "occupied")
    : [];
}

/**
 * The links for the advanced per-folder switches: folders read by at least one
 * agent T3 can give skills to. Every folder when the server doesn't say which
 * agents are switched on.
 */
export function advancedSkillLinks(
  entry: SkillEntry,
  snapshot: SkillsSnapshot,
): ReadonlyArray<SkillLinkStatus> {
  const providers = skillAgentProviders(snapshot);
  if (providers === null) return entry.links;
  return entry.links.filter((link) =>
    snapshot.linkTargets
      .find((target) => target.id === link.targetId)
      ?.providers.some((provider) => providers.includes(provider)),
  );
}

/** One line under a row's name about anything unusual. `null` when nothing is. */
export function skillRowStatus(entry: SkillEntry, scope: ResolvedSkillScope): string | null {
  const section = skillSectionOf(entry, scope);
  if (section === "inherited" && entry.globallyEnabled === false) return "Off in My skills";
  if ((section === "inherited" || section === "repository") && replacedByPrivateSkill(entry)) {
    return "Replaced by a private skill";
  }
  if (section === "private" && replacedByPrivateSkill(entry))
    return "Replaces a skill of the same name";
  if (needsProviderSync(entry)) return "Missing from an agent";
  if (entry.conflicts.some((conflict) => conflict.reason === "duplicateName")) {
    return "Duplicate name";
  }
  return null;
}

/** Who uses a skill right now, for the detail header. */
export function skillUsageSummary(entry: SkillEntry, snapshot: SkillsSnapshot): string {
  const { scope } = snapshot;
  const section = skillSectionOf(entry, scope);
  const reach = skillProviderReach(entry, snapshot);
  const users = reach.filter((item) => item.on).map((item) => item.provider);
  const usedBy = users.length > 0 ? `Used by ${formatProviderList(users)}` : "No agent uses it";
  switch (section) {
    case "mine":
      return entry.enabled ? usedBy : "Off. No agent uses it.";
    case "inherited":
      if (entry.globallyEnabled === false) return "Off in My skills, so off here too";
      if (replacedByPrivateSkill(entry)) return "Your private skill replaces it in this project";
      return entry.enabled
        ? "On in this project, from My skills"
        : "Off for T3 agents in this project";
    case "repository":
      if (isSharedProjectScope(scope)) return usedBy;
      if (replacedByPrivateSkill(entry)) return "Your private skill replaces it in this project";
      return entry.enabled ? "On for T3 agents" : "Off for T3 agents";
    case "private":
      return entry.enabled ? "Used by Claude and Codex agents in T3" : "Off";
    default:
      return `Not managed by T3. ${usedBy}.`;
  }
}

/** Explains how a skill's switches reach agents. `null` when the switch tells the whole story. */
export function skillProvidersNote(entry: SkillEntry, scope: ResolvedSkillScope): string | null {
  switch (skillSectionOf(entry, scope)) {
    case "inherited":
      return "Switching it off here affects only Claude and Codex agents you run in T3 for this project. Other agents read My skills directly and keep it.";
    case "repository":
      return isSharedProjectScope(scope)
        ? null
        : "Switching it off affects only Claude and Codex agents you run in T3. The file stays in the repository, so terminal agents and teammates still see it.";
    case "private":
      return "Private skills reach Claude and Codex agents you run in T3. Terminal agents and other providers don't see them.";
    default:
      return null;
  }
}

/** The name agents load a skill under: its SKILL.md `name`, else its folder name. */
export function skillInvocationName(entry: SkillEntry): string {
  return entry.invocationName ?? entry.name;
}

/**
 * Who else answers to the name a copy of `entry` would load under. A copy
 * keeps the SKILL.md `name`, so a different folder name does not avoid a
 * clash. Plugin and built-in skills count, since agents still load them.
 */
export function invocationNameClashes(
  snapshot: SkillsSnapshot,
  entry: SkillEntry,
): ReadonlyArray<SkillEntry> {
  const name = skillInvocationName(entry).toLowerCase();
  return snapshot.entries.filter(
    (candidate) =>
      candidate.id !== entry.id &&
      !candidate.id.startsWith("inherited:") &&
      skillInvocationName(candidate).toLowerCase() === name,
  );
}

/**
 * What taking over a skill does to the places it lives. A provider folder
 * holding the skill itself moves to Recovery and gets T3's link. Other
 * entries reach that folder through a link, so they keep working through it.
 * With no such folder (every entry links elsewhere), each link is replaced
 * and the folder they point at stays where it is.
 */
export function skillAdoptionPlan(entry: SkillEntry): {
  readonly moved: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<string>;
  readonly sourceStays: string | null;
} {
  const physical = entry.origins.filter((origin) => origin.symlinkTarget === undefined);
  if (physical.length === 0) {
    return {
      moved: entry.origins.map((origin) => origin.entryPath),
      kept: [],
      sourceStays: entry.path,
    };
  }
  const exact = physical.filter((origin) => origin.entryPath === entry.path);
  const moved = (exact.length > 0 ? exact : physical.slice(0, 1)).map((origin) => origin.entryPath);
  return {
    moved,
    kept: entry.origins
      .map((origin) => origin.entryPath)
      .filter((entryPath) => !moved.includes(entryPath)),
    sourceStays: null,
  };
}

/** Absolute on POSIX or Windows. The server checks again. */
export function isAbsoluteSkillPath(value: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value.trim());
}

/**
 * What the user can do with one link target. An inherited link reaches the
 * skill through a linked parent folder or someone else's link, so T3 neither
 * adds nor removes anything there.
 */
export function skillLinkAction(status: SkillLinkStatus): "link" | "unlink" | "replace" | null {
  switch (status.state) {
    case "available":
      return "link";
    case "occupied":
      return "replace";
    case "linked":
      return status.inherited ? null : "unlink";
  }
}

/**
 * One "Use with" switch: a provider folder or instruction file, named by the
 * providers that read it. Several providers can share one target, such as
 * `~/.agents/skills`, and then switch together.
 */
export interface SkillProviderSwitch {
  readonly status: SkillLinkStatus;
  readonly label: string;
  /** On means the target reaches the skill or instructions, by T3's link or another one. */
  readonly on: boolean;
  /** What flipping the switch does. `null` when T3 must leave the target as it is. */
  readonly action: ReturnType<typeof skillLinkAction>;
  /** Why the switch looks or behaves differently, in the user's terms. */
  readonly note: string | null;
}

const OCCUPANT_NOUN: Record<SkillPathKind, string> = {
  directory: "folder",
  file: "file",
  symlink: "link",
};

export function skillOccupantNoun(status: SkillLinkStatus): string {
  return status.occupant === undefined ? "item" : OCCUPANT_NOUN[status.occupant];
}

/**
 * The switches for one skill or the instructions, one per target. A label
 * that two targets share, such as two Codex homes, gets the path as its note
 * so the rows can be told apart.
 */
export function skillProviderSwitches(
  links: ReadonlyArray<SkillLinkStatus>,
  targets: ReadonlyArray<SkillLinkTarget>,
): ReadonlyArray<SkillProviderSwitch> {
  const labelled = links.map((status) => {
    const providers = targets.find((target) => target.id === status.targetId)?.providers ?? [];
    return {
      status,
      providers,
      label: providers.length > 0 ? providers.map(providerDisplayName).join(", ") : status.path,
    };
  });
  return labelled.map(({ status, providers, label }): SkillProviderSwitch => {
    const ambiguous = labelled.filter((other) => other.label === label).length > 1;
    const notes = [
      status.state === "occupied"
        ? `Already has its own ${skillOccupantNoun(status)} here.`
        : status.inherited
          ? "Already reaches this through another folder or link, so T3 leaves it alone."
          : providers.length > 1
            ? "These providers read one shared folder, so they switch together."
            : null,
      ambiguous ? status.path : null,
    ].filter((note) => note !== null);
    return {
      status,
      label,
      on: status.state === "linked",
      action: skillLinkAction(status),
      note: notes.length > 0 ? notes.join(" ") : null,
    };
  });
}

/** Global instructions and shared `AGENTS.md` name each target's providers through `files`. */
export function instructionLinkTargets(
  instructions: SkillInstructionsSummary,
): ReadonlyArray<SkillLinkTarget> {
  return instructions.links.map((status) => ({
    id: status.targetId,
    path: status.path,
    providers:
      instructions.files.find((candidate) => candidate.path === status.path)?.providers ?? [],
  }));
}

/** A short version of `PRIVATE_PROJECT_SUPPORT_NOTICE` for page headers. */
export const PRIVATE_PROJECT_SUMMARY =
  "Switches and private skills here apply only to Claude and Codex agents you run in T3. Nothing in the repository changes.";

/** What repository mode writes, for page headers. */
export const SHARED_PROJECT_SUMMARY =
  "Changes edit files in the repository. Terminal agents and teammates see them once you commit.";

/**
 * Names the folder whose private settings a project scope edits when it is
 * not the project itself: an enclosing folder's, or a Git worktree's main
 * checkout. Changes there reach every project that uses it. `null` otherwise.
 */
export function sharedProfileNotice(scope: ResolvedSkillScope): string | null {
  const root = scope.profileRoot;
  if (scope.mode !== "local" || root === undefined || root === scope.projectRoot) return null;
  return scope.profileSource === "worktree"
    ? `Uses the private settings of ${root} in the main checkout. Changes here also apply there and in its other worktrees.`
    : `Uses the private settings of ${root}, which contains this project. Changes here also apply there.`;
}

export function providerDisplayName(provider: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

const isSkillName = Schema.is(SkillName);

/** Names already used in the library that this scope creates and imports into. */
export function scopeLibraryNames(snapshot: SkillsSnapshot): string[] {
  return snapshot.entries
    .filter(
      (entry) =>
        entry.ownership === "managed" &&
        entry.scope === snapshot.scope.kind &&
        !entry.id.startsWith("inherited:"),
    )
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
          !entry.id.startsWith("inherited:") &&
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
  "Private changes apply only to Claude and Codex agents you run in T3 Code, not to terminal agents, teammates, or other providers. Private skills are listed to the agent, and a same-named repository or My skills skill is switched off in their favor. Claude picks up changes on its next turn, or once its background tasks finish. Codex needs a new or reloaded thread for any change to which repository or user skills, or which repository instructions, it loads, and keeps its earlier skill setup until then. Other changes reach Codex on its next turn. Nothing is removed from a thread's history, so an agent may still act on what it already read. Agents read private skills as plain files, so provider-only settings such as allowed-tools or context: fork may not apply.";
