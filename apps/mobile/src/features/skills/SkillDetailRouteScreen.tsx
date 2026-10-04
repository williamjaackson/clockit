import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { SkillEntry, SkillsReadResult, SkillsSnapshot } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  advancedSkillLinks,
  blockedProviderLinks,
  formatProviderList,
  isSkillsRevisionConflict,
  needsProviderSync,
  providerDisplayName,
  skillInvocationName,
  skillProviderReach,
  skillProvidersNote,
  skillSectionOf,
  skillSections,
  skillsFailureMessage,
  skillToggle,
  skillUsageSummary,
} from "@t3tools/client-runtime/state/skills";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { confirmSkillsAction, reportSkippedLinks, runSkillsCommand } from "./skills-commands";
import {
  SkillFileEditorSection,
  SkillProviderSwitchRows,
  SkillsDetailRow,
  SkillsNote,
  type SkillFileSaveOutcome,
} from "./skills-components";
import type { SkillsRoutes } from "./skills-routes";
import { SkillsDiscardGuard, useSkillsScope } from "./skills-screen-state";

function readOnlyReason(entry: SkillEntry, snapshot: SkillsSnapshot | null): string {
  if (entry.id.startsWith("inherited:")) {
    return "From My skills. Edit it there, or customize it for this project.";
  }
  if (snapshot !== null && skillSectionOf(entry, snapshot.scope) === "repository") {
    return "Lives in the repository. Customize it for this project, or switch to Repository files, to change it.";
  }
  return "Read only.";
}

