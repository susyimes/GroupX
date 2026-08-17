import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GroupXError } from "./core/errors.js";
import {
  BUILTIN_AGENT_IDS,
  resolveAgentCommand,
  systemCommandResolverDependencies,
  type AgentDriver,
  type BuiltinAgentId,
  type CommandResolverDependencies,
  type CommandSpec
} from "./launch/command-spec.js";

export const TRANSPORT_MODES = ["direct", "structured"] as const;
export const DEFAULT_CONTEXT_CHARACTERS = 256_000;
export const LEGACY_CONTEXT_CHARACTERS = 48_000;

export type TransportMode = (typeof TRANSPORT_MODES)[number];

/** Direct is a storage/history discriminator only; every public runtime entry rejects it. */
export const TRANSPORT_LIFECYCLE = {
  direct: "deprecated",
  structured: "active"
} as const satisfies Record<TransportMode, "active" | "deprecated">;

export function assertActiveTransport(
  transport: TransportMode
): asserts transport is "structured" {
  if (transport === "structured") return;
  throw new GroupXError(
    "ADAPTER_START_FAILED",
    "Direct transport is deprecated and disabled; use structured transport"
  );
}

const runtimeTransportSchema = z.enum(TRANSPORT_MODES).superRefine((transport, context) => {
  if (transport === "structured") return;
  context.addIssue({
    code: "custom",
    message: "Direct transport is deprecated and disabled; use structured"
  });
});

const commandSpecSchema = z
  .object({
    executable: z.string().min(1),
    prefixArgs: z.array(z.string().min(1)).default([])
  })
  .strict();

const commandInputSchema = z
  .union([z.string().min(1), commandSpecSchema])
  .transform((command): CommandSpec =>
    typeof command === "string" ? { executable: command, prefixArgs: [] } : command
  );

const agentIdKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u, "invalid agent id");

const agentConfigSchema = z
  .object({
    // Omit for the builtin ids (codex/grok/kimi/hermes/claude); required for custom ids.
    driver: z.enum(BUILTIN_AGENT_IDS).optional(),
    name: z.string().min(1).max(64).optional(),
    /** Stable GroupX room identity injected into every turn for this Agent. */
    identity: z.string().max(32_768).optional(),
    command: commandInputSchema,
    cwd: z.string().min(1),
    enabled: z.boolean().default(true)
  })
  .strict();

const agentsConfigSchema = z
  .record(agentIdKeySchema, agentConfigSchema)
  .superRefine((agents, context) => {
    if (Object.keys(agents).length === 0) {
      context.addIssue({ code: "custom", message: "At least one agent is required" });
    }
    for (const [agentId, agent] of Object.entries(agents)) {
      if (agent.driver === undefined && !isBuiltinAgentId(agentId)) {
        context.addIssue({
          code: "custom",
          path: [agentId, "driver"],
          message: `Custom agent "${agentId}" requires a driver: ${BUILTIN_AGENT_IDS.join(" | ")}`
        });
      }
    }
  })
  .transform((agents) =>
    Object.fromEntries(
      Object.entries(agents).map(([agentId, agent]) => [
        agentId,
        { ...agent, driver: agent.driver ?? (agentId as AgentDriver) }
      ])
    )
  );

export function isBuiltinAgentId(agentId: string): agentId is BuiltinAgentId {
  return (BUILTIN_AGENT_IDS as readonly string[]).includes(agentId);
}

