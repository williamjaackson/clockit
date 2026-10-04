import type {
  EnvironmentId,
  SkillRecoveryEntry,
  SkillScope,
  SkillsSnapshot,
} from "@t3tools/contracts";
import { providerDisplayName } from "@t3tools/client-runtime/state/skills";
import { useState } from "react";

import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { confirmSkillsAction, runSkillsCommand } from "./skillsCommands";

const KIND_LABEL: Record<SkillRecoveryEntry["kind"], string> = {
  archivedSkill: "Archived skill",
  replacedOriginal: "Replaced by a link",
};

export function SkillsRecovery(props: {
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
  readonly snapshot: SkillsSnapshot;
}) {
  const restore = useAtomCommand(skillsEnvironment.restore, { reportFailure: false });
  const deleteRecovery = useAtomCommand(skillsEnvironment.deleteRecovery, {
    reportFailure: false,
  });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { environmentId, scope } = props;

  const restoreEntry = async (entry: SkillRecoveryEntry) => {
    setPendingId(entry.id);
    const result = await runSkillsCommand(
      restore({ environmentId, input: { scope, recoveryId: entry.id } }),
      `Could not restore ${entry.name}`,
    );
    setPendingId(null);
    if (result === null) return;
    toastManager.add({
      type: result.skippedLinks.length > 0 ? "warning" : "success",
      title: `Restored ${entry.name}`,
      description:
        result.skippedLinks.length > 0
          ? `Some links were not restored because something else is at ${result.skippedLinks.join(", ")}.`
          : result.restoredPath,
    });
  };

  const deleteEntry = async (entry: SkillRecoveryEntry) => {
    if (
      !(await confirmSkillsAction(
        `Delete ${entry.name} permanently?\nIt can't be restored afterwards.`,
        "destructive",
      ))
    ) {
      return;
    }
    setPendingId(entry.id);
    await runSkillsCommand(
      deleteRecovery({ environmentId, input: { scope, recoveryId: entry.id } }),
      `Could not delete ${entry.name}`,
    );
    setPendingId(null);
  };

  if (props.snapshot.recovery.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Archived skills and files that T3 moved aside to make room for a link show up here.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border">
      {props.snapshot.recovery.map((entry) => (
        <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{entry.name}</span>
              <Badge variant="outline" size="sm">
                {KIND_LABEL[entry.kind]}
              </Badge>
            </div>
            <span className="break-all text-xs text-muted-foreground">
              From {entry.originalPath} · {new Date(entry.createdAt).toLocaleString()}
            </span>
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={pendingId !== null}
            onClick={() => void restoreEntry(entry)}
          >
            Restore
          </Button>
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={pendingId !== null}
            onClick={() => void deleteEntry(entry)}
          >
            Delete
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Where T3 looks for each provider's skills on this environment, and what it can't manage. */
export function SkillsProviders(props: { readonly snapshot: SkillsSnapshot }) {
  if (props.snapshot.providers.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Providers</h3>
      <ul className="flex flex-col gap-3">
        {props.snapshot.providers.map((provider) => (
          <li key={provider.provider} className="flex min-w-0 flex-col gap-0.5 text-xs">
            <span className="text-sm text-foreground">
              {providerDisplayName(provider.provider)}
              {provider.scanned ? null : (
                <span className="text-muted-foreground"> · reported by the provider</span>
              )}
            </span>
            {provider.globalRoots.map((root) => (
              <span key={root} className="break-all text-muted-foreground">
                {root}
              </span>
            ))}
            {provider.limitations.map((limitation) => (
              <span key={limitation} className="text-muted-foreground">
                {limitation}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
