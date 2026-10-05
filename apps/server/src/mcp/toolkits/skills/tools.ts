import {
  OrchestratorMcpFailure,
  SkillInstructionsDocument,
  SkillsArchiveInput,
  SkillsArchiveResult,
  SkillsError,
  SkillsImportInput,
  SkillsImportInstructionsInput,
  SkillsImportResult,
  SkillsLinkInput,
  SkillsLinkResult,
  SkillsListInput,
  SkillsReadInput,
  SkillsReadInstructionsInput,
  SkillsReadResult,
  SkillsRecoveryInput,
  SkillsReleaseInput,
  SkillsReleaseResult,
  SkillsResetProjectInput,
  SkillsResetProjectResult,
  SkillsRestoreResult,
  SkillsSaveInput,
  SkillsSaveInstructionsInput,
  SkillsSaveResult,
  SkillsSetEnabledInput,
  SkillsSetEnabledManyInput,
  SkillsSetEnabledResult,
  SkillsSnapshot,
  SkillsSyncProvidersInput,
  SkillsSyncProvidersResult,
  SkillsUnlinkInput,
  SkillsUnlinkResult,
  SkillsUpdateProjectSettingsInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SkillLibrary from "../../../skills/SkillLibrary.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const SCOPE_HELP =
  'scope {} is the global library in the T3 home. scope {projectPath} is the private profile for that project, kept outside the checkout and seen only by T3-launched agents. Only scope {projectPath, mode:"shared"} touches files inside the repository; pass it on every call that should, it is never assumed. Paths are on this environment\'s host.';

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, SkillsError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    SkillLibrary.SkillLibrary,
  ],
};
const MUTATION = "Requires a live full-access/default calling thread.";