const groupXConfigSchema = z
  .object({
    transport: runtimeTransportSchema.default("structured"),
    server: z
      .object({
        host: z.literal("127.0.0.1").default("127.0.0.1"),
        port: z.number().int().min(1).max(65_535).default(4_310)
      })
      .strict()
      .default({ host: "127.0.0.1", port: 4_310 }),
    storage: z
      .object({
        path: z.string().min(1).default(".groupx/groupx.db")
      })
      .strict()
      .default({ path: ".groupx/groupx.db" }),
    agents: agentsConfigSchema.default({
      codex: { driver: "codex", command: { executable: "codex", prefixArgs: [] }, cwd: ".", enabled: true },
      grok: { driver: "grok", command: { executable: "grok", prefixArgs: [] }, cwd: ".", enabled: true },
      kimi: { driver: "kimi", command: { executable: "kimi", prefixArgs: [] }, cwd: ".", enabled: true }
    }),
    limits: z
      .object({
        // REST/MCP request schemas use the same fixed wire bound. Keep this
        // field for an explicit runtime snapshot, but do not pretend a config
        // value can widen or narrow a parser that is intentionally static.
        // The retired 32_768 literal stays parseable so older generated
        // configs load; the loader upgrades it to the current bound.
        messageCharacters: z
          .union([z.literal(131_072), z.literal(32_768)])
          .default(131_072),
        queuePerAgent: z.number().int().min(1).max(10_000).default(64),
        rootTurns: z.number().int().min(1).max(1_000).default(48),
        hopCount: z.number().int().min(1).max(1_000).default(24),
        actorCallsPerRoot: z.number().int().min(1).max(1_000).default(16),
        // Cross-Agent room budget. This is a deterministic character bound,
        // not a claim about any provider's token window (Codex may expose a
        // much larger model-specific window). RoomContextEngine compacts at a
        // 75% soft target to leave native instructions/response headroom while
        // this value remains the hard ceiling.
        contextCharacters: z
          .number()
          .int()
          .min(1_024)
          .max(10_000_000)
          .default(DEFAULT_CONTEXT_CHARACTERS),
        sseEvents: z.number().int().min(8).max(100_000).default(512),
        // A single durable event frame must always fit this buffer, so the
        // default stays a wide multiple of the message wire bound.
        sseBytes: z.number().int().min(16_384).max(100_000_000).default(2_097_152)
      })
      .strict()
      .default({
        messageCharacters: 131_072,
        queuePerAgent: 64,
        rootTurns: 48,
        hopCount: 24,
        actorCallsPerRoot: 16,
        contextCharacters: DEFAULT_CONTEXT_CHARACTERS,
        sseEvents: 512,
        sseBytes: 2_097_152
      }),
    timeouts: z
      .object({
        handshakeMs: z.number().int().min(100).max(300_000).default(15_000),
        requestMs: z.number().int().min(100).max(300_000).default(10_000),
        firstEventMs: z.number().int().min(100).max(3_600_000).default(180_000),
        idleMs: z.number().int().min(100).max(3_600_000).default(300_000),
        cancelMs: z.number().int().min(100).max(300_000).default(10_000),
        closeMs: z.number().int().min(100).max(300_000).default(5_000),
        askMs: z.number().int().min(100).max(3_600_000).default(120_000)
      })
      .strict()
      .default({
        handshakeMs: 15_000,
        requestMs: 10_000,
        firstEventMs: 180_000,
        idleMs: 300_000,
        cancelMs: 10_000,
        closeMs: 5_000,
        askMs: 120_000
      })
  })
  .strict();

export type GroupXConfig = z.infer<typeof groupXConfigSchema>;

