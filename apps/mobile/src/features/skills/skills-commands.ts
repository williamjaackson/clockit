import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { skillsFailureMessage } from "@t3tools/client-runtime/state/skills";
import { Alert } from "react-native";

/** Runs a skills command and alerts on failure. Resolves to null when it failed. */
export async function runSkillsCommand<A, E>(
  run: Promise<AtomCommandResult<A, E>>,
  failureTitle: string,
): Promise<A | null> {
  const result = await run;
  if (result._tag === "Success") return result.value;
  if (!isAtomCommandInterrupted(result)) {
    Alert.alert(failureTitle, skillsFailureMessage(squashAtomCommandFailure(result)));
  }
  return null;
}

export function confirmSkillsAction(input: {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      input.title,
      input.message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: input.confirmLabel,
          style: input.destructive ? "destructive" : "default",
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
