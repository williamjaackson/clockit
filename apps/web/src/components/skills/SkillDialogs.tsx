import type {
  EnvironmentId,
  SkillEntry,
  SkillScope,
  SkillsReleaseResult,
  SkillsSnapshot,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  discoverableSkills,
  invocationNameClashes,
  isAbsoluteSkillPath,
  newSkillContent,
  scopeLibraryNames,
  skillAdoptionPlan,
  skillInvocationName,
  skillProviderReach,
  skillsFailureMessage,
  validateNewSkillName,
} from "@t3tools/client-runtime/state/skills";
import { useEffect, useRef, useState } from "react";

import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SkillsDisclosure, SkillsPathRow } from "./SkillsDisclosure";
import { SkillAgentIcons } from "./SkillsList";
import { reportSkippedLinks, runSkillsCommand } from "./skillsCommands";

function scopeDestination(snapshot: SkillsSnapshot): string {
  const { scope } = snapshot;
  if (scope.kind === "global") return "My skills";
  return scope.mode === "shared"
    ? ".agents/skills in the repository"
    : "this project's private skills";
}

export function NewSkillDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
  readonly snapshot: SkillsSnapshot;
  /** Runs after the skill exists. The dialog can't close while the request is in flight. */
  readonly onCreated: (snapshot: SkillsSnapshot, name: string) => void;
}) {
  const save = useAtomCommand(skillsEnvironment.save, { reportFailure: false });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const nameError = validateNewSkillName(name, scopeLibraryNames(props.snapshot));
  const canCreate = nameError === null && description.trim().length > 0 && !pending;

  const close = () => {
    if (pending) return;
    setName("");
    setDescription("");
    setTouched(false);
    props.onOpenChange(false);
  };

  const create = async () => {
    setTouched(true);
    if (!canCreate) return;
    setPending(true);
    const trimmed = name.trim();
    const result = await runSkillsCommand(
      save({
        environmentId: props.environmentId,
        input: {
          scope: props.scope,
          skill: { name: trimmed },
          content: newSkillContent({ name: trimmed, description }),
          expectedRevision: null,
        },
      }),
      "Could not create the skill",
    );
    setPending(false);
    if (result === null) return;
    setName("");
    setDescription("");
    setTouched(false);
    props.onOpenChange(false);
    reportSkippedLinks(result.skippedLinks);
    props.onCreated(result.snapshot, trimmed);
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New skill</DialogTitle>
          <DialogDescription>
            {props.snapshot.scope.kind === "global"
              ? "Adds a skill to My skills. Every agent you've turned on gets it."
              : `Creates a skill in ${scopeDestination(props.snapshot)}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="new-skill-name">Name</Label>
              <Input
                id="new-skill-name"
                placeholder="review-pull-requests"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={name}
                aria-invalid={touched && nameError !== null}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => setTouched(true)}
              />
              {touched && nameError !== null ? (
                <p className="text-xs text-destructive-foreground">{nameError}</p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-skill-description">Description</Label>
              <Textarea
                id="new-skill-description"
                placeholder="When agents should use this skill"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Agents read this to decide when to load the skill.
              </p>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button disabled={!canCreate} onClick={() => void create()}>
            Create skill
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** User skills T3 found in agent folders and doesn't manage yet. */
export function DiscoverSkillsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly snapshot: SkillsSnapshot;
  readonly onManage: (entry: SkillEntry) => void;
}) {
  const entries = discoverableSkills(props.snapshot);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage existing skills</DialogTitle>
          <DialogDescription>
            Skills already in your agents' folders. Bring one into My skills to edit it here and
            share it with every agent you've turned on.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other skills found. Skills installed by plugins stay with their plugin.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-lg border">
              {entries.map((entry) => (
                <li key={entry.id} className="flex min-w-0 items-center gap-3 px-3 py-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="break-words text-sm font-medium">{entry.name}</span>
                    {entry.description ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {entry.description}
                      </span>
                    ) : null}
                    <SkillAgentIcons reach={skillProviderReach(entry, props.snapshot)} />
                  </div>
                  <Button size="xs" variant="outline" onClick={() => props.onManage(entry)}>
                    Manage in T3…
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Brings a skill into this scope's library.
 * - A user skill in My skills: take it over (the default) or copy it.
 * - In a project's private view: a private copy that replaces the original
 *   for T3 agents in the project.
 * - In repository mode: a copy in `.agents/skills`.
 */
export function ImportSkillDialog(props: {
  readonly entry: SkillEntry;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
  readonly snapshot: SkillsSnapshot;
  /** Runs after the copy exists. The dialog can't close while the request is in flight. */
  readonly onImported: (snapshot: SkillsSnapshot, name: string) => void;
}) {
  const { entry, snapshot } = props;
  const importSkill = useAtomCommand(skillsEnvironment.import, { reportFailure: false });
  const [name, setName] = useState(entry.name);
  const [adopt, setAdopt] = useState(true);
  const [pending, setPending] = useState(false);

  const isGlobal = snapshot.scope.kind === "global";
  const isPrivate = snapshot.scope.kind === "project" && snapshot.scope.mode !== "shared";
  const canAdopt = isGlobal && entry.ownership === "unmanaged";
  const adopting = canAdopt && adopt;
  const nameError = validateNewSkillName(name, scopeLibraryNames(snapshot));
  const invocation = skillInvocationName(entry);
  const plan = skillAdoptionPlan(entry);
  const fromMySkills = entry.id.startsWith("inherited:");
  const clashes = invocationNameClashes(snapshot, entry).length;

  const submit = async () => {
    if (nameError !== null || pending) return;
    setPending(true);
    const trimmed = name.trim();
    const result = await runSkillsCommand(
      importSkill({
        environmentId: props.environmentId,
        input: {
          scope: props.scope,
          entryId: entry.id,
          ...(trimmed === entry.name ? {} : { name: trimmed }),
          ...(adopting ? { adoptOriginal: true } : {}),
        },
      }),
      "Could not bring the skill in",
    );
    setPending(false);
    if (result === null) return;
    props.onOpenChange(false);
    reportSkippedLinks(result.skippedLinks);
    props.onImported(result.snapshot, result.name);
  };

  const title = canAdopt
    ? `Manage ${entry.name} in T3`
    : isPrivate
      ? `Customize ${entry.name} for this project`
      : `Copy ${entry.name}`;
  const description = canAdopt
    ? "T3 keeps the skill in My skills, where you edit it and choose who uses it. Every agent you've turned on gets it."
    : isPrivate
      ? `Makes a private copy for this project. Claude and Codex agents you run in T3 here use it instead of the ${fromMySkills ? "My skills" : "repository"} version. The original stays as it is.`
      : `Copies the whole folder, scripts included, into ${scopeDestination(snapshot)}. The original stays where it is.`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onOpenChange(false);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {canAdopt ? (
              <RadioGroup
                aria-label="How to bring it in"
                value={adopt ? "move" : "copy"}
                onValueChange={(value) => setAdopt(value === "move")}
              >
                <label className="flex cursor-pointer items-start gap-3 text-sm">
                  <Radio value="move" className="mt-0.5" />
                  <span className="grid gap-1">
                    <span>Move it into T3</span>
                    <span className="text-xs text-muted-foreground">
                      {plan.sourceStays === null
                        ? "Agents keep using it, now from T3's copy. The original moves to Recovery, where you can restore it."
                        : "Agents keep using it, now from T3's copy. Its original folder stays where it is, outside T3."}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 text-sm">
                  <Radio value="copy" className="mt-0.5" />
                  <span className="grid gap-1">
                    <span>Copy only</span>
                    <span className="text-xs text-muted-foreground">
                      The original stays where it is and T3 doesn't manage it. Switching T3's copy
                      off leaves the original on.
                    </span>
                  </span>
                </label>
              </RadioGroup>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="import-skill-name">Folder name</Label>
              <Input
                id="import-skill-name"
                autoComplete="off"
                spellCheck={false}
                value={name}
                aria-invalid={nameError !== null}
                onChange={(event) => setName(event.target.value)}
              />
              {nameError !== null ? (
                <p className="text-xs text-destructive-foreground">{nameError}</p>
              ) : isPrivate ? (
                <p className="text-xs text-muted-foreground">
                  Agents load it as {invocation}, the name in its SKILL.md, so the copy replaces the
                  original whatever the folder is called.
                </p>
              ) : !adopting ? (
                <p className="text-xs text-muted-foreground">
                  Agents load it as {invocation}, the name in its SKILL.md
                  {clashes > 0 || !isGlobal ? ", so they'll see two skills by that name" : ""}. To
                  tell them apart, change the name in the copy's SKILL.md.
                </p>
              ) : null}
            </div>
            {adopting ? (
              <SkillsDisclosure title="Details">
                {plan.moved.map((location) => (
                  <SkillsPathRow
                    key={location}
                    label={plan.sourceStays === null ? "Moves to Recovery" : "Now points at T3"}
                    path={location}
                  />
                ))}
                {plan.kept.map((location) => (
                  <SkillsPathRow key={location} label="Keeps working" path={location} />
                ))}
                {plan.sourceStays !== null ? (
                  <SkillsPathRow label="Stays as it is" path={plan.sourceStays} />
                ) : null}
              </SkillsDisclosure>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={nameError !== null || pending} onClick={() => void submit()}>
            {adopting ? "Move into T3" : isPrivate ? "Customize" : "Copy"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
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

function releasePlan(
  destination: string | null,
  result: AtomCommandResult<SkillsReleaseResult, unknown>,
): ReleasePlan {
  return result._tag === "Success"
    ? { status: "ready", destination, result: result.value }
    : {
        status: "error",
        destination,
        message: skillsFailureMessage(squashAtomCommandFailure(result)),
      };
}

/**
 * Stops managing a My skills entry. A dry run shows where the folder goes
 * and which agent folders follow it; confirming carries out that plan.
 */
export function ReleaseSkillDialog(props: {
  readonly entry: SkillEntry;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly onReleased: () => void;
}) {
  const { entry, environmentId } = props;
  const preview = useAtomCommand(skillsEnvironment.releasePreview, { reportFailure: false });
  const release = useAtomCommand(skillsEnvironment.release, { reportFailure: false });
  // A skill that's off has no agent folder to return to, so it needs a folder.
  const [choosing, setChoosing] = useState(!entry.enabled);
  const [destination, setDestination] = useState("");
  const [plan, setPlan] = useState<ReleasePlan>(
    entry.enabled ? { status: "loading", destination: null } : { status: "idle" },
  );
  const [pending, setPending] = useState(false);
  const requestRef = useRef(0);

  const chosen = choosing ? destination.trim() : "";
  const chosenError =
    choosing && chosen.length > 0 && !isAbsoluteSkillPath(chosen)
      ? "Enter a full path, such as /Users/me/skills/name."
      : null;
  const planFor = choosing ? (chosen.length > 0 ? chosen : undefined) : null;

  const runPreview = async (target: string | null) => {
    const requestId = ++requestRef.current;
    setPlan({ status: "loading", destination: target });
    const result = await preview({
      environmentId,
      input: { name: entry.name, ...(target === null ? {} : { destination: target }) },
    });
    if (requestId === requestRef.current) setPlan(releasePlan(target, result));
  };

  // An enabled skill has a default destination, so its plan loads right away.
  const { enabled, name } = entry;
  useEffect(() => {
    if (!enabled) return;
    const requestId = ++requestRef.current;
    void preview({ environmentId, input: { name } }).then((result) => {
      if (requestId !== requestRef.current) return;
      setPlan(releasePlan(null, result));
    });
    return () => {
      requestRef.current += 1;
    };
  }, [enabled, environmentId, name, preview]);

  const planMatches =
    plan.status === "ready" && planFor !== undefined && plan.destination === planFor;

  const confirm = async () => {
    if (!planMatches || pending) return;
    setPending(true);
    const result = await runSkillsCommand(
      release({
        environmentId,
        input: {
          name: entry.name,
          ...(plan.destination === null ? {} : { destination: plan.destination }),
        },
      }),
      `Could not stop managing ${entry.name}`,
    );
    setPending(false);
    if (result === null) return;
    toastManager.add({
      type: "success",
      title: `T3 no longer manages ${entry.name}`,
      description: `It's now at ${result.destination}.`,
    });
    props.onOpenChange(false);
    props.onReleased();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onOpenChange(false);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Stop managing {entry.name}?</DialogTitle>
          <DialogDescription>
            {entry.enabled
              ? "The skill moves out of T3 with your latest edits, and the agents that use it now keep it. You can manage it in T3 again later."
              : "The skill moves out of T3 with your latest edits. It's off, so it goes to a folder no agent reads and stays off there."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            {plan.status === "loading" ? (
              <Skeleton className="h-12 w-full" />
            ) : plan.status === "error" ? (
              <Alert variant="error">
                <AlertDescription>{plan.message}</AlertDescription>
              </Alert>
            ) : plan.status === "ready" ? (
              <div className="grid gap-2">
                <SkillsPathRow label="Moves to" path={plan.result.destination} />
                {plan.result.relinked.length > 0 ? (
                  <SkillsDisclosure title="Agent folders that follow it">
                    {plan.result.relinked.map((location) => (
                      <SkillsPathRow key={location} label="Now points there" path={location} />
                    ))}
                  </SkillsDisclosure>
                ) : null}
              </div>
            ) : null}

            {choosing ? (
              <form
                className="grid gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (chosen.length > 0 && chosenError === null) void runPreview(chosen);
                }}
              >
                <Label htmlFor="release-destination">Move it to</Label>
                <div className="flex gap-2">
                  <Input
                    id="release-destination"
                    className="min-w-0 flex-1"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={`/Users/me/skills/${entry.name}`}
                    value={destination}
                    aria-invalid={chosenError !== null}
                    onChange={(event) => setDestination(event.target.value)}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={
                      chosen.length === 0 || chosenError !== null || plan.status === "loading"
                    }
                  >
                    Check
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {chosenError ??
                    (entry.enabled
                      ? "A new folder T3 creates. Agent folders that use the skill will point there."
                      : "A new folder T3 creates, outside every agent's skill folder.")}
                </p>
              </form>
            ) : (
              <div>
                <Button size="xs" variant="ghost" onClick={() => setChoosing(true)}>
                  Choose another folder
                </Button>
              </div>
            )}
            {choosing && entry.enabled ? (
              <div>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setChoosing(false);
                    setDestination("");
                    void runPreview(null);
                  }}
                >
                  Use the default folder
                </Button>
              </div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!planMatches || pending} onClick={() => void confirm()}>
            {pending ? <Spinner /> : null}
            Stop managing
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
