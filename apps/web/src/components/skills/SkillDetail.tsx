import type {
  EnvironmentId,
  SkillEntry,
  SkillScope,
  SkillsReadResult,
  SkillsSnapshot,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  advancedSkillLinks,
  blockedProviderLinks,
  formatProviderList,
  isSkillsRevisionConflict,
  needsProviderSync,
  providerDisplayName,
  skillInvocationName,
  skillProviderReach,
  skillProvidersNote,
  skillSectionOf,
  skillsFailureMessage,
  skillToggle,
  skillUsageSummary,
  unsupportedSkillProviders,
} from "@t3tools/client-runtime/state/skills";
import { MoreHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { SkillFileEditor, type SkillFileSaveOutcome } from "./SkillFileEditor";
import { SkillProviderSwitches } from "./SkillProviderSwitches";
import { SkillsDisclosure, SkillsPathRow, SkillsSectionTitle } from "./SkillsDisclosure";
import { confirmSkillsAction, runSkillsCommand } from "./skillsCommands";

type FileState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly result: SkillsReadResult; readonly loadId: number };

const DEFAULT_FILE = "SKILL.md";

function readOnlyReason(entry: SkillEntry, snapshot: SkillsSnapshot): string {
  switch (skillSectionOf(entry, snapshot.scope)) {
    case "inherited":
      return "From My skills. Edit it there, or customize it for this project.";
    case "repository":
      return "Lives in the repository. Customize it for this project, or switch to Repository files, to change it.";
    default:
      return "Read only.";
  }
}

