import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexError from "effect-codex-app-server/errors";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  type PreparedSkillOverlay,
  SkillOverlayError,
} from "../../provider/ProviderSkillOverlay.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

const DEFAULT_SETTINGS = Schema.decodeSync(CodexSettings)({});
const MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;

const overlayFor = (
  projectRoot: string,
  input: { readonly mode?: "inherit" | "replace" } = {},
): PreparedSkillOverlay => ({
  key: projectRoot,
  projectRoot,
  skills: [
    {
      name: "review",
      folderName: "review",
      description: "Review with house rules",
      directory: `/t3${projectRoot}/skills/review`,
      skillFile: `/t3${projectRoot}/skills/review/SKILL.md`,
      userInvocable: true,
      modelInvocable: true,
    },
  ],
  disabledRepoSkills: [
    {
      name: "deploy",
      folderName: "deploy",
      directory: `${projectRoot}/.agents/skills/deploy`,
      skillFile: `${projectRoot}/.agents/skills/deploy/SKILL.md`,
    },
  ],
  replaced: { names: ["review"], folderNames: [] },
  instructions: {
    mode: input.mode ?? "inherit",
    content: input.mode === "replace" ? `Rules for ${projectRoot}.` : null,
    path: `/t3${projectRoot}/AGENTS.md`,
  },
});

const nativeThread = (id: string, cwd: string) => ({
  id,
  sessionId: id,
  forkedFromId: null,
  preview: "",
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 1782622440,
  updatedAt: 1782622440,
  status: { type: "idle" },
  path: `/tmp/${id}.jsonl`,
  cwd,
  cliVersion: "0.156.0",
  source: "vscode",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
});

interface RecordedRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * A Codex app-server that answers the requests these tests make and records
 * them. Notification handlers are kept so a test can deliver one.
 */
const makeFakeClient = (requests: Array<RecordedRequest>) => {
  const notificationHandlers = new Map<
    string,
    (payload: unknown) => Effect.Effect<void, CodexError.CodexAppServerError>
  >();
  let turns = 0;
  const respond = (method: string, params: Record<string, unknown>): unknown => {
    switch (method) {
      case "initialize":
        return {
          userAgent: "T3 Code/0.156.0",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "macos",
        };
      case "thread/start":
        return { thread: nativeThread(`native-${String(params.cwd)}`, String(params.cwd)) };
      case "thread/resume":
        return { thread: nativeThread(String(params.threadId), String(params.cwd)) };
      case "turn/start":
        turns += 1;
        return {
          turn: {
            id: `turn-${turns}`,
            items: [],
            status: "inProgress",
            error: null,
            startedAt: 1782622440,
            completedAt: null,
            durationMs: null,
          },
        };
      default:
        return {};
    }
  };
  const request = (method: string, params: unknown) =>
    Effect.sync(() => {
      const record = params as Record<string, unknown>;
      requests.push({ method, params: record });
      return respond(method, record);
    });
  const client = {
    raw: {
      request,
      notify: () => Effect.void,
      respond: () => Effect.void,
      respondError: () => Effect.void,
    },
    request,
    notify: () => Effect.void,
    handleServerRequest: () => Effect.void,
    handleServerNotification: (
      method: string,
      handler: (payload: unknown) => Effect.Effect<void, CodexError.CodexAppServerError>,
    ) =>
      Effect.sync(() => {
        notificationHandlers.set(method, handler);
      }),
    handleUnknownServerRequest: () => Effect.void,
    handleUnknownServerNotification: () => Effect.void,
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  return { client, notificationHandlers };
};

const makeHarness = (input: {
  readonly resolveSkillOverlay?: (cwd: string) => PreparedSkillOverlay | undefined;
  readonly launchArgs?: string;
}) =>
  Effect.gen(function* () {
    const requests: Array<RecordedRequest> = [];
    const fake = makeFakeClient(requests);
    const adapter = CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: { ...DEFAULT_SETTINGS, launchArgs: input.launchArgs ?? "" },
      environment: {},
      clientFactory: { open: () => Effect.succeed(fake.client) },
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* makeReplayServerConfig("skill-overlay").pipe(Effect.orDie),
      ...(input.resolveSkillOverlay === undefined
        ? {}
        : {
            resolveSkillOverlay: (cwd: string) =>
              Effect.sync(() => input.resolveSkillOverlay!(cwd)),
          }),
    });

    const openThread = (cwd: string) =>
      Effect.gen(function* () {
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
        const threadId = ThreadId.make(`thread-${cwd}`);
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`session-${cwd}`),
          modelSelection: MODEL_SELECTION,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: MODEL_SELECTION,
          runtimePolicy,
        });
        let ordinal = 0;
        const startTurn = (text: string) => {
          ordinal += 1;
          const attemptId = RunAttemptId.make(`${cwd}-attempt-${ordinal}`);
          const now = DateTime.nowUnsafe();
          const turnInput: ProviderAdapterV2TurnInput = {
            appThread: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make("project-skill-overlay"),
              title: "Skill overlay",
              providerInstanceId: MODEL_SELECTION.instanceId,
              modelSelection: MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
            threadId,
            runId: RunId.make(`run-${attemptId}`),
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            attemptId,
            rootNodeId: NodeId.make(`node-${attemptId}`),
            providerThread: providerThread satisfies OrchestrationV2ProviderThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make(`message-${attemptId}`),
              text,
              attachments: [],
            },
            modelSelection: MODEL_SELECTION,
            runtimePolicy,
          };
          return runtime.startTurn(turnInput);
        };
        const resume = runtime.resumeThread({ providerThread, runtimePolicy });
        return { runtime, providerThread, startTurn, resume };
      });

    const last = (method: string) => requests.findLast((request) => request.method === method)!;
    return { openThread, requests, last, notificationHandlers: fake.notificationHandlers };
  });

