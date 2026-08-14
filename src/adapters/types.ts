export type AdapterId = "codex" | "grok" | "kimi" | "hermes" | (string & {});

export type CapabilityLevel =
  | "documented"
  | "advertised"
  | "probed"
  | "verified"
  | "deprecated"
  | "degraded"
  | "unsupported"
  | "not_observed";

export interface CapabilityFinding {
  capability: string;
  level: CapabilityLevel;
  detail: string;
  evidence?: string;
}

export interface CapabilityReport {
  adapterId: AdapterId;
  executablePath?: string;
  version?: string;
  protocol?: string;
  protocolVersion?: string;
  launchArgvShape: string[];
  findings: CapabilityFinding[];
  generatedAt: string;
}

export type McpBindingLaunchSpec =
  | {
      transport: "streamable-http";
      url: string;
    }
  | {
      transport: "stdio";
      command: string;
      args: string[];
    };

export interface LaunchProfile {
  /** Native executable path/name. Never interpreted through a shell. */
  command: string;
  /**
   * Launcher runtime prefix inserted immediately after `command` (for example
   * a Node.js module entrypoint). This is not a native CLI `extraArgs` escape
   * hatch; each Adapter appends its own fixed product argv after this prefix.
   */
  prefixArgs?: readonly string[];
  cwd: string;
  brokerUrl?: string;
  /** Optional Broker-generated process instance id used before MCP initialization. */
  instanceId?: string;
  /** Provenance/correlation handle, not an authentication credential. */
  bindingId?: string;
  mcp?: McpBindingLaunchSpec;
}

export interface NativeSession {
  adapterId: AdapterId;
  instanceId: string;
  bindingId: string;
  actorId: string;
  nativeSessionId?: string;
  protocol: string;
  startedAt: string;
}

export interface PromptInput {
  turnId: string;
  content: string;
  contextPacket?: string;
  correlationId: string;
  signal?: AbortSignal;
}

export type NormalizedNativeEventType =
  | "session.started"
  | "turn.started"
  | "content.delta"
  | "reasoning.delta"
  | "tool.started"
  | "tool.completed"
  | "turn.completed"
  | "turn.cancelled"
  | "turn.failed"
  | "transport.error";

export interface NativeEvent<TPayload = unknown> {
  adapterId: AdapterId;
  instanceId: string;
  nativeSessionId?: string;
  nativeTurnId?: string;
  nativeEventId?: string;
  type: NormalizedNativeEventType;
  payload: TPayload;
  occurredAt: string;
}

export interface CancelResult {
  requested: boolean;
  supported: boolean;
  terminalObserved: boolean;
  detail?: string;
}

export type AdapterHealthStatus = "stopped" | "starting" | "ready" | "degraded" | "failed";

export interface AdapterHealth {
  adapterId: AdapterId;
  status: AdapterHealthStatus;
  instanceId?: string;
  nativeSessionAvailable: boolean;
  lastError?: string;
  updatedAt: string;
}

export interface CliAdapter {
  readonly adapterId: AdapterId;
  readonly actorId: string;
  probe(): Promise<CapabilityReport>;
  start(input: LaunchProfile): Promise<NativeSession>;
  resume(input: LaunchProfile & { nativeSessionId: string }): Promise<NativeSession>;
  prompt(session: NativeSession, input: PromptInput): AsyncIterable<NativeEvent>;
  cancel(session: NativeSession, nativeTurnId: string): Promise<CancelResult>;
  close(session: NativeSession): Promise<void>;
  health(): AdapterHealth;
}
