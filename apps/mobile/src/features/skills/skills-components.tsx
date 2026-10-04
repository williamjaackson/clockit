import type { MenuAction } from "@react-native-menu/menu";
import type {
  EnvironmentId,
  SkillEntry,
  SkillLinkStatus,
  SkillLinkSubject,
  SkillOwnership,
  SkillPathKind,
  SkillScope,
} from "@t3tools/contracts";
import {
  INHERITED_LINK_NOTE,
  isUnlinkedLibrarySkill,
  providerDisplayName,
  skillLinkAction,
} from "@t3tools/client-runtime/state/skills";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ErrorBanner } from "../../components/ErrorBanner";
import { MaterialListRow } from "../../components/MaterialListRow";
import { cn } from "../../lib/cn";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { confirmSkillsAction, runSkillsCommand } from "./skills-commands";

/** A labeled row that opens a native menu of choices. */
export function SkillsSelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly borderTop?: boolean;
}) {
  const className = cn(
    "min-h-14 flex-row items-center gap-3 px-4 py-3",
    props.borderTop && "border-t border-border-subtle",
  );
  const value = (
    <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted" numberOfLines={1}>
      {props.value}
    </Text>
  );
  if (props.actions.length <= 1) {
    return (
      <View className={className}>
        <Text className="text-lg text-foreground">{props.label}</Text>
        {value}
      </View>
    );
  }
  return (
    <ControlPillMenu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        className={cn(className, "active:opacity-70")}
      >
        <Text className="text-lg text-foreground">{props.label}</Text>
        {value}
        <SymbolView name="chevron.down" size={14} tintColorClassName="accent-chevron" />
      </Pressable>
    </ControlPillMenu>
  );
}

const OWNERSHIP_LABEL: Record<SkillOwnership, string> = {
  managed: "Library",
  unmanaged: "Not in library",
  plugin: "Plugin",
  system: "Built-in",
};

