import { AcpV1Adapter, type AcpV1AdapterOptions } from "./acp-v1-adapter.js";

/** ACP v1 adapter for the fixed `grok agent stdio` entrypoint. */
export class GrokAcpAdapter extends AcpV1Adapter {
  constructor(options: AcpV1AdapterOptions = {}) {
    super(
      "grok",
      "agent:grok",
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
      options
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
