/**
 * Bounded filesystem scan of skill folders.
 *
 * Each root is read one level deep, the way Claude Code, Codex, and
 * Antigravity load skills. Symlinked entries are followed to their physical
 * folder, which is the dedupe key, so `~/.claude/skills/foo -> ~/.agents/skills/foo`
 * is one skill with two origins. `realPath` fails on symlink cycles, which
 * drops the entry instead of looping. Nothing here writes.
 *
 * @module skills/skillScan
 */
import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { parse as parseYamlDocument } from "yaml";

import type { SkillRootSpec } from "./skillLocations.ts";

const MAX_SCAN_ENTRIES = 10_000;
const MAX_SCAN_BYTES = 8_000_000;
const MAX_SKILL_FILE_BYTES = 1_000_000;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type ScannedSkillKind = "skills" | "system" | "plugin";

export interface ScannedOrigin {
  readonly providers: ReadonlyArray<ProviderDriverKind>;
  readonly rootPath: string;
  readonly entryPath: string;
  readonly symlinkTarget: string | undefined;
}

export interface ScannedSkill {
  readonly realPath: string;
  /** The folder name of the first origin. */
  readonly name: string;
  /** Frontmatter `name`, else the folder name: what providers load it as. */
  readonly invocationName: string;
  readonly description: string | undefined;
  readonly kind: ScannedSkillKind;
  readonly pluginId: string | undefined;
  readonly origins: Array<ScannedOrigin>;
}

export interface ScanBudget {
  remainingEntries: number;
  remainingBytes: number;
  readonly warnings: Array<string>;
}

export const makeScanBudget = (): ScanBudget => ({
  remainingEntries: MAX_SCAN_ENTRIES,
  remainingBytes: MAX_SCAN_BYTES,
  warnings: [],
});

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const errorCode = (error: PlatformError.PlatformError) =>
  error.cause instanceof Error && "code" in error.cause ? error.cause.code : undefined;

/** True for the errors `readlink` returns on something that is not a symlink. */
export const isNotASymlink = (error: PlatformError.PlatformError) =>
  isNotFound(error) || errorCode(error) === "EINVAL" || errorCode(error) === "UNKNOWN";

const MAX_INVOCATION_NAME_LENGTH = 128;

const isWithinOrEqual = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

function parseSkillFrontmatter(contents: string): {
  readonly name: string | undefined;
  readonly description: string | undefined;
} {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return { name: undefined, description: undefined };
  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    if (typeof parsed !== "object" || parsed === null) {
      return { name: undefined, description: undefined };
    }
    const { name, description } = parsed as Record<string, unknown>;
    const trimmedName = typeof name === "string" ? name.trim() : "";
    return {
      name:
        trimmedName && trimmedName.length <= MAX_INVOCATION_NAME_LENGTH ? trimmedName : undefined,
      description:
        typeof description === "string" && description.trim() ? description.trim() : undefined,
    };
  } catch {
    return { name: undefined, description: undefined };
  }
}

/** Read one skill folder: `SKILL.md` must be a regular file inside it. */
export const inspectSkillFolder = Effect.fn("inspectSkillFolder")(function* (
  entryPath: string,
  budget: ScanBudget,
): Effect.fn.Return<
  | {
      readonly realPath: string;
      readonly symlinkTarget: string | undefined;
      /** Frontmatter `name`, when SKILL.md was read and sets one. */
      readonly frontmatterName: string | undefined;
      readonly description: string | undefined;
    }
  | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const symlinkTarget = yield* fileSystem.readLink(entryPath).pipe(
    Effect.asSome,
    Effect.catchIf(isNotASymlink, () => Effect.succeedNone),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const realPath = yield* fileSystem
    .realPath(entryPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (realPath === undefined) return undefined;
  const info = yield* fileSystem.stat(realPath).pipe(Effect.orElseSucceed(() => undefined));
  if (info?.type !== "Directory") return undefined;
  const skillFile = path.join(realPath, "SKILL.md");
  const skillInfo = yield* fileSystem.stat(skillFile).pipe(Effect.orElseSucceed(() => undefined));
  if (skillInfo?.type !== "File") return undefined;

  let frontmatter: ReturnType<typeof parseSkillFrontmatter> = {
    name: undefined,
    description: undefined,
  };
  const size = Number(skillInfo.size);
  if (size <= MAX_SKILL_FILE_BYTES && size <= budget.remainingBytes) {
    budget.remainingBytes -= size;
    const contents = yield* fileSystem
      .readFileString(skillFile)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents !== undefined) frontmatter = parseSkillFrontmatter(contents);
  }
  return {
    realPath,
    symlinkTarget: Option.getOrUndefined(symlinkTarget),
    frontmatterName: frontmatter.name,
    description: frontmatter.description,
  };
});

/** One directory's entries, sorted, charged against the scan budget. */
export const listSkillDirectory = Effect.fn("listSkillDirectory")(function* (
  directory: string,
  budget: ScanBudget,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem.readDirectory(directory).pipe(
    Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])),
    Effect.catch((cause) => {
      budget.warnings.push(`Could not read ${directory}: ${cause.message}`);
      return Effect.succeed<ReadonlyArray<string>>([]);
    }),
  );
  if (entries.length > budget.remainingEntries) {
    budget.warnings.push(`Stopped scanning ${directory}: too many entries.`);
    const allowed = entries.toSorted().slice(0, budget.remainingEntries);
    budget.remainingEntries = 0;
    return allowed;
  }
  budget.remainingEntries -= entries.length;
  return entries.toSorted();
});

