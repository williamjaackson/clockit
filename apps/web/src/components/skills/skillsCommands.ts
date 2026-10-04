import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { skillsFailureMessage } from "@t3tools/client-runtime/state/skills";

import { requestConfirmDialog } from "../../confirmDialog";
import { toastManager } from "../ui/toast";

/** Runs a skills command, toasting failures. Resolves to null when it failed. */
export async function runSkillsCommand<A, E>(
  run: Promise<AtomCommandResult<A, E>>,
  failureTitle: string,
): Promise<A | null> {
  const result = await run;
  if (result._tag === "Success") return result.value;
  if (!isAtomCommandInterrupted(result)) {
    toastManager.add({
      type: "error",
      title: failureTitle,
      description: skillsFailureMessage(squashAtomCommandFailure(result)),
    });
  }
  return null;
}

/**
 * Creating, importing, or syncing a My skills entry leaves alone any agent
 * folder that already holds something of that name. Says so briefly; the
 * skill's own page lists the paths.
 */
export function reportSkippedLinks(skippedLinks: ReadonlyArray<string> | undefined) {
  if (skippedLinks === undefined || skippedLinks.length === 0) return;
  toastManager.add({
    type: "warning",
    title:
      skippedLinks.length === 1
        ? "One agent folder already had a skill with this name"
        : `${skippedLinks.length} agent folders already had a skill with these names`,
    description:
      "T3 left them alone, so those agents keep their own copy. Open the skill to see where.",
  });
}

export async function confirmSkillsAction(
  message: string,
  variant: "default" | "destructive" = "default",
): Promise<boolean> {
  return (await requestConfirmDialog(message, { variant })) ?? window.confirm(message);
}
