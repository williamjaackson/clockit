import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  type PreparedSkillOverlay,
  SkillOverlayError,
  type SkillOverlayResolver,
} from "../../provider/ProviderSkillOverlay.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const NATIVE_SESSION = "native-skill-overlay";
const DEFAULT_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;

const frame = (value: unknown) => value as SDKMessage;
const resultFrame = (uuid: string) =>
  frame({
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid,
    session_id: NATIVE_SESSION,
    terminal_reason: "completed",
  });

const privateOverlay = (
  projectRoot: string,
  privateRoot: string,
  input: { readonly key?: string; readonly mode?: "inherit" | "replace" } = {},
): PreparedSkillOverlay => ({
  key: input.key ?? "overlay-a",
  projectRoot,
  skills: [
    {
      name: "review",
      folderName: "review",
      description: "Review with house rules",
      directory: `${privateRoot}/review`,
      skillFile: `${privateRoot}/review/SKILL.md`,
      userInvocable: true,
      modelInvocable: true,
    },
  ],
  disabledRepoSkills: [
    {
      name: "deploy",
      folderName: "deploy",
      directory: `${projectRoot}/.claude/skills/deploy`,
      skillFile: `${projectRoot}/.claude/skills/deploy/SKILL.md`,
    },
  ],
  replaced: { names: ["review"], folderNames: [] },
  instructions: {
    mode: input.mode ?? "inherit",
    content: input.mode === "replace" ? "Private rule: use tabs." : null,
    path: `${privateRoot}/../AGENTS.md`,
  },
});

/**
 * One adapter with a scripted query runner. Each opened query gets its own
 * message queue; `finish` ends the turn running on the latest one.
 */
const makeHarness = (resolveSkillOverlay: SkillOverlayResolver | undefined) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-overlay-" });
    const configDir = path.join(base, "config");
    const writeSkill = (directory: string) =>
      fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(
          Effect.andThen(fileSystem.writeFileString(path.join(directory, "SKILL.md"), "# skill\n")),
        );
    const workspace = (name: string) =>
      Effect.gen(function* () {
        const cwd = path.join(base, name);
        yield* writeSkill(path.join(cwd, ".claude/skills/lint"));
        yield* writeSkill(path.join(cwd, ".claude/skills/deploy"));
        yield* writeSkill(path.join(cwd, ".claude/skills/review"));
        return cwd;
      });
    const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
    const offered: Array<SDKUserMessage> = [];
    const queues: Array<Queue.Queue<SDKMessage>> = [];
    const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: { ...DEFAULT_SETTINGS, homePath: configDir },
      environment: {},
      attachmentsDir: path.join(base, "attachments"),
      fileSystem,
      path,
      idAllocator,
      ...(resolveSkillOverlay === undefined ? {} : { resolveSkillOverlay }),
      queryRunner: {
        allocateSessionId: Effect.succeed(NATIVE_SESSION),
        open: (input) =>
          Effect.gen(function* () {
            const messages = yield* Queue.unbounded<SDKMessage>();
            opened.push(input.options);
            queues.push(messages);
            return {
              messages: Stream.fromQueue(messages),
              offer: (message: SDKUserMessage) => Effect.sync(() => void offered.push(message)),
              setModel: () => Effect.void,
              setPermissionMode: () => Effect.void,
              interrupt: Effect.void,
              close: Queue.shutdown(messages),
            };
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });

    const openThread = (cwd: string, name: string) =>
      Effect.gen(function* () {
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
        const threadId = ThreadId.make(`thread-${name}`);
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`session-${name}`),
          modelSelection: MODEL_SELECTION,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: MODEL_SELECTION,
          runtimePolicy,
        });
        const terminals = yield* Queue.unbounded<ProviderAdapterV2Event>();
        // Filled by the same consumer before each terminal, so a test reads
        // it after `runTurn` returns.
        const notices: Array<string> = [];
        yield* runtime.events.pipe(
          Stream.runForEach((event) => {
            if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
              notices.push(event.turnItem.message);
            }
            return event.type === "turn.terminal" ? Queue.offer(terminals, event) : Effect.void;
          }),
          Effect.forkScoped,
        );
        let ordinal = 0;
        const turnInput = (text: string): ProviderAdapterV2TurnInput => {
          ordinal += 1;
          const attemptId = RunAttemptId.make(`${name}-attempt-${ordinal}`);
          const now = DateTime.nowUnsafe();
          return {
            appThread: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make(`project-${name}`),
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
        };
        const runTurn = (text: string, before: ReadonlyArray<SDKMessage> = []) =>
          Effect.gen(function* () {
            yield* runtime.startTurn(turnInput(text));
            const messages = queues.at(-1)!;
            for (const message of before) yield* Queue.offer(messages, message);
            yield* Queue.offer(messages, resultFrame(`result-${name}-${ordinal}`));
            yield* Queue.take(terminals);
          });
        return {
          runtime,
          runTurn,
          notices,
          startTurn: (text: string) => runtime.startTurn(turnInput(text)),
        };
      });

    return { base, workspace, openThread, opened, offered };
  });

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const withHarness = <A, E>(
  resolveSkillOverlay: ((cwd: string) => PreparedSkillOverlay | undefined) | undefined,
  body: (harness: Harness) => Effect.Effect<A, E, Scope.Scope>,
) =>
  withHarnessResolver(
    resolveSkillOverlay === undefined
      ? undefined
      : (cwd) => Effect.sync(() => resolveSkillOverlay(cwd)),
    body,
  );