/** Parse a config document without resolving commands or filesystem-relative paths. */
export function parseConfigDocument(input: unknown): GroupXConfig {
  const parsed = groupXConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new GroupXError("INVALID_ENVELOPE", "Invalid GroupX config", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  return parsed.data;
}

/** Resolve a parsed document for one concrete config-directory/runtime context. */
export function resolveConfigDocument(
  config: GroupXConfig,
  baseDirectory: string,
  commandDependencies: CommandResolverDependencies = systemCommandResolverDependencies
): GroupXConfig {
  return resolveConfigPaths(config, baseDirectory, commandDependencies);
}

export function defaultConfig(
  cwd = process.cwd(),
  commandDependencies: CommandResolverDependencies = systemCommandResolverDependencies
): GroupXConfig {
  const parsed = groupXConfigSchema.parse({
    agents: {
      codex: { command: "codex", cwd },
      grok: { command: "grok", cwd },
      kimi: { command: "kimi", cwd }
    }
  });
  return resolveAgentCommands(parsed, path.resolve(cwd), commandDependencies);
}

export async function loadConfig(
  configPath?: string,
  cwd = process.cwd(),
  commandDependencies: CommandResolverDependencies = systemCommandResolverDependencies
): Promise<GroupXConfig> {
  if (configPath === undefined) {
    return resolveConfigPaths(defaultConfig(cwd, commandDependencies), cwd, commandDependencies);
  }
  const absolutePath = path.resolve(cwd, configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new GroupXError("INVALID_ENVELOPE", `Unable to read GroupX config: ${absolutePath}`, undefined, {
      cause: error
    });
  }
  const parsed = parseConfigDocument(raw);
  upgradeLegacyGeneratedDefaults(parsed);
  return resolveConfigDocument(parsed, path.dirname(absolutePath), commandDependencies);
}

/**
 * Upgrades values that exactly match an auto-generated default from an older
 * release to the current default. Any other explicit value stays user-owned;
 * this mirrors the original 48k context-budget migration precedent.
 */
export function upgradeLegacyGeneratedDefaults(config: GroupXConfig): void {
  if (config.limits.contextCharacters === LEGACY_CONTEXT_CHARACTERS) {
    config.limits.contextCharacters = DEFAULT_CONTEXT_CHARACTERS;
  }
  if (config.limits.messageCharacters === 32_768) {
    config.limits.messageCharacters = 131_072;
  }
  if (config.limits.rootTurns === 24) config.limits.rootTurns = 48;
  if (config.limits.hopCount === 12) config.limits.hopCount = 24;
  if (config.limits.actorCallsPerRoot === 8) config.limits.actorCallsPerRoot = 16;
  if (config.limits.sseBytes === 524_288) config.limits.sseBytes = 2_097_152;
  if (config.timeouts.firstEventMs === 90_000) config.timeouts.firstEventMs = 180_000;
  if (config.timeouts.idleMs === 120_000) config.timeouts.idleMs = 300_000;
}

function resolveConfigPaths(
  config: GroupXConfig,
  baseDirectory: string,
  commandDependencies: CommandResolverDependencies
): GroupXConfig {
  const resolvedBaseDirectory = path.resolve(baseDirectory);
  return {
    ...config,
    storage: { path: path.resolve(resolvedBaseDirectory, config.storage.path) },
    agents: mapAgentConfigs(config.agents, (agentId, agent) => ({
      ...agent,
      command: agent.enabled
        ? resolveAgentCommand(agentId, agent.driver, agent.command, resolvedBaseDirectory, commandDependencies)
        : agent.command,
      cwd: path.resolve(resolvedBaseDirectory, agent.cwd)
    }))
  };
}

function resolveAgentCommands(
  config: GroupXConfig,
  baseDirectory: string,
  commandDependencies: CommandResolverDependencies
): GroupXConfig {
  return {
    ...config,
    agents: mapAgentConfigs(config.agents, (agentId, agent) => ({
      ...agent,
      command: resolveAgentCommand(agentId, agent.driver, agent.command, baseDirectory, commandDependencies)
    }))
  };
}

function mapAgentConfigs(
  agents: GroupXConfig["agents"],
  map: (agentId: string, agent: GroupXConfig["agents"][string]) => GroupXConfig["agents"][string]
): GroupXConfig["agents"] {
  return Object.fromEntries(Object.entries(agents).map(([agentId, agent]) => [agentId, map(agentId, agent)]));
}

export function parseConfigPath(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") {
      const next = argv[index + 1];
      if (!next) {
        throw new GroupXError("INVALID_ENVELOPE", "--config requires a path");
      }
      return next;
    }
    if (value?.startsWith("--config=")) {
      const configPath = value.slice("--config=".length);
      if (configPath.length === 0) {
        throw new GroupXError("INVALID_ENVELOPE", "--config requires a path");
      }
      return configPath;
    }
  }
  return undefined;
}
