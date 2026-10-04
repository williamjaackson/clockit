import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  SkillEntry,
  SkillsSnapshot,
} from "@t3tools/contracts";
import {
  EMPTY_SKILLS_VIEW_ATOM,
  filterSkillEntries,
  findScopeLibraryEntry,
  GLOBAL_SKILLS_SCOPE,
  PRIVATE_PROJECT_SUPPORT_NOTICE,
  skillScope,
  skillsScopeKey,
  type SkillEntryFilter,
  type SkillsScopeSelection,
  skillsFailureMessage,
} from "@t3tools/client-runtime/state/skills";
import { useBlocker } from "@tanstack/react-router";
import { Atom } from "effect/unstable/reactivity";
import { PlusIcon } from "lucide-react";
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { skillsEnvironment } from "../../state/skills";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SkillDetail } from "./SkillDetail";
import { ImportSkillDialog, NewSkillDialog } from "./SkillDialogs";
import { SkillsInstructions } from "./SkillsInstructions";
import { SkillsFilterBar, SkillsList } from "./SkillsList";
import { SkillsProviders, SkillsRecovery } from "./SkillsRecovery";
import { confirmSkillsAction } from "./skillsCommands";
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

  const [tab, setTab] = useState<SkillsTab>("skills");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillEntryFilter>("all");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [newSkillOpen, setNewSkillOpen] = useState(false);
  const [importEntry, setImportEntry] = useState<SkillEntry | null>(null);

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
    })();

  const changeProject = (next: string | null) =>
    guarded(() => {
      setProjectPath(next);
      setSelectedEntryId(null);
    })();

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
  };

  /** Rescans the scope and reads the open file again. */
  const refresh = () => {
    if (environmentId === null) return;
    void guarded(() => {
      setEditorEpoch((epoch) => epoch + 1);
      skillsEnvironment.refresh(registry, { environmentId, scope });
    })();
  };

  const visibleEntries = useMemo(
    () => (snapshot === null ? [] : filterSkillEntries(snapshot.entries, { query, filter })),
    [filter, query, snapshot],
  );
  const selectEntry = (entryId: string) => {
    if (entryId === selectedEntryId) return;
    void guarded(() => setSelectedEntryId(entryId))();
  };
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
                  <SelectValue>{project?.title ?? "Global"}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value={GLOBAL_SCOPE_VALUE}>Global</SelectItem>
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

  const body = (() => {
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
    if (snapshot === null) {
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
    }

    return (
      <>
        {project !== null ? (
          <section className="flex flex-col gap-3">
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
            {shared ? (
              <Alert variant="warning">
                <AlertTitle>Edits files in the repository</AlertTitle>
                <AlertDescription>
                  <span className="break-all">
                    {snapshot.scope.projectRoot ?? project.workspaceRoot}
                  </span>
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="info">
                <AlertDescription>
                  Stored outside the repository in{" "}
                  <span className="break-all">{snapshot.scope.libraryPath}</span>.{" "}
                  {PRIVATE_PROJECT_SUPPORT_NOTICE}
                </AlertDescription>
              </Alert>
            )}
          </section>
        ) : null}

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
              <ul className="flex flex-col gap-0.5">
                {snapshot.warnings.map((warning) => (
                  <li key={warning} className="break-all">
                    {warning}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

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

        {tab === "skills" ? (
          <section className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1">
                  <SkillsFilterBar
                    query={query}
                    onQueryChange={setQuery}
                    filter={filter}
                    onFilterChange={setFilter}
                  />
                </div>
                <Button size="icon-sm" aria-label="New skill" onClick={() => setNewSkillOpen(true)}>
                  <PlusIcon />
                </Button>
              </div>
              {visibleEntries.length > 0 ? (
                <SkillsList
                  entries={visibleEntries}
                  selectedId={selectedEntry?.id ?? null}
                  onSelect={selectEntry}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {snapshot.entries.length === 0
                    ? "No skills yet. Create one, or add skills to a provider folder and refresh."
                    : "No skills match."}
                </p>
              )}
              <SkillsProviders snapshot={snapshot} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              {entryGone ? (
                <Alert variant="warning">
                  <AlertTitle>This skill is no longer listed</AlertTitle>
                  <AlertDescription>
                    It was moved or removed outside this page. Your unsaved edits are still here.
                    Copy anything you want to keep.
                  </AlertDescription>
                </Alert>
              ) : null}
              {selectedEntry !== null ? (
                <SkillDetail
                  key={`${scopeKey}:${selectedEntry.id}:${editorEpoch}`}
                  environmentId={environmentId}
                  scope={scope}
                  snapshot={snapshot}
                  entry={selectedEntry}
                  onDirtyChange={onDirtyChange}
                  confirmDiscard={confirmDiscard}
                  onSelectEntry={selectEntry}
                  onImport={setImportEntry}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Select a skill to see where providers find it and edit its files.
                </p>
              )}
            </div>
          </section>
        ) : tab === "instructions" ? (
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
      </>
    );
  })();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          {topbar}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">{body}</WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
