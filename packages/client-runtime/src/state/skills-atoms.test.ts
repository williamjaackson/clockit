import {
  EnvironmentId,
  WS_METHODS,
  type ServerConfig,
  type SkillScope,
  type SkillsSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createSkillsEnvironmentAtoms, type SkillsTarget } from "./skills.ts";

const ENV_A = EnvironmentId.make("skills-a");
const ENV_B = EnvironmentId.make("skills-b");
const GLOBAL: SkillScope = {};
const SHARED: SkillScope = { projectPath: "/repo", mode: "shared" };

/** A snapshot told apart by its only warning. */
function snapshot(label: string): SkillsSnapshot {
  return {
    scope: { kind: "global", libraryPath: "/home/me/.t3/skills" },
    entries: [],
    linkTargets: [],
    providers: [],
    instructions: {
      canonicalPath: "/home/me/.t3/instructions/AGENTS.md",
      canonicalExists: false,
      files: [],
      links: [],
    },
    recovery: [],
    warnings: [label],
  };
}

interface Call {
  readonly environmentId: EnvironmentId;
  readonly method: string;
  readonly scope: SkillScope;
  readonly reply: Deferred.Deferred<SkillsSnapshot>;
}

const makeHarness = Effect.fn("SkillsAtomsTest.makeHarness")(function* () {
  // Every request waits here until the test answers it.
  const calls = yield* Queue.unbounded<Call>();
  const answer = (environmentId: EnvironmentId, method: string, scope: SkillScope | undefined) =>
    Effect.gen(function* () {
      const reply = yield* Deferred.make<SkillsSnapshot>();
      yield* Queue.offer(calls, { environmentId, method, scope: scope ?? {}, reply });
      return yield* Deferred.await(reply);
    });

  const supervisorFor = (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.skillsList]: (input: { readonly scope: SkillScope }) =>
          answer(environmentId, "list", input.scope),
        [WS_METHODS.skillsSave]: (input: { readonly scope: SkillScope }) =>
          answer(environmentId, "save", input.scope).pipe(
            Effect.map((next) => ({ path: "/x", revision: "r", snapshot: next })),
          ),
        [WS_METHODS.skillsSetEnabled]: (input: { readonly scope: SkillScope }) =>
          answer(environmentId, "setEnabled", input.scope).pipe(
            Effect.map((next) => ({ skippedLinks: [], snapshot: next })),
          ),
        [WS_METHODS.skillsLink]: (input: { readonly scope?: SkillScope }) =>
          answer(environmentId, "link", input.scope).pipe(
            Effect.map((next) => ({ linked: [], recovery: [], snapshot: next })),
          ),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.succeed({} as ServerConfig),
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      return EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: "https://environment.example.test",
          wsBaseUrl: "wss://environment.example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
    });
  const supervisors = new Map([
    [ENV_A, yield* supervisorFor(ENV_A)],
    [ENV_B, yield* supervisorFor(ENV_B)],
  ]);
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (environmentId, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisors.get(environmentId)!,
      ),
    followStream: (environmentId, stream) =>
      Stream.provideService(
        stream,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisors.get(environmentId)!,
      ),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const atoms = createSkillsEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments)),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );

  const mount = (target: SkillsTarget) =>
    Effect.acquireRelease(
      Effect.sync(() => registry.mount(atoms.view(target))),
      (unmount) => Effect.sync(unmount),
    );
  /** Waits until the view settles on a snapshot with this label. */
  const settledOn = (target: SkillsTarget, label: string) =>
    AtomRegistry.toStream(registry, atoms.view(target)).pipe(
      Stream.filter((view) => !view.isLoading && view.snapshot?.warnings[0] === label),
      Stream.runHead,
    );
  const settled = (target: SkillsTarget) =>
    AtomRegistry.toStream(registry, atoms.view(target)).pipe(
      Stream.filter((view) => !view.isLoading),
      Stream.runHead,
      Effect.map((view) => Option.getOrThrow(view).snapshot?.warnings[0]),
    );
  const reply = (call: Call, label: string) => Deferred.succeed(call.reply, snapshot(label));
  return { atoms, registry, calls, mount, settledOn, settled, reply };
});

