import type {
  EnvironmentId,
  SkillLinkStatus,
  SkillLinkSubject,
  SkillLinkTarget,
  SkillScope,
} from "@t3tools/contracts";
import {
  skillOccupantNoun,
  skillProviderSwitches,
  type SkillProviderSwitch,
} from "@t3tools/client-runtime/state/skills";
import { useState, type ReactNode } from "react";

import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsGroup } from "../settings/SettingsGroup";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { confirmSkillsAction, runSkillsCommand } from "./skillsCommands";

/**
 * "Use with" switches for one subject: a global library skill or the global
 * instructions in provider folders, or in shared mode a repository skill or
 * `AGENTS.md` in the repository's own provider paths. Each switch adds or
 * removes T3's link at one target.
 */
export function SkillProviderSwitches(props: {
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
  readonly subject: SkillLinkSubject;
  readonly subjectLabel: string;
  readonly links: ReadonlyArray<SkillLinkStatus>;
  readonly linkTargets: ReadonlyArray<SkillLinkTarget>;
  /** Extra controls for a row, placed before its switch. */
  readonly renderExtra?: (row: SkillProviderSwitch) => ReactNode;
}) {
  const link = useAtomCommand(skillsEnvironment.link, { reportFailure: false });
  const unlink = useAtomCommand(skillsEnvironment.unlink, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const rows = skillProviderSwitches(props.links, props.linkTargets);
  const available = rows.filter((row) => row.action === "link");

  const run = async (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  };

  const turnOn = (targetIds: [string, ...string[]], replace: boolean) =>
    run(async () => {
      const result = await runSkillsCommand(
        link({
          environmentId: props.environmentId,
          input: { scope: props.scope, subject: props.subject, targetIds, replace },
        }),
        "Could not turn it on",
      );
      if (result !== null && result.recovery.length > 0) {
        toastManager.add({
          type: "success",
          title: "Moved the old copy to Recovery",
          description: result.recovery.map((entry) => entry.originalPath).join(", "),
        });
      }
    });

  const turnOff = (targetId: string) =>
    run(() =>
      runSkillsCommand(
        unlink({
          environmentId: props.environmentId,
          input: { scope: props.scope, subject: props.subject, targetIds: [targetId] },
        }),
        "Could not turn it off",
      ),
    );

  const replace = async (row: SkillProviderSwitch) => {
    const confirmed = await confirmSkillsAction(
      `Use ${props.subjectLabel} with ${row.label}?\n${row.status.path} already has its own ${skillOccupantNoun(row.status)}. T3 moves it to Recovery, where you can restore it, and puts ${props.subjectLabel} in its place.`,
      "destructive",
    );
    if (confirmed) await turnOn([row.status.targetId], true);
  };

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No providers on this environment read this.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <SettingsGroup>
        {rows.map((row) => (
          <div
            key={row.status.targetId}
            className="flex min-w-0 items-center gap-3 px-3 py-2.5 sm:px-4"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">{row.label}</span>
              {row.note !== null ? (
                <span className="break-words text-xs text-muted-foreground">{row.note}</span>
              ) : null}
            </div>
            {props.renderExtra?.(row)}
            {row.action === "replace" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => void replace(row)}
              >
                Replace…
              </Button>
            ) : (
              <Switch
                aria-label={`Use with ${row.label}`}
                checked={row.on}
                disabled={pending || row.action === null}
                onCheckedChange={(checked) =>
                  void (checked
                    ? turnOn([row.status.targetId], false)
                    : turnOff(row.status.targetId))
                }
              />
            )}
          </div>
        ))}
      </SettingsGroup>
      {available.length > 1 ? (
        <div>
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              void turnOn(
                available.map((row) => row.status.targetId) as [string, ...string[]],
                false,
              )
            }
          >
            Turn on for all
          </Button>
        </div>
      ) : null}
    </div>
  );
}
