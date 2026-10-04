// @effect-diagnostics nodeBuiltinImport:off - the worktree tests build real Git
// worktree metadata with the git CLI and hash a legacy profile's folder name,
// outside the service under test.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { SkillEntry, SkillsSnapshot } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SkillLibrary from "./SkillLibrary.ts";

/**
 * A fresh T3 home and user home per test. The service reads `HOME` from
 * `HostProcessEnvironment`, so every provider folder lands in the temp tree.
 * `faults.readLink` makes the service's `readLink` fail for one path, which
 * fails the snapshot at the end of a mutation after every change is made.
 * `faults.rename` fails renames onto matching paths, which is how atomic
 * writes land, so it fails one metadata write.
 */
const makeWorld = (options: { readonly env?: Record<string, string> } = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skills-" }),
    );
    const home = path.join(root, "home");
    const baseDir = path.join(root, "t3");
    const project = path.join(root, "project");
    yield* Effect.forEach([home, baseDir, project], (directory) =>
      fileSystem.makeDirectory(directory, { recursive: true }),
    );
    const faults: { readLink?: string; rename?: (to: string) => boolean } = {};
    const faultyFileSystem: FileSystem.FileSystem = {
      ...fileSystem,
      rename: (from, to) =>
        faults.rename?.(to)
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: to,
              }),
            )
          : fileSystem.rename(from, to),
      readLink: (target) =>
        faults.readLink === target
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readLink",
                pathOrDescriptor: target,
              }),
            )
          : fileSystem.readLink(target),
    };
    // Built into the test's scope: the service shuts its change stream down with it.
    const library = yield* Layer.build(
      SkillLibrary.layer.pipe(
        Layer.provide(
          Layer.mergeAll(ServerConfig.layerTest(root, baseDir), ServerSettings.layerTest()),
        ),
      ),
    ).pipe(
      Effect.map((context) => Context.get(context, SkillLibrary.SkillLibrary)),
      Effect.provideService(HostProcessEnvironment, { HOME: home, ...options.env }),
      Effect.provideService(FileSystem.FileSystem, faultyFileSystem),
    );
    const write = (target: string, contents: string | Uint8Array) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        yield* typeof contents === "string"
          ? fileSystem.writeFileString(target, contents)
          : fileSystem.writeFile(target, contents);
      });
    const writeSkill = (directory: string, description: string) =>
      write(path.join(directory, "SKILL.md"), `---\ndescription: ${description}\n---\nBody\n`);
    const symlink = (target: string, linkPath: string) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.dirname(linkPath), { recursive: true });
        yield* fileSystem.symlink(target, linkPath);
      });
    const readLink = (linkPath: string) =>
      fileSystem.readLink(linkPath).pipe(Effect.option, Effect.map(Option.getOrUndefined));
    const exists = (target: string) => fileSystem.exists(target);
    const read = (target: string) => fileSystem.readFileString(target);
    /** Every file and link under `directory` with its contents, to prove nothing changed. */
    const fingerprint = (
      directory: string,
    ): Effect.Effect<Record<string, string>, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const result: Record<string, string> = {};
        const entries = yield* fileSystem.readDirectory(directory, { recursive: true });
        for (const entry of entries.toSorted()) {
          const full = path.join(directory, entry);
          const link = yield* readLink(full);
          if (link !== undefined) {
            result[entry] = `-> ${link}`;
            continue;
          }
          const info = yield* fileSystem.stat(full);
          if (info.type === "File") result[entry] = yield* read(full);
        }
        return result;
      });
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      Effect.sync(() =>
        NodeChildProcess.execFileSync(
          "git",
          [
            "-c",
            "user.name=T3",
            "-c",
            "user.email=t3@example.invalid",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd, stdio: "pipe" },
        ),
      );
    return {
      library,
      fileSystem,
      faults,
      git,
      path,
      root,
      home,
      baseDir,
      project,
      write,
      writeSkill,
      symlink,
      readLink,
      exists,
      read,
      fingerprint,
    };
  });

const entryNamed = (
  snapshot: SkillsSnapshot,
  name: string,
  ownership?: SkillEntry["ownership"],
) => {
  const entry = snapshot.entries.find(
    (candidate) =>
      candidate.name === name && (ownership === undefined || candidate.ownership === ownership),
  );
  if (!entry) throw new Error(`No ${ownership ?? ""} entry named ${name}`);
  return entry;
};