const testLayer = Layer.merge(IdAllocator.layer, NodeServices.layer);

describe("CodexAdapterV2 private project skills", () => {
  it.effect("sends the same thread and turn requests without an overlay", () =>
    Effect.gen(function* () {
      const run = (resolveSkillOverlay?: (cwd: string) => PreparedSkillOverlay | undefined) =>
        Effect.gen(function* () {
          const harness = yield* makeHarness(
            resolveSkillOverlay === undefined ? {} : { resolveSkillOverlay },
          );
          const thread = yield* harness.openThread("/work/app");
          yield* thread.startTurn("please $review");
          return harness.requests;
        }).pipe(Effect.scoped);
      const baseline = yield* run();
      assert.deepEqual(yield* run(() => undefined), baseline);
      assert.deepEqual(
        baseline.find((request) => request.method === "thread/start")?.params.config,
        CodexAdapterV2.CODEX_THREAD_CONFIG,
      );
      assert.notProperty(
        baseline.find((request) => request.method === "turn/start")?.params,
        "additionalContext",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("switches off repository skills per thread and adds private context per turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        resolveSkillOverlay: (cwd) => overlayFor(cwd, { mode: "replace" }),
      });
      const first = yield* harness.openThread("/work/first");
      assert.deepEqual(harness.last("thread/start").params.config, {
        ...CodexAdapterV2.CODEX_THREAD_CONFIG,
        "skills.config": [
          { path: "/work/first/.agents/skills/deploy/SKILL.md", enabled: false },
          { name: "review", enabled: false },
        ],
        project_doc_max_bytes: 0,
      });
      yield* first.startTurn("please $review now");
      const turn = harness.last("turn/start").params;
      assert.deepEqual(turn.input, [
        { type: "text", text: "please $review now" },
        {
          type: "text",
          text: "The user invoked the private project skill `review`. Read /t3/work/first/skills/review/SKILL.md now and follow it for this request. Resolve relative paths in it against /t3/work/first/skills/review.",
        },
      ]);
      const context = turn.additionalContext as Record<string, { kind: string; value: string }>;
      assert.deepEqual(Object.keys(context), ["t3_project_instructions", "t3_private_skills"]);
      assert.include(context.t3_project_instructions!.value, "Rules for /work/first.");
      assert.include(context.t3_private_skills!.value, "/t3/work/first/skills/review/SKILL.md");

      // Compaction drops the context; the restore puts the private entries back.
      yield* harness.notificationHandlers.get("item/completed")!({
        threadId: "native-/work/first",
        turnId: "turn-1",
        item: { type: "contextCompaction", id: "compaction-1" },
      }).pipe(Effect.ignore);
      const restored = harness.last("thread/inject_items").params.items as ReadonlyArray<{
        readonly content: ReadonlyArray<{ readonly text: string }>;
      }>;
      assert.deepEqual(
        restored.map((item) => item.content[0]!.text),
        Object.entries(context).map(([key, entry]) => `<${key}>${entry.value}</${key}>`),
      );

      // Another project's session sees only its own paths.
      const second = yield* harness.openThread("/work/second");
      yield* second.startTurn("hello");
      assert.deepEqual(harness.last("thread/start").params.config, {
        ...CodexAdapterV2.CODEX_THREAD_CONFIG,
        "skills.config": [
          { path: "/work/second/.agents/skills/deploy/SKILL.md", enabled: false },
          { name: "review", enabled: false },
        ],
        project_doc_max_bytes: 0,
      });
      const secondContext = Object.values(
        harness.last("turn/start").params.additionalContext as Record<string, { value: string }>,
      )
        .map((entry) => entry.value)
        .join("\n");
      assert.include(secondContext, "/t3/work/second/skills/review/SKILL.md");
      assert.notInclude(secondContext, "/work/first");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a loaded thread's overlay until it reloads, and says so once", () =>
    Effect.gen(function* () {
      let current: PreparedSkillOverlay | undefined = overlayFor("/work/app");
      const harness = yield* makeHarness({ resolveSkillOverlay: () => current });
      const thread = yield* harness.openThread("/work/app");
      yield* thread.startTurn("one");
      const loadedContext = harness.last("turn/start").params.additionalContext;
      assert.isDefined(loadedContext);

      // Codex still applies the loaded skills.config, so the turn keeps the
      // private context that matches it instead of claiming the change.
      current = undefined;
      yield* thread.resume;
      yield* thread.startTurn("two");
      assert.deepEqual(harness.last("turn/start").params.additionalContext, loadedContext);
      yield* thread.startTurn("three please $review");
      const steeredInput = harness.last("turn/start").params.input as ReadonlyArray<{
        readonly text?: string;
      }>;
      assert.isTrue(
        steeredInput.some((item) => item.text?.includes("/t3/work/app/skills/review/SKILL.md")),
      );
      yield* thread.startTurn("four");

      const events = yield* thread.runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.ordinal === 4 &&
            event.providerTurn.status === "running",
        ),
        Stream.runCollect,
      );
      const notices = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
          ? [event.turnItem]
          : [],
      );
      assert.equal(notices.length, 1);
      assert.include(notices[0]!.message, "Codex applies them to new threads");

      // A thread loaded after the change gets the new setup.
      const fresh = yield* makeHarness({ resolveSkillOverlay: () => current });
      const freshThread = yield* fresh.openThread("/work/app");
      assert.deepEqual(
        fresh.last("thread/start").params.config,
        CodexAdapterV2.CODEX_THREAD_CONFIG,
      );
      yield* freshThread.startTurn("five");
      assert.notProperty(fresh.last("turn/start").params, "additionalContext");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails the turn when the project's private settings cannot be read", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedRequest> = [];
      const fake = makeFakeClient(requests);
      const adapter = CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_SETTINGS,
        environment: {},
        clientFactory: { open: () => Effect.succeed(fake.client) },
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig("skill-overlay-error").pipe(Effect.orDie),
        resolveSkillOverlay: () =>
          Effect.fail(new SkillOverlayError({ detail: "Manifest unreadable; fix it." })),
      });
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/work/app",
      });
      const runtime = yield* adapter.openSession({
        threadId: ThreadId.make("thread-error"),
        providerSessionId: ProviderSessionId.make("session-error"),
        modelSelection: MODEL_SELECTION,
        runtimePolicy,
      });
      const exit = yield* Effect.exit(
        runtime.ensureThread({
          threadId: ThreadId.make("thread-error"),
          modelSelection: MODEL_SELECTION,
          runtimePolicy,
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "Manifest unreadable");
      assert.isUndefined(requests.find((request) => request.method === "thread/start"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses to replace skills.config rules set in launch arguments", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        resolveSkillOverlay: (cwd) => overlayFor(cwd),
        launchArgs: `-c 'skills.config=[{name="x",enabled=false}]'`,
      });
      const exit = yield* Effect.exit(harness.openThread("/work/app"));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(Exit.isFailure(exit) ? exit.cause : ""),
        "launch arguments set skills.config",
      );
      assert.isUndefined(harness.requests.find((request) => request.method === "thread/start"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
