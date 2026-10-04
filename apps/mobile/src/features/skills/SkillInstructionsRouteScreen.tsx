import type { StaticScreenProps } from "@react-navigation/native";
import type {
  SkillInstructionFile,
  SkillInstructionFileName,
  SkillInstructionsDocument,
  SkillProjectInstructionMode,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isSkillsRevisionConflict,
  PRIVATE_PROJECT_SUPPORT_NOTICE,
  providerDisplayName,
  sharedProfileNotice,
  skillsFailureMessage,
} from "@t3tools/client-runtime/state/skills";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { SegmentedControl } from "../../components/SegmentedControl";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsChoiceRow } from "../settings/components/SettingsChoiceRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { confirmSkillsAction, runSkillsCommand } from "./skills-commands";
import {
  SkillFileEditorSection,
  SkillLinkRows,
  SkillsDetailRow,
  SkillsNote,
  SkillsWarning,
  type SkillFileSaveOutcome,
} from "./skills-components";
import type { SkillsRoutes } from "./skills-routes";
import { SkillsDiscardGuard, useSkillsScope } from "./skills-screen-state";

const INSTRUCTION_MODES: ReadonlyArray<{
  readonly value: SkillProjectInstructionMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "inherit",
    label: "Use repository",
    description: "Agents read the repository's instructions. Your private text is kept but unused.",
  },
  {
    value: "append",
    label: "Add to repository",
    description: "Agents read the repository's instructions, then your private text.",
  },
  {
    value: "replace",
    label: "Replace repository",
    description: "Agents read your private text instead of the repository's instructions.",
  },
  { value: "off", label: "Off", description: "Agents get no project instructions." },
];

type DocumentState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly document: SkillInstructionsDocument;
      readonly loadId: number;
    };

