import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { SkillsReleaseResult } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  findScopeLibraryEntry,
  invocationNameClashes,
  isAbsoluteSkillPath,
  newSkillContent,
  scopeLibraryNames,
  skillAdoptionPlan,
  skillInvocationName,
  skillsFailureMessage,
  validateNewSkillName,
} from "@t3tools/client-runtime/state/skills";
import { useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { reportSkippedLinks, runSkillsCommand } from "./skills-commands";
import { SkillsDetailRow, SkillsNote } from "./skills-components";
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
    reportSkippedLinks(result.skippedLinks);
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
            : params.projectPath === undefined
              ? "Adds a skill to My skills. Every agent you've turned on gets it. Agents read the description to decide when to load it."
              : "Agents read the description to decide when to load the skill."}
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
  const [adopt, setAdopt] = useState(true);
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

  const snapshot = view.snapshot;
  const { scope: resolvedScope } = snapshot;
  const canAdopt = resolvedScope.kind === "global" && entry.ownership === "unmanaged";
  const isPrivate = resolvedScope.kind === "project" && resolvedScope.mode !== "shared";
  const adopting = canAdopt && adopt;
  const nameError = validateNewSkillName(name, scopeLibraryNames(snapshot));
  const invocation = skillInvocationName(entry);
  const plan = skillAdoptionPlan(entry);
  const clashes = invocationNameClashes(snapshot, entry).length;
  const fromMySkills = entry.id.startsWith("inherited:");

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
      "Could not bring the skill in",
    );
    setPending(false);
    if (result === null) return;
    reportSkippedLinks(result.skippedLinks);
    leavingRef.current = true;
    const imported = findScopeLibraryEntry(result.snapshot, result.name);
    if (imported) navigation.replace("SettingsSkill", { ...params, entryId: imported.id });
    else navigation.goBack();
  };

  const intro = canAdopt
    ? "T3 keeps the skill in My skills, where you edit it and choose who uses it. Every agent you've turned on gets it."
    : isPrivate
      ? `Makes a private copy for this project. Claude and Codex agents you run in T3 here use it instead of the ${fromMySkills ? "My skills" : "repository"} version. The original stays as it is.`
      : "Copies the whole folder, scripts included, into .agents/skills in the repository. The original stays where it is.";
  const nameNote =
    nameError ??
    (isPrivate
      ? `Agents load it as ${invocation}, the name in its SKILL.md, so the copy replaces the original whatever the folder is called.`
      : !adopting
        ? `Agents load it as ${invocation}, the name in its SKILL.md${clashes > 0 || !canAdopt ? ", so they'll see two skills by that name" : ""}. To tell them apart, change the name in the copy's SKILL.md.`
        : null);

  return (
    <SettingsScreen
      title={canAdopt ? "Manage in T3" : isPrivate ? "Customize" : `Copy ${entry.name}`}
    >
      <SkillsDiscardGuard dirty={false} saving={pending} leavingRef={leavingRef} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SkillsNote>{intro}</SkillsNote>
        <SettingsSection>
          <FormField label="Folder name" value={name} onChange={setName} />
          {canAdopt ? (
            <SettingsSwitchRow
              icon="tray.and.arrow.up"
              label="Move it into T3"
              subtitle={
                adopt
                  ? plan.sourceStays === null
                    ? "Agents keep using it, now from T3's copy. The original moves to Recovery, where you can restore it."
                    : "Agents keep using it, now from T3's copy. Its original folder stays where it is, outside T3."
                  : "Copy only. The original stays where it is and T3 doesn't manage it. Switching T3's copy off leaves the original on."
              }
              value={adopt}
              onValueChange={setAdopt}
            />
          ) : null}
        </SettingsSection>
        {nameNote !== null ? <SkillsNote>{nameNote}</SkillsNote> : null}
        {adopting ? (
          <SettingsSection title="Details">
            {[
              ...plan.moved.map((path) => ({
                path,
                label: plan.sourceStays === null ? "Moves to Recovery" : "Now points at T3",
              })),
              ...plan.kept.map((path) => ({ path, label: "Keeps working" })),
              ...(plan.sourceStays === null
                ? []
                : [{ path: plan.sourceStays, label: "Stays as it is" }]),
            ].map((row, index) => (
              <SkillsDetailRow
                key={`${row.label}:${row.path}`}
                title={row.label}
                detail={row.path}
                borderTop={index > 0}
              />
            ))}
          </SettingsSection>
        ) : null}
        <SettingsSection>
          <SettingsActionRow
            icon="tray.and.arrow.up"
            label={adopting ? "Move into T3" : isPrivate ? "Customize" : "Copy"}
            disabled={nameError !== null || pending}
            loading={pending}
            onPress={() => void submit()}
          />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}

type ReleasePlan =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly destination: string | null }
  | { readonly status: "error"; readonly destination: string | null; readonly message: string }
  | {
      readonly status: "ready";
      readonly destination: string | null;
      readonly result: SkillsReleaseResult;
    };

/**
 * Stops managing a My skills entry. A dry run shows where the folder goes
 * and which agent folders follow it; confirming carries out that plan.
 */
