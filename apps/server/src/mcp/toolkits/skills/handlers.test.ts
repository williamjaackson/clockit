import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SkillsError,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SkillLibrary from "../../../skills/SkillLibrary.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SkillsHandlersLive } from "./handlers.ts";
import { SkillsToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("caller-thread");
const providerInstanceId = ProviderInstanceId.make("codex");

const liveCaller = {
  id: threadId,
  projectId: ProjectId.make("project"),
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  activeRunId: "active-run",
  archivedAt: null,
  deletedAt: null,
} as OrchestrationV2ThreadShell;

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "session",
  providerInstanceId,
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
};

const makeToolkit = (options: {
  readonly library: SkillLibrary.SkillLibrary["Service"];
  readonly caller?: Partial<OrchestrationV2ThreadShell>;
  readonly scope?: Partial<McpInvocationContext.McpInvocationScope>;
}) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        ...invocation,
        ...options.scope,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({ ...liveCaller, ...options.caller } as OrchestrationV2ThreadShell),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      Layer.succeed(SkillLibrary.SkillLibrary, options.library),
    );
    const toolkit = yield* SkillsToolkit.pipe(Effect.provide(SkillsHandlersLive));
    const last = <A, E, R>(handled: Effect.Effect<Stream.Stream<A, E, R>, E, R>) =>
      handled.pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)!),
        Effect.provide(dependencies),
      );
    return { toolkit, last };
  });

/** A library that records every call, then answers with `answer` or a `notFound` failure. */
const recordingLibrary = (answer?: unknown) => {
  const calls: Array<readonly [string, unknown]> = [];
  const record =
    (method: string) =>
    (input: unknown): Effect.Effect<never, SkillsError> =>
      Effect.suspend(() => {
        calls.push([method, input]);
        return answer === undefined
          ? Effect.fail(new SkillsError({ reason: "notFound", detail: "Recorded only." }))
          : Effect.succeed(answer as never);
      });
  const library = {
    list: record("list"),
    read: record("read"),
    save: record("save"),
    importSkill: record("importSkill"),
    setEnabled: record("setEnabled"),
    archive: record("archive"),
    restore: record("restore"),
    deleteRecovery: record("deleteRecovery"),
    link: record("link"),
    unlink: record("unlink"),
    readInstructions: record("readInstructions"),
    saveInstructions: record("saveInstructions"),
    importInstructions: record("importInstructions"),
    updateProjectSettings: record("updateProjectSettings"),
    setEnabledMany: record("setEnabledMany"),
    resetProject: record("resetProject"),
    syncProviders: record("syncProviders"),
    release: record("release"),
    resolveProjectOverlay: record("resolveProjectOverlay"),
    streamChanges: Stream.empty,
  } satisfies SkillLibrary.SkillLibrary["Service"];
  return { library, calls };
};