it.layer(NodeServices.layer)("SkillLibrary", (it) => {
  describe("discovery", () => {
    it.effect("lists each physical skill once with every provider origin", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        yield* world.writeSkill(path.join(home, ".agents/skills/shared"), "Shared skill");
        yield* world.symlink(
          "../../.agents/skills/shared",
          path.join(home, ".claude/skills/shared"),
        );
        yield* world.writeSkill(path.join(home, ".cursor/skills/shared"), "Another copy");
        yield* world.writeSkill(path.join(home, ".codex/skills/.system/builtin"), "Bundled");
        yield* world.writeSkill(
          path.join(home, ".claude/plugins/cache/market/plug/1.0.0/skills/from-plugin"),
          "Plugin skill",
        );
        // A self-referencing link must not hang the scan.
        yield* world.symlink("loop", path.join(home, ".agents/skills/loop"));

        const snapshot = yield* world.library.list({ scope: {} });

        const shared = snapshot.entries.find(
          (entry) => entry.name === "shared" && entry.path.includes(".agents"),
        )!;
        expect(shared.ownership).toBe("unmanaged");
        expect(shared.description).toBe("Shared skill");
        expect(shared.editable).toBe(false);
        expect(shared.origins.map((origin) => origin.entryPath).toSorted()).toEqual(
          [
            path.join(home, ".agents/skills/shared"),
            path.join(home, ".claude/skills/shared"),
          ].toSorted(),
        );
        expect(shared.providers).toEqual(
          expect.arrayContaining(["codex", "claudeAgent", "cursor", "opencode"]),
        );
        const cursorCopy = snapshot.entries.find(
          (entry) => entry.name === "shared" && entry.path.includes(".cursor"),
        )!;
        expect(cursorCopy.conflicts).toEqual([
          { entryId: shared.id, path: shared.path, reason: "duplicateName" },
        ]);
        expect(entryNamed(snapshot, "builtin").ownership).toBe("system");
        const plugin = entryNamed(snapshot, "from-plugin");
        expect(plugin.ownership).toBe("plugin");
        expect(plugin.pluginId).toBe("plug@market");
        expect(snapshot.entries.some((entry) => entry.name === "loop")).toBe(false);
        expect(snapshot.providers.find((support) => support.provider === "grok")?.scanned).toBe(
          false,
        );
      }),
    );
  });

  describe("import", () => {
    it.effect("copies the whole folder and refuses to overwrite a library skill", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        const source = path.join(home, ".agents/skills/tool");
        yield* world.writeSkill(source, "Tool");
        yield* world.write(path.join(source, "scripts/run.sh"), "#!/bin/sh\necho hi\n");
        yield* world.write(path.join(source, "references/notes.md"), "notes");
        yield* world.write(path.join(source, "assets/icon.bin"), new Uint8Array([0, 1, 2, 255]));
        const before = yield* world.fingerprint(source);
        const entry = entryNamed(yield* world.library.list({ scope: {} }), "tool");

        const imported = yield* world.library.importSkill({ scope: {}, entryId: entry.id });

        expect(imported.path).toBe(path.join(world.baseDir, "skills/tool"));
        expect(yield* world.fingerprint(imported.path)).toEqual(before);
        expect(yield* world.fingerprint(source)).toEqual(before);
        const managed = entryNamed(imported.snapshot, "tool", "managed");
        expect(managed.id).toBe("managed:tool");
        expect(managed.editable).toBe(true);

        const conflict = yield* world.library
          .importSkill({ scope: {}, entryId: entry.id })
          .pipe(Effect.flip);
        expect(conflict.reason).toBe("conflict");
        expect(yield* world.read(path.join(imported.path, "SKILL.md"))).toContain("Tool");

        const renamed = yield* world.library.importSkill({
          scope: {},
          entryId: entry.id,
          name: "tool-copy",
        });
        expect(yield* world.exists(path.join(renamed.path, "scripts/run.sh"))).toBe(true);
      }),
    );

    it.effect("adopting moves the original to recovery and restore brings it back", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        const original = path.join(home, ".agents/skills/tool");
        const userLink = path.join(home, ".claude/skills/tool");
        yield* world.writeSkill(original, "Tool");
        yield* world.symlink("../../.agents/skills/tool", userLink);
        const before = yield* world.fingerprint(original);
        const entry = entryNamed(yield* world.library.list({ scope: {} }), "tool");

        const imported = yield* world.library.importSkill({
          scope: {},
          entryId: entry.id,
          adoptOriginal: true,
        });

        expect(yield* world.readLink(original)).toBe(imported.path);
        // The user's own link is left as they made it; it now reaches the library.
        expect(yield* world.readLink(userLink)).toBe("../../.agents/skills/tool");
        expect(imported.recovery).toHaveLength(1);
        expect(imported.recovery[0]).toMatchObject({
          kind: "replacedOriginal",
          originalPath: original,
          itemType: "directory",
        });
        const managed = entryNamed(imported.snapshot, "tool", "managed");
        expect(managed.origins.find((origin) => origin.entryPath === original)?.ownedLink).toBe(
          true,
        );
        expect(managed.origins.find((origin) => origin.entryPath === userLink)?.ownedLink).toBe(
          false,
        );

        const restored = yield* world.library.restore({
          scope: {},
          recoveryId: imported.recovery[0]!.id,
        });

        expect(yield* world.readLink(original)).toBeUndefined();
        expect(yield* world.fingerprint(original)).toEqual(before);
        expect(restored.snapshot.recovery).toEqual([]);
        expect(yield* world.exists(path.join(imported.path, "SKILL.md"))).toBe(true);
      }),
    );
  });

  describe("links", () => {
    it.effect("links one skill per target and never overwrites what it does not own", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        yield* world.writeSkill(path.join(home, ".claude/skills/neighbour"), "Neighbour");
        yield* world.writeSkill(path.join(home, ".codex/skills/.system/builtin"), "Bundled");
        const neighbours = yield* world.fingerprint(home);
        yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "---\ndescription: Mine\n---\n",
          expectedRevision: null,
        });
        const canonical = path.join(world.baseDir, "skills/mine");

        const linked = yield* world.library.link({
          subject: { type: "skill", name: "mine" },
          targetIds: ["agents", "claude"],
        });

        expect(yield* world.readLink(path.join(home, ".agents/skills/mine"))).toBe(canonical);
        expect(yield* world.readLink(path.join(home, ".claude/skills/mine"))).toBe(canonical);
        const afterLink = yield* world.fingerprint(home);
        for (const [entry, contents] of Object.entries(neighbours)) {
          expect(afterLink[entry]).toBe(contents);
        }
        const mine = entryNamed(linked.snapshot, "mine", "managed");
        expect(
          mine.links.filter((status) => status.state === "linked").map((s) => s.targetId),
        ).toEqual(["agents", "claude"]);

        // An unknown folder in the way blocks the request until replace is explicit.
        const occupied = path.join(home, ".cursor/skills/mine");
        yield* world.writeSkill(occupied, "Somebody else's");
        const refused = yield* world.library
          .link({ subject: { type: "skill", name: "mine" }, targetIds: ["cursor"] })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("conflict");
        expect(refused.conflictPaths).toEqual([occupied]);
        expect(yield* world.read(path.join(occupied, "SKILL.md"))).toContain("Somebody else's");

        const replaced = yield* world.library.link({
          subject: { type: "skill", name: "mine" },
          targetIds: ["cursor"],
          replace: true,
        });
        expect(yield* world.readLink(occupied)).toBe(canonical);
        expect(replaced.recovery).toHaveLength(1);

        // An unknown symlink is never removed by unlink.
        const foreignLink = path.join(home, ".config/opencode/skills/mine");
        yield* world.symlink(path.join(home, "elsewhere"), foreignLink);
        const unlinked = yield* world.library.unlink({
          subject: { type: "skill", name: "mine" },
          targetIds: ["agents", "claude", "cursor", "opencode"],
        });
        expect(unlinked.removed.toSorted()).toEqual(
          [
            path.join(home, ".agents/skills/mine"),
            path.join(home, ".claude/skills/mine"),
            occupied,
          ].toSorted(),
        );
        expect(yield* world.readLink(foreignLink)).toBe(path.join(home, "elsewhere"));
        expect(yield* world.exists(path.join(canonical, "SKILL.md"))).toBe(true);
      }),
    );

    it.effect("rolls back every link when one target fails", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "x",
          expectedRevision: null,
        });
        // A file where Antigravity's skills folder should be makes that link fail.
        yield* world.write(path.join(home, ".gemini/config"), "not a folder");

        const failure = yield* world.library
          .link({ subject: { type: "skill", name: "mine" }, targetIds: ["agents", "antigravity"] })
          .pipe(Effect.flip);

        expect(failure.reason).toBe("filesystem");
        expect(yield* world.exists(path.join(home, ".agents/skills/mine"))).toBe(false);
      }),
    );

    it.effect("disabling removes owned links and enabling restores them", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "x",
          expectedRevision: null,
        });
        yield* world.library.link({
          subject: { type: "skill", name: "mine" },
          targetIds: ["agents", "claude"],
        });

        const disabled = yield* world.library.setEnabled({
          scope: {},
          skill: { name: "mine" },
          enabled: false,
        });

        expect(yield* world.exists(path.join(world.baseDir, "disabled-skills/mine/SKILL.md"))).toBe(
          true,
        );
        expect(yield* world.readLink(path.join(home, ".agents/skills/mine"))).toBeUndefined();
        expect(entryNamed(disabled.snapshot, "mine", "managed").enabled).toBe(false);

        // Something new took the Claude path while the skill was off.
        yield* world.writeSkill(path.join(home, ".claude/skills/mine"), "New owner");
        const enabled = yield* world.library.setEnabled({
          scope: {},
          skill: { name: "mine" },
          enabled: true,
        });

        expect(yield* world.readLink(path.join(home, ".agents/skills/mine"))).toBe(
          path.join(world.baseDir, "skills/mine"),
        );
        expect(enabled.skippedLinks).toEqual([path.join(home, ".claude/skills/mine")]);
        expect(yield* world.read(path.join(home, ".claude/skills/mine/SKILL.md"))).toContain(
          "New owner",
        );
      }),
    );

    it.effect("archive removes links and restore returns the skill with them", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "keep me",
          expectedRevision: null,
        });
        yield* world.library.link({
          subject: { type: "skill", name: "mine" },
          targetIds: ["agents"],
        });

        const archived = yield* world.library.archive({ scope: {}, name: "mine" });

        expect(yield* world.exists(path.join(world.baseDir, "skills/mine"))).toBe(false);
        expect(yield* world.readLink(path.join(home, ".agents/skills/mine"))).toBeUndefined();
        expect(archived.snapshot.recovery.map((entry) => entry.kind)).toEqual(["archivedSkill"]);

        yield* world.library.restore({ scope: {}, recoveryId: archived.recovery.id });

        expect(yield* world.read(path.join(world.baseDir, "skills/mine/SKILL.md"))).toBe("keep me");
        expect(yield* world.readLink(path.join(home, ".agents/skills/mine"))).toBe(
          path.join(world.baseDir, "skills/mine"),
        );
      }),
    );
  });

  describe("editing", () => {
    it.effect("rejects stale revisions so concurrent saves cannot clobber each other", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const created = yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "v1",
          expectedRevision: null,
        });
        const read = yield* world.library.read({ scope: {}, skill: { name: "mine" } });
        expect(read.revision).toBe(created.revision);

        const results = yield* Effect.all(
          ["from laptop", "from phone"].map((content) =>
            world.library
              .save({
                scope: {},
                skill: { name: "mine" },
                content,
                expectedRevision: read.revision,
              })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );

        expect(results.filter(Result.isSuccess)).toHaveLength(1);
        const loser = results.find(Result.isFailure)!;
        expect(loser.failure.reason).toBe("revisionConflict");
        const winner = results.find(Result.isSuccess)!;
        expect(loser.failure.currentRevision).toBe(winner.success.revision);
      }),
    );

    it.effect("refuses paths outside the skill, symlinked files, and unmanaged skills", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "x",
          expectedRevision: null,
        });
        const outside = path.join(home, "secret.txt");
        yield* world.write(outside, "secret");
        yield* world.symlink(outside, path.join(world.baseDir, "skills/mine/linked.md"));
        yield* world.writeSkill(path.join(home, ".agents/skills/theirs"), "Theirs");

        const traversal = yield* world.library
          .save({
            scope: {},
            skill: { name: "mine" },
            file: "../escape.md",
            content: "x",
            expectedRevision: null,
          })
          .pipe(Effect.flip);
        expect(traversal.reason).toBe("invalidPath");

        const throughLink = yield* world.library
          .save({
            scope: {},
            skill: { name: "mine" },
            file: "linked.md",
            content: "overwritten",
            expectedRevision: null,
          })
          .pipe(Effect.flip);
        expect(throughLink.reason).toBe("invalidPath");
        expect(yield* world.read(outside)).toBe("secret");

        const readOutside = yield* world.library
          .read({ scope: {}, skill: { name: "mine" }, file: "linked.md" })
          .pipe(Effect.flip);
        expect(readOutside.reason).toBe("invalidPath");

        const snapshot = yield* world.library.list({ scope: {} });
        const unmanaged = yield* world.library
          .save({
            scope: {},
            skill: { entryId: entryNamed(snapshot, "theirs").id },
            content: "edit",
            expectedRevision: null,
          })
          .pipe(Effect.flip);
        expect(unmanaged.reason).toBe("readOnly");

        const missing = yield* world.library
          .read({ scope: {}, skill: { name: "mine" }, file: "nope.md" })
          .pipe(Effect.flip);
        expect(missing.reason).toBe("notFound");
      }),
    );
  });

  describe("projects", () => {
    it.effect("local customization stays outside the checkout and feeds the overlay", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        yield* world.writeSkill(path.join(project, ".claude/skills/repo-skill"), "Repo skill");
        yield* world.writeSkill(path.join(project, ".agents/skills/other"), "Other");
        yield* world.write(path.join(project, "AGENTS.md"), "Repo instructions");
        const repoBefore = yield* world.fingerprint(project);
        const scope = { projectPath: project };

        const listed = yield* world.library.list({ scope });
        expect(listed.scope).toMatchObject({
          kind: "project",
          mode: "local",
          projectRoot: project,
        });
        expect(entryNamed(listed, "repo-skill").editable).toBe(false);

        yield* world.library.setEnabled({
          scope,
          skill: { entryId: entryNamed(listed, "other").id },
          enabled: false,
        });
        const imported = yield* world.library.importSkill({
          scope,
          entryId: entryNamed(listed, "repo-skill").id,
        });
        yield* world.library.save({
          scope,
          skill: { name: "repo-skill" },
          content: "My version",
          expectedRevision: (yield* world.library.read({ scope, skill: { name: "repo-skill" } }))
            .revision,
        });
        yield* world.library.saveInstructions({
          scope,
          content: "Private notes",
          expectedRevision: null,
        });
        yield* world.library.updateProjectSettings({
          projectPath: project,
          instructionMode: "append",
        });

        expect(yield* world.fingerprint(project)).toEqual(repoBefore);
        expect(imported.path.startsWith(path.join(world.baseDir, "skill-projects"))).toBe(true);
        const after = yield* world.library.list({ scope });
        const repoEntry = entryNamed(after, "repo-skill", "unmanaged");
        expect(repoEntry.enabled).toBe(false);
        expect(repoEntry.conflicts.map((conflict) => conflict.reason)).toEqual(["replacedByLocal"]);
        expect(entryNamed(after, "other").enabled).toBe(false);
        expect(after.instructions.mode).toBe("append");

        yield* world.write(path.join(project, "src/index.ts"), "");
        const overlay = yield* world.library.resolveProjectOverlay(path.join(project, "src"));
        expect(Option.isSome(overlay)).toBe(true);
        const value = Option.getOrThrow(overlay);
        expect(value.projectRoot).toBe(project);
        expect(value.skills.map((skill) => skill.name)).toEqual(["repo-skill"]);
        expect(value.suppressedRepoSkills).toEqual([
          {
            name: "other",
            folderName: "other",
            path: path.join(project, ".agents/skills/other"),
            reason: "disabled",
          },
          { name: "repo-skill", path: null, reason: "replaced" },
          {
            name: "repo-skill",
            folderName: "repo-skill",
            path: path.join(project, ".claude/skills/repo-skill"),
            reason: "replaced",
          },
        ]);
        expect(value.instructions).toMatchObject({ mode: "append", content: "Private notes" });

        const elsewhere = yield* world.library.resolveProjectOverlay(world.home);
        expect(Option.isNone(elsewhere)).toBe(true);
      }),
    );

    it.effect("shared mode writes repository files only when asked and checks revisions", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        yield* world.write(path.join(project, "CLAUDE.md"), "Team rules");
        const shared = { projectPath: project, mode: "shared" as const };

        const created = yield* world.library.save({
          scope: shared,
          skill: { name: "team" },
          content: "Team skill",
          expectedRevision: null,
        });
        expect(created.path).toBe(path.join(project, ".agents/skills/team/SKILL.md"));
        expect(entryNamed(created.snapshot, "team").editable).toBe(true);

        const doc = yield* world.library.readInstructions({ scope: shared, file: "CLAUDE.md" });
        const stale = yield* world.library
          .saveInstructions({
            scope: shared,
            file: "CLAUDE.md",
            content: "Overwrite",
            expectedRevision: null,
          })
          .pipe(Effect.flip);
        expect(stale.reason).toBe("revisionConflict");
        yield* world.library.saveInstructions({
          scope: shared,
          file: "CLAUDE.md",
          content: "Team rules v2",
          expectedRevision: doc.revision,
        });
        expect(yield* world.read(path.join(project, "CLAUDE.md"))).toBe("Team rules v2");

        const noProject = yield* world.library
          .list({ scope: { mode: "shared" } })
          .pipe(Effect.flip);
        expect(noProject.reason).toBe("invalidScope");
        const archive = yield* world.library
          .archive({ scope: shared, name: "team" })
          .pipe(Effect.flip);
        expect(archive.reason).toBe("unsupported");
        const missingProject = yield* world.library
          .list({ scope: { projectPath: path.join(project, "missing") } })
          .pipe(Effect.flip);
        expect(missingProject.reason).toBe("projectNotFound");
      }),
    );
  });

  describe("instructions", () => {
    it.effect("links global instructions and backs up existing provider files on request", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        const codexInstructions = path.join(home, ".codex/AGENTS.md");
        yield* world.write(codexInstructions, "Existing Codex rules");
        const snapshot = yield* world.library.list({ scope: {} });
        const codexFile = snapshot.instructions.files.find((file) => file.id === "codex")!;
        expect(codexFile.exists).toBe(true);

        const imported = yield* world.library.importInstructions({
          scope: {},
          sourceId: "codex",
        });
        expect(imported.content).toBe("Existing Codex rules");
        const again = yield* world.library
          .importInstructions({ scope: {}, sourceId: "codex" })
          .pipe(Effect.flip);
        expect(again.reason).toBe("conflict");

        const refused = yield* world.library
          .link({ subject: { type: "instructions" }, targetIds: ["codex", "claude"] })
          .pipe(Effect.flip);
        expect(refused.conflictPaths).toEqual([codexInstructions]);
        expect(yield* world.exists(path.join(home, ".claude/CLAUDE.md"))).toBe(false);

        const linked = yield* world.library.link({
          subject: { type: "instructions" },
          targetIds: ["codex", "claude"],
          replace: true,
        });
        const canonical = path.join(world.baseDir, "instructions/AGENTS.md");
        expect(yield* world.readLink(codexInstructions)).toBe(canonical);
        expect(yield* world.readLink(path.join(home, ".claude/CLAUDE.md"))).toBe(canonical);
        expect(linked.snapshot.instructions.links.map((status) => status.state)).toEqual([
          "linked",
          "linked",
          "available",
        ]);

        yield* world.library.restore({ scope: {}, recoveryId: linked.recovery[0]!.id });
        expect(yield* world.read(codexInstructions)).toBe("Existing Codex rules");
        expect(yield* world.readLink(codexInstructions)).toBeUndefined();
      }),
    );
  });

  describe("aliased folders", () => {
    it.effect("a provider folder that links to the library is never replaced or unlinked", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "---\ndescription: Mine\n---\nKeep me\n",
          expectedRevision: null,
        });
        const libraryRoot = path.join(world.baseDir, "skills");
        const agentsRoot = path.join(home, ".agents/skills");
        yield* world.symlink(libraryRoot, agentsRoot);
        const before = yield* world.fingerprint(libraryRoot);

        const listed = yield* world.library.list({ scope: {} });
        const mine = entryNamed(listed, "mine", "managed");
        expect(mine.links.find((status) => status.targetId === "agents")).toMatchObject({
          state: "linked",
          inherited: true,
        });
        expect(mine.providers).toEqual(expect.arrayContaining(["codex", "cursor", "opencode"]));

        const linked = yield* world.library.link({
          subject: { type: "skill", name: "mine" },
          targetIds: ["agents"],
          replace: true,
        });
        expect(linked.recovery).toEqual([]);
        const unlinked = yield* world.library.unlink({
          subject: { type: "skill", name: "mine" },
          targetIds: ["agents"],
        });
        expect(unlinked.removed).toEqual([]);
        yield* world.library.setEnabled({ scope: {}, skill: { name: "mine" }, enabled: false });
        yield* world.library.setEnabled({ scope: {}, skill: { name: "mine" }, enabled: true });
        const archived = yield* world.library.archive({ scope: {}, name: "mine" });
        yield* world.library.restore({ scope: {}, recoveryId: archived.recovery.id });

        expect(yield* world.readLink(agentsRoot)).toBe(libraryRoot);
        expect(yield* world.readLink(path.join(libraryRoot, "mine"))).toBeUndefined();
        expect(yield* world.fingerprint(libraryRoot)).toEqual(before);
      }),
    );

    it.effect("provider folders that are one folder get a single link", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "x",
          expectedRevision: null,
        });
        yield* world.fileSystem.makeDirectory(path.join(home, ".agents/skills"), {
          recursive: true,
        });
        yield* world.symlink("../.agents/skills", path.join(home, ".claude/skills"));

        const linked = yield* world.library.link({
          subject: { type: "skill", name: "mine" },
          targetIds: ["agents", "claude"],
        });

        expect(linked.linked).toEqual([path.join(home, ".agents/skills/mine")]);
        expect(yield* world.readLink(path.join(home, ".agents/skills/mine"))).toBe(
          path.join(world.baseDir, "skills/mine"),
        );
        const statuses = entryNamed(linked.snapshot, "mine", "managed").links;
        expect(statuses.find((status) => status.targetId === "agents")?.state).toBe("linked");
        expect(statuses.some((status) => status.targetId === "claude")).toBe(false);

        const unlinked = yield* world.library.unlink({
          subject: { type: "skill", name: "mine" },
          targetIds: ["claude"],
        });
        expect(unlinked.removed).toEqual([path.join(home, ".claude/skills/mine")]);
        expect(yield* world.exists(path.join(home, ".agents/skills/mine"))).toBe(false);
        expect(yield* world.read(path.join(world.baseDir, "skills/mine/SKILL.md"))).toBe("x");
      }),
    );

    it.effect("an instruction target that is the canonical file is left alone", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        yield* world.library.saveInstructions({
          scope: {},
          content: "Global rules",
          expectedRevision: null,
        });
        yield* world.symlink(path.join(world.baseDir, "instructions"), path.join(home, ".codex"));

        const listed = yield* world.library.list({ scope: {} });
        expect(
          listed.instructions.links.find((status) => status.targetId === "codex"),
        ).toMatchObject({ state: "linked", inherited: true });
        const linked = yield* world.library.link({
          subject: { type: "instructions" },
          targetIds: ["codex"],
          replace: true,
        });
        expect(linked.recovery).toEqual([]);
        const imported = yield* world.library
          .importInstructions({ scope: {}, sourceId: "codex" })
          .pipe(Effect.flip);
        expect(imported.reason).toBe("conflict");
        yield* world.library.unlink({ subject: { type: "instructions" }, targetIds: ["codex"] });

        expect(yield* world.read(path.join(world.baseDir, "instructions/AGENTS.md"))).toBe(
          "Global rules",
        );
        expect(yield* world.readLink(path.join(world.baseDir, "instructions/AGENTS.md"))).toBe(
          undefined,
        );
      }),
    );
  });

  describe("codex homes", () => {
    it.effect("links into a custom CODEX_HOME without touching .system", () =>
      Effect.gen(function* () {
        const outer = yield* makeWorld();
        const codexHome = outer.path.join(outer.root, "codex-home");
        const world = yield* makeWorld({ env: { CODEX_HOME: codexHome } });
        const { path } = world;
        yield* world.writeSkill(path.join(codexHome, "skills/.system/builtin"), "Bundled");
        const system = yield* world.fingerprint(path.join(codexHome, "skills/.system"));
        yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "x",
          expectedRevision: null,
        });

        const listed = yield* world.library.list({ scope: {} });
        expect(listed.linkTargets.find((target) => target.id === "codex")?.path).toBe(
          path.join(codexHome, "skills"),
        );
        yield* world.library.link({
          subject: { type: "skill", name: "mine" },
          targetIds: ["codex"],
        });

        expect(yield* world.readLink(path.join(codexHome, "skills/mine"))).toBe(
          path.join(world.baseDir, "skills/mine"),
        );
        expect(yield* world.fingerprint(path.join(codexHome, "skills/.system"))).toEqual(system);
      }),
    );

    it.effect("lists a Codex folder that is the .agents folder once", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        yield* world.fileSystem.makeDirectory(path.join(home, ".agents/skills"), {
          recursive: true,
        });
        yield* world.symlink("../.agents/skills", path.join(home, ".codex/skills"));

        const listed = yield* world.library.list({ scope: {} });

        expect(listed.linkTargets.some((target) => target.id === "codex")).toBe(false);
        expect(listed.linkTargets.find((target) => target.id === "agents")?.providers).toEqual(
          expect.arrayContaining(["codex", "cursor", "opencode"]),
        );
      }),
    );
  });

  describe("shared escapes", () => {
    it.effect("never writes outside the checkout through linked folders", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        const outside = path.join(world.root, "outside");
        yield* world.writeSkill(path.join(outside, "skills/theirs"), "External");
        yield* world.write(path.join(outside, "support/run.sh"), "external script");
        const shared = { projectPath: project, mode: "shared" as const };
        const external = yield* world.fingerprint(outside);
        const refuse = Effect.gen(function* () {
          const created = yield* world.library
            .save({ scope: shared, skill: { name: "new" }, content: "x", expectedRevision: null })
            .pipe(Effect.flip);
          expect(created.reason).toBe("readOnly");
          const edited = yield* world.library
            .save({
              scope: shared,
              skill: { name: "theirs" },
              content: "x",
              expectedRevision: (yield* world.library.read({
                scope: { projectPath: project },
                skill: {
                  entryId: entryNamed(
                    yield* world.library.list({ scope: { projectPath: project } }),
                    "theirs",
                  ).id,
                },
              })).revision,
            })
            .pipe(Effect.flip);
          expect(edited.reason).toBe("readOnly");
          expect(yield* world.fingerprint(outside)).toEqual(external);
          expect(yield* world.exists(path.join(outside, "skills/new"))).toBe(false);
        });

        // The whole .agents folder links out.
        yield* world.symlink(outside, path.join(project, ".agents"));
        yield* refuse;
        yield* world.fileSystem.remove(path.join(project, ".agents"));

        // Only the skills folder links out.
        yield* world.symlink(path.join(outside, "skills"), path.join(project, ".agents/skills"));
        yield* refuse;
        const imported = yield* world.library
          .importSkill({
            scope: shared,
            entryId: entryNamed(yield* world.library.list({ scope: shared }), "theirs").id,
            name: "copy",
          })
          .pipe(Effect.flip);
        expect(imported.reason).toBe("readOnly");
        expect(yield* world.fingerprint(outside)).toEqual(external);
        yield* world.fileSystem.remove(path.join(project, ".agents/skills"));

        // A skill folder inside, with a support folder that links out.
        yield* world.writeSkill(path.join(project, ".agents/skills/team"), "Team");
        yield* world.symlink(
          path.join(outside, "support"),
          path.join(project, ".agents/skills/team/scripts"),
        );
        const support = yield* world.library
          .save({
            scope: shared,
            skill: { name: "team" },
            file: "scripts/run.sh",
            content: "x",
            expectedRevision: null,
          })
          .pipe(Effect.flip);
        expect(support.reason).toBe("invalidPath");
        expect(yield* world.fingerprint(outside)).toEqual(external);
      }),
    );

    it.effect("edits a symlinked shared skill whose folder is inside the checkout", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        yield* world.writeSkill(path.join(project, "tools/inner"), "Inner");
        yield* world.symlink("../../tools/inner", path.join(project, ".agents/skills/inner"));
        const shared = { projectPath: project, mode: "shared" as const };
        const current = yield* world.library.read({ scope: shared, skill: { name: "inner" } });

        yield* world.library.save({
          scope: shared,
          skill: { name: "inner" },
          content: "Edited",
          expectedRevision: current.revision,
        });

        expect(yield* world.read(path.join(project, "tools/inner/SKILL.md"))).toBe("Edited");
        expect(yield* world.readLink(path.join(project, ".agents/skills/inner"))).toBe(
          "../../tools/inner",
        );
      }),
    );
  });

  describe("recovery ownership", () => {
    it.effect("restore removes only the exact link it replaced", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        for (const name of ["mine", "other"]) {
          yield* world.library.save({
            scope: {},
            skill: { name },
            content: name,
            expectedRevision: null,
          });
        }
        const occupied = path.join(home, ".cursor/skills/mine");
        yield* world.writeSkill(occupied, "Original");
        const linked = yield* world.library.link({
          subject: { type: "skill", name: "mine" },
          targetIds: ["cursor"],
          replace: true,
        });
        const recoveryId = linked.recovery[0]!.id;
        const entryFile = path.join(world.baseDir, "skill-recovery", recoveryId, "entry.json");

        for (const foreign of [
          path.join(world.baseDir, "skills/other"),
          path.join(world.baseDir, "skill-library.json"),
        ]) {
          yield* world.fileSystem.remove(occupied);
          yield* world.fileSystem.symlink(foreign, occupied);
          const refused = yield* world.library.restore({ scope: {}, recoveryId }).pipe(Effect.flip);
          expect(refused.reason).toBe("conflict");
          expect(yield* world.readLink(occupied)).toBe(foreign);
          expect(yield* world.exists(path.join(path.dirname(entryFile), "payload/SKILL.md"))).toBe(
            true,
          );
        }

        // A record written before installedLinkTarget existed only matches its own skill.
        const recordText = yield* world.read(entryFile);
        expect(recordText).toContain('"installedLinkTarget"');
        yield* world.write(entryFile, recordText.replace(/,"installedLinkTarget":"[^"]*"/, ""));
        expect(yield* world.read(entryFile)).not.toContain("installedLinkTarget");
        const legacy = yield* world.library.restore({ scope: {}, recoveryId }).pipe(Effect.flip);
        expect(legacy.reason).toBe("conflict");
        yield* world.fileSystem.remove(occupied);
        yield* world.fileSystem.symlink(path.join(world.baseDir, "skills/mine"), occupied);

        yield* world.library.restore({ scope: {}, recoveryId });
        expect(yield* world.read(path.join(occupied, "SKILL.md"))).toContain("Original");
        expect(yield* world.readLink(occupied)).toBeUndefined();
      }),
    );
  });

  describe("rollback", () => {
    it.effect("a late failure leaves files, links, and metadata as they were", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, home } = world;
        yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "Keep me",
          expectedRevision: null,
        });
        yield* world.library.link({
          subject: { type: "skill", name: "mine" },
          targetIds: ["agents", "claude"],
        });
        const state = Effect.all({
          home: world.fingerprint(home),
          t3: world.fingerprint(world.baseDir),
        });
        const failLate = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.gen(function* () {
            const before = yield* state;
            world.faults.readLink = path.join(world.baseDir, "instructions/AGENTS.md");
            const failure = yield* effect.pipe(Effect.flip);
            delete world.faults.readLink;
            expect(failure).toMatchObject({ reason: "filesystem" });
            expect(yield* state).toEqual(before);
          });
        const setEnabled = (enabled: boolean) =>
          world.library.setEnabled({ scope: {}, skill: { name: "mine" }, enabled });

        yield* failLate(setEnabled(false));
        yield* setEnabled(false);
        yield* failLate(setEnabled(true));
        yield* setEnabled(true);
        yield* failLate(world.library.archive({ scope: {}, name: "mine" }));
        const archived = yield* world.library.archive({ scope: {}, name: "mine" });
        yield* failLate(world.library.restore({ scope: {}, recoveryId: archived.recovery.id }));
        yield* world.library.restore({ scope: {}, recoveryId: archived.recovery.id });

        expect(yield* world.read(path.join(world.baseDir, "skills/mine/SKILL.md"))).toBe("Keep me");
        expect(yield* world.readLink(path.join(home, ".claude/skills/mine"))).toBe(
          path.join(world.baseDir, "skills/mine"),
        );
        expect(
          yield* world.exists(path.join(world.baseDir, "skill-recovery", archived.recovery.id)),
        ).toBe(false);
      }),
    );

    it.effect("saves, instructions, and settings that fail late change nothing", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        const state = Effect.all({
          t3: world.fingerprint(world.baseDir),
          repo: world.fingerprint(project),
        });
        const failLate = <A, E>(effect: Effect.Effect<A, E>, fault: typeof world.faults) =>
          Effect.gen(function* () {
            const before = yield* state;
            Object.assign(world.faults, fault);
            const failure = yield* effect.pipe(Effect.flip);
            delete world.faults.readLink;
            delete world.faults.rename;
            expect(failure).toMatchObject({ reason: "filesystem" });
            expect(yield* state).toEqual(before);
          });
        const scope = { projectPath: project };
        const manifestWrite = { rename: (to: string) => path.basename(to) === "manifest.json" };

        // A project's first private change also writes its manifest, last.
        yield* failLate(
          world.library.save({
            scope,
            skill: { name: "mine" },
            content: "v1",
            expectedRevision: null,
          }),
          manifestWrite,
        );
        yield* failLate(
          world.library.saveInstructions({ scope, content: "Notes", expectedRevision: null }),
          manifestWrite,
        );
        yield* world.write(path.join(project, "CLAUDE.md"), "Repo rules");
        yield* failLate(
          world.library.importInstructions({ scope, sourceId: "repo:CLAUDE.md" }),
          manifestWrite,
        );
        expect(yield* world.exists(path.join(world.baseDir, "skill-projects"))).toBe(false);

        const created = yield* world.library.save({
          scope,
          skill: { name: "mine" },
          content: "v1",
          expectedRevision: null,
        });
        const notes = yield* world.library.saveInstructions({
          scope,
          content: "Notes",
          expectedRevision: null,
        });
        // The snapshot at the end of a mutation reads the repository's instructions.
        const snapshotRead = { readLink: path.join(project, "AGENTS.md") };
        yield* failLate(
          world.library.save({
            scope,
            skill: { name: "mine" },
            content: "v2",
            expectedRevision: created.revision,
          }),
          snapshotRead,
        );
        yield* failLate(
          world.library.save({
            scope,
            skill: { name: "fresh" },
            file: "SKILL.md",
            content: "new",
            expectedRevision: null,
          }),
          snapshotRead,
        );
        yield* failLate(
          world.library.updateProjectSettings({ projectPath: project, instructionMode: "append" }),
          snapshotRead,
        );
        yield* failLate(
          world.library.save({
            scope: {},
            skill: { name: "global" },
            content: "x",
            expectedRevision: null,
          }),
          { readLink: path.join(world.baseDir, "instructions/AGENTS.md") },
        );

        const mine = yield* world.library.read({ scope, skill: { name: "mine" } });
        expect(mine).toMatchObject({ content: "v1", revision: created.revision });
        expect(
          yield* world.exists(path.join(path.dirname(path.dirname(created.path)), "fresh")),
        ).toBe(false);
        expect(yield* world.exists(path.join(world.baseDir, "skills"))).toBe(false);
        const instructions = yield* world.library.readInstructions({ scope });
        expect(instructions).toMatchObject({ revision: notes.revision, mode: "inherit" });
      }),
    );
  });

  describe("worktrees", () => {
    it.effect("a worktree inherits its primary checkout's profile with its own paths", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        yield* world.writeSkill(path.join(project, ".claude/skills/repo-skill"), "Repo skill");
        yield* world.write(path.join(project, "packages/app/src/index.ts"), "");
        yield* world.git(project, "init", "--quiet", "--initial-branch=main");
        yield* world.git(project, "add", ".");
        yield* world.git(project, "commit", "--quiet", "-m", "init");
        const worktree = path.join(world.baseDir, "worktrees/project/feature");
        yield* world.git(project, "worktree", "add", "--quiet", "-b", "feature", worktree);
        const other = path.join(world.root, "other");
        yield* world.fileSystem.makeDirectory(other);
        yield* world.git(other, "init", "--quiet");

        const scope = { projectPath: project };
        const listed = yield* world.library.list({ scope });
        yield* world.library.setEnabled({
          scope,
          skill: { entryId: entryNamed(listed, "repo-skill").id },
          enabled: false,
        });

        const fromWorktree = Option.getOrThrow(
          yield* world.library.resolveProjectOverlay(path.join(worktree, "packages/app/src")),
        );
        expect(fromWorktree.projectRoot).toBe(worktree);
        expect(fromWorktree.privateRoot).toBe(
          Option.getOrThrow(yield* world.library.resolveProjectOverlay(project)).privateRoot,
        );
        expect(fromWorktree.provenance).toMatchObject({ profileRoot: project, source: "worktree" });
        expect(fromWorktree.suppressedRepoSkills).toEqual([
          {
            name: "repo-skill",
            folderName: "repo-skill",
            path: path.join(worktree, ".claude/skills/repo-skill"),
            reason: "disabled",
          },
        ]);
        expect(fromWorktree.instructions.globalInstructionsEnabled).toBe(true);
        expect(Option.isNone(yield* world.library.resolveProjectOverlay(other))).toBe(true);

        // A sub-project without a profile of its own edits the one it inherits.
        yield* world.library.updateProjectSettings({
          projectPath: path.join(project, "packages/app"),
          instructionMode: "off",
        });
        const nested = Option.getOrThrow(
          yield* world.library.resolveProjectOverlay(path.join(worktree, "packages/app/src")),
        );
        expect(nested.projectRoot).toBe(worktree);
        expect(nested.instructions.mode).toBe("off");

        // Settings changed from the worktree land in the primary checkout's profile.
        yield* world.library.updateProjectSettings({
          projectPath: worktree,
          instructionMode: "replace",
        });
        const shared = Option.getOrThrow(yield* world.library.resolveProjectOverlay(worktree));
        expect(shared.provenance).toMatchObject({ profileRoot: project, source: "worktree" });
        expect(shared.instructions.mode).toBe("replace");
        expect(
          Option.getOrThrow(yield* world.library.resolveProjectOverlay(project)).instructions.mode,
        ).toBe("replace");
      }),
    );

    it.effect("managing a worktree edits the profile its agents use", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        yield* world.writeSkill(path.join(project, ".claude/skills/repo-skill"), "Repo skill");
        yield* world.git(project, "init", "--quiet", "--initial-branch=main");
        yield* world.git(project, "add", ".");
        yield* world.git(project, "commit", "--quiet", "-m", "init");
        const worktree = path.join(world.root, "worktrees/feature");
        yield* world.git(project, "worktree", "add", "--quiet", "-b", "feature", worktree);
        const primary = { projectPath: project };
        yield* world.library.save({
          scope: primary,
          skill: { name: "mine" },
          content: "v1",
          expectedRevision: null,
        });
        yield* world.library.saveInstructions({
          scope: primary,
          content: "Notes",
          expectedRevision: null,
        });
        yield* world.library.updateProjectSettings({
          projectPath: project,
          instructionMode: "append",
        });
        const primaryLibrary = (yield* world.library.list({ scope: primary })).scope.libraryPath;

        const wt = { projectPath: worktree };
        const listed = yield* world.library.list({ scope: wt });
        expect(listed.scope).toMatchObject({
          projectRoot: worktree,
          profileRoot: project,
          profileSource: "worktree",
          libraryPath: primaryLibrary,
        });
        expect(entryNamed(listed, "mine", "managed").enabled).toBe(true);
        expect(entryNamed(listed, "repo-skill").path).toBe(
          path.join(worktree, ".claude/skills/repo-skill"),
        );
        expect(listed.instructions.mode).toBe("append");

        const read = yield* world.library.read({ scope: wt, skill: { name: "mine" } });
        expect(read.content).toBe("v1");
        yield* world.library.save({
          scope: wt,
          skill: { name: "mine" },
          content: "v2",
          expectedRevision: read.revision,
        });
        const doc = yield* world.library.readInstructions({ scope: wt });
        expect(doc).toMatchObject({ content: "Notes", mode: "append" });
        yield* world.library.saveInstructions({
          scope: wt,
          content: "Notes v2",
          expectedRevision: doc.revision,
        });
        yield* world.library.setEnabled({
          scope: wt,
          skill: { entryId: entryNamed(listed, "repo-skill").id },
          enabled: false,
        });
        const archived = yield* world.library.archive({ scope: wt, name: "mine" });
        expect(
          (yield* world.library.list({ scope: primary })).recovery.map((entry) => entry.id),
        ).toEqual([archived.recovery.id]);
        yield* world.library.restore({ scope: wt, recoveryId: archived.recovery.id });

        const fromPrimary = yield* world.library.list({ scope: primary });
        expect(fromPrimary.instructions.mode).toBe("append");
        expect(entryNamed(fromPrimary, "repo-skill").enabled).toBe(false);
        expect(
          (yield* world.library.read({ scope: primary, skill: { name: "mine" } })).content,
        ).toBe("v2");
        expect((yield* world.library.readInstructions({ scope: primary })).content).toBe(
          "Notes v2",
        );
        expect(
          yield* world.fileSystem.readDirectory(path.join(world.baseDir, "skill-projects")),
        ).toHaveLength(1);
        for (const [cwd, root] of [
          [project, project],
          [worktree, worktree],
        ] as const) {
          const overlay = Option.getOrThrow(yield* world.library.resolveProjectOverlay(cwd));
          expect(overlay.instructions).toMatchObject({ mode: "append", content: "Notes v2" });
          expect(overlay.skills.map((skill) => skill.name)).toEqual(["mine"]);
          expect(overlay.suppressedRepoSkills[0]).toEqual({
            name: "repo-skill",
            folderName: "repo-skill",
            path: path.join(root, ".claude/skills/repo-skill"),
            reason: "disabled",
          });
        }
      }),
    );
  });

  describe("nested projects", () => {
    /** Management and agents in `projectPath` must read one profile, one way. */
    const expectSameProfile = (
      world: Effect.Success<ReturnType<typeof makeWorld>>,
      projectPath: string,
    ) =>
      Effect.gen(function* () {
        const listed = yield* world.library.list({ scope: { projectPath } });
        const overlay = Option.getOrThrow(yield* world.library.resolveProjectOverlay(projectPath));
        expect(overlay.provenance).toMatchObject({
          profileRoot: listed.scope.profileRoot,
          source: listed.scope.profileSource,
        });
        expect(overlay.instructions.mode).toBe(listed.instructions.mode);
        expect(overlay.instructions.path).toBe(listed.instructions.canonicalPath);
        return { listed, overlay };
      });

    it.effect("a sub-project manages the profile its agents inherit", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        const app = path.join(project, "packages/app");
        yield* world.writeSkill(path.join(project, ".claude/skills/top"), "Top");
        yield* world.writeSkill(path.join(app, ".claude/skills/sub-skill"), "Sub");
        yield* world.writeSkill(path.join(app, ".claude/skills/dup"), "Dup");
        const repo = yield* world.fingerprint(project);
        const parent = { projectPath: project };
        yield* world.library.setEnabled({
          scope: parent,
          skill: { entryId: entryNamed(yield* world.library.list({ scope: parent }), "top").id },
          enabled: false,
        });
        yield* world.library.saveInstructions({
          scope: parent,
          content: "Notes",
          expectedRevision: null,
        });
        yield* world.library.updateProjectSettings({
          projectPath: project,
          instructionMode: "append",
        });

        const nested = { projectPath: app };
        const { listed, overlay: inherited } = yield* expectSameProfile(world, app);
        expect(listed.scope).toMatchObject({
          projectRoot: app,
          profileRoot: project,
          profileSource: "project",
        });
        expect(listed.instructions.mode).toBe("append");
        expect(inherited.projectRoot).toBe(project);
        expect((yield* world.library.readInstructions({ scope: nested })).content).toBe("Notes");

        // Edits from the sub-project land in the inherited profile and keep its settings.
        yield* world.library.setEnabled({
          scope: nested,
          skill: { entryId: entryNamed(listed, "sub-skill").id },
          enabled: false,
        });
        yield* world.library.save({
          scope: nested,
          skill: { name: "dup" },
          content: "---\ndescription: Private\n---\nPrivate\n",
          expectedRevision: null,
        });
        const { listed: edited, overlay } = yield* expectSameProfile(world, app);
        expect(entryNamed(edited, "sub-skill").enabled).toBe(false);
        expect(entryNamed(edited, "dup", "unmanaged").enabled).toBe(false);
        expect(entryNamed(edited, "dup", "managed").enabled).toBe(true);
        expect(overlay.instructions).toMatchObject({ mode: "append", content: "Notes" });
        expect(overlay.skills.map((skill) => skill.name)).toEqual(["dup"]);
        expect(overlay.suppressedRepoSkills).toEqual([
          {
            name: "top",
            folderName: "top",
            path: path.join(project, ".claude/skills/top"),
            reason: "disabled",
          },
          {
            name: "sub-skill",
            folderName: "sub-skill",
            path: path.join(app, ".claude/skills/sub-skill"),
            reason: "disabled",
          },
          { name: "dup", path: null, reason: "replaced" },
          {
            name: "dup",
            folderName: "dup",
            path: path.join(app, ".claude/skills/dup"),
            reason: "replaced",
          },
        ]);
        const fromParent = yield* world.library.list({ scope: parent });
        expect(entryNamed(fromParent, "top").enabled).toBe(false);
        expect(entryNamed(fromParent, "dup", "managed").enabled).toBe(true);
        expect(
          yield* world.fileSystem.readDirectory(path.join(world.baseDir, "skill-projects")),
        ).toHaveLength(1);

        // Undoing each change from the sub-project clears what agents get.
        yield* world.library.setEnabled({
          scope: nested,
          skill: { entryId: entryNamed(edited, "sub-skill").id },
          enabled: true,
        });
        yield* world.library.archive({ scope: nested, name: "dup" });
        yield* world.library.setEnabled({
          scope: parent,
          skill: { entryId: entryNamed(fromParent, "top").id },
          enabled: true,
        });
        yield* world.library.updateProjectSettings({
          projectPath: app,
          instructionMode: "inherit",
        });
        const cleared = yield* world.library.list({ scope: nested });
        expect(cleared.scope.profileRoot).toBe(project);
        expect(cleared.entries.every((entry) => entry.enabled)).toBe(true);
        expect(cleared.instructions.mode).toBe("inherit");
        for (const cwd of [project, app]) {
          expect(Option.isNone(yield* world.library.resolveProjectOverlay(cwd))).toBe(true);
        }
        expect(yield* world.fingerprint(project)).toEqual(repo);
      }),
    );

    it.effect("a profile of a folder's own keeps priority over an enclosing one", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        const app = path.join(project, "packages/app");
        yield* world.fileSystem.makeDirectory(app, { recursive: true });
        yield* world.library.updateProjectSettings({ projectPath: app, instructionMode: "off" });
        yield* world.library.updateProjectSettings({
          projectPath: project,
          instructionMode: "append",
        });

        const { listed, overlay } = yield* expectSameProfile(world, app);
        expect(listed.scope).toMatchObject({ profileRoot: app, profileSource: "project" });
        expect(overlay).toMatchObject({ projectRoot: app, instructions: { mode: "off" } });
        const { listed: fromParent } = yield* expectSameProfile(world, project);
        expect(fromParent.instructions.mode).toBe("append");
      }),
    );

    it.effect("a sub-project of a worktree uses the primary checkout's root profile", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        yield* world.writeSkill(path.join(project, "packages/app/.claude/skills/app-skill"), "App");
        yield* world.git(project, "init", "--quiet", "--initial-branch=main");
        yield* world.git(project, "add", ".");
        yield* world.git(project, "commit", "--quiet", "-m", "init");
        const worktree = path.join(world.root, "worktrees/feature");
        yield* world.git(project, "worktree", "add", "--quiet", "-b", "feature", worktree);
        yield* world.library.updateProjectSettings({
          projectPath: project,
          instructionMode: "append",
        });
        const repo = yield* world.fingerprint(worktree);

        const app = path.join(worktree, "packages/app");
        const { listed } = yield* expectSameProfile(world, app);
        expect(listed.scope).toMatchObject({
          projectRoot: app,
          profileRoot: project,
          profileSource: "worktree",
        });
        yield* world.library.setEnabled({
          scope: { projectPath: app },
          skill: { entryId: entryNamed(listed, "app-skill").id },
          enabled: false,
        });
        for (const root of [worktree, project]) {
          const { listed: sub, overlay } = yield* expectSameProfile(
            world,
            path.join(root, "packages/app"),
          );
          expect(entryNamed(sub, "app-skill").enabled).toBe(false);
          expect(overlay.projectRoot).toBe(root);
          expect(overlay.suppressedRepoSkills).toEqual([
            {
              name: "app-skill",
              folderName: "app-skill",
              path: path.join(root, "packages/app/.claude/skills/app-skill"),
              reason: "disabled",
            },
          ]);
        }

        // A profile written for the worktree itself, as older versions did, still wins.
        yield* world.write(
          path.join(
            world.baseDir,
            "skill-projects",
            NodeCrypto.createHash("sha256").update(worktree).digest("hex").slice(0, 16),
            "manifest.json",
          ),
          JSON.stringify({
            version: 1,
            projectRoot: worktree,
            disabledRepoSkills: [],
            instructionMode: "off",
            globalInstructionsEnabled: true,
          }),
        );
        const { listed: legacy, overlay } = yield* expectSameProfile(world, app);
        expect(legacy.scope).toMatchObject({ profileRoot: worktree, profileSource: "project" });
        expect(overlay.instructions.mode).toBe("off");
        expect(entryNamed(legacy, "app-skill").enabled).toBe(true);
        expect(yield* world.fingerprint(worktree)).toEqual(repo);
      }),
    );
  });

  describe("change notifications", () => {
    it.effect("announces committed mutations only, after they commit", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        const globalSkill = path.join(world.baseDir, "skills/mine/SKILL.md");
        const events = yield* Queue.unbounded<{
          readonly change: SkillLibrary.SkillLibraryChange;
          readonly content: string | undefined;
        }>();
        yield* world.library.streamChanges.pipe(
          Stream.runForEach((change) =>
            world.read(globalSkill).pipe(
              Effect.option,
              Effect.flatMap((content) =>
                Queue.offer(events, { change, content: Option.getOrUndefined(content) }),
              ),
            ),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );

        const rejected = yield* world.library
          .save({
            scope: { projectPath: project },
            skill: { name: "mine" },
            content: "x",
            expectedRevision: "stale",
          })
          .pipe(Effect.flip);
        expect(rejected.reason).toBe("notFound");
        world.faults.readLink = path.join(world.baseDir, "instructions/AGENTS.md");
        yield* world.library
          .save({
            scope: {},
            skill: { name: "mine" },
            content: "rolled back",
            expectedRevision: null,
          })
          .pipe(Effect.flip);
        delete world.faults.readLink;

        yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "v1",
          expectedRevision: null,
        });
        expect(yield* Queue.take(events)).toEqual({ change: {}, content: "v1" });

        yield* world.library.list({ scope: {} });
        yield* world.library.read({ scope: {}, skill: { name: "mine" } });
        yield* world.library.updateProjectSettings({
          projectPath: project,
          instructionMode: "off",
        });
        expect((yield* Queue.take(events)).change).toEqual({
          projectRoot: project,
          profileRoot: project,
        });
        yield* world.library.saveInstructions({
          scope: { projectPath: project, mode: "shared" },
          content: "Team",
          expectedRevision: null,
        });
        expect((yield* Queue.take(events)).change).toEqual({ projectRoot: project });
        expect(yield* Queue.size(events)).toBe(0);
      }),
    );
  });

  describe("project settings", () => {
    it.effect("refuses to switch global instructions off for a project", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const failure = yield* world.library
          .updateProjectSettings({ projectPath: world.project, globalInstructionsEnabled: false })
          .pipe(Effect.flip);
        expect(failure.reason).toBe("unsupported");
        expect(yield* world.exists(world.path.join(world.baseDir, "skill-projects"))).toBe(false);
      }),
    );

    it.effect("overrides follow the name providers load a skill under", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        yield* world.write(
          path.join(project, ".claude/skills/repo-folder/SKILL.md"),
          "---\nname: deploy\ndescription: Repo deploy\n---\n",
        );
        yield* world.write(
          path.join(project, ".agents/skills/lint-folder/SKILL.md"),
          "---\nname: lint\n---\n",
        );
        const scope = { projectPath: project };
        yield* world.library.save({
          scope,
          skill: { name: "my-deploy" },
          content: "---\nname: deploy\ndescription: Mine\n---\n",
          expectedRevision: null,
        });
        const listed = yield* world.library.list({ scope });
        yield* world.library.setEnabled({
          scope,
          skill: { entryId: entryNamed(listed, "lint-folder").id },
          enabled: false,
        });

        const repo = entryNamed(listed, "repo-folder");
        expect(repo.invocationName).toBe("deploy");
        expect(repo.enabled).toBe(false);
        expect(repo.conflicts.map((conflict) => conflict.reason)).toEqual(["replacedByLocal"]);
        const overlay = Option.getOrThrow(yield* world.library.resolveProjectOverlay(project));
        expect(overlay.skills).toEqual([
          {
            name: "my-deploy",
            path: path.join(overlay.privateRoot, "skills/my-deploy"),
            invocationName: "deploy",
          },
        ]);
        expect(overlay.suppressedRepoSkills).toEqual([
          {
            name: "lint",
            folderName: "lint-folder",
            path: path.join(project, ".agents/skills/lint-folder"),
            reason: "disabled",
          },
          { name: "deploy", path: null, reason: "replaced" },
          {
            name: "deploy",
            folderName: "repo-folder",
            path: path.join(project, ".claude/skills/repo-folder"),
            reason: "replaced",
          },
        ]);
      }),
    );
  });

  describe("shared sync", () => {
    it.effect("links shared skills and instructions for Claude only when asked", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        yield* world.writeSkill(path.join(project, ".agents/skills/team"), "Team");
        yield* world.write(path.join(project, "AGENTS.md"), "Shared rules");
        yield* world.write(path.join(project, "CLAUDE.md"), "Old Claude rules");
        const shared = { projectPath: project, mode: "shared" as const };

        const saved = yield* world.library.save({
          scope: shared,
          skill: { name: "fresh" },
          content: "Fresh",
          expectedRevision: null,
        });
        expect(yield* world.exists(path.join(project, ".claude"))).toBe(false);
        expect(saved.snapshot.linkTargets.map((target) => target.id)).toEqual(["claude"]);
        expect(entryNamed(saved.snapshot, "team").links).toEqual([
          {
            targetId: "claude",
            path: path.join(project, ".claude/skills/team"),
            state: "available",
          },
        ]);
        expect(saved.snapshot.instructions.links[0]).toMatchObject({
          state: "occupied",
          occupant: "file",
        });

        const local = yield* world.library
          .link({
            scope: { projectPath: project },
            subject: { type: "skill", name: "team" },
            targetIds: ["claude"],
          })
          .pipe(Effect.flip);
        expect(local.reason).toBe("unsupported");

        const linked = yield* world.library.link({
          scope: shared,
          subject: { type: "skill", name: "team" },
          targetIds: ["claude"],
        });
        expect(yield* world.readLink(path.join(project, ".claude/skills/team"))).toBe(
          "../../.agents/skills/team",
        );
        const team = entryNamed(linked.snapshot, "team");
        expect(team.links[0]?.state).toBe("linked");
        expect(team.providers).toContain("claudeAgent");

        const refused = yield* world.library
          .link({ scope: shared, subject: { type: "instructions" }, targetIds: ["claude"] })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("conflict");
        const instructions = yield* world.library.link({
          scope: shared,
          subject: { type: "instructions" },
          targetIds: ["claude"],
          replace: true,
        });
        expect(yield* world.readLink(path.join(project, "CLAUDE.md"))).toBe("AGENTS.md");
        expect(instructions.recovery[0]).toMatchObject({ projectRoot: project });
        expect(
          instructions.snapshot.instructions.files.find((file) => file.id === "repo:CLAUDE.md")
            ?.ownedLink,
        ).toBe(true);
        expect(instructions.snapshot.recovery.map((entry) => entry.id)).toEqual([
          instructions.recovery[0]!.id,
        ]);

        yield* world.library.restore({ scope: shared, recoveryId: instructions.recovery[0]!.id });
        expect(yield* world.read(path.join(project, "CLAUDE.md"))).toBe("Old Claude rules");
        const unlinked = yield* world.library.unlink({
          scope: shared,
          subject: { type: "skill", name: "team" },
          targetIds: ["claude"],
        });
        expect(unlinked.removed).toEqual([path.join(project, ".claude/skills/team")]);
        expect(yield* world.read(path.join(project, ".agents/skills/team/SKILL.md"))).toContain(
          "Team",
        );
        expect(yield* world.read(path.join(project, "AGENTS.md"))).toBe("Shared rules");
      }),
    );
  });

  describe("shared instruction paths", () => {
    it.effect("follows links only while they stay inside the checkout", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path, project } = world;
        const outside = path.join(world.root, "outside.md");
        yield* world.write(outside, "External");
        const alias = path.join(world.root, "alias");
        yield* world.symlink(project, alias);
        yield* world.symlink(outside, path.join(project, "CLAUDE.md"));
        const shared = { projectPath: alias, mode: "shared" as const };

        const readOut = yield* world.library
          .readInstructions({ scope: shared, file: "CLAUDE.md" })
          .pipe(Effect.flip);
        expect(readOut.reason).toBe("readOnly");
        const writeOut = yield* world.library
          .saveInstructions({
            scope: shared,
            file: "CLAUDE.md",
            content: "x",
            expectedRevision: null,
          })
          .pipe(Effect.flip);
        expect(writeOut.reason).toBe("readOnly");
        expect(yield* world.read(outside)).toBe("External");

        const saved = yield* world.library.saveInstructions({
          scope: shared,
          content: "Team",
          expectedRevision: null,
        });
        expect(saved.path).toBe(path.join(project, "AGENTS.md"));
        yield* world.fileSystem.remove(path.join(project, "CLAUDE.md"));
        yield* world.symlink("AGENTS.md", path.join(project, "CLAUDE.md"));
        const viaLink = yield* world.library.readInstructions({ scope: shared, file: "CLAUDE.md" });
        expect(viaLink.content).toBe("Team");
        yield* world.library.saveInstructions({
          scope: shared,
          file: "CLAUDE.md",
          content: "Team v2",
          expectedRevision: viaLink.revision,
        });
        expect(yield* world.read(path.join(project, "AGENTS.md"))).toBe("Team v2");
        expect(yield* world.readLink(path.join(project, "CLAUDE.md"))).toBe("AGENTS.md");

        yield* world.write(path.join(project, "AGENTS.md"), "x".repeat(2_000_001));
        const large = yield* world.library.readInstructions({ scope: shared }).pipe(Effect.flip);
        expect(large.reason).toBe("unsupported");
      }),
    );
  });

  describe("file listing", () => {
    it.effect("skips links that leave the skill and survives cycles", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { path } = world;
        yield* world.library.save({
          scope: {},
          skill: { name: "mine" },
          content: "x",
          expectedRevision: null,
        });
        const skill = path.join(world.baseDir, "skills/mine");
        yield* world.write(path.join(world.root, "outside/secret.md"), "secret");
        yield* world.symlink(path.join(world.root, "outside"), path.join(skill, "external"));
        yield* world.write(path.join(skill, "docs/guide.md"), "guide");
        yield* world.symlink("..", path.join(skill, "docs/loop"));

        const read = yield* world.library.read({ scope: {}, skill: { name: "mine" } });

        expect(read.files).toEqual(["SKILL.md", "docs/guide.md"]);
        expect(read.filesTruncated).toBe(false);
      }),
    );
  });
});
