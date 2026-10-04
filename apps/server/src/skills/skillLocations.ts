/**
 * Where each provider looks for skills and instruction files on this
 * environment, mirroring the provider scanners in `provider/Drivers`.
 *
 * Homes come from the host environment and server settings, falling back to
 * `os.homedir()` only when `HOME` is unset, so tests point every provider at a
 * temp folder.
 *
 * @module skills/skillLocations
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  resolveProviderInstanceEnabled,
  type ServerSettings,
  type SkillProviderSupport,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");
const OPENCODE = ProviderDriverKind.make("opencode");
const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const GROK = ProviderDriverKind.make("grok");
const PI = ProviderDriverKind.make("pi");

const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

export interface SkillHomes {
  readonly home: string;
  /** Distinct Codex homes across configured instances, the default first. */
  readonly codexHomes: ReadonlyArray<string>;
  /** Distinct Claude config dirs across configured instances, the default first. */
  readonly claudeConfigDirs: ReadonlyArray<string>;
  readonly opencodeConfigDir: string;
  readonly geminiHome: string;
  /** The Codex homes of instances enabled in T3's settings. */
  readonly enabledCodexHomes: ReadonlyArray<string>;
  /** The Claude config dirs of instances enabled in T3's settings. */
  readonly enabledClaudeConfigDirs: ReadonlyArray<string>;
  /** Providers with at least one instance enabled in T3's settings. */
  readonly enabledProviders: ReadonlyArray<ProviderDriverKind>;
}

export interface SkillRootSpec {
  readonly path: string;
  readonly providers: ReadonlyArray<ProviderDriverKind>;
  /** `plugins` roots hold `<marketplace>/<plugin>/<version>/skills`. */
  readonly kind: "skills" | "plugins";
  /** Codex keeps bundled skills in `skills/.system`; list them as system skills. */
  readonly systemChildren: boolean;
}

export interface SkillLinkTargetSpec {
  readonly id: string;
  readonly path: string;
  readonly providers: ReadonlyArray<ProviderDriverKind>;
}

const shortHash = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 8);

/**
 * A driver's configured instances with whether each is enabled, by the same
 * rule as the provider registry. Explicit default slots replace the legacy
 * settings, as in the registry; T3's defaults enable Codex and Claude only.
 */
function instancesOf(
  settings: ServerSettings,
  driver: ProviderDriverKind,
): ReadonlyArray<{
  readonly config: unknown;
  readonly environment: ProviderInstanceConfig["environment"];
  readonly enabled: boolean;
}> {
  const explicit: Array<
    Pick<ProviderInstanceConfig, "driver" | "enabled" | "config" | "environment">
  > = Object.values(settings.providerInstances).filter((instance) => instance.driver === driver);
  const legacy = (settings.providers as Partial<Record<string, unknown>>)[driver];
  const instances =
    Object.hasOwn(settings.providerInstances, driver) || legacy === undefined
      ? explicit
      : [{ driver, config: legacy }, ...explicit];
  return instances.map((instance) => ({
    config: instance.config,
    environment: instance.environment,
    enabled: resolveProviderInstanceEnabled(instance),
  }));
}

