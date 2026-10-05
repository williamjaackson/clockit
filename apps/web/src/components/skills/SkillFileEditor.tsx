import { useEffect, useState, type ReactNode } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

export type SkillFileSaveOutcome =
  | { readonly _tag: "saved"; readonly revision: string | null }
  | { readonly _tag: "conflict" }
  | { readonly _tag: "failed"; readonly message: string };

/**
 * Edits one file against the revision it was read at. A save that hits a newer
 * revision on disk keeps the draft and waits for an explicit reload; it never
 * retries over the other change.
 */
export function SkillFileEditor(props: {
  readonly label: string;
  readonly content: string;
  readonly revision: string | null;
  readonly editable: boolean;
  readonly readOnlyReason?: string;
  readonly onSave: (
    content: string,
    expectedRevision: string | null,
  ) => Promise<SkillFileSaveOutcome>;
  /** Discards the draft and reads the file again. The caller confirms first when needed. */
  readonly onReload: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly footer?: ReactNode;
}) {
  const { onDirtyChange } = props;
  const [base, setBase] = useState({ content: props.content, revision: props.revision });
  const [draft, setDraft] = useState(props.content);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== base.content;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    const content = draft;
    const outcome = await props.onSave(content, base.revision);
    setSaving(false);
    switch (outcome._tag) {
      case "saved":
        setBase({ content, revision: outcome.revision });
        setConflict(false);
        return;
      case "conflict":
        setConflict(true);
        return;
      case "failed":
        setError(outcome.message);
        return;
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {conflict ? (
        <Alert variant="warning">
          <AlertTitle>This file changed since you opened it</AlertTitle>
          <AlertDescription>
            Your edits are still here and were not saved. Copy anything you want to keep, then
            reload to see the current file.
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={props.onReload}>
              Reload file
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {error !== null ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Textarea
        aria-label={props.label}
        value={draft}
        readOnly={!props.editable || saving}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-xs text-muted-foreground">
          {props.editable
            ? dirty
              ? "Unsaved changes"
              : base.revision === null
                ? "New file"
                : "Saved"
            : (props.readOnlyReason ?? "Read only")}
        </span>
        <div className="flex items-center gap-2">
          {props.footer}
          {props.editable ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={!dirty || saving}
                onClick={() => setDraft(base.content)}
              >
                Revert
              </Button>
              <Button size="sm" disabled={!dirty || saving || conflict} onClick={() => void save()}>
                {saving ? <Spinner /> : null}
                Save
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
