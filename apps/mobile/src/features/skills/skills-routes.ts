import type { EnvironmentId, SkillProjectMode } from "@t3tools/contracts";
import {
  GLOBAL_SKILLS_SCOPE,
  type SkillsScopeSelection,
} from "@t3tools/client-runtime/state/skills";

/**
 * Every Skills screen carries the exact environment and scope it acts on, so
 * a screen pushed for one project never saves into another.
 */
export type SkillsScopeParams = {
  readonly environmentId: EnvironmentId;
  readonly projectPath?: string;
  readonly mode?: SkillProjectMode;
};

export type SkillsRoutes = {
  SettingsSkill: SkillsScopeParams & { readonly entryId: string };
  SettingsSkillFile: SkillsScopeParams & { readonly entryId: string; readonly file: string };
  SettingsSkillInstructions: SkillsScopeParams;
  SettingsSkillNew: SkillsScopeParams;
  SettingsSkillImport: SkillsScopeParams & { readonly entryId: string };
};

export function selectionFromParams(params: SkillsScopeParams): SkillsScopeSelection {
  return params.projectPath === undefined
    ? GLOBAL_SKILLS_SCOPE
    : { kind: "project", projectPath: params.projectPath, mode: params.mode ?? "local" };
}

export function paramsFromSelection(
  environmentId: EnvironmentId,
  selection: SkillsScopeSelection,
): SkillsScopeParams {
  return selection.kind === "global"
    ? { environmentId }
    : { environmentId, projectPath: selection.projectPath, mode: selection.mode };
}
