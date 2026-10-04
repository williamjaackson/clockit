import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

/** Section heading used across the skills page, matching settings section titles. */
export function SkillsSectionTitle(props: { readonly children: ReactNode }) {
  return <h3 className="text-sm font-normal text-foreground/70">{props.children}</h3>;
}

/** A closed-by-default section for paths and other details most people never need. */
export function SkillsDisclosure(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex min-h-7 items-center gap-1.5 rounded-md text-sm font-normal text-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        {props.title}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-3 pt-2 pl-5">{props.children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** One labelled path inside a disclosure. Selectable so it can be copied. */
export function SkillsPathRow(props: { readonly label: string; readonly path: string }) {
  return (
    <div className="flex min-w-0 flex-col text-xs">
      <span className="text-foreground">{props.label}</span>
      <span className="break-all text-muted-foreground select-text">{props.path}</span>
    </div>
  );
}
