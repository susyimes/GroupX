import { GroupXError } from "../../core/errors.js";
import { boundDiagnosticText } from "../../observability/diagnostics.js";
import {
  preflightKimiUnrestrictedConfig,
  type KimiUnrestrictedConfigPreflight,
  type KimiUnrestrictedConfigSnapshot
} from "../kimi-config-preflight.js";
import type {
  CapabilityFinding,
  LaunchProfile,
  NativeSession,
  PromptInput
} from "../types.js";
import {
  DirectCliAdapter,
  type DirectCliAdapterOptions,
  type DirectTurnLaunch
} from "./direct-cli-adapter.js";
import {
  isRecord,
  stringField,
  type DirectProjection
} from "./protocol.js";

export interface KimiDirectAdapterOptions extends DirectCliAdapterOptions {
  configPreflight?: KimiUnrestrictedConfigPreflight;
}

/** @deprecated Direct has no runtime entry or active Gate; use KimiAcpAdapter. */
export class KimiDirectAdapter extends DirectCliAdapter {
  readonly #configPreflight: KimiUnrestrictedConfigPreflight;
  #configSnapshot: KimiUnrestrictedConfigSnapshot | undefined;

  constructor(options: KimiDirectAdapterOptions = {}) {
    const { configPreflight = preflightKimiUnrestrictedConfig, ...directOptions } = options;
    super("kimi", "agent:kimi", { version: "0.34.0", ...directOptions });
    this.#configPreflight = configPreflight;
  }

  override async start(input: LaunchProfile): Promise<NativeSession> {
    await this.#preflight(input);
    return await super.start(input);
  }

  override async resume(
    input: LaunchProfile & { nativeSessionId: string }
  ): Promise<NativeSession> {
    await this.#preflight(input);
    return await super.resume(input);
  }

  protected override launchArgvShape(resume: boolean): string[] {
    return [
      "<command>",
      "<prefixArgs...>",
      ...(resume ? ["--session", "<nativeSessionId>"] : []),
      "--prompt",
      "<prompt>",
      "--output-format",
      "stream-json"
    ];
  }

  protected override capabilityFindings(): CapabilityFinding[] {
    const preflightLevel = this.#configSnapshot === undefined ? "documented" : "probed";
    return [
      finding("access.permission_auto", "documented", "--prompt uses native auto permission handling; conflicting --auto/--yolo are not added"),
      finding(
        "access.config_preflight",
        preflightLevel,
        "Reads only default_permission_mode and default_plan_mode before opening the Direct session"
      ),
      finding(
        "access.plan_disabled",
        preflightLevel,
        "Direct requires effective default_plan_mode=false before any one-shot process can spawn"
      ),
      finding(
        "transport.direct",
        "deprecated",
        "Retained for compatibility only; Structured Kimi ACP is the active release transport"
      ),
      finding("output.jsonl", "documented", "--output-format stream-json emits JSONL"),
      finding("session.resume", "advertised", "--session resumes an explicit session in the same work directory"),
      finding("mcp.current_turn", "unsupported", "Direct one-shot mode does not attach GroupX MCP"),
      finding("live compatibility", "not_observed", "A live Direct model Turn is graded separately from config preflight")
    ];
  }

  protected override buildTurnLaunch(input: {
    profile: Pick<LaunchProfile, "command" | "prefixArgs" | "cwd" | "instanceId" | "bindingId">;
    promptText: string;
    nativeSessionId?: string;
  }): DirectTurnLaunch {
    return buildKimiDirectLaunch(input.profile, input.promptText, input.nativeSessionId);
  }

  protected override projectMessage(value: unknown): DirectProjection[] {
    return projectKimiDirectMessage(value);
  }

  protected override async preflightTurn(
    _session: NativeSession,
    _input: PromptInput
  ): Promise<void> {
    this.#configSnapshot = await this.#configPreflight();
  }

