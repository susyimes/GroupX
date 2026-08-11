import { GrokAcpAdapter, KimiAcpAdapter } from "../adapters/acp/index.js";
import { CodexAppServerAdapter } from "../adapters/codex/index.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { assertActiveTransport, type GroupXConfig } from "../config.js";

/** Build only the adapters enabled in the single globally selected transport. */
export function createAdapterRegistry(
  config: Pick<GroupXConfig, "transport" | "agents" | "timeouts">
): AdapterRegistry {
  // Direct is intentionally not wired here. Its implementation remains only
  // for historical compatibility tests; do not restore a runtime entry.
  assertActiveTransport(config.transport);
  const registry = new AdapterRegistry();
  if (config.agents.codex.enabled) {
    registry.register(new CodexAppServerAdapter({ timeouts: config.timeouts }));
  }
  const acpOptions = {
    handshakeTimeoutMs: config.timeouts.handshakeMs,
    closeGraceMs: config.timeouts.closeMs,
    killGraceMs: config.timeouts.closeMs
  };
  if (config.agents.grok.enabled) registry.register(new GrokAcpAdapter(acpOptions));
  if (config.agents.kimi.enabled) registry.register(new KimiAcpAdapter(acpOptions));
  return registry;
}
