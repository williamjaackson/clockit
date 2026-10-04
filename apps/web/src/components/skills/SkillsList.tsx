import type { SkillEntry, SkillOwnership } from "@t3tools/contracts";
import {
  isUnlinkedLibrarySkill,
  providerDisplayName,
  SKILL_ENTRY_FILTERS,
  type SkillEntryFilter,
} from "@t3tools/client-runtime/state/skills";
import { SearchIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const OWNERSHIP_LABEL: Record<SkillOwnership, string> = {
  managed: "Library",
  unmanaged: "Not in library",
  plugin: "Plugin",
  system: "Built-in",
};

export function SkillBadges(props: { readonly entry: SkillEntry }) {
  const { entry } = props;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant={entry.ownership === "managed" ? "secondary" : "outline"} size="sm">
        {OWNERSHIP_LABEL[entry.ownership]}
      </Badge>
      {!entry.enabled ? (
        <Badge variant="outline" size="sm">
          Disabled
        </Badge>
      ) : null}
      {isUnlinkedLibrarySkill(entry) ? (
        <Badge variant="info" size="sm">
          Not linked
        </Badge>
      ) : null}
      {entry.conflicts.length > 0 ? (
        <Badge variant="warning" size="sm">
          Same name
        </Badge>
      ) : null}
      {entry.providers.length > 0 ? (
        <span className="text-xs text-muted-foreground">
          {entry.providers.map(providerDisplayName).join(", ")}
        </span>
      ) : null}
    </div>
  );
}

export function SkillsFilterBar(props: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly filter: SkillEntryFilter;
  readonly onFilterChange: (filter: SkillEntryFilter) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <InputGroup className="min-w-0 flex-1">
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search skills"
          placeholder="Search by name, description, or provider"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
      </InputGroup>
      <Select
        value={props.filter}
        onValueChange={(value) => {
          const next = SKILL_ENTRY_FILTERS.find((option) => option.value === value);
          if (next) props.onFilterChange(next.value);
        }}
      >
        <SelectTrigger aria-label="Show" className="w-auto min-w-0">
          <SelectValue>
            {SKILL_ENTRY_FILTERS.find((option) => option.value === props.filter)?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {SKILL_ENTRY_FILTERS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

export function SkillsList(props: {
  readonly entries: ReadonlyArray<SkillEntry>;
  readonly selectedId: string | null;
  readonly onSelect: (entryId: string) => void;
}) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border" aria-label="Skills">
      {props.entries.map((entry) => {
        const selected = entry.id === props.selectedId;
        return (
          <li key={entry.id}>
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              className={cn(
                "flex w-full min-w-0 flex-col items-start gap-1 px-3 py-2.5 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent/50",
                selected && "bg-accent",
              )}
              onClick={() => props.onSelect(entry.id)}
            >
              <span
                className={cn(
                  "w-full truncate text-sm font-medium",
                  !entry.enabled && "text-muted-foreground",
                )}
              >
                {entry.name}
              </span>
              {entry.description ? (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {entry.description}
                </span>
              ) : null}
              <SkillBadges entry={entry} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