/** One skill: whether it's on, which agents get it, its files, and where it lives. Mount per entry. */
export function SkillDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
  readonly snapshot: SkillsSnapshot;
  readonly entry: SkillEntry;
  /** The value a switch request in flight asks for, if any. */
  readonly pendingEnabled: boolean | undefined;
  readonly onToggle: (entry: SkillEntry, enabled: boolean) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly confirmDiscard: () => Promise<boolean>;
  readonly onSelectEntry: (entryId: string) => void;
  /** False for entries the page doesn't list, such as plugin skills. */
  readonly canSelectEntry: (entryId: string) => boolean;
  readonly onImport: (entry: SkillEntry) => void;
  readonly onRelease: (entry: SkillEntry) => void;
  readonly onEditInMySkills: (entry: SkillEntry) => void;
  readonly onSync: (names: [string, ...string[]]) => void;
  readonly syncing: boolean;
}) {
  const { environmentId, scope, entry, snapshot } = props;
  const read = useAtomCommand(skillsEnvironment.read, { reportFailure: false });
  const save = useAtomCommand(skillsEnvironment.save, { reportFailure: false });
  const archive = useAtomCommand(skillsEnvironment.archive, { reportFailure: false });
  const [file, setFile] = useState(DEFAULT_FILE);
  const [fileState, setFileState] = useState<FileState>({ status: "loading" });
  const [files, setFiles] = useState<{ list: readonly string[]; truncated: boolean } | null>(null);
  const [archiving, setArchiving] = useState(false);
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

  const section = skillSectionOf(entry, snapshot.scope);
  const invocation = skillInvocationName(entry);

  // Archiving drops any draft first; otherwise the page would keep showing the
  // vanished skill to protect it.
  const archiveSkill = async () => {
    if (!(await props.confirmDiscard())) return;
    const message =
      section === "mine"
        ? `Archive ${entry.name}?\nT3's copy moves to Recovery, where you can restore it, and agents stop getting it from T3. Other skills called ${invocation} that T3 doesn't manage stay where they are.`
        : `Archive ${entry.name}?\nThe private skill moves to Recovery, where you can restore it. Any repository or My skills version it replaced applies again.`;
    if (!(await confirmSkillsAction(message, "destructive"))) return;
    const discarding = editorDirtyRef.current;
    if (discarding) setFileState({ status: "loading" });
    setArchiving(true);
    const result = await runSkillsCommand(
      archive({ environmentId, input: { scope, name: entry.name } }),
      "Could not archive the skill",
    );
    setArchiving(false);
    if (discarding && result === null) void load(file);
  };

  const toggle = skillToggle(entry, snapshot.scope);
  const checked = props.pendingEnabled ?? toggle?.checked ?? false;
  const reach = skillProviderReach(entry, snapshot);
  const providersNote = skillProvidersNote(entry, snapshot.scope);
  const isShared = snapshot.scope.kind === "project" && snapshot.scope.mode === "shared";
  const missing = needsProviderSync(entry)
    ? reach.filter((item) => item.pending).map((item) => item.provider)
    : [];
  const blocked = blockedProviderLinks(entry);
  const advancedLinks =
    section === "mine" && entry.enabled ? advancedSkillLinks(entry, snapshot) : [];
  const unsupported = unsupportedSkillProviders(snapshot);
  const duplicates = entry.conflicts.filter((conflict) => conflict.reason === "duplicateName");
  const replacements = entry.conflicts.filter((conflict) => conflict.reason === "replacedByLocal");
  const replacement =
    section === "inherited" || section === "repository" ? replacements[0] : undefined;
  const replaces = section === "private" ? replacements : [];
  const busy = archiving || props.pendingEnabled !== undefined;

  const menuItems: Array<{ readonly label: string; readonly run: () => void }> = [];
  if (section === "inherited") {
    menuItems.push({ label: "Edit in My skills", run: () => props.onEditInMySkills(entry) });
  }
  if (section === "inherited" || (section === "repository" && !isShared)) {
    menuItems.push({ label: "Customize for this project…", run: () => props.onImport(entry) });
  }
  if (section === "repository" && isShared && entry.links.length === 0) {
    menuItems.push({ label: "Copy to .agents/skills…", run: () => props.onImport(entry) });
  }
  if (section === "mine") {
    menuItems.push({ label: "Stop managing in T3…", run: () => props.onRelease(entry) });
  }
  const canArchive = section === "mine" || section === "private";

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="break-words text-lg font-semibold">{entry.name}</h2>
            <p className="text-sm text-muted-foreground">{skillUsageSummary(entry, snapshot)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {toggle !== null ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                {section === "inherited" || section === "repository" ? "On here" : "On"}
                <Switch
                  checked={checked}
                  title={toggle.disabledReason ?? undefined}
                  disabled={busy || toggle.disabledReason !== null}
                  onCheckedChange={(next) => props.onToggle(entry, next)}
                />
              </label>
            ) : null}
            {menuItems.length > 0 || canArchive ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={busy}
                      aria-label={`More actions for ${entry.name}`}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  {menuItems.map((item) => (
                    <MenuItem key={item.label} onClick={item.run}>
                      {item.label}
                    </MenuItem>
                  ))}
                  {canArchive ? (
                    <>
                      {menuItems.length > 0 ? <MenuSeparator /> : null}
                      <MenuItem variant="destructive" onClick={() => void archiveSkill()}>
                        Archive…
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        </div>
        {entry.description ? (
          <p className="text-sm text-foreground/80">{entry.description}</p>
        ) : null}
      </div>

      {section === "inherited" ? (
        <Alert variant="info">
          <AlertDescription>
            From My skills, so changes there reach every project. To change it only here, make a
            private copy.
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => props.onEditInMySkills(entry)}>
              Edit in My skills
            </Button>
            <Button size="xs" variant="outline" onClick={() => props.onImport(entry)}>
              Customize…
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {replacement !== undefined ? (
        <Alert variant="info">
          <AlertDescription>
            A private skill also called {invocation} replaces this one for T3 agents in this
            project.
          </AlertDescription>
          {props.canSelectEntry(replacement.entryId) ? (
            <AlertAction>
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onSelectEntry(replacement.entryId)}
              >
                Show it
              </Button>
            </AlertAction>
          ) : null}
        </Alert>
      ) : null}

      {replaces.length > 0 ? (
        <Alert variant="info">
          <AlertDescription>
            <p>
              T3 agents in this project use this instead of the other skill called {invocation}.
            </p>
            <ul className="mt-1 flex flex-col gap-1">
              {replaces.map((conflict) => (
                <li key={conflict.entryId} className="flex items-center gap-2">
                  <span className="min-w-0 break-all">{conflict.path}</span>
                  {props.canSelectEntry(conflict.entryId) ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => props.onSelectEntry(conflict.entryId)}
                    >
                      Show
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {duplicates.length > 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            <p>
              Other skills are also called {invocation}. Which one an agent loads depends on the
              agent.
            </p>
            <ul className="mt-1 flex flex-col gap-1">
              {duplicates.map((conflict) => (
                <li key={conflict.entryId} className="flex items-center gap-2">
                  <span className="min-w-0 break-all">{conflict.path}</span>
                  {props.canSelectEntry(conflict.entryId) ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => props.onSelectEntry(conflict.entryId)}
                    >
                      Show
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="flex flex-col gap-2">
        <SkillsSectionTitle>Agents</SkillsSectionTitle>
        {reach.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Agents">
            {reach.map((item) => (
              <li
                key={item.provider}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs",
                  !item.on && "text-muted-foreground",
                )}
              >
                <ProviderInstanceIcon
                  driverKind={item.provider}
                  displayName={providerDisplayName(item.provider)}
                  className={cn("z-0", !item.on && "opacity-30 grayscale")}
                  iconClassName="size-3.5"
                />
                {providerDisplayName(item.provider)}
                <span className="sr-only">{item.on ? ", has it" : ", doesn't have it"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No agent reads it.</p>
        )}
        {providersNote !== null ? (
          <p className="text-xs text-muted-foreground">{providersNote}</p>
        ) : null}
        {missing.length > 0 ? (
          <Alert variant="info">
            <AlertDescription>Not available to {formatProviderList(missing)} yet.</AlertDescription>
            <AlertAction>
              <Button
                size="xs"
                variant="outline"
                disabled={props.syncing}
                onClick={() => props.onSync([entry.name])}
              >
                Make available to all agents
              </Button>
            </AlertAction>
          </Alert>
        ) : null}
        {blocked.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">
              Some agent folders already have a different skill called {entry.name}, so T3 left them
              alone and those agents keep their own.
            </p>
            <SkillsDisclosure title="Where">
              {blocked.map((status) => (
                <SkillsPathRow
                  key={status.targetId}
                  label={
                    snapshot.linkTargets
                      .find((target) => target.id === status.targetId)
                      ?.providers.map(providerDisplayName)
                      .join(", ") ?? status.targetId
                  }
                  path={status.path}
                />
              ))}
            </SkillsDisclosure>
          </div>
        ) : null}
        {isShared && entry.links.length > 0 ? (
          <SkillProviderSwitches
            environmentId={environmentId}
            scope={scope}
            subject={{ type: "skill", name: entry.name }}
            subjectLabel={entry.name}
            links={entry.links}
            linkTargets={snapshot.linkTargets}
          />
        ) : null}
        {advancedLinks.length > 0 ? (
          <SkillsDisclosure title="Choose folders">
            <p className="text-xs text-muted-foreground">
              Each switch adds or removes the skill in one agent folder. Agents that share a folder
              switch together. A folder you switch off stays off when T3 adds skills to new agents.
              {unsupported.length > 0
                ? ` ${formatProviderList(unsupported)} ${unsupported.length === 1 ? "doesn't" : "don't"} read skill folders, so T3 can't add skills there.`
                : ""}
            </p>
            <SkillProviderSwitches
              environmentId={environmentId}
              scope={scope}
              subject={{ type: "skill", name: entry.name }}
              subjectLabel={entry.name}
              links={advancedLinks}
              linkTargets={snapshot.linkTargets}
            />
          </SkillsDisclosure>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex min-h-7 items-center justify-between gap-2">
          <SkillsSectionTitle>Files</SkillsSectionTitle>
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
            readOnlyReason={readOnlyReason(entry, snapshot)}
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

      <SkillsDisclosure title="Details">
        <SkillsPathRow label="Skill folder" path={entry.path} />
        {entry.origins.map((origin) => (
          <SkillsPathRow
            key={origin.entryPath}
            label={`Found by ${origin.providers.map(providerDisplayName).join(", ") || "no provider"}`}
            path={
              origin.symlinkTarget === undefined
                ? origin.entryPath
                : `${origin.entryPath} → ${origin.symlinkTarget}`
            }
          />
        ))}
      </SkillsDisclosure>
    </div>
  );
}
