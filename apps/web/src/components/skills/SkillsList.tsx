import type { ResolvedSkillScope, SkillEntry, SkillsSnapshot } from "@t3tools/contracts";
import {
  canResetSection,
  providerDisplayName,
  skillBulkEntries,
  skillEntryFilters,
  skillProviderReach,
  skillReachLabel,
  skillRowStatus,
  skillToggle,
  type SkillEntryFilter,
  type SkillProviderReach,
  type SkillSection,
} from "@t3tools/client-runtime/state/skills";
import { MoreHorizontalIcon, SearchIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

/**
 * One icon per agent T3 can give skills to. Agents that don't get the skill
 * are dimmed. The icons are decoration; `skillReachLabel` names the agents.
 */
export function SkillAgentIcons(props: { readonly reach: ReadonlyArray<SkillProviderReach> }) {
  if (props.reach.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1" aria-hidden>
      {props.reach.map((item) => (
        <ProviderInstanceIcon
          key={item.provider}
          driverKind={item.provider}
          displayName={providerDisplayName(item.provider)}
          className={cn("z-0", !item.on && "opacity-30 grayscale")}
          iconClassName="size-3.5"
        />
      ))}
    </span>
  );
}

export function SkillsFilterBar(props: {
  readonly scope: ResolvedSkillScope;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly filter: SkillEntryFilter;
  readonly onFilterChange: (filter: SkillEntryFilter) => void;
}) {
  const filters = skillEntryFilters(props.scope);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <InputGroup className="min-w-0 flex-1">
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search skills"
          placeholder="Search skills"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
      </InputGroup>
      <Select
        value={props.filter}
        onValueChange={(value) => {
          const next = filters.find((option) => option.value === value);
          if (next) props.onFilterChange(next.value);
        }}
      >
        <SelectTrigger aria-label="Show" className="w-auto min-w-0 max-w-36">
          <SelectValue>
            {filters.find((option) => option.value === props.filter)?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {filters.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

export interface SkillsListActions {
  readonly selectedId: string | null;
  readonly onSelect: (entryId: string) => void;
  /** Skill ids with a switch request in flight, and the value it asks for. */
  readonly pending: ReadonlyMap<string, boolean>;
  readonly onToggle: (entry: SkillEntry, enabled: boolean) => void;
  readonly onBulk: (section: SkillSection, enabled: boolean) => void;
  readonly onReset: (section: SkillSection) => void;
  readonly onShowOffInMySkills: () => void;
  readonly onOpenMySkills: () => void;
  readonly showOffInMySkills: boolean;
}

function SkillRow(props: {
  readonly entry: SkillEntry;
  readonly snapshot: SkillsSnapshot;
  readonly actions: SkillsListActions;
}) {
  const { entry, snapshot, actions } = props;
  const selected = entry.id === actions.selectedId;
  const toggle = skillToggle(entry, snapshot.scope);
  const requested = actions.pending.get(entry.id);
  const checked = requested ?? toggle?.checked ?? false;
  const reach = skillProviderReach(entry, snapshot);
  const status = skillRowStatus(entry, snapshot.scope);
  return (
    <li
      className={cn(
        "flex min-w-0 items-start gap-3 px-3 py-2 hover:bg-accent/50 has-[button:focus-visible]:bg-accent/50",
        selected && "bg-accent hover:bg-accent",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left outline-none"
        onClick={() => actions.onSelect(entry.id)}
      >
        <span
          className={cn(
            "w-full break-words text-sm font-medium",
            !checked && toggle !== null && "text-muted-foreground",
          )}
        >
          {entry.name}
        </span>
        {entry.description ? (
          <span className="w-full truncate text-xs text-muted-foreground">{entry.description}</span>
        ) : null}
        {reach.length > 0 || status !== null ? (
          <span className="flex w-full min-w-0 items-center gap-2 pt-0.5">
            <SkillAgentIcons reach={reach} />
            <span className="sr-only">Agents: {skillReachLabel(reach)}.</span>
            {status !== null ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{status}</span>
            ) : null}
          </span>
        ) : null}
      </button>
      {toggle !== null ? (
        <Switch
          size="sm"
          className="mt-0.5"
          aria-label={`Use ${entry.name}`}
          title={toggle.disabledReason ?? undefined}
          checked={checked}
          disabled={requested !== undefined || toggle.disabledReason !== null}
          onCheckedChange={(next) => actions.onToggle(entry, next)}
        />
      ) : null}
    </li>
  );
}

/** Bulk switches for one project section. The rows keep their own switches. */
function SectionMenu(props: {
  readonly section: SkillSection;
  readonly scope: ResolvedSkillScope;
  readonly actions: SkillsListActions;
}) {
  const { section, scope, actions } = props;
  const busy = section.all.some((entry) => actions.pending.has(entry.id));
  const canReset = canResetSection(section);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={busy}
            aria-label={`Actions for ${section.title}`}
          />
        }
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem
          disabled={skillBulkEntries(section.all, scope, true).length === 0}
          onClick={() => actions.onBulk(section, true)}
        >
          Turn all on
        </MenuItem>
        <MenuItem
          disabled={skillBulkEntries(section.all, scope, false).length === 0}
          onClick={() => actions.onBulk(section, false)}
        >
          Turn all off
        </MenuItem>
        {section.id === "inherited" || section.id === "repository" ? (
          <>
            <MenuSeparator />
            <MenuItem disabled={!canReset} onClick={() => actions.onReset(section)}>
              Reset to default…
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The skills of one scope, by section. My skills and repository mode have a
 * single section and no header; a project's private view heads each section
 * with its count and bulk switches.
 */
export function SkillsList(props: {
  readonly sections: ReadonlyArray<SkillSection>;
  readonly snapshot: SkillsSnapshot;
  readonly actions: SkillsListActions;
}) {
  const { snapshot, actions } = props;
  const privateProject = snapshot.scope.kind === "project" && snapshot.scope.mode !== "shared";
  return (
    <div className="flex flex-col">
      {props.sections.map((section) => (
        <section key={section.id} aria-label={section.title} className="flex flex-col">
          {privateProject ? (
            <div className="flex min-h-9 items-center gap-2 border-b border-border/60 px-3 pt-2 pb-1">
              <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                {section.title}
                <span className="ml-1.5 tabular-nums">{section.all.length}</span>
              </h3>
              <SectionMenu section={section} scope={snapshot.scope} actions={actions} />
            </div>
          ) : null}
          {section.entries.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border">
              {section.entries.map((entry) => (
                <SkillRow key={entry.id} entry={entry} snapshot={snapshot} actions={actions} />
              ))}
            </ul>
          ) : section.all.length > section.offInMySkills ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No skills match.</p>
          ) : null}
          {section.offInMySkills > 0 && !actions.showOffInMySkills ? (
            <div className="flex flex-wrap items-center gap-x-1 px-3 py-2 text-xs text-muted-foreground">
              <span>
                {section.offInMySkills} {section.offInMySkills === 1 ? "skill is" : "skills are"}{" "}
                off in My skills.
              </span>
              <Button size="xs" variant="ghost" onClick={actions.onShowOffInMySkills}>
                Show
              </Button>
              <Button size="xs" variant="ghost" onClick={actions.onOpenMySkills}>
                Open My skills
              </Button>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