it.effect("denies mutations to callers that cannot write, before the library is called", () =>
  Effect.gen(function* () {
    const denied: ReadonlyArray<{
      readonly caller?: Partial<OrchestrationV2ThreadShell>;
      readonly scope?: Partial<McpInvocationContext.McpInvocationScope>;
      readonly code: string;
    }> = [
      { scope: { capabilities: new Set() }, code: "capability_denied" },
      { caller: { activeRunId: null }, code: "parent_not_active" },
      {
        caller: { archivedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z") },
        code: "parent_not_active",
      },
      { caller: { runtimeMode: "approval-required" }, code: "capability_denied" },
      { caller: { interactionMode: "plan" }, code: "capability_denied" },
      { scope: { environmentId: EnvironmentId.make("other") }, code: "capability_denied" },
    ];
    for (const context of denied) {
      const { library, calls } = recordingLibrary();
      const { toolkit, last } = yield* makeToolkit({ library, ...context });
      const saved = yield* last(
        toolkit.handle("t3_skills_save", {
          scope: {},
          skill: { name: "mine" },
          content: "x",
          expectedRevision: null,
        }),
      );
      const deleted = yield* last(
        toolkit.handle("t3_skills_delete_recovery", { scope: {}, recoveryId: "recovery-1" }),
      );
      const released = yield* last(toolkit.handle("t3_skills_release", { name: "mine" }));
      expect(saved.isFailure).toBe(true);
      expect(saved.result).toMatchObject({ _tag: "OrchestratorMcpFailure", code: context.code });
      expect(deleted.result).toMatchObject({ _tag: "OrchestratorMcpFailure", code: context.code });
      expect(released.result).toMatchObject({ _tag: "OrchestratorMcpFailure", code: context.code });
      expect(calls).toEqual([]);
    }
  }),
);

it.effect("lets any caller in this environment read, but not other environments", () =>
  Effect.gen(function* () {
    const { library, calls } = recordingLibrary({
      path: "/home/agents/AGENTS.md",
      exists: false,
      content: "",
      revision: null,
    });
    // Reads do not need an active run or a full-access/default thread.
    const reader = yield* makeToolkit({
      library,
      caller: { activeRunId: null, runtimeMode: "approval-required", interactionMode: "plan" },
    });
    const read = yield* reader.last(
      reader.toolkit.handle("t3_skills_read_instructions", { scope: {} }),
    );
    expect(read.isFailure).toBe(false);
    expect(calls).toEqual([["readInstructions", { scope: {} }]]);

    for (const scope of [
      { environmentId: EnvironmentId.make("other") },
      { capabilities: new Set<never>() },
    ]) {
      const outsider = yield* makeToolkit({ library, scope });
      const refused = yield* outsider.last(
        outsider.toolkit.handle("t3_skills_read_instructions", { scope: {} }),
      );
      expect(refused.result).toMatchObject({ code: "capability_denied" });
    }
    expect(calls).toHaveLength(1);
  }),
);

it.effect("forwards scope exactly as given and never assumes shared mode", () =>
  Effect.gen(function* () {
    const { library, calls } = recordingLibrary();
    const { toolkit, last } = yield* makeToolkit({ library });
    const shared = { projectPath: "/work/app", mode: "shared" as const };
    yield* last(
      toolkit.handle("t3_skills_link", {
        scope: shared,
        subject: { type: "instructions" },
        targetIds: ["claude"],
      }),
    );
    yield* last(
      toolkit.handle("t3_skills_link", {
        subject: { type: "skill", name: "mine" },
        targetIds: ["codex"],
      }),
    );
    yield* last(
      toolkit.handle("t3_skills_save_instructions", {
        scope: { projectPath: "/work/app" },
        content: "Private notes",
        expectedRevision: null,
      }),
    );
    expect(calls).toStrictEqual([
      ["link", { scope: shared, subject: { type: "instructions" }, targetIds: ["claude"] }],
      ["link", { subject: { type: "skill", name: "mine" }, targetIds: ["codex"] }],
      [
        "saveInstructions",
        { scope: { projectPath: "/work/app" }, content: "Private notes", expectedRevision: null },
      ],
    ]);
  }),
);

it.effect("returns a skills failure's reason, path, and revision without its cause", () =>
  Effect.gen(function* () {
    const { library } = recordingLibrary();
    const { toolkit, last } = yield* makeToolkit({
      library: {
        ...library,
        save: () =>
          Effect.fail(
            new SkillsError({
              reason: "revisionConflict",
              detail: "The file changed since it was read.",
              path: "/t3/skills/mine/SKILL.md",
              currentRevision: "rev-2",
              cause: new Error("EACCES: private host detail"),
            }),
          ),
      },
    });
    const result = yield* last(
      toolkit.handle("t3_skills_save", {
        scope: {},
        skill: { name: "mine" },
        content: "x",
        expectedRevision: "rev-1",
      }),
    );
    expect(result.isFailure).toBe(true);
    expect(result.encodedResult).toStrictEqual({
      _tag: "SkillsError",
      reason: "revisionConflict",
      detail: "The file changed since it was read.",
      path: "/t3/skills/mine/SKILL.md",
      currentRevision: "rev-2",
    });
  }),
);

it.layer(NodeServices.layer)("with the real skill library", (it) => {
  it.effect("saves, reads, and rejects a stale revision, announcing only real changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skills-mcp-" }),
      );
      const project = path.join(root, "project");
      yield* Effect.forEach([path.join(root, "home"), path.join(root, "t3"), project], (dir) =>
        fileSystem.makeDirectory(dir, { recursive: true }),
      );
      // Built into the test scope so the change stream outlives this statement.
      const library = yield* SkillLibrary.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(root, path.join(root, "t3")),
            ServerSettings.layerTest(),
          ),
        ),
        Layer.build,
        Effect.map(Context.get(SkillLibrary.SkillLibrary)),
        Effect.provideService(HostProcessEnvironment, { HOME: path.join(root, "home") }),
      );
      // Three changes: the two MCP saves, then a project change made directly.
      // A duplicate or a published rejection would push the project change out.
      const changes = yield* library.streamChanges.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      const { toolkit, last } = yield* makeToolkit({ library });

      const created = yield* last(
        toolkit.handle("t3_skills_save", {
          scope: {},
          skill: { name: "mine" },
          content: "---\ndescription: Mine\n---\nv1\n",
          expectedRevision: null,
        }),
      );
      expect(created.isFailure).toBe(false);
      const read = yield* last(
        toolkit.handle("t3_skills_read", { scope: {}, skill: { name: "mine" } }),
      );
      expect(read.result).toMatchObject({
        content: "---\ndescription: Mine\n---\nv1\n",
        revision: (created.result as { revision: string }).revision,
      });
      const revision = (read.result as { revision: string }).revision;

      const stale = yield* last(
        toolkit.handle("t3_skills_save", {
          scope: {},
          skill: { name: "mine" },
          content: "lost",
          expectedRevision: "stale",
        }),
      );
      expect(stale.isFailure).toBe(true);
      expect(stale.encodedResult).toMatchObject({
        _tag: "SkillsError",
        reason: "revisionConflict",
        currentRevision: revision,
      });
      expect(stale.encodedResult).not.toHaveProperty("cause");

      const updated = yield* last(
        toolkit.handle("t3_skills_save", {
          scope: {},
          skill: { name: "mine" },
          content: "---\ndescription: Mine\n---\nv2\n",
          expectedRevision: revision,
        }),
      );
      expect(updated.isFailure).toBe(false);
      expect(yield* fileSystem.readFileString(path.join(root, "t3/skills/mine/SKILL.md"))).toBe(
        "---\ndescription: Mine\n---\nv2\n",
      );

      yield* library.updateProjectSettings({ projectPath: project, instructionMode: "append" });
      const announced = yield* Fiber.join(changes);
      expect(announced.map((change) => change.projectRoot)).toEqual([
        undefined,
        undefined,
        project,
      ]);
    }),
  );
});
