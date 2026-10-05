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

/**
 * Creating, importing, or syncing a My skills entry leaves alone any agent
 * folder that already holds something of that name. Says so briefly; the
 * skill's own screen lists the paths.
 */
export function reportSkippedLinks(skippedLinks: ReadonlyArray<string> | undefined) {
  if (skippedLinks === undefined || skippedLinks.length === 0) return;
  Alert.alert(
    skippedLinks.length === 1
      ? "One agent folder already had a skill with this name"
      : `${skippedLinks.length} agent folders already had a skill with these names`,
    "T3 left them alone, so those agents keep their own copy. Open the skill to see where.",
  );
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