export function skillEntrySummary(entry: SkillEntry): string {
  return [
    OWNERSHIP_LABEL[entry.ownership],
    entry.enabled ? null : "Disabled",
    isUnlinkedLibrarySkill(entry) ? "Not linked" : null,
    entry.conflicts.length > 0 ? "Same name" : null,
    entry.providers.map(providerDisplayName).join(", ") || null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A tappable two-line row: title, then muted detail. */
export function SkillsDetailRow(props: {
  readonly title: string;
  readonly detail?: string;
  readonly muted?: boolean;
  readonly borderTop?: boolean;
  readonly onPress?: () => void;
  readonly accessory?: ReactNode;
}) {
  if (Platform.OS === "android") {
    return (
      <MaterialListRow
        className="bg-grouped-card"
        title={props.title}
        titleClassName={props.muted ? "text-foreground-muted" : undefined}
        subtitle={props.detail}
        trailing={props.accessory}
        onPress={props.onPress}
      />
    );
  }
  const content = (
    <View
      className={cn(
        "min-h-14 flex-row items-center gap-3 px-4 py-3",
        props.borderTop && "border-t border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text
          className={cn("text-lg", props.muted ? "text-foreground-muted" : "text-foreground")}
          numberOfLines={1}
        >
          {props.title}
        </Text>
        {props.detail ? (
          <Text className="text-sm text-foreground-muted" numberOfLines={2}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.accessory}
      {props.onPress ? (
        <SymbolView name="chevron.right" size={14} tintColorClassName="accent-chevron" />
      ) : null}
    </View>
  );
  return props.onPress ? (
    <Pressable accessibilityRole="button" onPress={props.onPress} className="active:opacity-70">
      {content}
    </Pressable>
  ) : (
    content
  );
}

/** Plain explanatory text placed between sections. */
export function SkillsNote(props: { readonly children: ReactNode }) {
  return (
    <Text selectable className="px-2 text-sm leading-normal text-foreground-muted">
      {props.children}
    </Text>
  );
}

/** A prominent notice for actions that touch files other people or tools read. */
export function SkillsWarning(props: { readonly title: string; readonly detail: string }) {
  return (
    <View className="gap-1 rounded-2xl border border-warning-border bg-warning px-3.5 py-3">
      <Text className="font-t3-medium text-sm text-warning-foreground">{props.title}</Text>
      <Text selectable className="text-sm text-warning-foreground">
        {props.detail}
      </Text>
    </View>
  );
}

const OCCUPANT_LABEL: Record<SkillPathKind, string> = {
  directory: "folder",
  file: "file",
  symlink: "link",
};

/**
 * Link state per target for one subject: a global library skill or the global
 * instructions, or in shared mode a repository skill or `AGENTS.md`.
 */
export function SkillLinkRows(props: {
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
  readonly subject: SkillLinkSubject;
  readonly subjectLabel: string;
  readonly links: ReadonlyArray<SkillLinkStatus>;
  readonly providersFor: (targetId: string) => string;
}) {
  const link = useAtomCommand(skillsEnvironment.link, { reportFailure: false });
  const unlink = useAtomCommand(skillsEnvironment.unlink, { reportFailure: false });
  const [pendingId, setPendingId] = useState<string | null>(null);

  const run = async (status: SkillLinkStatus) => {
    if (pendingId !== null) return;
    if (status.state === "occupied") {
      const occupant = status.occupant === undefined ? "item" : OCCUPANT_LABEL[status.occupant];
      const confirmed = await confirmSkillsAction({
        title: `Replace the ${occupant}?`,
        message: `${status.path} moves to Recovery, where you can restore it, and ${props.subjectLabel} is linked in its place.`,
        confirmLabel: "Replace",
        destructive: true,
      });
      if (!confirmed) return;
    }
    setPendingId(status.targetId);
    const targetIds: [string] = [status.targetId];
    await (status.state === "linked"
      ? runSkillsCommand(
          unlink({
            environmentId: props.environmentId,
            input: { scope: props.scope, subject: props.subject, targetIds },
          }),
          "Could not unlink",
        )
      : runSkillsCommand(
          link({
            environmentId: props.environmentId,
            input: {
              scope: props.scope,
              subject: props.subject,
              targetIds,
              replace: status.state === "occupied",
            },
          }),
          "Could not link",
        ));
    setPendingId(null);
  };

  return props.links.map((status, index) => {
    const action = skillLinkAction(status);
    return (
      <SkillsDetailRow
        key={status.targetId}
        title={props.providersFor(status.targetId)}
        detail={status.path}
        borderTop={index > 0}
        accessory={
          action === null ? (
            <Text accessibilityHint={INHERITED_LINK_NOTE} className="text-sm text-foreground-muted">
              Linked via parent
            </Text>
          ) : pendingId === status.targetId ? (
            <ActivityIndicator colorClassName="accent-icon" />
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={pendingId !== null}
              onPress={() => void run(status)}
              className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
            >
              <Text className="text-sm font-t3-medium text-foreground">
                {LINK_ACTION_LABEL[action]}
              </Text>
            </Pressable>
          )
        }
      />
    );
  });
}

const LINK_ACTION_LABEL = { link: "Link", unlink: "Unlink", replace: "Replace" } as const;

export type SkillFileSaveOutcome =
  | { readonly _tag: "saved"; readonly revision: string | null }
  | { readonly _tag: "conflict" }
  | { readonly _tag: "failed"; readonly message: string };

/**
 * Edits one file against the revision it was read at. A save that hits a newer
 * revision keeps the draft and waits for an explicit reload.
 */
export function SkillFileEditorSection(props: {
  readonly label: string;
  readonly content: string;
  readonly revision: string | null;
  readonly editable: boolean;
  readonly readOnlyReason?: string;
  readonly onSave: (
    content: string,
    expectedRevision: string | null,
  ) => Promise<SkillFileSaveOutcome>;
  readonly onReload: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onSavingChange?: (saving: boolean) => void;
}) {
  const { onDirtyChange, onSavingChange } = props;
  const [base, setBase] = useState({ content: props.content, revision: props.revision });
  const [draft, setDraft] = useState(props.content);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== base.content;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onSavingChange?.(saving), [saving, onSavingChange]);

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    const content = draft;
    const outcome = await props.onSave(content, base.revision);
    setSaving(false);
    if (outcome._tag === "saved") {
      setBase({ content, revision: outcome.revision });
      setConflict(false);
    } else if (outcome._tag === "conflict") {
      setConflict(true);
    } else {
      setError(outcome.message);
    }
  };

  return (
    <View className="gap-3">
      {conflict ? (
        <ErrorBanner message="This file changed since you opened it. Your edits are still here and were not saved. Copy anything you want to keep, then reload." />
      ) : null}
      {error !== null ? <ErrorBanner message={error} /> : null}
      <View className="overflow-hidden rounded-[24px] bg-grouped-card px-4 py-3">
        <TextInput
          accessibilityLabel={props.label}
          value={draft}
          onChangeText={setDraft}
          editable={props.editable && !saving}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          textAlignVertical="top"
          className="min-h-64 font-mono text-sm text-foreground"
        />
      </View>
      <SkillsNote>
        {props.editable
          ? dirty
            ? "Unsaved changes"
            : base.revision === null
              ? "New file"
              : "Saved"
          : (props.readOnlyReason ?? "Read only")}
      </SkillsNote>
      {props.editable ? (
        <View className="overflow-hidden rounded-[24px] bg-grouped-card">
          {conflict ? (
            <SettingsActionRow
              icon="arrow.clockwise"
              label="Reload file"
              onPress={props.onReload}
            />
          ) : (
            <SettingsActionRow
              icon="checkmark"
              label="Save"
              disabled={!dirty || saving}
              loading={saving}
              onPress={() => void save()}
            />
          )}
          <SettingsActionRow
            icon="arrow.uturn.backward"
            label="Revert"
            disabled={!dirty || saving}
            onPress={() => setDraft(base.content)}
          />
        </View>
      ) : null}
    </View>
  );
}
