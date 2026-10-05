import type { MenuAction } from "@react-native-menu/menu";
import type {
  EnvironmentId,
  ResolvedSkillScope,
  SkillEntry,
  SkillLinkStatus,
  SkillLinkSubject,
  SkillLinkTarget,
  SkillScope,
  SkillsSnapshot,
} from "@t3tools/contracts";
import {
  canResetSection,
  skillBulkEntries,
  skillOccupantNoun,
  skillProviderReach,
  skillProviderSwitches,
  skillReachLabel,
  skillRowStatus,
  skillToggle,
  type SkillProviderReach,
  type SkillProviderSwitch,
  type SkillSection,
} from "@t3tools/client-runtime/state/skills";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ErrorBanner } from "../../components/ErrorBanner";
import { MaterialListRow } from "../../components/MaterialListRow";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { runSkillsCommand } from "./skills-commands";

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

/** One icon per agent T3 can give skills to, dimmed for agents without the skill. */
export function SkillAgentIcons(props: { readonly reach: ReadonlyArray<SkillProviderReach> }) {
  if (props.reach.length === 0) return null;
  return (
    <View
      className="flex-row items-center gap-1.5"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {props.reach.map((item) => (
        <View key={item.provider} style={{ opacity: item.on ? 1 : 0.3 }}>
          <ProviderIcon provider={item.provider} size={14} />
        </View>
      ))}
    </View>
  );
}

/**
 * One skill in a list: the name, its purpose, and which agents have it. The
 * switch sits beside the pressable area, never inside it.
 */
