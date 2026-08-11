/**
 * @deprecated Direct transport has no public runtime entry or active M0 Gate.
 * These exports remain only for historical compatibility tests and data migration.
 */
export {
  DirectCliAdapter,
  buildDirectPromptText,
  estimateWindowsCommandLineCharacters,
  type DirectCliAdapterOptions,
  type DirectTurnLaunch
} from "./direct-cli-adapter.js";
export {
  DirectJsonlProcess,
  DirectJsonlProtocolError,
  DirectJsonlTerminationError,
  type DirectJsonlProcessExit,
  type DirectJsonlProcessOptions,
  type DirectJsonlProtocolErrorKind
} from "./process.js";
export {
  classifyNativePolicyDiagnostic,
  classifyStructuredInteraction,
  diagnosticFields,
  type DirectProjection,
  type DirectTerminalStatus
} from "./protocol.js";
export {
  CodexDirectAdapter,
  buildCodexDirectLaunch,
  projectCodexDirectMessage,
  type CodexDirectAdapterOptions
} from "./codex-direct-adapter.js";
export {
  GrokDirectAdapter,
  buildGrokDirectLaunch,
  projectGrokDirectMessage,
  type GrokDirectAdapterOptions
} from "./grok-direct-adapter.js";
export {
  KimiDirectAdapter,
  buildKimiDirectLaunch,
  projectKimiDirectMessage,
  type KimiDirectAdapterOptions
} from "./kimi-direct-adapter.js";
