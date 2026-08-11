import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GroupXError } from "./core/errors.js";
import {
  resolveAgentCommand,
  systemCommandResolverDependencies,
  type BuiltinAgentId,
  type CommandResolverDependencies,
  type CommandSpec
} from "./launch/command-spec.js";

export const TRANSPORT_MODES = ["direct", "structured"] as const;

export type TransportMode = (typeof TRANSPORT_MODES)[number];

/** Direct remains readable/runnable for compatibility, but is not an active product or release path. */
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

const agentConfigSchema = z
  .object({
    command: commandInputSchema,
    cwd: z.string().min(1),
    enabled: z.boolean().default(true)
  })
  .strict();

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
    agents: z
      .object({
        codex: agentConfigSchema.default({ command: { executable: "codex", prefixArgs: [] }, cwd: ".", enabled: true }),
        grok: agentConfigSchema.default({ command: { executable: "grok", prefixArgs: [] }, cwd: ".", enabled: true }),
        kimi: agentConfigSchema.default({ command: { executable: "kimi", prefixArgs: [] }, cwd: ".", enabled: true })
      })
      .strict()
      .default({
        codex: { command: { executable: "codex", prefixArgs: [] }, cwd: ".", enabled: true },
        grok: { command: { executable: "grok", prefixArgs: [] }, cwd: ".", enabled: true },
        kimi: { command: { executable: "kimi", prefixArgs: [] }, cwd: ".", enabled: true }
      }),
    limits: z
      .object({
        // REST/MCP request schemas use the same fixed wire bound. Keep this
        // field for an explicit runtime snapshot, but do not pretend a config
        // value can widen or narrow a parser that is intentionally static.
        messageCharacters: z.literal(32_768).default(32_768),
        queuePerAgent: z.number().int().min(1).max(10_000).default(64),
        rootTurns: z.number().int().min(1).max(1_000).default(24),
        hopCount: z.number().int().min(1).max(1_000).default(12),
        actorCallsPerRoot: z.number().int().min(1).max(1_000).default(8),
        contextCharacters: z.number().int().min(1_024).max(10_000_000).default(48_000),
        sseEvents: z.number().int().min(8).max(100_000).default(512),
        sseBytes: z.number().int().min(16_384).max(100_000_000).default(524_288)
      })
      .strict()
      .default({
        messageCharacters: 32_768,
        queuePerAgent: 64,
        rootTurns: 24,
        hopCount: 12,
        actorCallsPerRoot: 8,
        contextCharacters: 48_000,
        sseEvents: 512,
        sseBytes: 524_288
      }),
    timeouts: z
      .object({
        handshakeMs: z.number().int().min(100).max(300_000).default(15_000),
        requestMs: z.number().int().min(100).max(300_000).default(10_000),
        firstEventMs: z.number().int().min(100).max(3_600_000).default(90_000),
        idleMs: z.number().int().min(100).max(3_600_000).default(120_000),
        cancelMs: z.number().int().min(100).max(300_000).default(10_000),
        closeMs: z.number().int().min(100).max(300_000).default(5_000),
        askMs: z.number().int().min(100).max(3_600_000).default(120_000)
      })
      .strict()
      .default({
        handshakeMs: 15_000,
        requestMs: 10_000,
        firstEventMs: 90_000,
        idleMs: 120_000,
        cancelMs: 10_000,
        closeMs: 5_000,
        askMs: 120_000
      })
  })
  .strict();

export type GroupXConfig = z.infer<typeof groupXConfigSchema>;

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
  const parsed = groupXConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GroupXError("INVALID_ENVELOPE", "Invalid GroupX config", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  return resolveConfigPaths(parsed.data, path.dirname(absolutePath), commandDependencies);
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
    agents: {
      codex: resolveAgentConfig("codex", config.agents.codex, resolvedBaseDirectory, commandDependencies),
      grok: resolveAgentConfig("grok", config.agents.grok, resolvedBaseDirectory, commandDependencies),
      kimi: resolveAgentConfig("kimi", config.agents.kimi, resolvedBaseDirectory, commandDependencies)
    }
  };
}

function resolveAgentCommands(
  config: GroupXConfig,
  baseDirectory: string,
  commandDependencies: CommandResolverDependencies
): GroupXConfig {
  return {
    ...config,
    agents: {
      codex: {
        ...config.agents.codex,
        command: resolveAgentCommand("codex", config.agents.codex.command, baseDirectory, commandDependencies)
      },
      grok: {
        ...config.agents.grok,
        command: resolveAgentCommand("grok", config.agents.grok.command, baseDirectory, commandDependencies)
      },
      kimi: {
        ...config.agents.kimi,
        command: resolveAgentCommand("kimi", config.agents.kimi.command, baseDirectory, commandDependencies)
      }
    }
  };
}

function resolveAgentConfig(
  agentId: BuiltinAgentId,
  config: GroupXConfig["agents"][BuiltinAgentId],
  baseDirectory: string,
  commandDependencies: CommandResolverDependencies
): GroupXConfig["agents"][BuiltinAgentId] {
  return {
    ...config,
    command: resolveAgentCommand(agentId, config.command, baseDirectory, commandDependencies),
    cwd: path.resolve(baseDirectory, config.cwd)
  };
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