it.effect("a scan that started before a save never replaces the save's snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const target = { environmentId: ENV_A, scope: GLOBAL };
      yield* harness.mount(target);
      const staleScan = yield* Queue.take(harness.calls);
      expect(staleScan.method).toBe("list");

      const saving = harness.atoms.save.run(harness.registry, {
        environmentId: ENV_A,
        input: { scope: GLOBAL, skill: { name: "review" }, content: "x", expectedRevision: null },
      });
      const save = yield* Queue.take(harness.calls);
      expect(save.method).toBe("save");
      yield* harness.reply(save, "saved");
      expect((yield* Effect.promise(() => saving))._tag).toBe("Success");

      // The older scan lands last. The view keeps the save's answer.
      yield* harness.reply(staleScan, "stale");
      expect(yield* harness.settled(target)).toBe("saved");

      // An explicit refresh starts after the save, so its answer wins.
      harness.atoms.refresh(harness.registry, target);
      const refresh = yield* Queue.take(harness.calls);
      expect(refresh.method).toBe("list");
      yield* harness.reply(refresh, "refreshed");
      yield* harness.settledOn(target, "refreshed");
    }),
  ),
);

it.effect("a mutation's snapshot only reaches its own environment and scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const globalA = { environmentId: ENV_A, scope: GLOBAL };
      const sharedA = { environmentId: ENV_A, scope: SHARED };
      const globalB = { environmentId: ENV_B, scope: GLOBAL };
      yield* harness.mount(globalA);
      yield* harness.mount(sharedA);
      yield* harness.mount(globalB);
      for (let index = 0; index < 3; index += 1) {
        const call = yield* Queue.take(harness.calls);
        yield* harness.reply(call, `${call.environmentId}:${call.scope.mode ?? "global"}`);
      }
      yield* harness.settledOn(globalA, "skills-a:global");
      yield* harness.settledOn(sharedA, "skills-a:shared");
      yield* harness.settledOn(globalB, "skills-b:global");

      // A shared link carries its scope; the global views stay as they were.
      const linking = harness.atoms.link.run(harness.registry, {
        environmentId: ENV_A,
        input: { scope: SHARED, subject: { type: "instructions" }, targetIds: ["claude"] },
      });
      const link = yield* Queue.take(harness.calls);
      expect(link).toMatchObject({ method: "link", scope: SHARED });
      yield* harness.reply(link, "linked");
      yield* Effect.promise(() => linking);
      yield* harness.settledOn(sharedA, "linked");
      expect(yield* harness.settled(globalA)).toBe("skills-a:global");
      expect(yield* harness.settled(globalB)).toBe("skills-b:global");

      // A link without a scope is about the global library.
      const globalLinking = harness.atoms.link.run(harness.registry, {
        environmentId: ENV_B,
        input: { subject: { type: "skill", name: "review" }, targetIds: ["claude"] },
      });
      yield* harness.reply(yield* Queue.take(harness.calls), "b-linked");
      yield* Effect.promise(() => globalLinking);
      yield* harness.settledOn(globalB, "b-linked");
      expect(yield* harness.settled(globalA)).toBe("skills-a:global");
    }),
  ),
);

it.effect("mutations run one at a time per environment and land in order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const target = { environmentId: ENV_A, scope: GLOBAL };
      yield* harness.mount(target);
      yield* harness.reply(yield* Queue.take(harness.calls), "initial");
      yield* harness.settledOn(target, "initial");

      const saving = harness.atoms.save.run(harness.registry, {
        environmentId: ENV_A,
        input: { scope: GLOBAL, skill: { name: "review" }, content: "x", expectedRevision: "r" },
      });
      const disabling = harness.atoms.setEnabled.run(harness.registry, {
        environmentId: ENV_A,
        input: { scope: GLOBAL, skill: { name: "review" }, enabled: false },
      });
      const otherEnvironment = harness.atoms.save.run(harness.registry, {
        environmentId: ENV_B,
        input: { scope: GLOBAL, skill: { name: "deploy" }, content: "y", expectedRevision: "r" },
      });

      // The save and the other environment's save start; the toggle waits.
      const first = yield* Queue.take(harness.calls);
      const second = yield* Queue.take(harness.calls);
      const started = [first, second].map((call) => `${call.environmentId}:${call.method}`);
      expect(started.toSorted()).toEqual(["skills-a:save", "skills-b:save"]);
      expect(yield* Queue.size(harness.calls)).toBe(0);

      const saveA = first.environmentId === ENV_A ? first : second;
      const saveB = first.environmentId === ENV_A ? second : first;
      yield* harness.reply(saveB, "b-saved");
      yield* Effect.promise(() => otherEnvironment);
      expect(yield* Queue.size(harness.calls)).toBe(0);

      yield* harness.reply(saveA, "saved");
      yield* Effect.promise(() => saving);
      const toggle = yield* Queue.take(harness.calls);
      expect(toggle.method).toBe("setEnabled");
      yield* harness.reply(toggle, "disabled");
      yield* Effect.promise(() => disabling);
      yield* harness.settledOn(target, "disabled");
    }),
  ),
);
