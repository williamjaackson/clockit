import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  SkillEntry,
  SkillsSnapshot,
} from "@t3tools/contracts";
import {
  discoverableSkills,
  EMPTY_SKILLS_VIEW_ATOM,
  findScopeLibraryEntry,
  GLOBAL_SKILLS_SCOPE,
  PRIVATE_PROJECT_SUMMARY,
  PRIVATE_PROJECT_SUPPORT_NOTICE,
  providerSyncNames,
  SHARED_PROJECT_SUMMARY,
  sharedProfileNotice,
  skillBulkEntries,
  skillEntryFilters,
  skillScope,
  skillSections,
  skillsScopeKey,
  type SkillEntryFilter,
  type SkillSection,
  type SkillsScopeSelection,
  skillsFailureMessage,
} from "@t3tools/client-runtime/state/skills";
import { useBlocker } from "@tanstack/react-router";
import { Atom } from "effect/unstable/reactivity";
import { ChevronLeftIcon, PlusIcon } from "lucide-react";
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SkillDetail } from "./SkillDetail";
import {
  DiscoverSkillsDialog,
  ImportSkillDialog,
  NewSkillDialog,
  ReleaseSkillDialog,
} from "./SkillDialogs";
import { SkillsDisclosure, SkillsPathRow } from "./SkillsDisclosure";
import { SkillsInstructions } from "./SkillsInstructions";
import { SkillsFilterBar, SkillsList } from "./SkillsList";
import { SkillsProviders, SkillsRecovery } from "./SkillsRecovery";
import { confirmSkillsAction, reportSkippedLinks, runSkillsCommand } from "./skillsCommands";
import { readSharedModeState, saveSharedMode, sharedModeKey } from "./skillsSharedMode";

type SkillsTab = "skills" | "instructions" | "recovery";

const GLOBAL_SCOPE_VALUE = "global";
const EMPTY_PROJECTS_ATOM = Atom.make<ReadonlyArray<OrchestrationProjectShell>>([]).pipe(
  Atom.withLabel("web-skills:no-projects"),
);