/**
 * Scan roots into physical skills keyed by real path. Callers pass a map so
 * the library folders and provider roots share one dedupe table.
 */
export const scanSkillRoots = Effect.fn("scanSkillRoots")(function* (
  roots: ReadonlyArray<SkillRootSpec>,
  budget: ScanBudget,
  skills: Map<string, ScannedSkill>,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const addSkill = Effect.fn("addScannedSkill")(function* (input: {
    readonly root: SkillRootSpec;
    readonly rootPath: string;
    readonly entryPath: string;
    readonly kind: ScannedSkillKind;
    readonly pluginId?: string;
  }) {
    const inspected = yield* inspectSkillFolder(input.entryPath, budget);
    if (!inspected) return;
    const origin: ScannedOrigin = {
      providers: input.root.providers,
      rootPath: input.rootPath,
      entryPath: input.entryPath,
      symlinkTarget: inspected.symlinkTarget,
    };
    const existing = skills.get(inspected.realPath);
    if (existing) {
      if (!existing.origins.some((candidate) => candidate.entryPath === origin.entryPath)) {
        existing.origins.push(origin);
      }
      return;
    }
    const name = path.basename(input.entryPath);
    skills.set(inspected.realPath, {
      realPath: inspected.realPath,
      name,
      invocationName: inspected.frontmatterName ?? name,
      description: inspected.description,
      kind: input.kind,
      pluginId: input.pluginId,
      origins: [origin],
    });
  });

  const scanFolder = Effect.fn("scanSkillFolder")(function* (
    root: SkillRootSpec,
    directory: string,
    kind: ScannedSkillKind,
    pluginId?: string,
  ): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
    for (const name of yield* listSkillDirectory(directory, budget)) {
      if (name.startsWith(".")) {
        if (name === ".system" && root.systemChildren && kind === "skills") {
          yield* scanFolder(root, path.join(directory, name), "system");
        }
        continue;
      }
      yield* addSkill({
        root,
        rootPath: directory,
        entryPath: path.join(directory, name),
        kind,
        ...(pluginId ? { pluginId } : {}),
      });
    }
  });

  /**
   * `<cache>/<marketplace>/<plugin>/<version>/skills`. Old versions linger in
   * the cache, so only the most recently modified version of each plugin counts.
   */
  const scanPluginCache = Effect.fn("scanSkillPluginCache")(function* (root: SkillRootSpec) {
    for (const marketplace of yield* listSkillDirectory(root.path, budget)) {
      if (marketplace.startsWith(".")) continue;
      const marketplacePath = path.join(root.path, marketplace);
      for (const plugin of yield* listSkillDirectory(marketplacePath, budget)) {
        if (plugin.startsWith(".")) continue;
        const pluginPath = path.join(marketplacePath, plugin);
        let latest: { readonly path: string; readonly mtime: number } | undefined;
        for (const version of yield* listSkillDirectory(pluginPath, budget)) {
          if (version.startsWith(".")) continue;
          const versionPath = path.join(pluginPath, version);
          const info = yield* fileSystem
            .stat(versionPath)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (info?.type !== "Directory") continue;
          const mtime = Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
          if (!latest || mtime > latest.mtime) latest = { path: versionPath, mtime };
        }
        if (latest) {
          yield* scanFolder(
            root,
            path.join(latest.path, "skills"),
            "plugin",
            `${plugin}@${marketplace}`,
          );
        }
      }
    }
  });

  for (const root of roots) {
    if (budget.remainingEntries === 0) break;
    if (root.kind === "plugins") {
      yield* scanPluginCache(root);
    } else {
      yield* scanFolder(root, root.path, "skills");
    }
  }
});

const MAX_LISTED_FILES = 500;
const MAX_LISTED_DEPTH = 8;
const MAX_LISTED_DIRECTORIES = 200;
const MAX_EXAMINED_ENTRIES = 5_000;

/**
 * Files inside one skill folder, relative and `/`-separated, capped. Links
 * that lead out of the skill are skipped rather than followed, and every
 * physical folder is visited once, so cycles and huge trees stay bounded.
 */
export const listSkillFiles = Effect.fn("listSkillFiles")(function* (
  skillPath: string,
): Effect.fn.Return<
  { readonly files: ReadonlyArray<string>; readonly truncated: boolean },
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  const visited = new Set<string>();
  let examined = 0;
  let truncated = false;
  const root = yield* fileSystem.realPath(skillPath).pipe(Effect.orElseSucceed(() => undefined));
  if (root === undefined) return { files, truncated };

  const visit = Effect.fn("visitSkillFiles")(function* (
    directory: string,
    prefix: string,
    depth: number,
  ): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
    if (visited.size >= MAX_LISTED_DIRECTORIES) {
      truncated = true;
      return;
    }
    visited.add(directory);
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of entries.toSorted()) {
      if (files.length >= MAX_LISTED_FILES || examined >= MAX_EXAMINED_ENTRIES) {
        truncated = true;
        return;
      }
      examined += 1;
      const real = yield* fileSystem
        .realPath(path.join(directory, entry))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (real === undefined || !isWithinOrEqual(path, root, real)) continue;
      const info = yield* fileSystem.stat(real).pipe(Effect.orElseSucceed(() => undefined));
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (info?.type === "Directory") {
        if (visited.has(real)) continue;
        if (depth >= MAX_LISTED_DEPTH) {
          truncated = true;
          continue;
        }
        yield* visit(real, relative, depth + 1);
      } else if (info?.type === "File") {
        files.push(relative);
      }
    }
  });

  yield* visit(root, "", 0);
  return { files, truncated };
});
