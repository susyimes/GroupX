import { GroupXError } from "../../core/errors.js";
import type { JsonLineRpcClient } from "../jsonline-rpc.js";
import { AcpV1Adapter, type AcpV1AdapterOptions } from "./acp-v1-adapter.js";
import { isRecord } from "./protocol.js";

export interface KimiAcpAdapterOptions extends AcpV1AdapterOptions {
  /** Room-local agent key; defaults to the builtin `kimi`. */
  agentId?: string;
}

/** ACP v1 adapter for the fixed `kimi acp` entrypoint. */
export class KimiAcpAdapter extends AcpV1Adapter {
  constructor(options: KimiAcpAdapterOptions = {}) {
    const { agentId = "kimi", ...acpOptions } = options;
    super(agentId, `agent:${agentId}`, ["acp"], acpOptions);
  }

  protected override async configureSession(
    client: JsonLineRpcClient,
    nativeSessionId: string,
    timeoutMs: number
  ): Promise<void> {
    try {
      const result = await client.request(
        "session/set_mode",
        { sessionId: nativeSessionId, modeId: "auto" },
        { timeoutMs }
      );
      if (!isRecord(result)) {
        throw new GroupXError(
          "PROTOCOL_INVALID_MESSAGE",
          "Kimi ACP session/set_mode result must be an object"
        );
      }
    } catch (error) {
      if (this.isNativePolicyBlock(error)) {
        throw new GroupXError(
          "NATIVE_POLICY_BLOCKED",
          "Native policy blocked Kimi ACP auto mode",
          undefined,
          error instanceof Error ? { cause: error } : undefined
        );
      }
      throw error;
    }
  }
}