export function SkillsPage() {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);

  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const onDirtyChange = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  }, []);
  // Part of every editor's key. Bumping it drops the draft and reads the file again.
  const [editorEpoch, setEditorEpoch] = useState(0);

  // An unsaved draft pins the environment, project, and skill it belongs to,
  // even if they disappear, so the draft is never dropped without asking.
  const [pinned, setPinned] = useState<{
    readonly key: string;
    readonly environment: (typeof environments)[number];
    readonly project: OrchestrationProjectShell | null;
    readonly entry: SkillEntry | null;
  } | null>(null);
  const held = dirty ? pinned : null;
  const resolvedEnvironment =
    environments.find((candidate) => candidate.environmentId === chosenEnvironmentId) ??
    environments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    environments[0] ??
    null;
  const environment =
    held !== null && held.environment.environmentId !== resolvedEnvironment?.environmentId
      ? (environments.find(
          (candidate) => candidate.environmentId === held.environment.environmentId,
        ) ?? held.environment)
      : resolvedEnvironment;
  const environmentId = environment?.environmentId ?? null;
  const environmentGone =
    environment !== null &&
    !environments.some((candidate) => candidate.environmentId === environment.environmentId);
  const projects = useAtomValue(
    environmentId === null
      ? EMPTY_PROJECTS_ATOM
      : environmentProjects.environmentProjectsAtom(environmentId),
  );
  const resolvedProject =
    projects.find((candidate) => candidate.workspaceRoot === projectPath) ?? null;
  const project =
    held !== null &&
    held.environment.environmentId === environmentId &&
    held.project?.workspaceRoot !== resolvedProject?.workspaceRoot
      ? held.project
      : resolvedProject;
  const projectGone =
    project !== null &&
    !projects.some((candidate) => candidate.workspaceRoot === project.workspaceRoot);

  const [sharedModeState, setSharedModeState] = useState(readSharedModeState);
  const projectModeKey =
    environmentId !== null && project !== null
      ? sharedModeKey(environmentId, project.workspaceRoot)
      : null;
  const shared = projectModeKey !== null && sharedModeState.shared.has(projectModeKey);
  const scopeProjectPath = project?.workspaceRoot ?? null;
  const scopeMode = shared ? "shared" : "local";
  const selection = useMemo<SkillsScopeSelection>(
    () =>
      scopeProjectPath === null
        ? GLOBAL_SKILLS_SCOPE
        : { kind: "project", projectPath: scopeProjectPath, mode: scopeMode },
    [scopeMode, scopeProjectPath],
  );
  const scope = useMemo(() => skillScope(selection), [selection]);
  const scopeKey = skillsScopeKey(environmentId, selection);
  const scopeKeyRef = useRef(scopeKey);
  useLayoutEffect(() => {
    scopeKeyRef.current = scopeKey;
  }, [scopeKey]);
  const view = useAtomValue(
    environmentId === null
      ? EMPTY_SKILLS_VIEW_ATOM
      : skillsEnvironment.view({ environmentId, scope }),
  );
  const snapshot = view.snapshot;
  const profileNotice = snapshot === null ? null : sharedProfileNotice(snapshot.scope);

  const [tab, setTab] = useState<SkillsTab>("skills");
  const [query, setQuery] = useState("");
  const [chosenFilter, setFilter] = useState<SkillEntryFilter>("all");
  const [showOffInMySkills, setShowOffInMySkills] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [newSkillOpen, setNewSkillOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [importEntry, setImportEntry] = useState<SkillEntry | null>(null);
  const [releaseEntry, setReleaseEntry] = useState<SkillEntry | null>(null);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Switch requests in flight, by scope and entry, with the value each asks for.
  const [pendingToggles, setPendingToggles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const filter =
    snapshot !== null &&
    skillEntryFilters(snapshot.scope).some((option) => option.value === chosenFilter)
      ? chosenFilter
      : "all";

  const setEnabledCommand = useAtomCommand(skillsEnvironment.setEnabled, { reportFailure: false });
  const setEnabledManyCommand = useAtomCommand(skillsEnvironment.setEnabledMany, {
    reportFailure: false,
  });
  const resetProjectCommand = useAtomCommand(skillsEnvironment.resetProject, {
    reportFailure: false,
  });
  const syncProvidersCommand = useAtomCommand(skillsEnvironment.syncProviders, {
    reportFailure: false,
  });

  const liveEntry = snapshot?.entries.find((entry) => entry.id === selectedEntryId) ?? null;
  const selectedEntry =
    liveEntry ?? (held?.entry?.id === selectedEntryId ? (held?.entry ?? null) : null);
  const entryGone = selectedEntry !== null && liveEntry === null;
  const pinKey =
    dirty && environment !== null
      ? JSON.stringify([environment.environmentId, project?.workspaceRoot, selectedEntry?.id])
      : null;
  if (pinKey !== (pinned?.key ?? null)) {
    setPinned(
      pinKey === null || environment === null
        ? null
        : { key: pinKey, environment, project, entry: selectedEntry },
    );
  }

  const confirmDiscard = useCallback(
    async () =>
      !dirtyRef.current ||
      (await confirmSkillsAction(
        "Discard unsaved changes?\nYour edits have not been saved.",
        "destructive",
      )),
    [],
  );
  useBlocker({
    shouldBlockFn: async () => !(await confirmDiscard()),
    enableBeforeUnload: () => dirtyRef.current,
    disabled: !dirty,
  });

  /** Asks before dropping a draft, then drops it for real by remounting the editor. */
  const discardDraft = async () => {
    if (!(await confirmDiscard())) return false;
    if (dirtyRef.current) {
      onDirtyChange(false);
      setEditorEpoch((epoch) => epoch + 1);
    }
    return true;
  };
  const guarded = (apply: () => void) => async () => {
    if (await discardDraft()) apply();
  };

  const changeEnvironment = (next: EnvironmentId) =>
    guarded(() => {
      setChosenEnvironmentId(next);
      setProjectPath(null);
      setSelectedEntryId(null);
      setShowOffInMySkills(false);
    })();

  const changeProject = (next: string | null) =>
    guarded(() => {
      setProjectPath(next);
      setSelectedEntryId(null);
      setShowOffInMySkills(false);
    })();

  /** Opens a project's inherited skill where it can be edited: in My skills. */
  const editInMySkills = (entry: SkillEntry) =>
    void guarded(() => {
      setProjectPath(null);
      setSelectedEntryId(`managed:${entry.name}`);
      setQuery("");
      setFilter("all");
      setShowOffInMySkills(false);
    })();

  const openMySkills = () => void changeProject(null);

  const changeShared = async (nextShared: boolean) => {
    if (project === null || projectModeKey === null || nextShared === shared) return;
    if (nextShared && !sharedModeState.confirmed.has(projectModeKey)) {
      const confirmed = await confirmSkillsAction(
        `Edit repository files for ${project.title}?\nChanges write skills, AGENTS.md, and CLAUDE.md inside ${project.workspaceRoot}. Terminal agents and teammates see them once they are committed.`,
      );
      if (!confirmed) return;
    }
    if (!(await discardDraft())) return;
    setSharedModeState(saveSharedMode(sharedModeState, projectModeKey, nextShared));
    setSelectedEntryId(null);
    setShowOffInMySkills(false);
  };

  /** Rescans the scope and reads the open file again. */
  const refresh = () => {
    if (environmentId === null) return;
    void guarded(() => {
      setEditorEpoch((epoch) => epoch + 1);
      skillsEnvironment.refresh(registry, { environmentId, scope });
    })();
  };

  const sections = useMemo(
    () => (snapshot === null ? [] : skillSections(snapshot, { query, filter, showOffInMySkills })),
    [filter, query, showOffInMySkills, snapshot],
  );
  const discoverable = useMemo(
    () => (snapshot === null ? [] : discoverableSkills(snapshot)),
    [snapshot],
  );
  const syncNames = useMemo(
    () => (snapshot === null ? [] : providerSyncNames(snapshot)),
    [snapshot],
  );
  const pendingHere = useMemo(() => {
    const prefix = `${scopeKey}\n`;
    return new Map(
      [...pendingToggles]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value] as const),
    );
  }, [pendingToggles, scopeKey]);
  const canSelectEntry = (entryId: string) =>
    sections.some((section) => section.all.some((entry) => entry.id === entryId));
  const selectEntry = (entryId: string) => {
    if (entryId === selectedEntryId) return;
    void guarded(() => setSelectedEntryId(entryId))();
  };

  const markPending = (key: string, ids: ReadonlyArray<string>, value: boolean | null) =>
    setPendingToggles((current) => {
      const next = new Map(current);
      for (const id of ids) {
        if (value === null) next.delete(`${key}\n${id}`);
        else next.set(`${key}\n${id}`, value);
      }
      return next;
    });

  /**
   * Switches skills in the current scope, one or a section at a time. A T3
   * skill moves folders when switched, so a draft of the open one is dropped
   * first and its file read again afterwards. Project switches on inherited
   * and repository skills touch no files.
   */
  const switchSkills = async (entries: ReadonlyArray<SkillEntry>, enabled: boolean) => {
    const [first, ...rest] = entries;
    if (environmentId === null || first === undefined) return;
    const ids = entries.map((entry) => entry.id);
    if (ids.some((id) => pendingHere.has(id))) return;
    const movesOpenSkill =
      selectedEntry !== null &&
      ids.includes(selectedEntry.id) &&
      selectedEntry.ownership === "managed" &&
      !selectedEntry.id.startsWith("inherited:");
    if (movesOpenSkill && !(await discardDraft())) return;
    const key = scopeKey;
    markPending(key, ids, enabled);
    const failure = enabled ? "Could not turn skills on" : "Could not turn skills off";
    const result = await runSkillsCommand(
      rest.length === 0
        ? setEnabledCommand({
            environmentId,
            input: { scope, skill: { entryId: first.id }, enabled },
          })
        : setEnabledManyCommand({
            environmentId,
            input: {
              scope,
              skills: [{ entryId: first.id }, ...rest.map((entry) => ({ entryId: entry.id }))],
              enabled,
            },
          }),
      failure,
    );
    markPending(key, ids, null);
    if (movesOpenSkill && !dirtyRef.current) setEditorEpoch((epoch) => epoch + 1);
    if (result !== null && result.skippedLinks.length > 0) {
      toastManager.add({
        type: "warning",
        title: "Some agents didn't get the skill back",
        description: `Something else now sits at ${result.skippedLinks.join(", ")}.`,
      });
    }
  };

  const toggleEntry = (entry: SkillEntry, enabled: boolean) => void switchSkills([entry], enabled);
  const bulkToggle = (section: SkillSection, enabled: boolean) => {
    if (snapshot === null) return;
    void switchSkills(skillBulkEntries(section.all, snapshot.scope, enabled), enabled);
  };

  const resetSection = async (section: SkillSection) => {
    if (environmentId === null || project === null) return;
    if (section.id !== "inherited" && section.id !== "repository") return;
    const confirmed = await confirmSkillsAction(
      section.id === "inherited"
        ? "Turn every My skills skill back on for this project?\nSkills that are off in My skills stay off. Private skills don't change."
        : "Turn every repository skill back on for T3 agents?\nPrivate skills don't change.",
    );
    if (!confirmed) return;
    await runSkillsCommand(
      resetProjectCommand({
        environmentId,
        input: { projectPath: project.workspaceRoot, sections: [section.id] },
      }),
      "Could not reset the project's skills",
    );
  };

  /** Adds My skills entries to enabled agents that lack them. Never removes or replaces anything. */
  const syncProviders = async (names: ReadonlyArray<string>) => {
    const [first, ...rest] = names;
    if (environmentId === null || first === undefined || syncing) return;
    setSyncing(true);
    const result = await runSkillsCommand(
      syncProvidersCommand({ environmentId, input: { names: [first, ...rest] } }),
      "Could not add skills to every agent",
    );
    setSyncing(false);
    if (result === null) return;
    if (result.skippedLinks.length > 0) reportSkippedLinks(result.skippedLinks);
    else toastManager.add({ type: "success", title: "Every agent you've turned on has them now" });
  };

  const openRelease = (entry: SkillEntry) => void guarded(() => setReleaseEntry(entry))();
  /**
   * Opens a skill a dialog just wrote, unless the page has since moved to
   * another environment or scope. `targetKey` is the scope the dialog wrote to.
   */
  const openWrittenSkill = (targetKey: string) => (next: SkillsSnapshot, name: string) => {
    if (targetKey !== scopeKeyRef.current) return;
    const written = findScopeLibraryEntry(next, name);
    if (written !== null) selectEntry(written.id);
  };

  const connected = environment?.connection.phase === "connected";
  const scopeValue = project?.workspaceRoot ?? GLOBAL_SCOPE_VALUE;

  const topbar = (
    <div className="flex w-full min-w-0 items-center gap-3 py-2">
      <WorkspaceBreadcrumb ariaLabel="Skills breadcrumb" className="min-w-0 flex-1">
        <WorkspaceBreadcrumbItem>
          <h1>Skills</h1>
        </WorkspaceBreadcrumbItem>
        {environment !== null ? (
          <>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem className="min-w-10">
              {environments.length > 1 ? (
                <Select
                  value={environment.environmentId}
                  onValueChange={(value) => {
                    const next = environments.find(
                      (candidate) => candidate.environmentId === value,
                    );
                    if (next && next.environmentId !== environmentId) {
                      void changeEnvironment(next.environmentId);
                    }
                  }}
                >
                  <SelectTrigger
                    aria-label="Environment"
                    size="compact"
                    variant="ghost"
                    className="w-auto min-w-0"
                  >
                    <SelectValue>{environment.label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {environments.map((candidate) => (
                      <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : (
                <span className="truncate text-sm text-muted-foreground">{environment.label}</span>
              )}
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10">
              <Select
                value={scopeValue}
                onValueChange={(value) => {
                  if (value === null || value === scopeValue) return;
                  void changeProject(value === GLOBAL_SCOPE_VALUE ? null : value);
                }}
              >
                <SelectTrigger
                  aria-label="Scope"
                  size="compact"
                  variant="ghost"
                  className="w-auto min-w-0"
                >
                  <SelectValue>{project?.title ?? "My skills"}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value={GLOBAL_SCOPE_VALUE}>My skills</SelectItem>
                  {projects.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.workspaceRoot}>
                      <span className="flex min-w-0 flex-col">
                        <span>{candidate.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {candidate.workspaceRoot}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </WorkspaceBreadcrumbItem>
          </>
        ) : null}
      </WorkspaceBreadcrumb>
      <Button
        onClick={refresh}
        aria-label="Refresh skills"
        aria-busy={view.isLoading}
        disabled={environmentId === null || view.isLoading}
        size="icon-sm"
        variant="ghost"
      >
        <RefreshIcon size="sm" refreshing={view.isLoading && snapshot !== null} />
      </Button>
    </div>
  );

  const openStatus = (() => {
    if (environment === null || environmentId === null) {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No environments</EmptyTitle>
            <EmptyDescription>Connect an environment to manage its skills.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    if (snapshot !== null) return null;
    if (!connected && !view.isLoading) {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{environment.label} is not connected</EmptyTitle>
            <EmptyDescription>
              Skills live on each environment. Reconnect it to manage them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    if (view.error !== null && !view.isLoading) {
      return (
        <Alert variant="error">
          <AlertTitle>Could not read skills</AlertTitle>
          <AlertDescription>{skillsFailureMessage(view.error)}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={refresh}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  })();

  const content = (() => {
    if (
      openStatus !== null ||
      environment === null ||
      environmentId === null ||
      snapshot === null
    ) {
      return (
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">{openStatus}</WorkspacePageContainer>
        </ScrollArea>
      );
    }

    const detailOpen = selectedEntry !== null;
    const toolbar = (
      <WorkspacePageContainer width="expanded" className="shrink-0 gap-3 pb-4">
        {environmentGone || projectGone ? (
          <Alert variant="warning">
            <AlertTitle>
              {environmentGone
                ? `${environment.label} is no longer available`
                : `${project?.title ?? "This project"} is no longer in ${environment.label}`}
            </AlertTitle>
            <AlertDescription>
              Your unsaved edits are still here, but saving will probably fail. Copy anything you
              want to keep.
            </AlertDescription>
          </Alert>
        ) : null}
        {view.error !== null ? (
          <Alert variant="error">
            <AlertDescription>
              Could not refresh: {skillsFailureMessage(view.error)}
            </AlertDescription>
          </Alert>
        ) : null}
        {snapshot.warnings.length > 0 ? (
          <Alert variant="warning">
            <AlertTitle>Some folders were not fully scanned</AlertTitle>
            <AlertDescription>
              <ul className="flex max-h-24 flex-col gap-0.5 overflow-y-auto">
                {snapshot.warnings.map((warning) => (
                  <li key={warning} className="break-all">
                    {warning}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <ToggleGroup
            aria-label="Skills section"
            value={[tab]}
            onValueChange={(next) => {
              const value = next[0];
              if (
                (value === "skills" || value === "instructions" || value === "recovery") &&
                value !== tab
              ) {
                void guarded(() => setTab(value))();
              }
            }}
          >
            <Toggle value="skills">Skills</Toggle>
            <Toggle value="instructions">Instructions</Toggle>
            <Toggle value="recovery">
              Recovery{snapshot.recovery.length > 0 ? ` (${snapshot.recovery.length})` : ""}
            </Toggle>
          </ToggleGroup>
          {project !== null ? (
            <ToggleGroup
              aria-label="Where project changes go"
              value={[shared ? "shared" : "local"]}
              onValueChange={(next) => {
                if (next[0] === "shared" || next[0] === "local") {
                  void changeShared(next[0] === "shared");
                }
              }}
            >
              <Toggle value="local">Private to T3</Toggle>
              <Toggle value="shared">Repository files</Toggle>
            </ToggleGroup>
          ) : null}
        </div>

        {project !== null && shared ? (
          <Alert variant="warning">
            <AlertDescription>{SHARED_PROJECT_SUMMARY}</AlertDescription>
          </Alert>
        ) : project !== null ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">{PRIVATE_PROJECT_SUMMARY}</p>
            {profileNotice !== null ? (
              <p className="break-words text-xs text-warning-foreground">{profileNotice}</p>
            ) : null}
            <SkillsDisclosure title="How private changes work">
              {/* Capped so an open disclosure never squeezes the skills list out of view. */}
              <div className="flex max-h-40 flex-col gap-3 overflow-y-auto">
                <p className="text-xs text-muted-foreground">{PRIVATE_PROJECT_SUPPORT_NOTICE}</p>
                <SkillsPathRow label="Stored in" path={snapshot.scope.libraryPath} />
              </div>
            </SkillsDisclosure>
          </div>
        ) : null}
      </WorkspacePageContainer>
    );

    const isGlobal = snapshot.scope.kind === "global";
    const isPrivateProject = snapshot.scope.kind === "project" && snapshot.scope.mode !== "shared";
    const listed = sections.reduce((count, section) => count + section.entries.length, 0);
    const total = sections.reduce((count, section) => count + section.all.length, 0);
    const listActions = {
      selectedId: selectedEntry?.id ?? null,
      onSelect: selectEntry,
      pending: pendingHere,
      onToggle: toggleEntry,
      onBulk: bulkToggle,
      onReset: (section: SkillSection) => void resetSection(section),
      onShowOffInMySkills: () => setShowOffInMySkills(true),
      onOpenMySkills: openMySkills,
      showOffInMySkills,
    };
    const addButton = isGlobal ? (
      <Menu>
        <MenuTrigger render={<Button size="icon-sm" aria-label="Add skills" />}>
          <PlusIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => setNewSkillOpen(true)}>New skill…</MenuItem>
          <MenuItem onClick={() => setDiscoverOpen(true)}>
            Manage existing skills…
            {discoverable.length > 0 ? ` (${discoverable.length})` : ""}
          </MenuItem>
        </MenuPopup>
      </Menu>
    ) : (
      <Button
        size="icon-sm"
        aria-label={isPrivateProject ? "New private skill" : "New skill"}
        onClick={() => setNewSkillOpen(true)}
      >
        <PlusIcon />
      </Button>
    );

    const skillsPane = (
      <div className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 grid-rows-[minmax(0,1fr)] gap-6 px-5 pb-5 sm:px-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div
          className={cn("min-h-0 min-w-0 flex-col gap-2", detailOpen ? "hidden lg:flex" : "flex")}
        >
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <SkillsFilterBar
                scope={snapshot.scope}
                query={query}
                onQueryChange={setQuery}
                filter={filter}
                onFilterChange={setFilter}
              />
            </div>
            {addButton}
          </div>
          {syncNames.length > 0 ? (
            <Alert variant="info">
              <AlertDescription>
                {syncNames.length === 1
                  ? "1 skill is missing from an agent you've turned on."
                  : `${syncNames.length} skills are missing from an agent you've turned on.`}
              </AlertDescription>
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={syncing}
                  onClick={() => void syncProviders(syncNames)}
                >
                  Add to all agents
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
            {total > 0 ? (
              <ScrollArea>
                <SkillsList sections={sections} snapshot={snapshot} actions={listActions} />
              </ScrollArea>
            ) : (
              <div className="flex flex-col items-start gap-2 p-3 text-sm text-muted-foreground">
                <p>
                  {isGlobal
                    ? "Nothing in My skills yet. Bring in skills your agents already have, or create one."
                    : "This project has no skills of its own yet."}
                </p>
                {isGlobal && discoverable.length > 0 ? (
                  <Button size="xs" variant="outline" onClick={() => setDiscoverOpen(true)}>
                    Manage existing skills ({discoverable.length})
                  </Button>
                ) : null}
              </div>
            )}
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              {listed === total
                ? `${total} ${total === 1 ? "skill" : "skills"}`
                : `${listed} of ${total}`}
            </span>
            <Button size="xs" variant="ghost" onClick={() => setProvidersOpen(true)}>
              How agents find skills
            </Button>
          </div>
        </div>

        <div className={cn("min-h-0 min-w-0 flex-col", detailOpen ? "flex" : "hidden lg:flex")}>
          {selectedEntry !== null ? (
            <>
              <div className="pb-2 lg:hidden">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void guarded(() => setSelectedEntryId(null))()}
                >
                  <ChevronLeftIcon />
                  {isGlobal ? "My skills" : "All skills"}
                </Button>
              </div>
              {/* Keyed per skill so picking another one starts at the top. */}
              <ScrollArea key={`${scopeKey}:${selectedEntry.id}`} className="min-h-0 flex-1">
                <div className="flex flex-col gap-4 pr-4 pb-6">
                  {entryGone ? (
                    <Alert variant="warning">
                      <AlertTitle>This skill is no longer listed</AlertTitle>
                      <AlertDescription>
                        It was moved or removed outside this page. Your unsaved edits are still
                        here. Copy anything you want to keep.
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  <SkillDetail
                    key={`${scopeKey}:${selectedEntry.id}:${editorEpoch}`}
                    environmentId={environmentId}
                    scope={scope}
                    snapshot={snapshot}
                    entry={selectedEntry}
                    pendingEnabled={pendingHere.get(selectedEntry.id)}
                    onToggle={toggleEntry}
                    onDirtyChange={onDirtyChange}
                    confirmDiscard={confirmDiscard}
                    onSelectEntry={selectEntry}
                    canSelectEntry={canSelectEntry}
                    onImport={setImportEntry}
                    onRelease={openRelease}
                    onEditInMySkills={editInMySkills}
                    onSync={(names) => void syncProviders(names)}
                    syncing={syncing}
                  />
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 rounded-lg border border-dashed">
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Select a skill</EmptyTitle>
                  <EmptyDescription>
                    {isGlobal
                      ? "Turn it on or off, see which agents have it, and edit its files."
                      : "Turn it on or off for this project and read its files."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          )}
        </div>
      </div>
    );

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {toolbar}
        {tab === "skills" ? (
          skillsPane
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer width="expanded" className="pt-0">
              {tab === "instructions" ? (
                <SkillsInstructions
                  key={`${scopeKey}:${editorEpoch}`}
                  environmentId={environmentId}
                  scope={scope}
                  snapshot={snapshot}
                  onDirtyChange={onDirtyChange}
                  confirmDiscard={confirmDiscard}
                />
              ) : (
                <SkillsRecovery environmentId={environmentId} scope={scope} snapshot={snapshot} />
              )}
            </WorkspacePageContainer>
          </ScrollArea>
        )}

        <NewSkillDialog
          open={newSkillOpen}
          onOpenChange={setNewSkillOpen}
          environmentId={environmentId}
          scope={scope}
          snapshot={snapshot}
          onCreated={openWrittenSkill(scopeKey)}
        />
        {importEntry !== null ? (
          <ImportSkillDialog
            key={importEntry.id}
            entry={importEntry}
            onOpenChange={(open) => {
              if (!open) setImportEntry(null);
            }}
            environmentId={environmentId}
            scope={scope}
            snapshot={snapshot}
            onImported={openWrittenSkill(scopeKey)}
          />
        ) : null}
        {snapshot.scope.kind === "global" ? (
          <DiscoverSkillsDialog
            open={discoverOpen}
            onOpenChange={setDiscoverOpen}
            snapshot={snapshot}
            onManage={(entry) => {
              setDiscoverOpen(false);
              setImportEntry(entry);
            }}
          />
        ) : null}
        {releaseEntry !== null ? (
          <ReleaseSkillDialog
            key={releaseEntry.id}
            entry={releaseEntry}
            environmentId={environmentId}
            onOpenChange={(open) => {
              if (!open) setReleaseEntry(null);
            }}
            onReleased={() => setSelectedEntryId(null)}
          />
        ) : null}
        <Dialog open={providersOpen} onOpenChange={setProvidersOpen}>
          <DialogPopup className="max-w-lg">
            <DialogHeader>
              <DialogTitle>How agents find skills</DialogTitle>
              <DialogDescription>
                The folders each agent reads on {environment.label}, and what T3 can't see.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <SkillsProviders snapshot={snapshot} />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      </div>
    );
  })();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          {topbar}
        </WorkspacePageHeader>
        {content}
      </div>
    </SidebarInset>
  );
}
