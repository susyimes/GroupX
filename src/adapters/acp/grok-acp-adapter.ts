import { AcpV1Adapter, type AcpV1AdapterOptions } from "./acp-v1-adapter.js";

export interface GrokAcpAdapterOptions extends AcpV1AdapterOptions {
  /** Room-local agent key; defaults to the builtin `grok`. */
  agentId?: string;
}

/** ACP v1 adapter for the fixed `grok agent stdio` entrypoint. */
export class GrokAcpAdapter extends AcpV1Adapter {
  constructor(options: GrokAcpAdapterOptions = {}) {
    const { agentId = "grok", ...acpOptions } = options;
    super(
      agentId,
      `agent:${agentId}`,
      [
        "--no-auto-update",
        "--permission-mode",
        "bypassPermissions",
        "--sandbox",
        "off",
        "--no-plan",
        "agent",
        "stdio"
      ],
      acpOptions
    );
  }

  protected override isNativePolicyBlock(error: unknown): boolean {
    if (super.isNativePolicyBlock(error)) {
      return true;
    }
    const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return [
      "always-approve disabled by managed policy",
      "always-approve enable refused: disabled by managed policy",
      "always-approve enable blocked by managed policy",
      "defaultmode=bypasspermissions ignored: disabled by managed policy",
      "disable_bypass_permissions_mode = true"
    ].some((marker) => text.includes(marker));
  }
}