export function SkillReleaseRouteScreen({
  route,
}: StaticScreenProps<SkillsRoutes["SettingsSkillRelease"]>) {
  const params = route.params;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<SkillsRoutes>>();
  const { view } = useSkillsScope(params);
  const preview = useAtomCommand(skillsEnvironment.releasePreview, { reportFailure: false });
  const release = useAtomCommand(skillsEnvironment.release, { reportFailure: false });
  const leavingRef = useRef(false);
  const entry = view.snapshot?.entries.find((candidate) => candidate.id === params.entryId) ?? null;
  // Fixed when the screen opens, so a release that lands doesn't flip the form.
  const [enabled] = useState(entry?.enabled ?? false);
  const [name] = useState(entry?.name ?? null);
  const [choosing, setChoosing] = useState(!enabled);
  const [destination, setDestination] = useState("");
  const [plan, setPlan] = useState<ReleasePlan>(
    enabled ? { status: "loading", destination: null } : { status: "idle" },
  );
  const [pending, setPending] = useState(false);
  const requestRef = useRef(0);
  const { environmentId } = params;

  const runPreview = async (target: string | null) => {
    if (name === null) return;
    const requestId = ++requestRef.current;
    setPlan({ status: "loading", destination: target });
    const result = await preview({
      environmentId,
      input: { name, ...(target === null ? {} : { destination: target }) },
    });
    if (requestId !== requestRef.current) return;
    setPlan(
      result._tag === "Success"
        ? { status: "ready", destination: target, result: result.value }
        : {
            status: "error",
            destination: target,
            message: skillsFailureMessage(squashAtomCommandFailure(result)),
          },
    );
  };

  useEffect(() => {
    if (!enabled || name === null) return;
    const requestId = ++requestRef.current;
    void preview({ environmentId, input: { name } }).then((result) => {
      if (requestId !== requestRef.current) return;
      setPlan(
        result._tag === "Success"
          ? { status: "ready", destination: null, result: result.value }
          : {
              status: "error",
              destination: null,
              message: skillsFailureMessage(squashAtomCommandFailure(result)),
            },
      );
    });
    return () => {
      requestRef.current += 1;
    };
  }, [enabled, environmentId, name, preview]);

  if (name === null) {
    return (
      <SettingsScreen title="Stop managing">
        <ScrollView contentContainerClassName="gap-5 px-5 pt-4">
          <EmptyState title="Skill not found" detail="Go back and refresh the list." />
        </ScrollView>
      </SettingsScreen>
    );
  }

  const chosen = choosing ? destination.trim() : "";
  const chosenError =
    choosing && chosen.length > 0 && !isAbsoluteSkillPath(chosen)
      ? "Enter a full path, such as /Users/me/skills/name."
      : null;
  const planFor = choosing ? (chosen.length > 0 ? chosen : undefined) : null;
  const planMatches =
    plan.status === "ready" && planFor !== undefined && plan.destination === planFor;

  const confirm = async () => {
    if (plan.status !== "ready" || !planMatches || pending) return;
    setPending(true);
    const result = await runSkillsCommand(
      release({
        environmentId,
        input: { name, ...(plan.destination === null ? {} : { destination: plan.destination }) },
      }),
      `Could not stop managing ${name}`,
    );
    setPending(false);
    if (result === null) return;
    leavingRef.current = true;
    // The skill's own screen no longer has anything to show.
    navigation.pop(2);
  };

  return (
    <SettingsScreen title="Stop managing">
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
          {enabled
            ? `${name} moves out of T3 with your latest edits, and the agents that use it now keep it. You can manage it in T3 again later.`
            : `${name} moves out of T3 with your latest edits. It's off, so it goes to a folder no agent reads and stays off there.`}
        </SkillsNote>
        {plan.status === "loading" ? (
          <SkillsNote>Checking where it goes…</SkillsNote>
        ) : plan.status === "error" ? (
          <ErrorBanner message={plan.message} />
        ) : plan.status === "ready" ? (
          <SettingsSection title="Plan">
            <SkillsDetailRow title="Moves to" detail={plan.result.destination} />
            {plan.result.relinked.map((path) => (
              <SkillsDetailRow key={path} title="Now points there" detail={path} borderTop />
            ))}
          </SettingsSection>
        ) : null}

        {choosing ? (
          <View className="gap-2">
            <SettingsSection>
              <FormField
                label="Move it to"
                value={destination}
                onChange={setDestination}
                placeholder={`/Users/me/skills/${name}`}
              />
              <SettingsActionRow
                icon="magnifyingglass"
                label="Check this folder"
                disabled={chosen.length === 0 || chosenError !== null || plan.status === "loading"}
                onPress={() => void runPreview(chosen)}
              />
              {enabled ? (
                <SettingsActionRow
                  icon="arrow.uturn.backward"
                  label="Use the default folder"
                  onPress={() => {
                    setChoosing(false);
                    setDestination("");
                    void runPreview(null);
                  }}
                />
              ) : null}
            </SettingsSection>
            <SkillsNote>
              {chosenError ??
                (enabled
                  ? "A new folder T3 creates. Agent folders that use the skill will point there."
                  : "A new folder T3 creates, outside every agent's skill folder.")}
            </SkillsNote>
          </View>
        ) : (
          <SettingsSection>
            <SettingsActionRow
              icon="folder"
              label="Choose another folder"
              onPress={() => setChoosing(true)}
            />
          </SettingsSection>
        )}

        <SettingsSection>
          <SettingsActionRow
            icon="arrow.up.right.circle"
            label="Stop managing"
            tone="danger"
            disabled={!planMatches || pending}
            loading={pending}
            onPress={() => void confirm()}
          />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
