import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  SkillRecoveryEntry,
} from "@t3tools/contracts";
import {
  EMPTY_SKILLS_VIEW_ATOM,
  filterSkillEntries,
  GLOBAL_SKILLS_SCOPE,
  PRIVATE_PROJECT_SUPPORT_NOTICE,
  providerDisplayName,
  SKILL_ENTRY_FILTERS,
  skillScope,
  skillsFailureMessage,
  type SkillEntryFilter,
  type SkillsScopeSelection,
} from "@t3tools/client-runtime/state/skills";
import { Atom } from "effect/unstable/reactivity";
import { useContext, useMemo, useReducer, useState } from "react";
import { Alert, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { SegmentedControl } from "../../components/SegmentedControl";
import { environmentPresentations } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { confirmSkillsAction, runSkillsCommand } from "./skills-commands";
import {
  SkillsDetailRow,
  SkillsNote,
  SkillsSelectRow,
  SkillsWarning,
  skillEntrySummary,
} from "./skills-components";
import { paramsFromSelection, type SkillsRoutes } from "./skills-routes";
import { readSharedMode, saveSharedMode } from "./skills-shared-mode";

const GLOBAL_VALUE = "global";
const EMPTY_PROJECTS_ATOM = Atom.make<ReadonlyArray<OrchestrationProjectShell>>([]).pipe(
  Atom.withLabel("mobile-skills:no-projects"),
);

export function SkillsRouteScreen() {
  const registry = useContext(RegistryContext);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<SkillsRoutes>>();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const environments = useMemo(
    () =>
      [...presentations].map(([environmentId, presentation]) => ({
        environmentId,
        label: presentation.entry.target.label,
        connected: presentation.connection.phase === "connected",
      })),
    [presentations],
  );
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((candidate) => candidate.environmentId === chosenEnvironmentId) ??
    environments.find((candidate) => candidate.connected) ??
    environments[0] ??
    null;
  const environmentId = environment?.environmentId ?? null;
  const projects = useAtomValue(
    environmentId === null
      ? EMPTY_PROJECTS_ATOM
      : environmentProjects.environmentProjectsAtom(environmentId),
  );
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const project = projects.find((candidate) => candidate.workspaceRoot === projectPath) ?? null;
  // Re-render after the repository-files choice changes; the choice lives outside React.
  const [, rerenderAfterModeChange] = useReducer((count: number) => count + 1, 0);
  const shared =
    environmentId !== null &&
    project !== null &&
    readSharedMode(environmentId, project.workspaceRoot).shared;
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
  const view = useAtomValue(
    environmentId === null
      ? EMPTY_SKILLS_VIEW_ATOM
      : skillsEnvironment.view({ environmentId, scope }),
  );
  const snapshot = view.snapshot;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillEntryFilter>("all");
  const entries = useMemo(
    () => (snapshot === null ? [] : filterSkillEntries(snapshot.entries, { query, filter })),
    [filter, query, snapshot],
  );
  const restore = useAtomCommand(skillsEnvironment.restore, { reportFailure: false });
  const deleteRecovery = useAtomCommand(skillsEnvironment.deleteRecovery, {
    reportFailure: false,
  });

  const routeParams = environmentId === null ? null : paramsFromSelection(environmentId, selection);

  const changeShared = async (nextShared: boolean) => {
    if (environmentId === null || project === null || nextShared === shared) return;
    if (nextShared && !readSharedMode(environmentId, project.workspaceRoot).confirmed) {
      const confirmed = await confirmSkillsAction({
        title: `Edit repository files for ${project.title}?`,
        message: `Changes write skills, AGENTS.md, and CLAUDE.md inside ${project.workspaceRoot}. Terminal agents and teammates see them once they are committed.`,
        confirmLabel: "Edit repository files",
      });
      if (!confirmed) return;
    }
    saveSharedMode(environmentId, project.workspaceRoot, nextShared);
    rerenderAfterModeChange();
  };

  const refresh = () => {
    if (environmentId !== null) skillsEnvironment.refresh(registry, { environmentId, scope });
  };

  const openRecovery = async (entry: SkillRecoveryEntry) => {
    if (environmentId === null) return;
    const choice = await new Promise<"restore" | "delete" | null>((resolve) => {
      Alert.alert(
        entry.name,
        `From ${entry.originalPath}`,
        [
          { text: "Restore", onPress: () => resolve("restore") },
          { text: "Delete permanently", style: "destructive", onPress: () => resolve("delete") },
          { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
        ],
        { cancelable: true, onDismiss: () => resolve(null) },
      );
    });
    if (choice === "restore") {
      await runSkillsCommand(
        restore({ environmentId, input: { scope, recoveryId: entry.id } }),
        `Could not restore ${entry.name}`,
      );
    } else if (choice === "delete") {
      const confirmed = await confirmSkillsAction({
        title: `Delete ${entry.name} permanently?`,
        message: "It can't be restored afterwards.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (confirmed) {
        await runSkillsCommand(
          deleteRecovery({ environmentId, input: { scope, recoveryId: entry.id } }),
          `Could not delete ${entry.name}`,
        );
      }
    }
  };

  const body = (() => {
    if (environment === null) {
      return (
        <EmptyState title="No environments" detail="Connect an environment to manage its skills." />
      );
    }
    if (snapshot === null) {
      if (!environment.connected && !view.isLoading) {
        return (
          <EmptyState
            title={`${environment.label} is not connected`}
            detail="Skills live on each environment. Reconnect it to manage them."
          />
        );
      }
      if (view.error !== null && !view.isLoading) {
        return (
          <EmptyState
            title="Could not read skills"
            detail={skillsFailureMessage(view.error)}
            actionLabel="Try again"
            onAction={refresh}
          />
        );
      }
      return <SkillsNote>Reading skills…</SkillsNote>;
    }
    return (
      <>
        {view.error !== null ? (
          <ErrorBanner message={`Could not refresh: ${skillsFailureMessage(view.error)}`} />
        ) : null}
        {snapshot.warnings.length > 0 ? (
          <SkillsNote>
            Some folders were not fully scanned: {snapshot.warnings.join(" ")}
          </SkillsNote>
        ) : null}

        <SettingsSection>
          {routeParams !== null ? (
            <>
              <SkillsDetailRow
                title="Instructions"
                detail={
                  selection.kind === "project" && selection.mode === "shared"
                    ? "AGENTS.md and CLAUDE.md"
                    : snapshot.instructions.canonicalPath
                }
                onPress={() => navigation.navigate("SettingsSkillInstructions", routeParams)}
              />
              <View className="border-t border-border-subtle" />
              <SettingsActionRow
                icon="plus"
                label="New skill"
                onPress={() => navigation.navigate("SettingsSkillNew", routeParams)}
              />
            </>
          ) : null}
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Refresh"
            loading={view.isLoading}
            disabled={view.isLoading}
            onPress={refresh}
          />
        </SettingsSection>

        <View className="gap-3">
          <View className="rounded-[24px] bg-grouped-card px-4 py-3">
            <TextInput
              accessibilityLabel="Search skills"
              placeholder="Search by name, description, or provider"
              placeholderTextColorClassName="accent-foreground-muted"
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              className="min-h-8 font-sans text-base text-foreground"
            />
          </View>
          <SettingsSection>
            <SkillsSelectRow
              label="Show"
              value={SKILL_ENTRY_FILTERS.find((option) => option.value === filter)?.label ?? ""}
              actions={SKILL_ENTRY_FILTERS.map((option) => ({
                id: option.value,
                title: option.label,
                state: option.value === filter ? "on" : "off",
              }))}
              onSelect={(id) => {
                const next = SKILL_ENTRY_FILTERS.find((option) => option.value === id);
                if (next) setFilter(next.value);
              }}
            />
          </SettingsSection>
        </View>

        {entries.length > 0 && routeParams !== null ? (
          <SettingsSection title={`Skills (${entries.length})`}>
            {entries.map((entry, index) => (
              <SkillsDetailRow
                key={entry.id}
                title={entry.name}
                detail={[entry.description, skillEntrySummary(entry)].filter(Boolean).join("\n")}
                muted={!entry.enabled}
                borderTop={index > 0}
                onPress={() =>
                  navigation.navigate("SettingsSkill", { ...routeParams, entryId: entry.id })
                }
              />
            ))}
          </SettingsSection>
        ) : (
          <SkillsNote>
            {snapshot.entries.length === 0
              ? "No skills yet. Create one, or add skills to a provider folder and refresh."
              : "No skills match."}
          </SkillsNote>
        )}

        {snapshot.recovery.length > 0 ? (
          <SettingsSection title="Recovery">
            {snapshot.recovery.map((entry, index) => (
              <SkillsDetailRow
                key={entry.id}
                title={entry.name}
                detail={`${entry.kind === "archivedSkill" ? "Archived" : "Replaced by a link"} · ${entry.originalPath}`}
                borderTop={index > 0}
                onPress={() => void openRecovery(entry)}
              />
            ))}
          </SettingsSection>
        ) : null}

        {snapshot.providers.length > 0 ? (
          <SettingsSection title="Providers">
            {snapshot.providers.map((provider, index) => (
              <SkillsDetailRow
                key={provider.provider}
                title={providerDisplayName(provider.provider)}
                detail={[...provider.globalRoots, ...provider.limitations].join("\n") || undefined}
                borderTop={index > 0}
              />
            ))}
          </SettingsSection>
        ) : null}
      </>
    );
  })();

  return (
    <SettingsScreen title="Skills">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environment !== null ? (
          <SettingsSection>
            <SkillsSelectRow
              label="Environment"
              value={environment.label}
              actions={environments.map((candidate) => ({
                id: candidate.environmentId,
                title: candidate.label,
                state: candidate.environmentId === environmentId ? "on" : "off",
              }))}
              onSelect={(id) => {
                const next = environments.find((candidate) => candidate.environmentId === id);
                if (!next || next.environmentId === environmentId) return;
                setChosenEnvironmentId(next.environmentId);
                setProjectPath(null);
              }}
            />
            <SkillsSelectRow
              label="Scope"
              value={project?.title ?? "Global"}
              borderTop
              actions={[
                { id: GLOBAL_VALUE, title: "Global", state: project === null ? "on" : "off" },
                ...projects.map((candidate) => ({
                  id: candidate.workspaceRoot,
                  title: candidate.title,
                  subtitle: candidate.workspaceRoot,
                  state:
                    candidate.workspaceRoot === project?.workspaceRoot
                      ? ("on" as const)
                      : ("off" as const),
                })),
              ]}
              onSelect={(id) => setProjectPath(id === GLOBAL_VALUE ? null : id)}
            />
          </SettingsSection>
        ) : null}

        {project !== null ? (
          <View className="gap-2">
            <SegmentedControl
              options={[
                { value: "local", label: "Private to T3" },
                { value: "shared", label: "Repository files" },
              ]}
              selected={shared ? "shared" : "local"}
              onSelect={(value) => void changeShared(value === "shared")}
            />
            {shared ? (
              <SkillsWarning
                title="Edits files in the repository"
                detail={snapshot?.scope.projectRoot ?? project.workspaceRoot}
              />
            ) : (
              <SkillsNote>
                Stored outside the repository
                {snapshot !== null ? ` in ${snapshot.scope.libraryPath}` : ""}.{" "}
                {PRIVATE_PROJECT_SUPPORT_NOTICE}
              </SkillsNote>
            )}
          </View>
        ) : null}

        {body}
      </ScrollView>
    </SettingsScreen>
  );
}