/** Resolve provider homes the way the spawned CLIs would see them. */
export const resolveSkillHomes = Effect.fn("resolveSkillHomes")(function* (input: {
  readonly settings: ServerSettings | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): Effect.fn.Return<SkillHomes, never, Path.Path> {
  const path = yield* Path.Path;
  const { environment, platform } = input;
  const settings = input.settings ?? DEFAULT_SERVER_SETTINGS;
  const home =
    (platform === "win32" ? environment.USERPROFILE : environment.HOME)?.trim() || NodeOS.homedir();
  const expand = (value: string) =>
    path.resolve(
      value === "~"
        ? home
        : value.startsWith("~/") || value.startsWith("~\\")
          ? path.join(home, value.slice(2))
          : value,
    );

  const codexHomes = new Set<string>();
  const enabledCodexHomes = new Set<string>();
  for (const instance of instancesOf(settings, CODEX)) {
    const env = mergeProviderInstanceEnvironment(instance.environment, environment);
    const config = Option.getOrUndefined(decodeCodexSettings(instance.config ?? {}));
    const configured = config?.homePath.trim() || env.CODEX_HOME?.trim();
    const codexHome = configured ? expand(configured) : path.join(home, ".codex");
    codexHomes.add(codexHome);
    if (instance.enabled) enabledCodexHomes.add(codexHome);
  }
  const claudeConfigDirs = new Set<string>();
  const enabledClaudeConfigDirs = new Set<string>();
  for (const instance of instancesOf(settings, CLAUDE)) {
    const env = mergeProviderInstanceEnvironment(instance.environment, environment);
    const config = Option.getOrUndefined(decodeClaudeSettings(instance.config ?? {}));
    const configured = config?.homePath.trim() || env.CLAUDE_CONFIG_DIR?.trim();
    const configDir = configured ? expand(configured) : path.join(home, ".claude");
    claudeConfigDirs.add(configDir);
    if (instance.enabled) enabledClaudeConfigDirs.add(configDir);
  }
  // A driver with no instance at all, such as a fork's, still gets its folders scanned.
  if (codexHomes.size === 0) codexHomes.add(path.join(home, ".codex"));
  if (claudeConfigDirs.size === 0) claudeConfigDirs.add(path.join(home, ".claude"));

  const xdgConfig = environment.XDG_CONFIG_HOME?.trim();
  return {
    home,
    codexHomes: [...codexHomes],
    claudeConfigDirs: [...claudeConfigDirs],
    opencodeConfigDir:
      xdgConfig && path.isAbsolute(xdgConfig)
        ? path.join(xdgConfig, "opencode")
        : path.join(home, ".config", "opencode"),
    geminiHome: path.join(home, ".gemini"),
    enabledCodexHomes: [...enabledCodexHomes],
    enabledClaudeConfigDirs: [...enabledClaudeConfigDirs],
    enabledProviders: [CODEX, CLAUDE, CURSOR, OPENCODE, ANTIGRAVITY, GROK, PI].filter((provider) =>
      instancesOf(settings, provider).some((instance) => instance.enabled),
    ),
  };
});

function mergeRoots(roots: ReadonlyArray<SkillRootSpec>): ReadonlyArray<SkillRootSpec> {
  const byPath = new Map<string, SkillRootSpec>();
  for (const root of roots) {
    const existing = byPath.get(root.path);
    byPath.set(
      root.path,
      existing
        ? {
            ...existing,
            providers: [...new Set([...existing.providers, ...root.providers])],
            systemChildren: existing.systemChildren || root.systemChildren,
          }
        : root,
    );
  }
  return [...byPath.values()];
}

const skillsRoot = (
  path: string,
  providers: ReadonlyArray<ProviderDriverKind>,
  systemChildren = false,
): SkillRootSpec => ({ path, providers, kind: "skills", systemChildren });

/**
 * User-level skill folders. Cursor and OpenCode also read the Claude and
 * Codex folders under the literal home, whatever a T3 instance overrides.
 */
export function globalSkillRoots(path: Path.Path, homes: SkillHomes): ReadonlyArray<SkillRootSpec> {
  const defaultCodexSkills = path.join(homes.home, ".codex", "skills");
  const defaultClaudeSkills = path.join(homes.home, ".claude", "skills");
  return mergeRoots([
    skillsRoot(path.join(homes.home, ".agents", "skills"), [CODEX, CURSOR, OPENCODE]),
    ...homes.codexHomes.map((codexHome) =>
      skillsRoot(path.join(codexHome, "skills"), [CODEX], true),
    ),
    skillsRoot(defaultCodexSkills, [CURSOR], true),
    ...homes.claudeConfigDirs.map((dir) => skillsRoot(path.join(dir, "skills"), [CLAUDE])),
    skillsRoot(defaultClaudeSkills, [CURSOR, OPENCODE]),
    skillsRoot(path.join(homes.home, ".cursor", "skills"), [CURSOR]),
    skillsRoot(path.join(homes.opencodeConfigDir, "skills"), [OPENCODE]),
    skillsRoot(path.join(homes.opencodeConfigDir, "skill"), [OPENCODE]),
    skillsRoot(path.join(homes.geminiHome, "config", "skills"), [ANTIGRAVITY]),
    skillsRoot(path.join(homes.geminiHome, "antigravity-cli", "skills"), [ANTIGRAVITY]),
    ...homes.codexHomes.map((codexHome): SkillRootSpec => ({
      path: path.join(codexHome, "plugins", "cache"),
      providers: [CODEX],
      kind: "plugins",
      systemChildren: false,
    })),
    ...homes.claudeConfigDirs.map((dir): SkillRootSpec => ({
      path: path.join(dir, "plugins", "cache"),
      providers: [CLAUDE],
      kind: "plugins",
      systemChildren: false,
    })),
  ]);
}

/** Project skill folders, relative to the project root, and who reads them. */
const PROJECT_SKILL_ROOTS: ReadonlyArray<readonly [string, ReadonlyArray<ProviderDriverKind>]> = [
  [".agents/skills", [CODEX, CURSOR, OPENCODE, ANTIGRAVITY]],
  [".codex/skills", [CURSOR]],
  [".claude/skills", [CLAUDE, CURSOR, OPENCODE]],
  [".cursor/skills", [CURSOR]],
  [".opencode/skills", [OPENCODE]],
  [".opencode/skill", [OPENCODE]],
  [".gemini/skills", [ANTIGRAVITY]],
  [".agent/skills", [ANTIGRAVITY]],
];

export function projectSkillRoots(
  path: Path.Path,
  projectRoot: string,
): ReadonlyArray<SkillRootSpec> {
  return PROJECT_SKILL_ROOTS.map(([relative, providers]) =>
    skillsRoot(path.join(projectRoot, ...relative.split("/")), providers),
  );
}

/** True when `folder` is where a provider looks for a project's skills, such as `<any>/.claude/skills`. */
export function isProjectSkillFolder(folder: string): boolean {
  const normalized = folder.replaceAll("\\", "/");
  return PROJECT_SKILL_ROOTS.some(([relative]) => normalized.endsWith(`/${relative}`));
}

/** Shared mode writes new and imported skills here: the folder most providers read. */
export const SHARED_PROJECT_SKILLS_DIR = [".agents", "skills"] as const;

/** Instruction files a repository can carry, and who reads them. */
const PROJECT_INSTRUCTION_FILES: ReadonlyArray<
  readonly [string, ReadonlyArray<ProviderDriverKind>]
> = [
  ["AGENTS.md", [CODEX, CURSOR, OPENCODE]],
  ["CLAUDE.md", [CLAUDE]],
  [".claude/CLAUDE.md", [CLAUDE]],
  ["GEMINI.md", [ANTIGRAVITY]],
];

export function projectInstructionFiles(path: Path.Path, projectRoot: string) {
  return PROJECT_INSTRUCTION_FILES.map(([relative, providers]) => ({
    id: `repo:${relative}`,
    path: path.join(projectRoot, ...relative.split("/")),
    providers,
  }));
}

/**
 * Folders T3 links library skills into, one symlink per skill. `.agents/skills`
 * covers Codex, Cursor, and OpenCode at once and is the usual choice. Each
 * Codex home is offered too, for a custom `CODEX_HOME` that does not read the
 * user's `.agents` folder. Links are per skill and skill names never start
 * with a dot, so Codex's `.system` folder is never touched.
 *
 * Each target names every provider that reads its folder, per
 * `globalSkillRoots`, so a link into the literal `~/.codex/skills` also says
 * it reaches Cursor while a custom Codex home does not.
 */
export function skillLinkTargets(
  path: Path.Path,
  homes: SkillHomes,
): ReadonlyArray<SkillLinkTargetSpec> {
  const readers = new Map(
    globalSkillRoots(path, homes).map((root) => [root.path, root.providers] as const),
  );
  return linkTargetFolders(path, homes).map((target) => ({
    ...target,
    providers: readers.get(target.path) ?? target.providers,
  }));
}

function linkTargetFolders(path: Path.Path, homes: SkillHomes): ReadonlyArray<SkillLinkTargetSpec> {
  return [
    {
      id: "agents",
      path: path.join(homes.home, ".agents", "skills"),
      providers: [CODEX, CURSOR, OPENCODE],
    },
    ...homes.codexHomes.map((codexHome, index) => ({
      id: index === 0 ? "codex" : `codex:${shortHash(codexHome)}`,
      path: path.join(codexHome, "skills"),
      providers: [CODEX],
    })),
    ...homes.claudeConfigDirs.map((dir, index) => ({
      id: index === 0 ? "claude" : `claude:${shortHash(dir)}`,
      path: path.join(dir, "skills"),
      providers: [CLAUDE],
    })),
    { id: "cursor", path: path.join(homes.home, ".cursor", "skills"), providers: [CURSOR] },
    {
      id: "opencode",
      path: path.join(homes.opencodeConfigDir, "skills"),
      providers: [OPENCODE],
    },
    {
      id: "antigravity",
      path: path.join(homes.geminiHome, "config", "skills"),
      providers: [ANTIGRAVITY],
    },
  ];
}

/**
 * The link target folders a global library skill needs so that every provider
 * enabled in T3's settings reaches it, in `skillLinkTargets` order. `reached`
 * holds the skill folders (as in `globalSkillRoots`) that already reach the
 * skill, and `excluded` the target folders the user unlinked it from.
 *
 * Each enabled Codex home and Claude config dir gets its own folder: a custom
 * `CODEX_HOME` is not assumed to read `~/.agents/skills`. Cursor, OpenCode,
 * and Antigravity get their own folder only when no folder they read is
 * reached or planned already, so a skill is not listed to them twice.
 */
export function planDefaultLinks(
  path: Path.Path,
  homes: SkillHomes,
  input: { readonly reached: ReadonlySet<string>; readonly excluded: ReadonlySet<string> },
): ReadonlyArray<string> {
  const skillRoots = globalSkillRoots(path, homes).filter((root) => root.kind === "skills");
  const readBy = (provider: ProviderDriverKind) =>
    skillRoots.filter((root) => root.providers.includes(provider)).map((root) => root.path);
  const enabled = new Set(homes.enabledProviders);
  const defaultCodexHome = path.join(homes.home, ".codex");
  const consumers: ReadonlyArray<{
    readonly reads: ReadonlyArray<string>;
    readonly target: string;
  }> = [
    ...homes.enabledCodexHomes.map((codexHome) => ({
      reads: [
        path.join(codexHome, "skills"),
        ...(codexHome === defaultCodexHome ? [path.join(homes.home, ".agents", "skills")] : []),
      ],
      target: path.join(codexHome, "skills"),
    })),
    ...homes.enabledClaudeConfigDirs.map((dir) => ({
      reads: [path.join(dir, "skills")],
      target: path.join(dir, "skills"),
    })),
    ...(enabled.has(CURSOR)
      ? [{ reads: readBy(CURSOR), target: path.join(homes.home, ".cursor", "skills") }]
      : []),
    ...(enabled.has(OPENCODE)
      ? [{ reads: readBy(OPENCODE), target: path.join(homes.opencodeConfigDir, "skills") }]
      : []),
    ...(enabled.has(ANTIGRAVITY)
      ? [{ reads: readBy(ANTIGRAVITY), target: path.join(homes.geminiHome, "config", "skills") }]
      : []),
  ];
  const reached = new Set(input.reached);
  const planned: Array<string> = [];
  for (const consumer of consumers) {
    if (consumer.reads.some((folder) => reached.has(folder))) continue;
    if (input.excluded.has(consumer.target)) continue;
    if (!planned.includes(consumer.target)) planned.push(consumer.target);
    reached.add(consumer.target);
  }
  return planned;
}

/**
 * Repository folders T3 links shared skills from `.agents/skills` into. Only
 * providers that ignore `.agents/skills` need one; the others already read the
 * canonical folder, and a second copy would list every skill twice.
 */
export function projectSkillLinkTargets(
  path: Path.Path,
  projectRoot: string,
): ReadonlyArray<SkillLinkTargetSpec> {
  return [{ id: "claude", path: path.join(projectRoot, ".claude", "skills"), providers: [CLAUDE] }];
}

/** Repository instruction files T3 can link to the repository's `AGENTS.md`. */
export function projectInstructionLinkTargets(
  path: Path.Path,
  projectRoot: string,
): ReadonlyArray<SkillLinkTargetSpec> {
  return [{ id: "claude", path: path.join(projectRoot, "CLAUDE.md"), providers: [CLAUDE] }];
}

/** User-level instruction files T3 can replace with a link to the global instructions. */
export function instructionLinkTargets(
  path: Path.Path,
  homes: SkillHomes,
): ReadonlyArray<SkillLinkTargetSpec> {
  return [
    ...homes.codexHomes.map((codexHome, index) => ({
      id: index === 0 ? "codex" : `codex:${shortHash(codexHome)}`,
      path: path.join(codexHome, "AGENTS.md"),
      providers: [CODEX],
    })),
    ...homes.claudeConfigDirs.map((dir, index) => ({
      id: index === 0 ? "claude" : `claude:${shortHash(dir)}`,
      path: path.join(dir, "CLAUDE.md"),
      providers: [CLAUDE],
    })),
    {
      id: "opencode",
      path: path.join(homes.opencodeConfigDir, "AGENTS.md"),
      providers: [OPENCODE],
    },
  ];
}

const LIMITATIONS: Partial<Record<string, ReadonlyArray<string>>> = {
  [CODEX]: [
    "Codex also reads .agents/skills in folders between the working directory and the repository root. T3 lists the project root only.",
    "Admin skills in /etc/codex/skills are not listed.",
  ],
  [CLAUDE]: [
    "Skills switched off with Claude Code's skillOverrides setting still show as enabled.",
    "Claude Code switches skills off by name, so switching one off in a project also hides other skills with that name there.",
    "Claude Code does not read .agents/skills. In shared mode, link repository skills into .claude/skills to reach it.",
  ],
  [CURSOR]: [
    "Cursor also finds skills in nested folders. T3 lists the top level of each folder only.",
    "Cursor has no global instructions file. Its user rules live in Cursor settings.",
  ],
  [OPENCODE]: ["Skill folders added in OpenCode's own config are not listed."],
  [ANTIGRAVITY]: [
    "Antigravity reads global instructions from its own profile, so T3 does not link them.",
  ],
  [GROK]: ["Grok reports its skills through its CLI. T3 does not scan or link Grok skill folders."],
  [PI]: ["Pi reports its skills through its RPC. T3 does not scan or link Pi skill folders."],
};

export function providerSupport(input: {
  readonly enabledProviders: ReadonlyArray<ProviderDriverKind>;
  readonly globalRoots: ReadonlyArray<SkillRootSpec>;
  readonly linkTargets: ReadonlyArray<SkillLinkTargetSpec>;
  readonly instructionTargets: ReadonlyArray<SkillLinkTargetSpec>;
}): ReadonlyArray<SkillProviderSupport> {
  const scanned = [CODEX, CLAUDE, CURSOR, OPENCODE, ANTIGRAVITY];
  const support = scanned.map((provider) => ({
    provider,
    scanned: true,
    enabled: input.enabledProviders.includes(provider),
    globalRoots: input.globalRoots
      .filter((root) => root.providers.includes(provider))
      .map((root) => root.path),
    projectRoots: PROJECT_SKILL_ROOTS.filter(([, providers]) => providers.includes(provider)).map(
      ([relative]) => relative,
    ),
    linkTargetIds: input.linkTargets
      .filter((target) => target.providers.includes(provider))
      .map((target) => target.id),
    instructionTargetIds: input.instructionTargets
      .filter((target) => target.providers.includes(provider))
      .map((target) => target.id),
    limitations: LIMITATIONS[provider] ?? [],
  }));
  const reportedOnly = [GROK, PI].map((provider) => ({
    provider,
    scanned: false,
    enabled: input.enabledProviders.includes(provider),
    globalRoots: [],
    projectRoots: [],
    linkTargetIds: [],
    instructionTargetIds: [],
    limitations: LIMITATIONS[provider] ?? [],
  }));
  return [...support, ...reportedOnly];
}
