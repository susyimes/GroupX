import { GrokAcpAdapter, KimiAcpAdapter } from "../adapters/acp/index.js";
import { CodexAppServerAdapter } from "../adapters/codex/index.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { CliAdapter } from "../adapters/types.js";
import {
  assertActiveTransport,
  type GroupXConfig
} from "../config.js";
import type { AgentDriver } from "../launch/command-spec.js";

export function createStructuredAgentAdapter(
  agentId: string,
  driver: AgentDriver,
  timeouts: GroupXConfig["timeouts"]
): CliAdapter {
  const acpOptions = {
    handshakeTimeoutMs: timeouts.handshakeMs,
    closeGraceMs: timeouts.closeMs,
    killGraceMs: timeouts.closeMs,
    agentId
  };
  switch (driver) {
    case "codex":
      return new CodexAppServerAdapter({ timeouts, agentId });
    case "grok":
      return new GrokAcpAdapter(acpOptions);
    case "kimi":
      return new KimiAcpAdapter(acpOptions);
  }
}

/** Build one adapter per enabled configured agent in the single globally selected transport. */
export function createAdapterRegistry(
  config: Pick<GroupXConfig, "transport" | "agents" | "timeouts">
): AdapterRegistry {
  // Direct is intentionally not wired here. Its implementation remains only
  // for historical compatibility tests; do not restore a runtime entry.
  assertActiveTransport(config.transport);
  const registry = new AdapterRegistry();
  for (const [agentId, agent] of Object.entries(config.agents)) {
    if (!agent.enabled) continue;
    registry.register(createStructuredAgentAdapter(agentId, agent.driver, config.timeouts));
  }
  return registry;
}
