import type {
  EnvironmentId,
  SkillEntry,
  SkillScope,
  SkillsReadResult,
  SkillsSnapshot,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isSkillsRevisionConflict,
  providerDisplayName,
  sharedProfileNotice,
  skillsFailureMessage,
} from "@t3tools/client-runtime/state/skills";
import { useCallback, useEffect, useRef, useState } from "react";

import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SkillFileEditor, type SkillFileSaveOutcome } from "./SkillFileEditor";
import { SkillLinkTargets } from "./SkillLinkTargets";
import { confirmSkillsAction, runSkillsCommand } from "./skillsCommands";
import { SkillBadges } from "./SkillsList";

type FileState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly result: SkillsReadResult; readonly loadId: number };

const DEFAULT_FILE = "SKILL.md";

function readOnlyReason(entry: SkillEntry): string {
  switch (entry.ownership) {
    case "plugin":
      return "Installed by a plugin. Import a copy to change it.";
    case "system":
      return "Built into the provider. Import a copy to change it.";
    default:
      return "Lives outside the library. Import it to edit.";
  }
}

/** One skill: its state, where providers find it, links, and its files. Mount per entry. */
export function SkillDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
  readonly snapshot: SkillsSnapshot;
  readonly entry: SkillEntry;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly confirmDiscard: () => Promise<boolean>;
  readonly onSelectEntry: (entryId: string) => void;
  readonly onImport: (entry: SkillEntry) => void;
}) {
  const { environmentId, scope, entry, snapshot } = props;
  const read = useAtomCommand(skillsEnvironment.read, { reportFailure: false });
  const save = useAtomCommand(skillsEnvironment.save, { reportFailure: false });
  const setEnabled = useAtomCommand(skillsEnvironment.setEnabled, { reportFailure: false });
  const archive = useAtomCommand(skillsEnvironment.archive, { reportFailure: false });
  const [file, setFile] = useState(DEFAULT_FILE);
  const [fileState, setFileState] = useState<FileState>({ status: "loading" });
  const [files, setFiles] = useState<{ list: readonly string[]; truncated: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const loadIdRef = useRef(0);
  const entryId = entry.id;
  const editorDirtyRef = useRef(false);
  const { onDirtyChange } = props;
  const trackDirty = useCallback(
    (dirty: boolean) => {
      editorDirtyRef.current = dirty;
      onDirtyChange(dirty);
    },
    [onDirtyChange],
  );

  const load = useCallback(
    async (nextFile: string) => {
      const loadId = ++loadIdRef.current;
      const result = await read({
        environmentId,
        input: { scope, skill: { entryId }, file: nextFile },
      });
      // A newer load, or leaving this skill, makes this answer stale.
      if (loadId !== loadIdRef.current) return;
      if (result._tag === "Failure") {
        setFileState({
          status: "error",
          message: skillsFailureMessage(squashAtomCommandFailure(result)),
        });
        return;
      }
      setFiles({ list: result.value.files, truncated: result.value.filesTruncated });
      setFileState({ status: "ready", result: result.value, loadId });
    },
    [entryId, environmentId, read, scope],
  );

  useEffect(() => {
    void load(DEFAULT_FILE);
    return () => {
      loadIdRef.current += 1;
    };
  }, [load]);

  const selectFile = async (nextFile: string) => {
    if (nextFile === file || !(await props.confirmDiscard())) return;
    setFile(nextFile);
    setFileState({ status: "loading" });
    void load(nextFile);
  };

  const saveFile = async (
    content: string,
    expectedRevision: string | null,
  ): Promise<SkillFileSaveOutcome> => {
    const result = await save({
      environmentId,
      input: { scope, skill: { entryId }, file, content, expectedRevision },
    });
    if (result._tag === "Success") return { _tag: "saved", revision: result.value.revision };
    const error = squashAtomCommandFailure(result);
    return isSkillsRevisionConflict(error)
      ? { _tag: "conflict" }
      : { _tag: "failed", message: skillsFailureMessage(error) };
  };

  // Enabling or disabling moves a library skill's folder, so an open draft is
  // dropped first and the file read again from its new place afterwards.
  const toggleEnabled = async (enabled: boolean) => {
    const discarding = editorDirtyRef.current;
    if (!(await props.confirmDiscard())) return;
    if (discarding) setFileState({ status: "loading" });
    setPending(true);
    const result = await runSkillsCommand(
      setEnabled({ environmentId, input: { scope, skill: { entryId }, enabled } }),
      enabled ? "Could not enable the skill" : "Could not disable the skill",
    );
    setPending(false);
    if (discarding) void load(file);
    if (result !== null && result.skippedLinks.length > 0) {
      toastManager.add({
        type: "warning",
        title: "Some links were not restored",
        description: `Something else is now at ${result.skippedLinks.join(", ")}.`,
      });
    }
  };

  // Archiving drops any draft first; otherwise the page would keep showing the
  // vanished skill to protect it.
  const archiveSkill = async () => {
    if (!(await props.confirmDiscard())) return;
    if (
      !(await confirmSkillsAction(
        `Archive ${entry.name}?\nIt moves to Recovery and its provider links are removed. You can restore it from Recovery.`,
        "destructive",
      ))
    ) {
      return;
    }
    const discarding = editorDirtyRef.current;
    if (discarding) setFileState({ status: "loading" });
    setPending(true);
    const result = await runSkillsCommand(
      archive({ environmentId, input: { scope, name: entry.name } }),
      "Could not archive the skill",
    );
    setPending(false);
    if (discarding && result === null) void load(file);
  };

  const isProjectPrivate = snapshot.scope.kind === "project" && snapshot.scope.mode !== "shared";
  const isShared = snapshot.scope.kind === "project" && snapshot.scope.mode === "shared";
  const canToggle = entry.ownership === "managed" || isProjectPrivate;
  const profileNotice = isProjectPrivate ? sharedProfileNotice(snapshot.scope) : null;
  // Shared snapshots only list links for skills kept directly in `.agents/skills`.
  const showLinks =
    (entry.ownership === "managed" && entry.scope === "global" && entry.enabled) ||
    (isShared && entry.links.length > 0);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="truncate text-lg font-semibold">{entry.name}</h2>
            <SkillBadges entry={entry} />
          </div>
          <div className="flex items-center gap-2">
            {canToggle ? (
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={entry.enabled}
                  disabled={pending}
                  onCheckedChange={(checked) => void toggleEnabled(checked)}
                />
                Enabled
              </label>
            ) : null}
            {entry.ownership !== "managed" ? (
              <Button size="sm" variant="outline" onClick={() => props.onImport(entry)}>
                Import…
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost-destructive"
                disabled={pending}
                onClick={() => void archiveSkill()}
              >
                Archive
              </Button>
            )}
          </div>
        </div>
        {entry.description ? (
          <p className="text-sm text-muted-foreground">{entry.description}</p>
        ) : null}
        <p className="break-all text-xs text-muted-foreground select-text">{entry.path}</p>
        {profileNotice !== null && canToggle ? (
          <p className="break-all text-xs text-muted-foreground">{profileNotice}</p>
        ) : null}
      </div>

      {entry.conflicts.length > 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            <p>Other skills share this name. Which one an agent loads depends on the provider.</p>
            <ul className="mt-1 flex flex-col gap-1">
              {entry.conflicts.map((conflict) => (
                <li key={conflict.entryId} className="flex items-center gap-2">
                  <span className="min-w-0 break-all">{conflict.path}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => props.onSelectEntry(conflict.entryId)}
                  >
                    Show
                  </Button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {entry.origins.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Found by</h3>
          <ul className="flex flex-col gap-1.5">
            {entry.origins.map((origin) => (
              <li key={origin.entryPath} className="flex min-w-0 flex-col text-xs">
                <span className="text-foreground">
                  {origin.providers.map(providerDisplayName).join(", ") || "No provider"}
                </span>
                <span className="break-all text-muted-foreground">
                  {origin.entryPath}
                  {origin.symlinkTarget !== undefined ? ` → ${origin.symlinkTarget}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {showLinks ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">
            {isShared ? "Repository links" : "Provider links"}
          </h3>
          {isShared ? (
            <p className="text-xs text-muted-foreground">
              Claude Code reads .claude/skills, not .agents/skills. Linking adds a relative symlink
              to the repository so both read this folder. Nothing is linked until you ask.
            </p>
          ) : null}
          <SkillLinkTargets
            environmentId={environmentId}
            scope={scope}
            subject={{ type: "skill", name: entry.name }}
            subjectLabel={entry.name}
            links={entry.links}
            linkTargets={snapshot.linkTargets}
          />
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Files</h3>
          {files !== null && files.list.length > 1 ? (
            <Select value={file} onValueChange={(value) => value && void selectFile(value)}>
              <SelectTrigger aria-label="Skill file" size="sm" className="w-auto min-w-0">
                <SelectValue>{file}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {files.list.map((path) => (
                  <SelectItem key={path} value={path}>
                    {path}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </div>
        {files?.truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing the first {files.list.length} files.
          </p>
        ) : null}
        {fileState.status === "loading" ? (
          <Skeleton className="h-40 w-full" />
        ) : fileState.status === "error" ? (
          <Alert variant="error">
            <AlertDescription>{fileState.message}</AlertDescription>
          </Alert>
        ) : (
          <SkillFileEditor
            key={`${file}:${fileState.loadId}`}
            label={`${entry.name}/${file}`}
            content={fileState.result.content}
            revision={fileState.result.revision}
            editable={fileState.result.entry.editable}
            readOnlyReason={readOnlyReason(entry)}
            onSave={saveFile}
            onDirtyChange={trackDirty}
            onReload={() =>
              void (async () => {
                if (!(await props.confirmDiscard())) return;
                setFileState({ status: "loading" });
                void load(file);
              })()
            }
          />
        )}
      </section>
    </div>
  );
}
