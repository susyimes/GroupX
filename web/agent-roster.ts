export interface PendingConfiguredAgent {
  actorId: string;
  displayName: string;
  status: "pending_restart";
  cwd: string;
  enabled: true;
  capabilities: string[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuredAgents(snapshot: unknown): unknown[] {
  if (!isRecord(snapshot) || !isRecord(snapshot.config) || !Array.isArray(snapshot.config.agents)) {
    return [];
  }
  return snapshot.config.agents;
}

/**
 * Projects enabled agents saved after runtime startup without pretending their
 * native session is already available. The active bootstrap roster remains
 * authoritative for every actor it contains.
 */
export function pendingConfiguredAgents(
  snapshot: unknown,
  activeActorIds: ReadonlySet<string>
): PendingConfiguredAgent[] {
  const pending = new Map<string, PendingConfiguredAgent>();
  for (const value of configuredAgents(snapshot)) {
    if (!isRecord(value) || value.enabled !== true || typeof value.id !== "string") continue;
    const id = value.id.trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u.test(id)) continue;
    const actorId = `agent:${id}`;
    if (activeActorIds.has(actorId)) continue;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const cwd = typeof value.cwd === "string" ? value.cwd.trim() : "";
    pending.set(actorId, {
      actorId,
      displayName: name || id,
      status: "pending_restart",
      cwd,
      enabled: true,
      capabilities: []
    });
  }
  return [...pending.values()].sort((left, right) => left.actorId.localeCompare(right.actorId));
}
