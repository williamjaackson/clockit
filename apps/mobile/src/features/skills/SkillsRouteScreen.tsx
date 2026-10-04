import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  SkillEntry,
  SkillRecoveryEntry,
} from "@t3tools/contracts";
import {
  discoverableSkills,
  EMPTY_SKILLS_VIEW_ATOM,
  formatProviderList,
  GLOBAL_SKILLS_SCOPE,
  PRIVATE_PROJECT_SUMMARY,
  PRIVATE_PROJECT_SUPPORT_NOTICE,
  providerDisplayName,
  providerSyncNames,
  SHARED_PROJECT_SUMMARY,
  sharedProfileNotice,
  skillAgentProviders,
  skillBulkEntries,
  skillEntryFilters,
  skillProviderReach,
  skillScope,
  skillSections,
  skillsFailureMessage,
  unsupportedSkillProviders,
  type SkillEntryFilter,
  type SkillSection,
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
import { confirmSkillsAction, reportSkippedLinks, runSkillsCommand } from "./skills-commands";
import {
  SkillAgentIcons,
  SkillListRow,
  SkillSectionMenu,
  SkillsDetailRow,
  SkillsNote,
  SkillsSelectRow,
  SkillsWarning,
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
  // Keys switch requests in flight to the scope they act on.
  const scopeKey = JSON.stringify([environmentId, scopeProjectPath, scopeMode]);
  const view = useAtomValue(
    environmentId === null
      ? EMPTY_SKILLS_VIEW_ATOM
      : skillsEnvironment.view({ environmentId, scope }),
  );
  const snapshot = view.snapshot;
  const profileNotice = snapshot === null ? null : sharedProfileNotice(snapshot.scope);
  const [query, setQuery] = useState("");
  const [chosenFilter, setFilter] = useState<SkillEntryFilter>("all");
  const [showOffInMySkills, setShowOffInMySkills] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Switch requests in flight, by scope and entry, with the value each asks for.
  const [pendingToggles, setPendingToggles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const filters = snapshot === null ? [] : skillEntryFilters(snapshot.scope);
  const filter = filters.some((option) => option.value === chosenFilter) ? chosenFilter : "all";
  const sections = useMemo(
    () => (snapshot === null ? [] : skillSections(snapshot, { query, filter, showOffInMySkills })),
    [filter, query, showOffInMySkills, snapshot],
  );
  const discoverable = useMemo(
    () => (snapshot === null ? [] : discoverableSkills(snapshot)),
    [snapshot],
  );
  const syncNames = snapshot === null ? [] : providerSyncNames(snapshot);
  const pendingKey = (entryId: string) => `${scopeKey}\n${entryId}`;
  const restore = useAtomCommand(skillsEnvironment.restore, { reportFailure: false });
  const deleteRecovery = useAtomCommand(skillsEnvironment.deleteRecovery, {
    reportFailure: false,
  });
  const setEnabled = useAtomCommand(skillsEnvironment.setEnabled, { reportFailure: false });
  const setEnabledMany = useAtomCommand(skillsEnvironment.setEnabledMany, {
    reportFailure: false,
  });
  const resetProject = useAtomCommand(skillsEnvironment.resetProject, { reportFailure: false });
  const syncProviders = useAtomCommand(skillsEnvironment.syncProviders, { reportFailure: false });

  const routeParams = environmentId === null ? null : paramsFromSelection(environmentId, selection);

  const changeScope = (next: string | null) => {
    setProjectPath(next);
    setShowOffInMySkills(false);
    setDiscoverOpen(false);
  };

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
    setShowOffInMySkills(false);
    rerenderAfterModeChange();
  };

  const refresh = () => {
    if (environmentId !== null) skillsEnvironment.refresh(registry, { environmentId, scope });
  };

  const markPending = (keys: ReadonlyArray<string>, value: boolean | null) =>
    setPendingToggles((current) => {
      const next = new Map(current);
      for (const key of keys) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      return next;
    });

  /**
   * Switches skills in this scope, one or a whole section at once. Editors
   * live on other screens, so nothing here holds a draft that a move could
   * strand.
   */
  const switchSkills = async (entries: ReadonlyArray<SkillEntry>, enabled: boolean) => {
    const [first, ...rest] = entries;
    if (environmentId === null || first === undefined) return;
    const keys = entries.map((entry) => pendingKey(entry.id));
    if (keys.some((key) => pendingToggles.has(key))) return;
    markPending(keys, enabled);
    const result = await runSkillsCommand(
      rest.length === 0
        ? setEnabled({ environmentId, input: { scope, skill: { entryId: first.id }, enabled } })
        : setEnabledMany({
            environmentId,
            input: {
              scope,
              skills: [{ entryId: first.id }, ...rest.map((entry) => ({ entryId: entry.id }))],
              enabled,
            },
          }),
      enabled ? "Could not turn skills on" : "Could not turn skills off",
    );
    markPending(keys, null);
    if (result !== null && result.skippedLinks.length > 0) {
      Alert.alert(
        "Some agents didn't get the skill back",
        `Something else now sits at ${result.skippedLinks.join(", ")}.`,
      );
    }
  };

  const resetSection = async (section: SkillSection) => {
    if (environmentId === null || scopeProjectPath === null) return;
    if (section.id !== "inherited" && section.id !== "repository") return;
    const confirmed = await confirmSkillsAction(
      section.id === "inherited"
        ? {
            title: "Turn every My skills skill back on?",
            message:
              "Applies to this project. Skills that are off in My skills stay off, and private skills don't change.",
            confirmLabel: "Reset",
          }
        : {
            title: "Turn every repository skill back on?",
            message: "Applies to T3 agents in this project. Private skills don't change.",
            confirmLabel: "Reset",
          },
    );
    if (!confirmed) return;
    await runSkillsCommand(
      resetProject({
        environmentId,
        input: { projectPath: scopeProjectPath, sections: [section.id] },
      }),
      "Could not reset the project's skills",
    );
  };

  const syncAll = async () => {
    const [first, ...rest] = syncNames;
    if (environmentId === null || first === undefined || syncing) return;
    setSyncing(true);
    const result = await runSkillsCommand(
      syncProviders({ environmentId, input: { names: [first, ...rest] } }),
      "Could not add skills to every agent",
    );
    setSyncing(false);
    if (result !== null) reportSkippedLinks(result.skippedLinks);
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
    const isGlobal = snapshot.scope.kind === "global";
    const isPrivateProject = snapshot.scope.kind === "project" && snapshot.scope.mode !== "shared";
    const total = sections.reduce((count, section) => count + section.all.length, 0);
    const agents = skillAgentProviders(snapshot);
    const listedProviders = snapshot.providers.filter((provider) =>
      agents === null ? provider.scanned : agents.includes(provider.provider),
    );
    const unsupported = unsupportedSkillProviders(snapshot);
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
                  selection.kind === "global"
                    ? "One file for every agent you turn on"
                    : selection.mode === "shared"
                      ? "AGENTS.md and CLAUDE.md"
                      : "Private instructions for T3 agents"
                }
                onPress={() => navigation.navigate("SettingsSkillInstructions", routeParams)}
              />
              <View className="border-t border-border-subtle" />
              <SettingsActionRow
                icon="plus"
                label={isPrivateProject ? "New private skill" : "New skill"}
                onPress={() => navigation.navigate("SettingsSkillNew", routeParams)}
              />
              {isGlobal ? (
                <SettingsActionRow
                  icon="tray.and.arrow.up"
                  label={
                    discoverable.length > 0
                      ? `Manage existing skills (${discoverable.length})`
                      : "Manage existing skills"
                  }
                  onPress={() => setDiscoverOpen((open) => !open)}
                />
              ) : null}
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

        {isGlobal && discoverOpen && routeParams !== null ? (
          <View className="gap-2">
            <SettingsSection title="Skills your agents already have">
              {discoverable.length > 0 ? (
                discoverable.map((entry, index) => (
                  <SkillsDetailRow
                    key={entry.id}
                    title={entry.name}
                    detail={entry.description}
                    borderTop={index > 0}
                    accessory={<SkillAgentIcons reach={skillProviderReach(entry, snapshot)} />}
                    onPress={() =>
                      navigation.navigate("SettingsSkillImport", {
                        ...routeParams,
                        entryId: entry.id,
                      })
                    }
                  />
                ))
              ) : (
                <SkillsDetailRow title="No other skills found" />
              )}
            </SettingsSection>
            <SkillsNote>
              Bring one into My skills to edit it here and share it with every agent you've turned
              on. Skills installed by plugins stay with their plugin.
            </SkillsNote>
          </View>
        ) : null}

        {syncNames.length > 0 ? (
          <View className="gap-2">
            <SkillsWarning
              title={
                syncNames.length === 1
                  ? "1 skill is missing from an agent"
                  : `${syncNames.length} skills are missing from an agent`
              }
              detail="An agent you've turned on doesn't have them yet. Adding them never removes or replaces anything."
            />
            <SettingsSection>
              <SettingsActionRow
                icon="plus"
                label="Add to all agents"
                loading={syncing}
                disabled={syncing}
                onPress={() => void syncAll()}
              />
            </SettingsSection>
          </View>
        ) : null}

        <View className="gap-3">
          <View className="rounded-[24px] bg-grouped-card px-4 py-3">
            <TextInput
              accessibilityLabel="Search skills"
              placeholder="Search skills"
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
              value={filters.find((option) => option.value === filter)?.label ?? ""}
              actions={filters.map((option) => ({
                id: option.value,
                title: option.label,
                state: option.value === filter ? "on" : "off",
              }))}
              onSelect={(id) => {
                const next = filters.find((option) => option.value === id);
                if (next) setFilter(next.value);
              }}
            />
          </SettingsSection>
        </View>

        {total === 0 ? (
          <SkillsNote>
            {isGlobal
              ? "Nothing in My skills yet. Bring in skills your agents already have, or create one."
              : "This project has no skills of its own yet."}
          </SkillsNote>
        ) : routeParams !== null ? (
          sections.map((section) => (
            <View key={section.id} className="gap-2">
              <SettingsSection
                title={`${section.title} (${section.all.length})`}
                trailing={
                  isPrivateProject ? (
                    <SkillSectionMenu
                      section={section}
                      scope={snapshot.scope}
                      disabled={section.all.some((entry) =>
                        pendingToggles.has(pendingKey(entry.id)),
                      )}
                      onBulk={(enabled) =>
                        void switchSkills(
                          skillBulkEntries(section.all, snapshot.scope, enabled),
                          enabled,
                        )
                      }
                      onReset={() => void resetSection(section)}
                    />
                  ) : undefined
                }
              >
                {section.entries.length > 0 ? (
                  section.entries.map((entry, index) => (
                    <SkillListRow
                      key={entry.id}
                      entry={entry}
                      snapshot={snapshot}
                      pendingEnabled={pendingToggles.get(pendingKey(entry.id))}
                      borderTop={index > 0}
                      onPress={() =>
                        navigation.navigate("SettingsSkill", { ...routeParams, entryId: entry.id })
                      }
                      onToggle={(enabled) => void switchSkills([entry], enabled)}
                    />
                  ))
                ) : (
                  <SkillsDetailRow title="No skills match" />
                )}
              </SettingsSection>
              {section.offInMySkills > 0 && !showOffInMySkills ? (
                <SettingsSection>
                  <SettingsActionRow
                    icon="eye"
                    label={`Show ${section.offInMySkills} off in My skills`}
                    onPress={() => setShowOffInMySkills(true)}
                  />
                  <SettingsActionRow
                    icon="arrow.right"
                    label="Open My skills"
                    onPress={() => changeScope(null)}
                  />
                </SettingsSection>
              ) : null}
            </View>
          ))
        ) : null}

        {snapshot.recovery.length > 0 ? (
          <SettingsSection title="Recovery">
            {snapshot.recovery.map((entry, index) => (
              <SkillsDetailRow
                key={entry.id}
                title={entry.name}
                detail={`${entry.kind === "archivedSkill" ? "Archived" : "Moved aside by T3"} · ${entry.originalPath}`}
                borderTop={index > 0}
                onPress={() => void openRecovery(entry)}
              />
            ))}
          </SettingsSection>
        ) : null}

        {listedProviders.length > 0 ? (
          <SettingsSection title="How agents find skills">
            {listedProviders.map((provider, index) => (
              <SkillsDetailRow
                key={provider.provider}
                title={providerDisplayName(provider.provider)}
                detail={[...provider.globalRoots, ...provider.limitations].join("\n") || undefined}
                borderTop={index > 0}
              />
            ))}
          </SettingsSection>
        ) : null}
        {unsupported.length > 0 ? (
          <SkillsNote>
            {formatProviderList(unsupported)}{" "}
            {unsupported.length === 1 ? "reads skills its own way" : "read skills their own way"},
            so T3 can't add skills there.
          </SkillsNote>
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
                changeScope(null);
              }}
            />
            <SkillsSelectRow
              label="Scope"
              value={project?.title ?? "My skills"}
              borderTop
              actions={[
                { id: GLOBAL_VALUE, title: "My skills", state: project === null ? "on" : "off" },
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
              onSelect={(id) => changeScope(id === GLOBAL_VALUE ? null : id)}
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
                detail={SHARED_PROJECT_SUMMARY}
              />
            ) : (
              <>
                {profileNotice !== null ? (
                  <SkillsWarning title="Inherited private settings" detail={profileNotice} />
                ) : null}
                <SkillsNote>{PRIVATE_PROJECT_SUMMARY}</SkillsNote>
                <SettingsSection>
                  <SkillsDetailRow
                    title="How private changes work"
                    onPress={() =>
                      Alert.alert(
                        "How private changes work",
                        snapshot === null
                          ? PRIVATE_PROJECT_SUPPORT_NOTICE
                          : `${PRIVATE_PROJECT_SUPPORT_NOTICE}\n\nStored in ${snapshot.scope.libraryPath}`,
                      )
                    }
                  />
                </SettingsSection>
              </>
            )}
          </View>
        ) : null}

        {body}
      </ScrollView>
    </SettingsScreen>
  );
}
