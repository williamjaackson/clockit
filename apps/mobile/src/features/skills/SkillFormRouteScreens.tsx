import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  findScopeLibraryEntry,
  newSkillContent,
  scopeLibraryNames,
  validateNewSkillName,
} from "@t3tools/client-runtime/state/skills";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { runSkillsCommand } from "./skills-commands";
import { SkillsNote } from "./skills-components";
import type { SkillsRoutes } from "./skills-routes";
import { SkillsDiscardGuard, useSkillsScope } from "./skills-screen-state";

function FormField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly multiline?: boolean;
  readonly borderTop?: boolean;
}) {
  return (
    <View
      className={
        props.borderTop ? "gap-2 border-t border-border-subtle px-4 py-3" : "gap-2 px-4 py-3"
      }
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColorClassName="accent-foreground-muted"
        autoCapitalize="none"
        autoCorrect={props.multiline === true}
        multiline={props.multiline}
        textAlignVertical={props.multiline ? "top" : "center"}
        className={
          props.multiline
            ? "min-h-20 font-sans text-base text-foreground"
            : "min-h-8 font-sans text-base text-foreground"
        }
      />
    </View>
  );
}

export function SkillNewRouteScreen({
  route,
}: StaticScreenProps<SkillsRoutes["SettingsSkillNew"]>) {
  const params = route.params;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<SkillsRoutes>>();
  const { scope, view } = useSkillsScope(params);
  const save = useAtomCommand(skillsEnvironment.save, { reportFailure: false });
  const leavingRef = useRef(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const nameError = validateNewSkillName(
    name,
    view.snapshot === null ? [] : scopeLibraryNames(view.snapshot),
  );
  const canCreate = nameError === null && description.trim().length > 0 && !pending;

  const create = async () => {
    if (!canCreate) return;
    setPending(true);
    const trimmed = name.trim();
    const result = await runSkillsCommand(
      save({
        environmentId: params.environmentId,
        input: {
          scope,
          skill: { name: trimmed },
          content: newSkillContent({ name: trimmed, description }),
          expectedRevision: null,
        },
      }),
      "Could not create the skill",
    );
    setPending(false);
    if (result === null) return;
    // The guard below kept this screen in place, so it still belongs to `params`.
    leavingRef.current = true;
    const created = findScopeLibraryEntry(result.snapshot, trimmed);
    if (created) navigation.replace("SettingsSkill", { ...params, entryId: created.id });
    else navigation.goBack();
  };

  return (
    <SettingsScreen title="New skill">
      <SkillsDiscardGuard
        dirty={name.trim().length > 0 || description.trim().length > 0}
        saving={pending}
        leavingRef={leavingRef}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection>
          <FormField
            label="Name"
            value={name}
            onChange={setName}
            placeholder="review-pull-requests"
          />
          <FormField
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="When agents should use this skill"
            multiline
            borderTop
          />
        </SettingsSection>
        <SkillsNote>
          {name.trim().length > 0 && nameError !== null
            ? nameError
            : `Agents read the description to decide when to load the skill. The skill is created in ${view.snapshot?.scope.libraryPath ?? "this library"}.`}
        </SkillsNote>
        <SettingsSection>
          <SettingsActionRow
            icon="plus"
            label="Create skill"
            disabled={!canCreate}
            loading={pending}
            onPress={() => void create()}
          />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}

export function SkillImportRouteScreen({
  route,
}: StaticScreenProps<SkillsRoutes["SettingsSkillImport"]>) {
  const params = route.params;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<SkillsRoutes>>();
  const { scope, view } = useSkillsScope(params);
  const importSkill = useAtomCommand(skillsEnvironment.import, { reportFailure: false });
  const leavingRef = useRef(false);
  const entry = view.snapshot?.entries.find((candidate) => candidate.id === params.entryId) ?? null;
  const [name, setName] = useState(entry?.name ?? "");
  const [adopt, setAdopt] = useState(false);
  const [pending, setPending] = useState(false);

  if (entry === null || view.snapshot === null) {
    return (
      <SettingsScreen title="Import">
        <ScrollView contentContainerClassName="gap-5 px-5 pt-4">
          <EmptyState title="Skill not found" detail="Go back and refresh the list." />
        </ScrollView>
      </SettingsScreen>
    );
  }

  const canAdopt = view.snapshot.scope.kind === "global" && entry.ownership === "unmanaged";
  const adopting = canAdopt && adopt;
  const nameError = validateNewSkillName(
    name,
    view.snapshot === null ? [] : scopeLibraryNames(view.snapshot),
  );
  const keepsDuplicate = !adopting && name.trim().toLowerCase() === entry.name.toLowerCase();

  const submit = async () => {
    if (nameError !== null || pending) return;
    setPending(true);
    const trimmed = name.trim();
    const result = await runSkillsCommand(
      importSkill({
        environmentId: params.environmentId,
        input: {
          scope,
          entryId: entry.id,
          ...(trimmed === entry.name ? {} : { name: trimmed }),
          ...(adopting ? { adoptOriginal: true } : {}),
        },
      }),
      "Could not import the skill",
    );
    setPending(false);
    if (result === null) return;
    leavingRef.current = true;
    const imported = findScopeLibraryEntry(result.snapshot, result.name);
    if (imported) navigation.replace("SettingsSkill", { ...params, entryId: imported.id });
    else navigation.goBack();
  };

  return (
    <SettingsScreen title={`Import ${entry.name}`}>
      <SkillsDiscardGuard dirty={false} saving={pending} leavingRef={leavingRef} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SkillsNote>
          Copies the whole folder, including scripts and other files, into{" "}
          {view.snapshot.scope.libraryPath}.
        </SkillsNote>
        <SettingsSection>
          <FormField label="Name in library" value={name} onChange={setName} />
          {canAdopt ? (
            <SettingsSwitchRow
              icon="link"
              label="Adopt the original and link it"
              subtitle={`Moves ${entry.path} to Recovery and puts a link to the library copy in its place.`}
              value={adopt}
              onValueChange={setAdopt}
            />
          ) : null}
        </SettingsSection>
        {nameError !== null ? (
          <SkillsNote>{nameError}</SkillsNote>
        ) : keepsDuplicate ? (
          <SkillsNote>
            The original stays where it is, so providers will find two skills named {entry.name}.
            Which one they load is up to each provider. Choose a new name to keep them apart.
          </SkillsNote>
        ) : null}
        <SettingsSection>
          <SettingsActionRow
            icon="tray.and.arrow.up"
            label={adopting ? "Import and adopt" : "Import copy"}
            disabled={nameError !== null || pending}
            loading={pending}
            onPress={() => void submit()}
          />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