export function SkillListRow(props: {
  readonly entry: SkillEntry;
  readonly snapshot: SkillsSnapshot;
  /** The value a switch request in flight asks for, if any. */
  readonly pendingEnabled: boolean | undefined;
  readonly borderTop?: boolean;
  readonly onPress: () => void;
  readonly onToggle: (enabled: boolean) => void;
}) {
  const { entry, snapshot } = props;
  const toggle = skillToggle(entry, snapshot.scope);
  const checked = props.pendingEnabled ?? toggle?.checked ?? false;
  const reach = skillProviderReach(entry, snapshot);
  const status = skillRowStatus(entry, snapshot.scope);
  const muted = toggle !== null && !checked;
  return (
    <View
      className={cn(
        "min-h-14 flex-row items-center gap-3 pr-4",
        props.borderTop && "border-t border-border-subtle",
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          entry.name,
          entry.description,
          `Agents: ${skillReachLabel(reach)}`,
          status,
        ]
          .filter(Boolean)
          .join(". ")}
        onPress={props.onPress}
        className="min-w-0 flex-1 gap-0.5 py-3 pl-4 active:opacity-70"
      >
        <Text className={cn("text-lg", muted ? "text-foreground-muted" : "text-foreground")}>
          {entry.name}
        </Text>
        {entry.description ? (
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {entry.description}
          </Text>
        ) : null}
        {reach.length > 0 || status !== null ? (
          <View className="flex-row items-center gap-2 pt-0.5">
            <SkillAgentIcons reach={reach} />
            {status !== null ? (
              <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
                {status}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Pressable>
      {toggle !== null ? (
        <ThemedSwitch
          accessibilityLabel={`Use ${entry.name}`}
          accessibilityHint={toggle.disabledReason ?? undefined}
          disabled={props.pendingEnabled !== undefined || toggle.disabledReason !== null}
          value={checked}
          onValueChange={props.onToggle}
        />
      ) : (
        <SymbolView name="chevron.right" size={14} tintColorClassName="accent-chevron" />
      )}
    </View>
  );
}

/** Bulk switches for one project section, from a native menu in its header. */
export function SkillSectionMenu(props: {
  readonly section: SkillSection;
  readonly scope: ResolvedSkillScope;
  readonly disabled: boolean;
  readonly onBulk: (enabled: boolean) => void;
  readonly onReset: () => void;
}) {
  const { section, scope } = props;
  const resettable = section.id === "inherited" || section.id === "repository";
  const actions: MenuAction[] = [
    {
      id: "on",
      title: "Turn all on",
      attributes: { disabled: skillBulkEntries(section.all, scope, true).length === 0 },
    },
    {
      id: "off",
      title: "Turn all off",
      attributes: { disabled: skillBulkEntries(section.all, scope, false).length === 0 },
    },
    ...(resettable
      ? [
          {
            id: "reset",
            title: "Reset to default",
            attributes: { disabled: !canResetSection(section) },
          },
        ]
      : []),
  ];
  return (
    <ControlPillMenu
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "on") props.onBulk(true);
        else if (nativeEvent.event === "off") props.onBulk(false);
        else if (nativeEvent.event === "reset") props.onReset();
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${section.title}`}
        disabled={props.disabled}
        className="px-2 py-1 active:opacity-70 disabled:opacity-40"
      >
        <SymbolView name="ellipsis.circle" size={18} tintColorClassName="accent-icon" />
      </Pressable>
    </ControlPillMenu>
  );
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

/**
 * "Use with" switches for one subject: a global library skill or the global
 * instructions in provider folders, or in shared mode a repository skill or
 * `AGENTS.md`. Each switch adds or removes T3's link at one target.
 */
export function SkillProviderSwitchRows(props: {
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
  readonly subject: SkillLinkSubject;
  readonly subjectLabel: string;
  readonly links: ReadonlyArray<SkillLinkStatus>;
  readonly linkTargets: ReadonlyArray<SkillLinkTarget>;
  /** Called for a provider that already has its own file, before offering to replace it. */
  readonly onImportText?: (row: SkillProviderSwitch) => void;
}) {
  const link = useAtomCommand(skillsEnvironment.link, { reportFailure: false });
  const unlink = useAtomCommand(skillsEnvironment.unlink, { reportFailure: false });
  const [pendingId, setPendingId] = useState<string | null>(null);

  const run = async (row: SkillProviderSwitch, on: boolean) => {
    if (pendingId !== null) return;
    const { status } = row;
    if (row.action === "replace") {
      const choice = await new Promise<"replace" | "import" | null>((resolve) => {
        Alert.alert(
          `Use ${props.subjectLabel} with ${row.label}?`,
          `${status.path} already has its own ${skillOccupantNoun(status)}. Replacing moves it to Recovery, where you can restore it.`,
          [
            ...(props.onImportText
              ? [{ text: "Import its text", onPress: () => resolve("import") }]
              : []),
            { text: "Replace", style: "destructive", onPress: () => resolve("replace") },
            { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
          ],
          { cancelable: true, onDismiss: () => resolve(null) },
        );
      });
      if (choice === "import") props.onImportText?.(row);
      if (choice !== "replace") return;
    }
    setPendingId(status.targetId);
    const targetIds: [string] = [status.targetId];
    await (on || row.action === "replace"
      ? runSkillsCommand(
          link({
            environmentId: props.environmentId,
            input: {
              scope: props.scope,
              subject: props.subject,
              targetIds,
              replace: row.action === "replace",
            },
          }),
          "Could not turn it on",
        )
      : runSkillsCommand(
          unlink({
            environmentId: props.environmentId,
            input: { scope: props.scope, subject: props.subject, targetIds },
          }),
          "Could not turn it off",
        ));
    setPendingId(null);
  };

  return skillProviderSwitches(props.links, props.linkTargets).map((row, index) => (
    <SkillsDetailRow
      key={row.status.targetId}
      title={row.label}
      detail={row.note ?? undefined}
      borderTop={index > 0}
      accessory={
        pendingId === row.status.targetId ? (
          <ActivityIndicator colorClassName="accent-icon" />
        ) : row.action === "replace" ? (
          <Pressable
            accessibilityRole="button"
            disabled={pendingId !== null}
            onPress={() => void run(row, true)}
            className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
          >
            <Text className="text-sm font-t3-medium text-foreground">Replace…</Text>
          </Pressable>
        ) : (
          <ThemedSwitch
            accessibilityLabel={`Use with ${row.label}`}
            disabled={pendingId !== null || row.action === null}
            value={row.on}
            onValueChange={(on) => void run(row, on)}
          />
        )
      }
    />
  ));
}

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
