import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { SkillEntry, SkillsReadResult } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isSkillsRevisionConflict,
  PRIVATE_PROJECT_SUPPORT_NOTICE,
  providerDisplayName,
  sharedProfileNotice,
  skillsFailureMessage,
} from "@t3tools/client-runtime/state/skills";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { confirmSkillsAction, runSkillsCommand } from "./skills-commands";
import {
  SkillFileEditorSection,
  SkillLinkRows,
  SkillsDetailRow,
  SkillsNote,
  skillEntrySummary,
  type SkillFileSaveOutcome,
} from "./skills-components";
import type { SkillsRoutes } from "./skills-routes";
import { SkillsDiscardGuard, useSkillsScope } from "./skills-screen-state";

function readOnlyReason(entry: SkillEntry): string {
  switch (entry.ownership) {
    case "plugin":
      return "Installed by a plugin. Import a copy to change it.";
    case "system":
      return "Built into the provider. Import a copy to change it.";
    default:
      return "Lives outside the library. Import it to edit.";
  }
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
  const [files, setFiles] = useState<{ list: readonly string[]; truncated: boolean } | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
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

  const isProjectPrivate = snapshot.scope.kind === "project" && snapshot.scope.mode !== "shared";
  const isShared = snapshot.scope.kind === "project" && snapshot.scope.mode === "shared";
  const canToggle = entry.ownership === "managed" || isProjectPrivate;
  const profileNotice = isProjectPrivate ? sharedProfileNotice(snapshot.scope) : null;
  // Shared snapshots only list links for skills kept directly in `.agents/skills`.
  const showLinks =
    (entry.ownership === "managed" && entry.scope === "global" && entry.enabled) ||
    (isShared && entry.links.length > 0);

  const toggleEnabled = async (enabled: boolean) => {
    setPending(true);
    const result = await runSkillsCommand(
      setEnabled({ environmentId, input: { scope, skill: { entryId }, enabled } }),
      enabled ? "Could not enable the skill" : "Could not disable the skill",
    );
    setPending(false);
    if (result !== null && result.skippedLinks.length > 0) {
      Alert.alert(
        "Some links were not restored",
        `Something else is now at ${result.skippedLinks.join(", ")}.`,
      );
    }
  };

  const archiveSkill = async () => {
    const confirmed = await confirmSkillsAction({
      title: `Archive ${entry.name}?`,
      message:
        "It moves to Recovery and its provider links are removed. You can restore it from Recovery.",
      confirmLabel: "Archive",
      destructive: true,
    });
    if (!confirmed) return;
    setPending(true);
    const result = await runSkillsCommand(
      archive({ environmentId, input: { scope, name: entry.name } }),
      "Could not archive the skill",
    );
    setPending(false);
    if (result === null) return;
    leavingRef.current = true;
    navigation.goBack();
  };

  return (
    <SettingsScreen title={entry.name}>
      <SkillsDiscardGuard dirty={false} saving={pending} leavingRef={leavingRef} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection>
          <SkillsDetailRow
            title={entry.description ?? entry.name}
            detail={`${skillEntrySummary(entry)}\n${entry.path}`}
          />
        </SettingsSection>
        {profileNotice !== null && canToggle ? <SkillsNote>{profileNotice}</SkillsNote> : null}
        {isProjectPrivate ? <SkillsNote>{PRIVATE_PROJECT_SUPPORT_NOTICE}</SkillsNote> : null}

        <SettingsSection>
          {canToggle ? (
            <SettingsSwitchRow
              icon="checkmark.circle"
              label="Enabled"
              disabled={pending}
              value={entry.enabled}
              onValueChange={(enabled) => void toggleEnabled(enabled)}
            />
          ) : null}
          {entry.ownership !== "managed" ? (
            <SettingsActionRow
              icon="tray.and.arrow.up"
              label="Import to library"
              onPress={() => navigation.navigate("SettingsSkillImport", params)}
            />
          ) : (
            <SettingsActionRow
              icon="archivebox"
              label="Archive"
              tone="danger"
              disabled={pending}
              onPress={() => void archiveSkill()}
            />
          )}
        </SettingsSection>

        {entry.conflicts.length > 0 ? (
          <SettingsSection title="Same name elsewhere">
            {entry.conflicts.map((conflict, index) => (
              <SkillsDetailRow
                key={conflict.entryId}
                title={conflict.path}
                borderTop={index > 0}
                onPress={() =>
                  navigation.push("SettingsSkill", { ...params, entryId: conflict.entryId })
                }
              />
            ))}
          </SettingsSection>
        ) : null}
        {entry.conflicts.length > 0 ? (
          <SkillsNote>Which copy an agent loads depends on the provider.</SkillsNote>
        ) : null}

        {entry.origins.length > 0 ? (
          <SettingsSection title="Found by">
            {entry.origins.map((origin, index) => (
              <SkillsDetailRow
                key={origin.entryPath}
                title={origin.providers.map(providerDisplayName).join(", ") || "No provider"}
                detail={
                  origin.symlinkTarget === undefined
                    ? origin.entryPath
                    : `${origin.entryPath} → ${origin.symlinkTarget}`
                }
                borderTop={index > 0}
              />
            ))}
          </SettingsSection>
        ) : null}

        {showLinks && entry.links.length > 0 ? (
          <SettingsSection title={isShared ? "Repository links" : "Provider links"}>
            <SkillLinkRows
              environmentId={environmentId}
              scope={scope}
              subject={{ type: "skill", name: entry.name }}
              subjectLabel={entry.name}
              links={entry.links}
              providersFor={(targetId) =>
                snapshot.linkTargets
                  .find((target) => target.id === targetId)
                  ?.providers.map(providerDisplayName)
                  .join(", ") || targetId
              }
            />
          </SettingsSection>
        ) : null}
        {showLinks && isShared ? (
          <SkillsNote>
            Claude Code reads .claude/skills, not .agents/skills. Linking adds a relative symlink to
            the repository so both read this folder. Nothing is linked until you ask.
          </SkillsNote>
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
  const { scope } = useSkillsScope(params);
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
            readOnlyReason={readOnlyReason(fileState.result.entry)}
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
