import { GroupXError } from "../../core/errors.js";
import type { CapabilityReport } from "../types.js";
import type { JsonLineRpcClient } from "../jsonline-rpc.js";
import { AcpV1Adapter, type AcpV1AdapterOptions } from "./acp-v1-adapter.js";
import {
  isRecord,
  type AcpAgentCapabilities,
  type AcpImplementationInfo
} from "./protocol.js";

export interface HermesAcpAdapterOptions extends AcpV1AdapterOptions {
  /** Room-local agent key; defaults to the builtin `hermes`. */
  agentId?: string;
}

/** ACP v1 adapter for Hermes Agent's fixed `hermes --yolo acp` entrypoint. */
export class HermesAcpAdapter extends AcpV1Adapter {
  constructor(options: HermesAcpAdapterOptions = {}) {
    const { agentId = "hermes", ...acpOptions } = options;
    super(agentId, `agent:${agentId}`, ["--yolo", "acp"], acpOptions);
  }

  protected override effectiveCapabilities(
    capabilities: AcpAgentCapabilities,
    agentInfo: AcpImplementationInfo | undefined
  ): AcpAgentCapabilities {
    if (agentInfo?.name !== "hermes-agent") {
      throw new GroupXError(
        "PROTOCOL_INVALID_MESSAGE",
        "Hermes ACP initialize response must identify hermes-agent"
      );
    }

    // Hermes 0.20.1 accepts stdio/http/sse MCP descriptors on session/new/load,
    // but still omits mcpCapabilities from initialize. Keep this scoped
    // exception inside the Hermes driver; every other ACP driver remains
    // strictly capability-gated by the shared kernel.
    return {
      ...capabilities,
      mcpCapabilities: { ...capabilities.mcpCapabilities, http: true }
    };
  }

  protected override async configureSession(
    client: JsonLineRpcClient,
    nativeSessionId: string,
    timeoutMs: number
  ): Promise<void> {
    const result = await client.request(
      "session/set_mode",
      { sessionId: nativeSessionId, modeId: "dont_ask" },
      { timeoutMs }
    );
    if (!isRecord(result)) {
      throw new GroupXError(
        "PROTOCOL_INVALID_MESSAGE",
        "Hermes ACP session/set_mode result must be an object"
      );
    }
  }

  override async probe(): Promise<CapabilityReport> {
    const report = await super.probe();
    return {
      ...report,
      findings: report.findings.map((finding) =>
        finding.capability === "mcp.http" && finding.level === "unsupported"
          ? {
              ...finding,
              level: "documented" as const,
              detail:
                "Hermes accepts ACP-provided HTTP MCP descriptors but does not advertise mcpCapabilities.http"
            }
          : finding
      )
    };
  }
}
