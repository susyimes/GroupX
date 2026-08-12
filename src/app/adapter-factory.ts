import { GrokAcpAdapter, KimiAcpAdapter } from "../adapters/acp/index.js";
import { CodexAppServerAdapter } from "../adapters/codex/index.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { CliAdapter } from "../adapters/types.js";
import { assertActiveTransport, type GroupXConfig } from "../config.js";

/** Build one adapter per enabled configured agent in the single globally selected transport. */
export function createAdapterRegistry(
  config: Pick<GroupXConfig, "transport" | "agents" | "timeouts">
): AdapterRegistry {
  // Direct is intentionally not wired here. Its implementation remains only
  // for historical compatibility tests; do not restore a runtime entry.
  assertActiveTransport(config.transport);
  const registry = new AdapterRegistry();
  const acpOptions = {
    handshakeTimeoutMs: config.timeouts.handshakeMs,
    closeGraceMs: config.timeouts.closeMs,
    killGraceMs: config.timeouts.closeMs
  };
  for (const [agentId, agent] of Object.entries(config.agents)) {
    if (!agent.enabled) continue;
    let adapter: CliAdapter;
    switch (agent.driver) {
      case "codex":
        adapter = new CodexAppServerAdapter({ timeouts: config.timeouts, agentId });
        break;
      case "grok":
        adapter = new GrokAcpAdapter({ ...acpOptions, agentId });
        break;
      case "kimi":
        adapter = new KimiAcpAdapter({ ...acpOptions, agentId });
        break;
    }
    registry.register(adapter);
  }
  return registry;
}
