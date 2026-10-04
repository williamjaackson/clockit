import type { EnvironmentId, SkillEntry, SkillScope, SkillsSnapshot } from "@t3tools/contracts";
import {
  newSkillContent,
  scopeLibraryNames,
  validateNewSkillName,
} from "@t3tools/client-runtime/state/skills";
import { useState } from "react";

import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Textarea } from "../ui/textarea";
import { runSkillsCommand } from "./skillsCommands";

export function NewSkillDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
  readonly snapshot: SkillsSnapshot;
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
    props.onCreated(result.snapshot, trimmed);
    close();
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New skill</DialogTitle>
          <DialogDescription>
            Creates a folder with a SKILL.md in {props.snapshot.scope.libraryPath}.
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
          <Button variant="outline" onClick={close}>
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

/**
 * Copies a skill into this scope's library. Adopting moves the original to
 * Recovery and links the copy in its place, so it is a separate, explicit choice.
 */
export function ImportSkillDialog(props: {
  readonly entry: SkillEntry | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
  readonly snapshot: SkillsSnapshot;
  readonly onImported: (snapshot: SkillsSnapshot, name: string) => void;
}) {
  const entry = props.entry;
  const importSkill = useAtomCommand(skillsEnvironment.import, { reportFailure: false });
  const [name, setName] = useState(entry?.name ?? "");
  const [adopt, setAdopt] = useState(false);
  const [pending, setPending] = useState(false);
  if (entry === null) return null;

  const isGlobal = props.snapshot.scope.kind === "global";
  const canAdopt = isGlobal && entry.ownership === "unmanaged";
  const adopting = canAdopt && adopt;
  const nameError = validateNewSkillName(name, scopeLibraryNames(props.snapshot));
  const keepsDuplicate = !adopting && name.trim().toLowerCase() === entry.name.toLowerCase();

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
      "Could not import the skill",
    );
    setPending(false);
    if (result === null) return;
    props.onImported(result.snapshot, result.name);
    props.onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import {entry.name}</DialogTitle>
          <DialogDescription>
            Copies the whole folder, including scripts and other files, into{" "}
            {props.snapshot.scope.libraryPath}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="import-skill-name">Name in library</Label>
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
              ) : keepsDuplicate ? (
                <p className="text-xs text-muted-foreground">
                  The original stays where it is, so providers will find two skills named{" "}
                  {entry.name}. Which one they load is up to each provider. Choose a new name to
                  keep them apart.
                </p>
              ) : null}
            </div>
            {canAdopt ? (
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={adopt}
                  onCheckedChange={(checked) => setAdopt(checked === true)}
                />
                <span className="grid gap-1">
                  <span>Adopt the original and link it</span>
                  <span className="text-xs text-muted-foreground">
                    Moves {entry.path} to Recovery and puts a link to the library copy in its place.
                  </span>
                </span>
              </label>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={nameError !== null || pending} onClick={() => void submit()}>
            {adopting ? "Import and adopt" : "Import copy"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
