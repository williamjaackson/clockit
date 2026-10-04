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

export async function confirmSkillsAction(
  message: string,
  variant: "default" | "destructive" = "default",
): Promise<boolean> {
  return (await requestConfirmDialog(message, { variant })) ?? window.confirm(message);
}
