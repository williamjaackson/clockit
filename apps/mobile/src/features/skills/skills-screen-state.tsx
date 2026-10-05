import { useAtomValue } from "@effect/atom-react";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { skillScope } from "@t3tools/client-runtime/state/skills";
import { useMemo } from "react";
import { Alert, Platform } from "react-native";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { skillsEnvironment } from "../../state/skills";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { selectionFromParams, type SkillsScopeParams } from "./skills-routes";

/** The scope a pushed Skills screen acts on, and that scope's snapshot. */
export function useSkillsScope(params: SkillsScopeParams) {
  const { environmentId, projectPath, mode } = params;
  const scope = useMemo(
    () => skillScope(selectionFromParams({ environmentId, projectPath, mode })),
    [environmentId, mode, projectPath],
  );
  const view = useAtomValue(skillsEnvironment.view({ environmentId, scope }));
  return { scope, view };
}

/**
 * Keeps an unsaved draft from being dropped by back gestures or buttons, and
 * holds the screen while a request it started is still running.
 */
export function SkillsDiscardGuard({
  dirty,
  saving,
  leavingRef,
}: {
  readonly dirty: boolean;
  readonly saving: boolean;
  /** Set when the screen navigates away on its own after finishing, so the guard lets it. */
  readonly leavingRef?: { readonly current: boolean };
}) {
  const navigation = useNavigation();
  const preventRemove = dirty || saving;
  usePreventRemove(preventRemove, ({ data }) => {
    if (leavingRef?.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) {
      Alert.alert("Still saving", "Wait for it to finish before leaving.");
      return;
    }
    Alert.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });
  return Platform.OS === "ios" ? (
    <NativeStackScreenOptions
      options={{
        headerBackVisible: false,
        gestureEnabled: !preventRemove,
        // The system back button starts its pop before the guard runs, so
        // a bar button dispatches instead.
        unstable_headerLeftItems: () => [
          withNativeGlassHeaderItem({
            type: "button",
            label: "",
            accessibilityLabel: "Back",
            icon: { type: "sfSymbol", name: "chevron.backward" },
            onPress: () => navigation.goBack(),
          }),
        ],
      }}
    />
  ) : null;
}