export function SkillDetailRouteScreen({
  route,
}: StaticScreenProps<SkillsRoutes["SettingsSkill"]>) {
  const params = route.params;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<SkillsRoutes>>();
  const { scope, view } = useSkillsScope(params);
  const snapshot = view.snapshot;
  const entry = snapshot?.entries.find((candidate) => candidate.id === params.entryId) ?? null;
  const read = useAtomCommand(skillsEnvironment.read, { reportFailure: false });
  const setEnabled = useAtomCommand(skillsEnvironment.setEnabled, { reportFailure: false });
  const archive = useAtomCommand(skillsEnvironment.archive, { reportFailure: false });
  const syncProviders = useAtomCommand(skillsEnvironment.syncProviders, { reportFailure: false });
  const [files, setFiles] = useState<{ list: readonly string[]; truncated: boolean } | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [pendingEnabled, setPendingEnabled] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [showFolders, setShowFolders] = useState(false);
  const leavingRef = useRef(false);
  const { environmentId, entryId } = params;

  useEffect(() => {
    let current = true;
    void read({ environmentId, input: { scope, skill: { entryId } } }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") {
        setFiles({ list: result.value.files, truncated: result.value.filesTruncated });
      } else {
        setFilesError(skillsFailureMessage(squashAtomCommandFailure(result)));
      }
    });
    return () => {
      current = false;
    };
  }, [entryId, environmentId, read, scope]);

  if (entry === null || snapshot === null) {
    return (
      <SettingsScreen title="Skill">
        <ScrollView contentContainerClassName="gap-5 px-5 pt-4">
          {view.isLoading ? (
            <SkillsNote>Reading skills…</SkillsNote>
          ) : (
            <EmptyState
              title="Skill not found"
              detail="It may have been archived, renamed, or removed. Go back and refresh."
            />
          )}
        </ScrollView>
      </SettingsScreen>
    );
  }

  const section = skillSectionOf(entry, snapshot.scope);
  const isShared = snapshot.scope.kind === "project" && snapshot.scope.mode === "shared";
  const toggle = skillToggle(entry, snapshot.scope);
  const reach = skillProviderReach(entry, snapshot);
  const providersNote = skillProvidersNote(entry, snapshot.scope);
  const missing = needsProviderSync(entry)
    ? reach.filter((item) => item.pending).map((item) => item.provider)
    : [];
  const blocked = blockedProviderLinks(entry);
  const advancedLinks =
    section === "mine" && entry.enabled ? advancedSkillLinks(entry, snapshot) : [];
  const invocation = skillInvocationName(entry);
  const listed = new Set(
    skillSections(snapshot, { query: "", filter: "all", showOffInMySkills: true }).flatMap(
      (candidate) => candidate.all.map((listedEntry) => listedEntry.id),
    ),
  );
  const duplicates = entry.conflicts.filter((conflict) => conflict.reason === "duplicateName");
  const replacements = entry.conflicts.filter((conflict) => conflict.reason === "replacedByLocal");
  const isReplaced =
    (section === "inherited" || section === "repository") && replacements.length > 0;
  const replaces = section === "private" ? replacements : [];
  const globalParams = { environmentId };

  const toggleEnabled = async (enabled: boolean) => {
    setPendingEnabled(enabled);
    const result = await runSkillsCommand(
      setEnabled({ environmentId, input: { scope, skill: { entryId }, enabled } }),
      enabled ? "Could not turn the skill on" : "Could not turn the skill off",
    );
    setPendingEnabled(undefined);
    if (result !== null && result.skippedLinks.length > 0) {
      Alert.alert(
        "Some agents didn't get the skill back",
        `Something else now sits at ${result.skippedLinks.join(", ")}.`,
      );
    }
  };

  const sync = async () => {
    setBusy(true);
    const result = await runSkillsCommand(
      syncProviders({ environmentId, input: { names: [entry.name] } }),
      "Could not add the skill to every agent",
    );
    setBusy(false);
    if (result !== null) reportSkippedLinks(result.skippedLinks);
  };

  const archiveSkill = async () => {
    const confirmed = await confirmSkillsAction({
      title: `Archive ${entry.name}?`,
      message:
        section === "mine"
          ? `T3's copy moves to Recovery, where you can restore it, and agents stop getting it from T3. Other skills called ${invocation} that T3 doesn't manage stay where they are.`
          : "The private skill moves to Recovery, where you can restore it. Any repository or My skills version it replaced applies again.",
      confirmLabel: "Archive",
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    const result = await runSkillsCommand(
      archive({ environmentId, input: { scope, name: entry.name } }),
      "Could not archive the skill",
    );
    setBusy(false);
    if (result === null) return;
    leavingRef.current = true;
    navigation.goBack();
  };

  const showEntry = (id: string) => navigation.push("SettingsSkill", { ...params, entryId: id });

  return (
    <SettingsScreen title={entry.name}>
      <SkillsDiscardGuard
        dirty={false}
        saving={busy || pendingEnabled !== undefined}
        leavingRef={leavingRef}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection>
          <SkillsDetailRow title={skillUsageSummary(entry, snapshot)} detail={entry.description} />
          {toggle !== null ? (
            <SettingsSwitchRow
              icon="checkmark.circle"
              label={section === "inherited" || section === "repository" ? "On here" : "On"}
              {...(toggle.disabledReason === null ? {} : { subtitle: toggle.disabledReason })}
              disabled={pendingEnabled !== undefined || busy || toggle.disabledReason !== null}
              value={pendingEnabled ?? toggle.checked}
              onValueChange={(enabled) => void toggleEnabled(enabled)}
            />
          ) : null}
        </SettingsSection>

        {section === "inherited" ? (
          <View className="gap-2">
            <SettingsSection>
              <SettingsActionRow
                icon="square.and.pencil"
                label="Edit in My skills"
                onPress={() =>
                  navigation.push("SettingsSkill", {
                    ...globalParams,
                    entryId: `managed:${entry.name}`,
                  })
                }
              />
              <SettingsActionRow
                icon="doc.on.doc"
                label="Customize for this project"
                onPress={() => navigation.navigate("SettingsSkillImport", params)}
              />
            </SettingsSection>
            <SkillsNote>
              From My skills, so changes there reach every project. To change it only here, make a
              private copy.
            </SkillsNote>
          </View>
        ) : null}

        {isReplaced ? (
          <SkillsNote>
            A private skill also called {invocation} replaces this one for T3 agents in this
            project.
          </SkillsNote>
        ) : null}
        {replaces.length > 0 || duplicates.length > 0 ? (
          <SettingsSection
            title={replaces.length > 0 ? "Replaces for T3 agents here" : "Same name elsewhere"}
          >
            {[...replaces, ...duplicates].map((conflict, index) => (
              <SkillsDetailRow
                key={conflict.entryId}
                title={conflict.path}
                borderTop={index > 0}
                {...(listed.has(conflict.entryId)
                  ? { onPress: () => showEntry(conflict.entryId) }
                  : {})}
              />
            ))}
          </SettingsSection>
        ) : null}
        {duplicates.length > 0 ? (
          <SkillsNote>
            Other skills are also called {invocation}. Which one an agent loads depends on the
            agent.
          </SkillsNote>
        ) : null}

        <SettingsSection title="Agents">
          {reach.length > 0 ? (
            reach.map((item, index) => (
              <SkillsDetailRow
                key={item.provider}
                title={providerDisplayName(item.provider)}
                detail={item.on ? "Has it" : item.pending ? "Not yet" : "Doesn't have it"}
                muted={!item.on}
                borderTop={index > 0}
                accessory={<ProviderIcon provider={item.provider} size={18} />}
              />
            ))
          ) : (
            <SkillsDetailRow title="No agent reads it" />
          )}
          {missing.length > 0 ? (
            <SettingsActionRow
              icon="plus"
              label="Make available to all agents"
              loading={busy}
              disabled={busy}
              onPress={() => void sync()}
            />
          ) : null}
        </SettingsSection>
        {missing.length > 0 ? (
          <SkillsNote>Not available to {formatProviderList(missing)} yet.</SkillsNote>
        ) : null}
        {providersNote !== null ? <SkillsNote>{providersNote}</SkillsNote> : null}
        {blocked.length > 0 ? (
          <SkillsNote>
            Some agent folders already have a different skill called {entry.name}, so T3 left them
            alone and those agents keep their own: {blocked.map((status) => status.path).join(", ")}
          </SkillsNote>
        ) : null}

        {isShared && entry.links.length > 0 ? (
          <SettingsSection title="Use with">
            <SkillProviderSwitchRows
              environmentId={environmentId}
              scope={scope}
              subject={{ type: "skill", name: entry.name }}
              subjectLabel={entry.name}
              links={entry.links}
              linkTargets={snapshot.linkTargets}
            />
          </SettingsSection>
        ) : null}
        {advancedLinks.length > 0 ? (
          <View className="gap-2">
            <SettingsSection title={showFolders ? "Folders" : undefined}>
              <SettingsActionRow
                icon={showFolders ? "chevron.up" : "chevron.down"}
                label={showFolders ? "Hide folders" : "Choose folders"}
                onPress={() => setShowFolders((open) => !open)}
              />
              {showFolders ? (
                <SkillProviderSwitchRows
                  environmentId={environmentId}
                  scope={scope}
                  subject={{ type: "skill", name: entry.name }}
                  subjectLabel={entry.name}
                  links={advancedLinks}
                  linkTargets={snapshot.linkTargets}
                />
              ) : null}
            </SettingsSection>
            {showFolders ? (
              <SkillsNote>
                Each switch adds or removes the skill in one agent folder. Agents that share a
                folder switch together. A folder you switch off stays off when T3 adds skills to new
                agents.
              </SkillsNote>
            ) : null}
          </View>
        ) : null}

        <SettingsSection title="Files">
          {(files?.list ?? ["SKILL.md"]).map((file, index) => (
            <SkillsDetailRow
              key={file}
              title={file}
              borderTop={index > 0}
              onPress={() => navigation.navigate("SettingsSkillFile", { ...params, file })}
            />
          ))}
        </SettingsSection>
        {files?.truncated ? (
          <SkillsNote>Showing the first {files.list.length} files.</SkillsNote>
        ) : null}
        {filesError !== null ? <ErrorBanner message={filesError} /> : null}

        <SettingsSection title="Details">
          <SkillsDetailRow title="Skill folder" detail={entry.path} />
          {entry.origins.map((origin) => (
            <SkillsDetailRow
              key={origin.entryPath}
              title={`Found by ${origin.providers.map(providerDisplayName).join(", ") || "no provider"}`}
              detail={
                origin.symlinkTarget === undefined
                  ? origin.entryPath
                  : `${origin.entryPath} → ${origin.symlinkTarget}`
              }
              borderTop
            />
          ))}
        </SettingsSection>

        {section === "mine" ||
        section === "private" ||
        (section === "repository" && (!isShared || entry.links.length === 0)) ? (
          <SettingsSection>
            {section === "repository" ? (
              <SettingsActionRow
                icon="doc.on.doc"
                label={isShared ? "Copy to .agents/skills" : "Customize for this project"}
                onPress={() => navigation.navigate("SettingsSkillImport", params)}
              />
            ) : null}
            {section === "mine" ? (
              <SettingsActionRow
                icon="arrow.up.right.circle"
                label="Stop managing in T3"
                disabled={busy}
                onPress={() => navigation.navigate("SettingsSkillRelease", params)}
              />
            ) : null}
            {section === "mine" || section === "private" ? (
              <SettingsActionRow
                icon="archivebox"
                label="Archive"
                tone="danger"
                disabled={busy}
                onPress={() => void archiveSkill()}
              />
            ) : null}
          </SettingsSection>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}

type FileState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly result: SkillsReadResult; readonly loadId: number };

export function SkillFileRouteScreen({
  route,
}: StaticScreenProps<SkillsRoutes["SettingsSkillFile"]>) {
  const params = route.params;
  const insets = useSafeAreaInsets();
  const { scope, view } = useSkillsScope(params);
  const read = useAtomCommand(skillsEnvironment.read, { reportFailure: false });
  const save = useAtomCommand(skillsEnvironment.save, { reportFailure: false });
  const [fileState, setFileState] = useState<FileState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadIdRef = useRef(0);
  const { environmentId, entryId, file } = params;

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    const result = await read({ environmentId, input: { scope, skill: { entryId }, file } });
    if (loadId !== loadIdRef.current) return;
    setFileState(
      result._tag === "Success"
        ? { status: "ready", result: result.value, loadId }
        : { status: "error", message: skillsFailureMessage(squashAtomCommandFailure(result)) },
    );
  }, [entryId, environmentId, file, read, scope]);

  useEffect(() => {
    void load();
    return () => {
      loadIdRef.current += 1;
    };
  }, [load]);

  const saveFile = async (
    content: string,
    expectedRevision: string | null,
  ): Promise<SkillFileSaveOutcome> => {
    const result = await save({
      environmentId,
      input: { scope, skill: { entryId }, file, content, expectedRevision },
    });
    if (result._tag === "Success") return { _tag: "saved", revision: result.value.revision };
    const error = squashAtomCommandFailure(result);
    return isSkillsRevisionConflict(error)
      ? { _tag: "conflict" }
      : { _tag: "failed", message: skillsFailureMessage(error) };
  };

  return (
    <SettingsScreen title={file}>
      <SkillsDiscardGuard dirty={dirty} saving={saving} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {fileState.status === "loading" ? (
          <SkillsNote>Reading {file}…</SkillsNote>
        ) : fileState.status === "error" ? (
          <ErrorBanner message={fileState.message} />
        ) : (
          <SkillFileEditorSection
            key={fileState.loadId}
            label={file}
            content={fileState.result.content}
            revision={fileState.result.revision}
            editable={fileState.result.entry.editable}
            readOnlyReason={readOnlyReason(fileState.result.entry, view.snapshot)}
            onSave={saveFile}
            onDirtyChange={setDirty}
            onSavingChange={setSaving}
            onReload={() =>
              void confirmSkillsAction({
                title: "Discard your edits?",
                message: "Reloading shows the current file and drops your unsaved changes.",
                confirmLabel: "Reload",
                destructive: true,
              }).then((confirmed) => {
                if (!confirmed) return;
                setFileState({ status: "loading" });
                void load();
              })
            }
          />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