const SkillsListTool = Tool.make("t3_skills_list", {
  ...shared,
  description: `List skills, link targets, provider support, instruction files, and recovery items for one scope. Metadata only; read contents with t3_skills_read. ${SCOPE_HELP}`,
  parameters: SkillsListInput,
  success: SkillsSnapshot,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const SkillsReadTool = Tool.make("t3_skills_read", {
  ...shared,
  description:
    "Read one file of a listed skill, SKILL.md by default. Address a library skill by name or any listed entry by entryId. Keep the returned revision to save edits.",
  parameters: SkillsReadInput,
  success: SkillsReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const SkillsSaveTool = Tool.make("t3_skills_save", {
  ...shared,
  description: `Write one file of an editable skill. Pass the revision from t3_skills_read as expectedRevision, or null to create the file; a stale revision fails with revisionConflict and currentRevision instead of overwriting. ${MUTATION}`,
  parameters: SkillsSaveInput,
  success: SkillsSaveResult,
}).annotate(Tool.Destructive, true);
const SkillsImportTool = Tool.make("t3_skills_import", {
  ...shared,
  description: `Copy a listed skill folder into this scope's library. adoptOriginal:true (global scope only) moves the provider original to recovery and links the library copy in its place. ${MUTATION}`,
  parameters: SkillsImportInput,
  success: SkillsImportResult,
}).annotate(Tool.Destructive, true);
const SkillsSetEnabledTool = Tool.make("t3_skills_set_enabled", {
  ...shared,
  description: `Enable or disable a skill for this scope. Disabling a global library skill removes only T3's links and enabling puts them back; skippedLinks lists paths something else now occupies. ${MUTATION}`,
  parameters: SkillsSetEnabledInput,
  success: SkillsSetEnabledResult,
}).annotate(Tool.Destructive, true);
const SkillsSetEnabledManyTool = Tool.make("t3_skills_set_enabled_many", {
  ...shared,
  description: `Enable or disable several skills of one scope together; either every one changes or none do. In a project scope, inherited:<name> entries switch a global library skill off for that project only, and one that is off globally cannot be switched on there. ${MUTATION}`,
  parameters: SkillsSetEnabledManyInput,
  success: SkillsSetEnabledResult,
}).annotate(Tool.Destructive, true);
const SkillsResetProjectTool = Tool.make("t3_skills_reset_project", {
  ...shared,
  description: `Switch a project's inherited global skills and/or repository skills back on by clearing its private switches for the named sections. Private skills are left alone. ${MUTATION}`,
  parameters: SkillsResetProjectInput,
  success: SkillsResetProjectResult,
}).annotate(Tool.Destructive, true);
const SkillsSyncProvidersTool = Tool.make("t3_skills_sync_providers", {
  ...shared,
  description: `Link enabled global library skills into the default provider folders they do not reach yet, so every provider enabled in T3 gets them. Never removes or replaces anything, and skips folders the user unlinked a skill from; skippedLinks lists occupied paths. ${MUTATION}`,
  parameters: SkillsSyncProvidersInput,
  success: SkillsSyncProvidersResult,
}).annotate(Tool.Destructive, true);
const SkillsReleaseTool = Tool.make("t3_skills_release", {
  ...shared,
  description: `Stop managing a global library skill: move its current folder to destination and repoint T3's links there, so the same providers keep it. Run with dryRun:true first and show the user the destination. A disabled skill needs a destination outside every provider skill folder. ${MUTATION}`,
  parameters: SkillsReleaseInput,
  success: SkillsReleaseResult,
}).annotate(Tool.Destructive, true);
const SkillsArchiveTool = Tool.make("t3_skills_archive", {
  ...shared,
  description: `Delete a library skill by moving it to recovery and removing T3's links. Undo with t3_skills_restore. ${MUTATION}`,
  parameters: SkillsArchiveInput,
  success: SkillsArchiveResult,
}).annotate(Tool.Destructive, true);
const SkillsRestoreTool = Tool.make("t3_skills_restore", {
  ...shared,
  description: `Put a recovery item back: an archived skill returns to the library, or a replaced provider original moves back in place of T3's link. ${MUTATION}`,
  parameters: SkillsRecoveryInput,
  success: SkillsRestoreResult,
}).annotate(Tool.Destructive, true);
const SkillsDeleteRecoveryTool = Tool.make("t3_skills_delete_recovery", {
  ...shared,
  description: `Permanently delete one recovery item by its recoveryId. This cannot be undone and nothing is cleaned up automatically. ${MUTATION}`,
  parameters: SkillsRecoveryInput,
  success: SkillsSnapshot,
}).annotate(Tool.Destructive, true);
const SkillsLinkTool = Tool.make("t3_skills_link", {
  ...shared,
  description: `Link a library skill or this scope's instructions into provider folders by targetId from t3_skills_list. Scope defaults to global; a project scope must pass mode:"shared". An occupied target fails the whole request unless replace:true, which moves the occupant to recovery first. ${MUTATION}`,
  parameters: SkillsLinkInput,
  success: SkillsLinkResult,
}).annotate(Tool.Destructive, true);
const SkillsUnlinkTool = Tool.make("t3_skills_unlink", {
  ...shared,
  description: `Remove T3's links for a library skill or this scope's instructions from the given targets. Links T3 does not own are left alone. ${MUTATION}`,
  parameters: SkillsUnlinkInput,
  success: SkillsUnlinkResult,
}).annotate(Tool.Destructive, true);
const SkillsReadInstructionsTool = Tool.make("t3_skills_read_instructions", {
  ...shared,
  description: `Read this scope's canonical instructions. In shared mode, file picks the repository AGENTS.md or CLAUDE.md. Keep the returned revision to save edits. ${SCOPE_HELP}`,
  parameters: SkillsReadInstructionsInput,
  success: SkillInstructionsDocument,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const SkillsSaveInstructionsTool = Tool.make("t3_skills_save_instructions", {
  ...shared,
  description: `Write this scope's canonical instructions. Pass the revision from t3_skills_read_instructions as expectedRevision, or null when none exist yet; a stale revision fails with revisionConflict instead of overwriting. ${MUTATION}`,
  parameters: SkillsSaveInstructionsInput,
  success: SkillInstructionsDocument,
}).annotate(Tool.Destructive, true);
const SkillsImportInstructionsTool = Tool.make("t3_skills_import_instructions", {
  ...shared,
  description: `Copy a listed instruction file (sourceId from t3_skills_list instructions.files) into this scope's canonical instructions. Global or private project scope only. Existing canonical instructions need their current revision as expectedRevision. ${MUTATION}`,
  parameters: SkillsImportInstructionsInput,
  success: SkillInstructionsDocument,
}).annotate(Tool.Destructive, true);
const SkillsUpdateProjectSettingsTool = Tool.make("t3_skills_update_project_settings", {
  ...shared,
  description: `Set how a project's private instructions combine with the repository's for T3 agents: inherit, append, replace, or off. Omitted fields are preserved. ${MUTATION}`,
  parameters: SkillsUpdateProjectSettingsInput,
  success: SkillsSnapshot,
}).annotate(Tool.Destructive, true);

export const SkillsToolkit = Toolkit.make(
  SkillsListTool,
  SkillsReadTool,
  SkillsSaveTool,
  SkillsImportTool,
  SkillsSetEnabledTool,
  SkillsArchiveTool,
  SkillsRestoreTool,
  SkillsDeleteRecoveryTool,
  SkillsLinkTool,
  SkillsUnlinkTool,
  SkillsReadInstructionsTool,
  SkillsSaveInstructionsTool,
  SkillsImportInstructionsTool,
  SkillsUpdateProjectSettingsTool,
  SkillsSetEnabledManyTool,
  SkillsResetProjectTool,
  SkillsSyncProvidersTool,
  SkillsReleaseTool,
);