  async #preflight(input: LaunchProfile): Promise<void> {
    try {
      this.#configSnapshot = await this.#configPreflight();
    } catch (error) {
      const message =
        error instanceof GroupXError && error.code === "ADAPTER_START_FAILED"
          ? error.message
          : "Kimi unrestricted config preflight failed";
      this.rejectAdapterStart(input, message);
    }
  }
}

export function buildKimiDirectLaunch(
  profile: Pick<LaunchProfile, "command" | "prefixArgs">,
  promptText: string,
  nativeSessionId?: string
): DirectTurnLaunch {
  return {
    argv: [
      profile.command,
      ...(profile.prefixArgs ?? []),
      ...(nativeSessionId === undefined ? [] : ["--session", nativeSessionId]),
      "--prompt",
      promptText,
      "--output-format",
      "stream-json"
    ]
  };
}

export function projectKimiDirectMessage(value: unknown): DirectProjection[] {
  if (!isRecord(value)) return [];
  const role = stringField(value, "role");
  const type = stringField(value, "type");
  if (role === "assistant") {
    const projections: DirectProjection[] = [];
    const text = stringField(value, "content");
    if (text !== undefined) {
      projections.push({ kind: "event", type: "content.delta", payload: { text } });
    }
    if (Array.isArray(value.tool_calls)) {
      for (const toolCall of value.tool_calls) {
        if (!isRecord(toolCall)) continue;
        const nativeEventId = stringField(toolCall, "id");
        projections.push({
          kind: "event",
          type: "tool.started",
          payload: kimiToolProjection(toolCall),
          ...(nativeEventId === undefined ? {} : { nativeEventId })
        });
      }
    }
    return projections;
  }
  if (role === "tool") {
    const nativeEventId = stringField(value, "tool_call_id", "id");
    return [{
      kind: "event",
      type: "tool.completed",
      payload: {
        ...(nativeEventId === undefined ? {} : { toolCallId: nativeEventId }),
        ...(stringField(value, "status") === undefined ? {} : { status: stringField(value, "status") })
      },
      ...(nativeEventId === undefined ? {} : { nativeEventId })
    }];
  }
  if (role === "meta" && type === "session.resume_hint") {
    const nativeSessionId = stringField(value, "session_id", "sessionId");
    if (nativeSessionId === undefined) {
      return [{ kind: "terminal", status: "failed", payload: { message: "Kimi resume hint omitted session_id" } }];
    }
    return [
      { kind: "session", nativeSessionId },
      { kind: "terminal", status: "completed", payload: { sessionId: nativeSessionId } }
    ];
  }
  if (
    role === "meta" &&
    type !== undefined &&
    /(?:approval|permission|question|elicitation|user_input)/i.test(type) &&
    /(?:request|pending|prompt)/i.test(type)
  ) {
    return [{ kind: "native_interaction", detail: `Unexpected Kimi Direct interaction: ${type}` }];
  }
  if (
    role === "meta" &&
    type !== undefined &&
    /plan/i.test(type) &&
    /(?:request|pending|confirm|question)/i.test(`${type} ${stringField(value, "status") ?? ""}`)
  ) {
    return [{ kind: "native_interaction", detail: `Kimi Direct entered an interactive plan state: ${type}` }];
  }
  if (role === "error" || type === "error" || type === "turn.error") {
    const message = stringField(value, "message", "content", "error", "detail") ?? "Kimi Direct error";
    return [{
      kind: "terminal",
      status: "failed",
      payload: { message: boundDiagnosticText(message, 512) }
    }];
  }
  return [];
}

function kimiToolProjection(value: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of ["id", "type"] as const) {
    if (Object.hasOwn(value, key)) projected[key] = structuredClone(value[key]);
  }
  if (isRecord(value.function)) {
    const name = stringField(value.function, "name");
    if (name !== undefined) projected.name = name;
  }
  return projected;
}

function finding(
  capability: string,
  level: CapabilityFinding["level"],
  detail: string
): CapabilityFinding {
  return { capability, level, detail };
}
