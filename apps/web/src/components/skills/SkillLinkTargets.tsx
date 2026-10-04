import type {
  EnvironmentId,
  SkillLinkStatus,
  SkillLinkSubject,
  SkillLinkTarget,
  SkillPathKind,
} from "@t3tools/contracts";
import { providerDisplayName } from "@t3tools/client-runtime/state/skills";
import { useState } from "react";

import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { confirmSkillsAction, runSkillsCommand } from "./skillsCommands";

const OCCUPANT_LABEL: Record<SkillPathKind, string> = {
  directory: "folder",
  file: "file",
  symlink: "link",
};

/** Link state for one global library skill or the global instructions, per provider folder. */
export function SkillLinkTargets(props: {
  readonly environmentId: EnvironmentId;
  readonly subject: SkillLinkSubject;
  readonly subjectLabel: string;
  readonly links: ReadonlyArray<SkillLinkStatus>;
  readonly linkTargets: ReadonlyArray<SkillLinkTarget>;
}) {
  const link = useAtomCommand(skillsEnvironment.link, { reportFailure: false });
  const unlink = useAtomCommand(skillsEnvironment.unlink, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const available = props.links.filter((status) => status.state === "available");

  const providersFor = (targetId: string) => {
    const providers = props.linkTargets.find((target) => target.id === targetId)?.providers ?? [];
    return providers.length > 0 ? providers.map(providerDisplayName).join(", ") : targetId;
  };

  const run = async (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  };

  const linkTargets = (targetIds: [string, ...string[]], replace: boolean) =>
    run(async () => {
      const result = await runSkillsCommand(
        link({
          environmentId: props.environmentId,
          input: { subject: props.subject, targetIds, replace },
        }),
        "Could not link",
      );
      if (result !== null && result.recovery.length > 0) {
        toastManager.add({
          type: "success",
          title: "Linked",
          description: `Moved ${result.recovery.map((entry) => entry.originalPath).join(", ")} to Recovery.`,
        });
      }
    });

  const replaceTarget = async (status: SkillLinkStatus) => {
    const occupant = status.occupant === undefined ? "item" : OCCUPANT_LABEL[status.occupant];
    const confirmed = await confirmSkillsAction(
      `Replace the ${occupant} at ${status.path}?\nIt moves to Recovery, where you can restore it, and ${props.subjectLabel} is linked in its place.`,
      "destructive",
    );
    if (confirmed) await linkTargets([status.targetId], true);
  };

  if (props.links.length === 0) {
    return <p className="text-sm text-muted-foreground">No provider folders to link to.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-border rounded-lg border">
        {props.links.map((status) => (
          <li key={status.targetId} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{providersFor(status.targetId)}</span>
              <span className="break-all text-xs text-muted-foreground">{status.path}</span>
            </div>
            {status.state === "linked" ? (
              <>
                <Badge variant="success">Linked</Badge>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    void run(() =>
                      runSkillsCommand(
                        unlink({
                          environmentId: props.environmentId,
                          input: { subject: props.subject, targetIds: [status.targetId] },
                        }),
                        "Could not unlink",
                      ),
                    )
                  }
                >
                  Unlink
                </Button>
              </>
            ) : status.state === "available" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => void linkTargets([status.targetId], false)}
              >
                Link
              </Button>
            ) : (
              <>
                <Badge variant="warning">
                  {status.occupant === undefined
                    ? "In use"
                    : `Has a ${OCCUPANT_LABEL[status.occupant]}`}
                </Badge>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void replaceTarget(status)}
                >
                  Replace…
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {available.length > 1 ? (
        <div>
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() =>
              void linkTargets(
                available.map((status) => status.targetId) as [string, ...string[]],
                false,
              )
            }
          >
            Link to all available
          </Button>
        </div>
      ) : null}
    </div>
  );
}