export function SkillInstructionsRouteScreen({
  route,
}: StaticScreenProps<SkillsRoutes["SettingsSkillInstructions"]>) {
  const params = route.params;
  const insets = useSafeAreaInsets();
  const { scope, view } = useSkillsScope(params);
  const snapshot = view.snapshot;
  const readInstructions = useAtomCommand(skillsEnvironment.readInstructions, {
    reportFailure: false,
  });
  const saveInstructions = useAtomCommand(skillsEnvironment.saveInstructions, {
    reportFailure: false,
  });
  const importInstructions = useAtomCommand(skillsEnvironment.importInstructions, {
    reportFailure: false,
  });
  const updateProjectSettings = useAtomCommand(skillsEnvironment.updateProjectSettings, {
    reportFailure: false,
  });
  const shared = params.projectPath !== undefined && params.mode === "shared";
  const projectPrivate = params.projectPath !== undefined && !shared;
  const profileNotice = snapshot === null ? null : sharedProfileNotice(snapshot.scope);
  const [sharedFile, setSharedFile] = useState<SkillInstructionFileName>("AGENTS.md");
  const file = shared ? sharedFile : undefined;
  const [documentState, setDocumentState] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState(false);
  const loadIdRef = useRef(0);
  const { environmentId } = params;

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    const result = await readInstructions({
      environmentId,
      input: { scope, ...(file === undefined ? {} : { file }) },
    });
    if (loadId !== loadIdRef.current) return;
    setDocumentState(
      result._tag === "Success"
        ? { status: "ready", document: result.value, loadId }
        : { status: "error", message: skillsFailureMessage(squashAtomCommandFailure(result)) },
    );
  }, [environmentId, file, readInstructions, scope]);

  useEffect(() => {
    void load();
    return () => {
      loadIdRef.current += 1;
    };
  }, [load]);

  const confirmDiscard = async () =>
    !dirty ||
    confirmSkillsAction({
      title: "Discard your edits?",
      message: "Your unsaved changes will be lost.",
      confirmLabel: "Discard",
      destructive: true,
    });

  const saveDocument = async (
    content: string,
    expectedRevision: string | null,
  ): Promise<SkillFileSaveOutcome> => {
    const result = await saveInstructions({
      environmentId,
      input: { scope, ...(file === undefined ? {} : { file }), content, expectedRevision },
    });
    if (result._tag === "Success") return { _tag: "saved", revision: result.value.revision };
    const error = squashAtomCommandFailure(result);
    return isSkillsRevisionConflict(error)
      ? { _tag: "conflict" }
      : { _tag: "failed", message: skillsFailureMessage(error) };
  };

  const importFile = async (source: SkillInstructionFile) => {
    const current = documentState.status === "ready" ? documentState.document : null;
    const replacing = snapshot?.instructions.canonicalExists === true || current?.exists === true;
    if (
      replacing &&
      !(await confirmSkillsAction({
        title: "Replace your instructions?",
        message: `The current text is overwritten with ${source.path}.`,
        confirmLabel: "Replace",
        destructive: true,
      }))
    ) {
      return;
    }
    if (!(await confirmDiscard())) return;
    setPending(true);
    const result = await runSkillsCommand(
      importInstructions({
        environmentId,
        input: {
          scope,
          sourceId: source.id,
          ...(replacing ? { expectedRevision: current?.revision ?? null } : {}),
        },
      }),
      "Could not import the instructions",
    );
    setPending(false);
    if (result !== null) {
      const loadId = ++loadIdRef.current;
      setDocumentState({ status: "ready", document: result, loadId });
    }
  };

  const changeMode = async (instructionMode: SkillProjectInstructionMode) => {
    if (params.projectPath === undefined) return;
    setPending(true);
    await runSkillsCommand(
      updateProjectSettings({
        environmentId,
        input: { projectPath: params.projectPath, instructionMode },
      }),
      "Could not change how instructions apply",
    );
    setPending(false);
  };

  const mode = snapshot?.instructions.mode ?? "inherit";
  const files = shared ? [] : (snapshot?.instructions.files ?? []);

  return (
    <SettingsScreen title="Instructions">
      <SkillsDiscardGuard dirty={dirty} saving={saving} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {shared ? (
          <>
            <SkillsWarning
              title="Edits files in the repository"
              detail={snapshot?.scope.projectRoot ?? params.projectPath ?? ""}
            />
            <SegmentedControl
              options={[
                { value: "AGENTS.md", label: "AGENTS.md" },
                { value: "CLAUDE.md", label: "CLAUDE.md" },
              ]}
              selected={sharedFile}
              onSelect={(value) => {
                if (value === sharedFile) return;
                void confirmDiscard().then((ok) => {
                  if (!ok) return;
                  setDocumentState({ status: "loading" });
                  setSharedFile(value);
                });
              }}
            />
          </>
        ) : null}

        {projectPrivate && profileNotice !== null ? (
          <SkillsWarning title="Inherited private settings" detail={profileNotice} />
        ) : null}
        {projectPrivate ? (
          <SettingsSection title="How your private instructions apply">
            {INSTRUCTION_MODES.map((option, index) => (
              <SettingsChoiceRow
                key={option.value}
                label={option.label}
                description={option.description}
                selected={option.value === mode}
                separated={index > 0}
                disabled={pending}
                onPress={() => {
                  if (option.value !== mode) void changeMode(option.value);
                }}
              />
            ))}
          </SettingsSection>
        ) : null}
        {projectPrivate ? <SkillsNote>{PRIVATE_PROJECT_SUPPORT_NOTICE}</SkillsNote> : null}

        <SkillsNote>
          {documentState.status === "ready"
            ? documentState.document.path
            : (snapshot?.instructions.canonicalPath ?? "")}
        </SkillsNote>
        {documentState.status === "loading" ? (
          <SkillsNote>Reading instructions…</SkillsNote>
        ) : documentState.status === "error" ? (
          <ErrorBanner message={documentState.message} />
        ) : (
          <SkillFileEditorSection
            key={documentState.loadId}
            label="Instructions"
            content={documentState.document.content}
            revision={documentState.document.revision}
            editable
            onSave={saveDocument}
            onDirtyChange={setDirty}
            onSavingChange={setSaving}
            onReload={() =>
              void confirmDiscard().then((ok) => {
                if (!ok) return;
                setDocumentState({ status: "loading" });
                void load();
              })
            }
          />
        )}

        {files.length > 0 ? (
          <SettingsSection title={projectPrivate ? "Repository files" : "Provider files"}>
            {files.map((candidate, index) => {
              const importable = candidate.exists && !candidate.ownedLink;
              return (
                <SkillsDetailRow
                  key={candidate.id}
                  title={candidate.providers.map(providerDisplayName).join(", ") || "Repository"}
                  detail={`${candidate.path}${
                    candidate.ownedLink ? " · Linked" : candidate.exists ? "" : " · Missing"
                  }`}
                  borderTop={index > 0}
                  {...(importable && !pending ? { onPress: () => void importFile(candidate) } : {})}
                />
              );
            })}
          </SettingsSection>
        ) : null}
        {files.some((candidate) => candidate.exists && !candidate.ownedLink) ? (
          <SkillsNote>Tap a file to import its text into these instructions.</SkillsNote>
        ) : null}

        {snapshot !== null && !projectPrivate && snapshot.instructions.links.length > 0 ? (
          <>
            <SettingsSection title={shared ? "Repository links" : "Provider links"}>
              <SkillLinkRows
                environmentId={environmentId}
                scope={scope}
                subject={{ type: "instructions" }}
                subjectLabel={shared ? "AGENTS.md" : "your instructions"}
                links={snapshot.instructions.links}
                providersFor={(targetId) => {
                  const status = snapshot.instructions.links.find(
                    (candidate) => candidate.targetId === targetId,
                  );
                  const providers =
                    snapshot.instructions.files.find((candidate) => candidate.path === status?.path)
                      ?.providers ?? [];
                  return providers.map(providerDisplayName).join(", ") || targetId;
                }}
              />
            </SettingsSection>
            <SkillsNote>
              {shared
                ? "Claude Code reads CLAUDE.md, not AGENTS.md. Linking turns CLAUDE.md into a symlink to AGENTS.md in the repository, so both read the same file. Nothing is linked until you ask."
                : "Link a provider's instruction file to these instructions so every provider reads the same text."}
            </SkillsNote>
          </>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
