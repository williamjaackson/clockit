import type {
  EnvironmentId,
  SkillInstructionFile,
  SkillInstructionFileName,
  SkillInstructionsDocument,
  SkillProjectInstructionMode,
  SkillScope,
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SkillFileEditor, type SkillFileSaveOutcome } from "./SkillFileEditor";
import { SkillLinkTargets } from "./SkillLinkTargets";
import { confirmSkillsAction, runSkillsCommand } from "./skillsCommands";

const INSTRUCTION_MODES: ReadonlyArray<{
  readonly value: SkillProjectInstructionMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "inherit",
    label: "Use repository",
    description: "Agents read the repository's instructions. Your private text is kept but unused.",
  },
  {
    value: "append",
    label: "Add to repository",
    description: "Agents read the repository's instructions, then your private text.",
  },
  {
    value: "replace",
    label: "Replace repository",
    description: "Agents read your private text instead of the repository's instructions.",
  },
  { value: "off", label: "Off", description: "Agents get no project instructions." },
];

const SHARED_FILES: ReadonlyArray<SkillInstructionFileName> = ["AGENTS.md", "CLAUDE.md"];

type DocumentState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly document: SkillInstructionsDocument;
      readonly loadId: number;
    };

export function SkillsInstructions(props: {
  readonly environmentId: EnvironmentId;
  readonly scope: SkillScope;
  readonly snapshot: SkillsSnapshot;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly confirmDiscard: () => Promise<boolean>;
}) {
  const { environmentId, scope, snapshot } = props;
  const readInstructions = useAtomCommand(skillsEnvironment.readInstructions, {
    reportFailure: false,
  });
  const saveInstructions = useAtomCommand(skillsEnvironment.saveInstructions, {
    reportFailure: false,
  });
  const importInstructions = useAtomCommand(skillsEnvironment.importInstructions, {
    reportFailure: false,
  });
  const updateProjectSettings = useAtomCommand(skillsEnvironment.updateProjectSettings, {
    reportFailure: false,
  });
  const shared = snapshot.scope.kind === "project" && snapshot.scope.mode === "shared";
  const projectPrivate = snapshot.scope.kind === "project" && !shared;
  const [sharedFile, setSharedFile] = useState<SkillInstructionFileName>("AGENTS.md");
  const file = shared ? sharedFile : undefined;
  const [documentState, setDocumentState] = useState<DocumentState>({ status: "loading" });
  const [pending, setPending] = useState(false);
  const loadIdRef = useRef(0);

  const show = useCallback((document: SkillInstructionsDocument) => {
    const loadId = ++loadIdRef.current;
    setDocumentState({ status: "ready", document, loadId });
  }, []);

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    const result = await readInstructions({
      environmentId,
      input: { scope, ...(file === undefined ? {} : { file }) },
    });
    if (loadId !== loadIdRef.current) return;
    setDocumentState(
      result._tag === "Success"
        ? { status: "ready", document: result.value, loadId }
        : { status: "error", message: skillsFailureMessage(squashAtomCommandFailure(result)) },
    );
  }, [environmentId, file, readInstructions, scope]);

  useEffect(() => {
    void load();
    return () => {
      loadIdRef.current += 1;
    };
  }, [load]);

  const saveDocument = async (
    content: string,
    expectedRevision: string | null,
  ): Promise<SkillFileSaveOutcome> => {
    const result = await saveInstructions({
      environmentId,
      input: { scope, ...(file === undefined ? {} : { file }), content, expectedRevision },
    });
    if (result._tag === "Success") {
      return { _tag: "saved", revision: result.value.revision };
    }
    const error = squashAtomCommandFailure(result);
    return isSkillsRevisionConflict(error)
      ? { _tag: "conflict" }
      : { _tag: "failed", message: skillsFailureMessage(error) };
  };

  const importFile = async (source: SkillInstructionFile) => {
    const current = documentState.status === "ready" ? documentState.document : null;
    const replacing = snapshot.instructions.canonicalExists || current?.exists === true;
    if (replacing) {
      if (
        !(await confirmSkillsAction(
          `Replace your instructions with ${source.path}?\nThe current text at ${snapshot.instructions.canonicalPath} is overwritten.`,
          "destructive",
        ))
      ) {
        return;
      }
    }
    if (!(await props.confirmDiscard())) return;
    setPending(true);
    const result = await runSkillsCommand(
      importInstructions({
        environmentId,
        input: {
          scope,
          sourceId: source.id,
          ...(replacing ? { expectedRevision: current?.revision ?? null } : {}),
        },
      }),
      "Could not import the instructions",
    );
    setPending(false);
    if (result !== null) show(result);
  };

  const changeMode = async (instructionMode: SkillProjectInstructionMode) => {
    if (snapshot.scope.kind !== "project" || scope.projectPath === undefined) return;
    setPending(true);
    await runSkillsCommand(
      updateProjectSettings({
        environmentId,
        input: { projectPath: scope.projectPath, instructionMode },
      }),
      "Could not change how instructions apply",
    );
    setPending(false);
  };

  const mode = snapshot.instructions.mode ?? "inherit";
  const profileNotice = sharedProfileNotice(snapshot.scope);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {projectPrivate ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">How your private instructions apply</h3>
          <Select
            value={mode}
            disabled={pending}
            onValueChange={(value) => {
              const next = INSTRUCTION_MODES.find((option) => option.value === value);
              if (next) void changeMode(next.value);
            }}
          >
            <SelectTrigger aria-label="How private instructions apply" className="sm:max-w-xs">
              <SelectValue>
                {INSTRUCTION_MODES.find((option) => option.value === mode)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {INSTRUCTION_MODES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="text-xs text-muted-foreground">
            {INSTRUCTION_MODES.find((option) => option.value === mode)?.description}
          </p>
          {profileNotice !== null ? (
            <p className="break-all text-xs text-muted-foreground">{profileNotice}</p>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <h3 className="text-sm font-medium">
              {shared ? "Repository instructions" : "Instructions"}
            </h3>
            <span className="break-all text-xs text-muted-foreground">
              {documentState.status === "ready"
                ? documentState.document.path
                : snapshot.instructions.canonicalPath}
            </span>
          </div>
          {shared ? (
            <ToggleGroup
              aria-label="Instruction file"
              value={[sharedFile]}
              onValueChange={(next) => {
                const value = SHARED_FILES.find((name) => name === next[0]);
                if (value === undefined || value === sharedFile) return;
                void props.confirmDiscard().then((ok) => {
                  if (!ok) return;
                  setDocumentState({ status: "loading" });
                  setSharedFile(value);
                });
              }}
            >
              {SHARED_FILES.map((name) => (
                <Toggle key={name} value={name}>
                  {name}
                </Toggle>
              ))}
            </ToggleGroup>
          ) : null}
        </div>
        {documentState.status === "loading" ? (
          <Skeleton className="h-40 w-full" />
        ) : documentState.status === "error" ? (
          <Alert variant="error">
            <AlertDescription>{documentState.message}</AlertDescription>
          </Alert>
        ) : (
          <SkillFileEditor
            key={documentState.loadId}
            label="Instructions"
            content={documentState.document.content}
            revision={documentState.document.revision}
            editable
            onSave={saveDocument}
            onDirtyChange={props.onDirtyChange}
            onReload={() =>
              void (async () => {
                if (!(await props.confirmDiscard())) return;
                setDocumentState({ status: "loading" });
                void load();
              })()
            }
          />
        )}
      </section>

      {!shared && snapshot.instructions.files.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">
            {projectPrivate ? "Repository files" : "Provider files"}
          </h3>
          <ul className="flex flex-col divide-y divide-border rounded-lg border">
            {snapshot.instructions.files.map((candidate) => (
              <li key={candidate.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">
                    {candidate.providers.map(providerDisplayName).join(", ") || "Repository"}
                  </span>
                  <span className="break-all text-xs text-muted-foreground">{candidate.path}</span>
                </div>
                {candidate.ownedLink ? (
                  <Badge variant="success">Linked</Badge>
                ) : !candidate.exists ? (
                  <Badge variant="outline">Missing</Badge>
                ) : null}
                {candidate.exists && !candidate.ownedLink ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending}
                    onClick={() => void importFile(candidate)}
                  >
                    Import
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!projectPrivate && snapshot.instructions.links.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{shared ? "Repository links" : "Provider links"}</h3>
          <p className="text-xs text-muted-foreground">
            {shared
              ? "Claude Code reads CLAUDE.md, not AGENTS.md. Linking turns CLAUDE.md into a symlink to AGENTS.md in the repository, so both read the same file. Nothing is linked until you ask."
              : "Link a provider's instruction file to these instructions so every provider reads the same text."}
          </p>
          <SkillLinkTargets
            environmentId={environmentId}
            scope={scope}
            subject={{ type: "instructions" }}
            subjectLabel={shared ? "AGENTS.md" : "your instructions"}
            links={snapshot.instructions.links}
            linkTargets={snapshot.instructions.links.map((status) => ({
              id: status.targetId,
              path: status.path,
              providers:
                snapshot.instructions.files.find((candidate) => candidate.path === status.path)
                  ?.providers ?? [],
            }))}
          />
        </section>
      ) : null}
    </div>
  );
}
