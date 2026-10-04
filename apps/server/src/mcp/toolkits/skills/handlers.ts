import { OrchestratorMcpFailure, SkillsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Skills from "../../../skills/SkillLibrary.ts";
import { readCaller, readMutationCaller } from "../../threadAccess.ts";
import { SkillsToolkit } from "./tools.ts";

/** Keep the reason, detail, path, and revision the agent acts on; drop the underlying cause. */
const skillsFailure = ({ reason, detail, path, currentRevision, conflictPaths }: SkillsError) =>
  new SkillsError({
    reason,
    detail,
    ...(path === undefined ? {} : { path }),
    ...(currentRevision === undefined ? {} : { currentRevision }),
    ...(conflictPaths === undefined ? {} : { conflictPaths }),
  });

/**
 * Skills live on this environment's host, so the credential must belong to it.
 * Every check runs before the library is touched.
 */
const access = (writable: boolean) =>
  Effect.gen(function* () {
    const { scope, caller } = yield* writable ? readMutationCaller() : readCaller();
    const environment = yield* Environment.ServerEnvironment;
    if ((yield* environment.getEnvironmentId) !== scope.environmentId)
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential belongs to another environment.",
      });
    if (
      writable &&
      (caller.archivedAt !== null ||
        caller.runtimeMode !== "full-access" ||
        caller.interactionMode !== "default")
    )
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Skill changes require a live full-access/default calling thread.",
      });
    return yield* Skills.SkillLibrary;
  });

const call =
  (writable: boolean) =>
  <A>(run: (library: Skills.SkillLibrary["Service"]) => Effect.Effect<A, SkillsError>) =>
    access(writable).pipe(
      Effect.flatMap((library) => run(library).pipe(Effect.mapError(skillsFailure))),
    );
const read = call(false);
const write = call(true);

export const SkillsHandlersLive = SkillsToolkit.toLayer({
  t3_skills_list: (input) => read((library) => library.list(input)),
  t3_skills_read: (input) => read((library) => library.read(input)),
  t3_skills_save: (input) => write((library) => library.save(input)),
  t3_skills_import: (input) => write((library) => library.importSkill(input)),
  t3_skills_set_enabled: (input) => write((library) => library.setEnabled(input)),
  t3_skills_archive: (input) => write((library) => library.archive(input)),
  t3_skills_restore: (input) => write((library) => library.restore(input)),
  t3_skills_delete_recovery: (input) => write((library) => library.deleteRecovery(input)),
  t3_skills_link: (input) => write((library) => library.link(input)),
  t3_skills_unlink: (input) => write((library) => library.unlink(input)),
  t3_skills_read_instructions: (input) => read((library) => library.readInstructions(input)),
  t3_skills_save_instructions: (input) => write((library) => library.saveInstructions(input)),
  t3_skills_import_instructions: (input) => write((library) => library.importInstructions(input)),
  t3_skills_update_project_settings: (input) =>
    write((library) => library.updateProjectSettings(input)),
});