const withHarnessResolver = <A, E>(
  resolveSkillOverlay: SkillOverlayResolver | undefined,
  body: (harness: Harness) => Effect.Effect<A, E, Scope.Scope>,
) =>
  makeHarness(resolveSkillOverlay).pipe(
    Effect.flatMap(body),
    Effect.scoped,
    Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
  );

const userText = (message: SDKUserMessage) =>
  typeof message.message.content === "string"
    ? [message.message.content]
    : message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));

describe("ClaudeAdapterV2 private project skills", () => {
  it.effect("opens the same query and sends the same prompt without an overlay", () => {
    const run = (resolver: ((cwd: string) => PreparedSkillOverlay | undefined) | undefined) =>
      withHarness(resolver, (harness) =>
        Effect.gen(function* () {
          const cwd = yield* harness.workspace("app");
          const thread = yield* harness.openThread(cwd, "plain");
          yield* thread.runTurn("please $lint and $review");
          const [options] = harness.opened;
          return {
            settings: options?.settings,
            systemPrompt: options?.systemPrompt,
            additionalDirectories: options?.additionalDirectories?.map((dir) =>
              dir.replace(harness.base, "<base>"),
            ),
            prompts: harness.offered.map(userText),
          };
        }),
      );
    return Effect.gen(function* () {
      const withoutResolver = yield* run(undefined);
      assert.deepEqual(yield* run(() => undefined), withoutResolver);
      // Native dispatch still runs the last known skill.
      assert.deepEqual(withoutResolver.prompts, [["please /lint and", "/review"]]);
    });
  });

  it.effect("switches off repository copies and routes a private mention to its file", () =>
    Effect.gen(function* () {
      let projectRoot = "";
      const privateRoot = "/t3/skill-projects/app/skills";
      yield* withHarness(
        (cwd) =>
          cwd === projectRoot
            ? privateOverlay(projectRoot, privateRoot, { mode: "replace" })
            : undefined,
        (harness) =>
          Effect.gen(function* () {
            projectRoot = yield* harness.workspace("app");
            const thread = yield* harness.openThread(projectRoot, "private");
            yield* thread.runTurn("use $review then $lint");
            const options = harness.opened[0]!;
            const settings = options.settings as Record<string, unknown>;
            assert.deepEqual(settings.skillOverrides, { deploy: "off", review: "off" });
            assert.deepEqual(settings.claudeMdExcludes, [
              `${projectRoot}/**/CLAUDE.md`,
              `${projectRoot}/**/CLAUDE.local.md`,
              `${projectRoot}/**/.claude/rules/**`,
            ]);
            // The thinking-summary settings survive the merge.
            assert.equal(settings.showThinkingSummaries, true);
            const append =
              typeof options.systemPrompt === "object" && "append" in options.systemPrompt
                ? (options.systemPrompt.append ?? "")
                : "";
            assert.include(append, "Private rule: use tabs.");
            assert.include(append, `${privateRoot}/review/SKILL.md`);
            // The private copy is read by path; only the native skill runs as a command.
            assert.deepEqual(userText(harness.offered[0]!), [
              `The user invoked the private project skill \`review\`. Read ${privateRoot}/review/SKILL.md now and follow it for this request. Resolve relative paths in it against ${privateRoot}/review.`,
              "use $review then",
              "/lint",
            ]);
          }),
      );
    }),
  );

  it.effect(
    "reopens at the next turn when the overlay changes and restores native skills when cleared",
    () =>
      Effect.gen(function* () {
        let current: PreparedSkillOverlay | undefined;
        yield* withHarness(
          () => current,
          (harness) =>
            Effect.gen(function* () {
              const cwd = yield* harness.workspace("app");
              current = privateOverlay(cwd, "/t3/private/skills");
              const thread = yield* harness.openThread(cwd, "reopen");
              yield* thread.runTurn("first");
              yield* thread.runTurn("second");
              assert.equal(harness.opened.length, 1);

              current = privateOverlay(cwd, "/t3/private/skills", {
                key: "overlay-b",
                mode: "replace",
              });
              yield* thread.runTurn("third");
              assert.equal(harness.opened.length, 2);
              assert.equal(harness.opened[1]!.resume, NATIVE_SESSION);
              assert.isDefined(
                (harness.opened[1]!.settings as Record<string, unknown>).claudeMdExcludes,
              );

              current = undefined;
              yield* thread.runTurn("$review again");
              assert.equal(harness.opened.length, 3);
              const cleared = harness.opened[2]!.settings as Record<string, unknown>;
              assert.isUndefined(cleared.skillOverrides);
              assert.isUndefined(cleared.claudeMdExcludes);
              const append =
                typeof harness.opened[2]!.systemPrompt === "object" &&
                "append" in harness.opened[2]!.systemPrompt
                  ? (harness.opened[2]!.systemPrompt.append ?? "")
                  : "";
              assert.notInclude(append, "Private project");
              // The repository copy is native again.
              assert.deepEqual(userText(harness.offered.at(-1)!), ["/review again"]);
            }),
        );
      }),
  );

  it.effect("keeps the live process and its overlay while background work runs", () =>
    Effect.gen(function* () {
      let current: PreparedSkillOverlay | undefined;
      const privateRoot = "/t3/private/skills";
      yield* withHarness(
        () => current,
        (harness) =>
          Effect.gen(function* () {
            const cwd = yield* harness.workspace("app");
            current = privateOverlay(cwd, privateRoot);
            const thread = yield* harness.openThread(cwd, "background");
            yield* thread.runTurn("start a background build", [
              frame({
                type: "system",
                subtype: "task_started",
                task_id: "bg-task",
                tool_use_id: "toolu_bg",
                description: "Background build",
                is_backgrounded: true,
                task_type: "local_bash",
                uuid: "00000000-0000-4000-8000-000000000201",
                session_id: NATIVE_SESSION,
              }),
            ]);

            // Cleared while the build runs: the process keeps the overlay it
            // opened with, so the prompt still routes $review to the private
            // file the process's settings expect, and the user is told.
            current = undefined;
            yield* thread.runTurn("please $review", [
              frame({
                type: "system",
                subtype: "task_notification",
                task_id: "bg-task",
                tool_use_id: "toolu_bg",
                status: "completed",
                output_file: "/tmp/bg-task.output",
                summary: "Build finished",
                uuid: "00000000-0000-4000-8000-000000000202",
                session_id: NATIVE_SESSION,
              }),
            ]);
            assert.equal(harness.opened.length, 1);
            assert.include(userText(harness.offered[1]!)[0], `${privateRoot}/review/SKILL.md`);
            assert.equal(thread.notices.length, 1);
            assert.include(thread.notices[0], "background work finishes");

            // The build is done, so the next turn reopens without the overlay.
            yield* thread.runTurn("$review again");
            assert.equal(harness.opened.length, 2);
            const reopened = harness.opened[1]!.settings as Record<string, unknown>;
            assert.isUndefined(reopened.skillOverrides);
            assert.deepEqual(userText(harness.offered.at(-1)!), ["/review again"]);
            assert.equal(thread.notices.length, 1);
          }),
      );
    }),
  );

  it.effect("fails the turn when the project's private settings cannot be read", () =>
    withHarnessResolver(
      () => Effect.fail(new SkillOverlayError({ detail: "Manifest unreadable; fix it." })),
      (harness) =>
        Effect.gen(function* () {
          const thread = yield* harness.openThread(yield* harness.workspace("app"), "broken");
          const exit = yield* Effect.exit(thread.startTurn("hello"));
          assert.isTrue(Exit.isFailure(exit));
          assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "Manifest unreadable");
          assert.equal(harness.opened.length, 0);
        }),
    ),
  );

  it.effect("keeps each project's skills and instructions in its own session", () =>
    Effect.gen(function* () {
      const roots = new Map<string, PreparedSkillOverlay>();
      yield* withHarness(
        (cwd) => roots.get(cwd),
        (harness) =>
          Effect.gen(function* () {
            const first = yield* harness.workspace("first");
            const second = yield* harness.workspace("second");
            roots.set(first, privateOverlay(first, "/t3/first/skills", { key: "first" }));
            roots.set(second, {
              ...privateOverlay(second, "/t3/second/skills", { key: "second" }),
              disabledRepoSkills: [],
            });
            const a = yield* harness.openThread(first, "first");
            const b = yield* harness.openThread(second, "second");
            yield* a.runTurn("one");
            yield* b.runTurn("two");
            const [optionsA, optionsB] = harness.opened;
            const appendOf = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined) =>
              typeof options?.systemPrompt === "object" && "append" in options.systemPrompt
                ? (options.systemPrompt.append ?? "")
                : "";
            assert.include(appendOf(optionsA), "/t3/first/skills/review/SKILL.md");
            assert.notInclude(appendOf(optionsA), "/t3/second");
            assert.include(appendOf(optionsB), "/t3/second/skills/review/SKILL.md");
            assert.notInclude(appendOf(optionsB), "/t3/first");
            assert.deepEqual((optionsB!.settings as Record<string, unknown>).skillOverrides, {
              review: "off",
            });
          }),
      );
    }),
  );

  it.effect("refuses instruction replacement it cannot scope to the repository", () =>
    Effect.gen(function* () {
      yield* withHarness(
        () => privateOverlay("/work/[app]", "/t3/private/skills", { mode: "replace" }),
        (harness) =>
          Effect.gen(function* () {
            const thread = yield* harness.openThread(yield* harness.workspace("glob"), "glob");
            const exit = yield* Effect.exit(thread.startTurn("hello"));
            assert.isTrue(Exit.isFailure(exit));
            assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "file pattern");
            assert.equal(harness.opened.length, 0);
          }),
      );
    }),
  );
});
