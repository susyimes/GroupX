import { GroupXError } from "../core/errors.js";
import type {
  IdentityRecord,
  MemoryRecord,
  StoredEventRecord,
  SummaryRecord
} from "../storage/types.js";
import { classifyIdentityPerspective } from "./service.js";
import type {
  BuildContextPacketInput,
  ContextEntry,
  ContextPacket,
  ContextPacketOmissions,
  ContextPacketSections,
  ContextPacketStore,
  ContextSourceLabel,
  CurrentContextMessage,
  IdentityContextEntry
} from "./types.js";

const CONTEXT_SCHEMA = "groupx.context/0.4" as const;
const QUERY_LIMIT = 500;
const MAX_REPLY_DEPTH = 64;

type OptionalSectionName = Exclude<keyof ContextPacketOmissions, "generatedSummary">;

function requireNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new GroupXError("INVALID_ENVELOPE", `${field} must not be blank`);
  }
}

function requireBudgetInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GroupXError("INVALID_ENVELOPE", `${field} must be a non-negative safe integer`);
  }
}

function contentFromMessageEvent(event: StoredEventRecord): string {
  if (event.eventType !== "message.created") {
    throw new GroupXError(
      "INVALID_ENVELOPE",
      `Context message ${event.eventId} is not a message.created event`
    );
  }
  if (
    event.body === null ||
    typeof event.body !== "object" ||
    typeof (event.body as Record<string, unknown>).content !== "string"
  ) {
    throw new GroupXError(
      "STORE_UNAVAILABLE",
      `Context message ${event.eventId} has no string content`
    );
  }
  return (event.body as { content: string }).content;
}

function sourceLabel(input: {
  kind: string;
  eventId?: string;
  recordId?: string;
}): ContextSourceLabel {
  return {
    kind: input.kind,
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    ...(input.recordId === undefined ? {} : { recordId: input.recordId })
  };
}

function eventSubject(event: StoredEventRecord): string {
  return event.targets.length === 0 ? event.roomId : event.targets.join(",");
}

function eventEntry(event: StoredEventRecord): ContextEntry {
  return {
    entryType: "message",
    id: event.eventId,
    authorActorId: event.actorId,
    authorDisplayName: event.actorDisplayName,
    subject: eventSubject(event),
    source: sourceLabel({
      kind: event.provenance?.sourceKind ?? "event",
      eventId: event.eventId
    }),
    content: contentFromMessageEvent(event),
    seq: event.seq,
    occurredAt: event.occurredAt
  };
}

function directMessageEntry(
  roomId: string,
  targetActorId: string,
  message: CurrentContextMessage
): ContextEntry {
  requireNonBlank(message.authorActorId, "currentMessage.authorActorId");
  return {
    entryType: "message",
    id: message.sourceEventId ?? "current_message",
    authorActorId: message.authorActorId,
    ...(message.authorDisplayName === undefined
      ? {}
      : { authorDisplayName: message.authorDisplayName }),
    subject: targetActorId || roomId,
    source: sourceLabel({
      kind: message.sourceKind ?? "direct",
      ...(message.sourceEventId === undefined ? {} : { eventId: message.sourceEventId })
    }),
    content: message.content,
    ...(message.occurredAt === undefined ? {} : { occurredAt: message.occurredAt })
  };
}

function memoryEntry(memory: MemoryRecord): ContextEntry {
  return {
    entryType: "memory",
    id: memory.memoryId,
    authorActorId: memory.authorActorId,
    subject: memory.subjectActorId ?? memory.scopeId,
    source: sourceLabel({
      kind: memory.sourceKind,
      ...(memory.sourceEventId === undefined ? {} : { eventId: memory.sourceEventId }),
      recordId: memory.memoryId
    }),
    content: memory.content,
    occurredAt: memory.createdAt
  };
}

function identityEntry(identity: IdentityRecord): IdentityContextEntry {
  return {
    entryType: "identity",
    id: identity.identityId,
    authorActorId: identity.authorActorId,
    subject: identity.subjectActorId,
    source: sourceLabel({
      kind: identity.sourceKind,
      ...(identity.sourceEventId === undefined ? {} : { eventId: identity.sourceEventId }),
      recordId: identity.identityId
    }),
    content: identity.content,
    occurredAt: identity.createdAt,
    perspective: classifyIdentityPerspective(identity)
  };
}

function configuredIdentityEntry(targetActorId: string, content: string): IdentityContextEntry {
  return {
    entryType: "identity",
    id: `config:${targetActorId}`,
    authorActorId: "system:groupx",
    subject: targetActorId,
    source: sourceLabel({ kind: "agent_config" }),
    content,
    perspective: "configured"
  };
}

function summaryEntry(summary: SummaryRecord): ContextEntry {
  return {
    entryType: "summary",
    id: summary.summaryId,
    authorActorId: summary.generatorActorId,
    subject: summary.roomId,
    source: sourceLabel({ kind: "generated_summary", recordId: summary.summaryId }),
    content: summary.content,
    seq: summary.throughSeq,
    occurredAt: summary.createdAt
  };
}

function sourceText(source: ContextSourceLabel): string {
  return [
    source.kind,
    ...(source.eventId === undefined ? [] : [`event=${source.eventId}`]),
    ...(source.recordId === undefined ? [] : [`record=${source.recordId}`])
  ].join(";");
}

function renderEntry(entry: ContextEntry): string {
  const displayName =
    entry.authorDisplayName === undefined ? "" : ` author_name=${entry.authorDisplayName}`;
  const sequence = entry.seq === undefined ? "" : ` seq=${entry.seq}`;
  return `- id=${entry.id}${sequence} author=${entry.authorActorId}${displayName} subject=${entry.subject} source=${sourceText(entry.source)}\n${entry.content}`;
}

function pushSection(parts: string[], heading: string, entries: readonly ContextEntry[]): void {
  if (entries.length === 0) return;
  parts.push(`[${heading}]\n${entries.map(renderEntry).join("\n\n")}`);
}

export function renderContextPacket(input: {
  roomId: string;
  targetActorId: string;
  afterSeq: number;
  throughSeq: number;
  sections: ContextPacketSections;
}): string {
  const parts = [
    `[groupx_protocol]\nschema=${CONTEXT_SCHEMA}\nroom=${input.roomId}\ntarget=${input.targetActorId}\nafter_seq=${input.afterSeq}\nthrough_seq=${input.throughSeq}`
  ];
  pushSection(parts, "configured_agent_identity", input.sections.configuredIdentity);
  pushSection(parts, "self_identity", input.sections.selfIdentity);
  pushSection(parts, "user_authored_identity", input.sections.userAuthoredIdentity);
  pushSection(parts, "observed_identity", input.sections.observedIdentity);
  pushSection(parts, "agent_core_memory", input.sections.agentCoreMemory);
  pushSection(parts, "agent_dated_memory", input.sections.agentDatedMemory);
  pushSection(parts, "public_memory", input.sections.publicMemory);
  pushSection(parts, "room_checkpoint_summary", input.sections.generatedSummary);
  pushSection(parts, "room_delta_since_cursor", input.sections.unreadTranscript);
  pushSection(parts, "reply_chain", input.sections.replyChain);
  pushSection(parts, "current_message", [input.sections.currentMessage]);
  return parts.join("\n\n");
}

function sortRecent<T extends { occurredAt?: string; id: string }>(items: T[]): T[] {
  return items.sort((left, right) => {
    const time = (right.occurredAt ?? "").localeCompare(left.occurredAt ?? "");
    return time === 0 ? right.id.localeCompare(left.id) : time;
  });
}

function sortTranscript(items: ContextEntry[]): ContextEntry[] {
  return items.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
}

export class ContextPacketBuilder {
  readonly #store: ContextPacketStore;

  constructor(store: ContextPacketStore) {
    this.#store = store;
  }

  buildContextPacket(input: BuildContextPacketInput): ContextPacket {
    requireNonBlank(input.roomId, "roomId");
    requireNonBlank(input.targetActorId, "targetActorId");
    requireBudgetInteger(input.throughSeq, "throughSeq");
    requireBudgetInteger(input.maxChars, "maxChars");

    const currentMessage =
      input.currentEvent === undefined
        ? directMessageEntry(input.roomId, input.targetActorId, input.currentMessage)
        : this.#currentEventEntry(input);
    requireNonBlank(currentMessage.content, "current message content");

    const replyToEventId =
      input.currentEvent?.replyToEventId ?? input.currentMessage?.replyToEventId;
    const replyChain = this.#readReplyChain(
      input.roomId,
      replyToEventId,
      input.throughSeq
    );
    const afterSeq = Math.min(
      this.#store.getDeliveryCursor(input.targetActorId, input.roomId)?.lastDeliveredSeq ?? 0,
      input.throughSeq
    );
    const activeSummary = this.#store.getActiveSummary(input.roomId, input.throughSeq);
    const generatedSummary =
      activeSummary !== undefined && activeSummary.throughSeq > afterSeq
        ? [summaryEntry(activeSummary)]
        : [];
    const transcriptAfterSeq = Math.max(
      afterSeq,
      generatedSummary[0]?.seq ?? afterSeq
    );

    const excludedEventIds = new Set<string>([
      currentMessage.id,
      ...replyChain.map((entry) => entry.id)
    ]);
    const unreadTranscript = this.#readUnreadTranscript(
      input.roomId,
      transcriptAfterSeq,
      input.throughSeq,
      excludedEventIds
    );
    const publicMemory = sortRecent(
      this.#store
        .searchMemory({
          scopeType: "room",
          scopeId: input.roomId,
          includeHistory: false,
          limit: QUERY_LIMIT
        })
        .filter((memory) => memory.status === "active")
        .map(memoryEntry)
    );
    const agentMemoryRecords = this.#store
      .searchMemory({
        scopeType: "agent",
        scopeId: input.targetActorId,
        includeHistory: false,
        limit: QUERY_LIMIT
      })
      .filter((memory) => memory.status === "active");
    const agentCoreMemory = sortRecent(
      agentMemoryRecords
        .filter((memory) => memory.agentMemoryType === "core")
        .map(memoryEntry)
    );
    const representedMessageIds = new Set([
      currentMessage.id,
      ...replyChain.map((entry) => entry.id),
      ...unreadTranscript.map((entry) => entry.id)
    ]);
    const agentDatedMemory = sortRecent(
      agentMemoryRecords
        .filter(
          (memory) =>
            memory.agentMemoryType === "dated" &&
            (memory.sourceEventId === undefined || !representedMessageIds.has(memory.sourceEventId))
        )
        .map(memoryEntry)
    );
    const identities = sortRecent(
      this.#store
        .readIdentity({
          subjectActorId: input.targetActorId,
          includeHistory: false,
          limit: QUERY_LIMIT
        })
        .filter((identity) => identity.status === "active")
        .map(identityEntry)
    );
    const identityGroups = {
      selfIdentity: identities.filter((identity) => identity.perspective === "self"),
      userAuthoredIdentity: identities.filter(
        (identity) => identity.perspective === "user-authored"
      ),
      observedIdentity: identities.filter((identity) => identity.perspective === "observed")
    };

    const sections: ContextPacketSections = {
      configuredIdentity:
        input.configuredIdentity?.trim().length
          ? [configuredIdentityEntry(input.targetActorId, input.configuredIdentity.trim())]
          : [],
      selfIdentity: [],
      userAuthoredIdentity: [],
      observedIdentity: [],
      agentCoreMemory: [],
      agentDatedMemory: [],
      publicMemory: [],
      generatedSummary,
      unreadTranscript: [],
      replyChain,
      currentMessage
    };
    const render = (): string =>
      renderContextPacket({
        roomId: input.roomId,
        targetActorId: input.targetActorId,
        afterSeq,
        throughSeq: input.throughSeq,
        sections
      });

    let text = render();
    if (text.length > input.maxChars) {
      throw new GroupXError(
        "CONTEXT_BUDGET_EXCEEDED",
        "Context budget cannot preserve the current message, reply chain, and checkpoint summary",
        { requiredChars: text.length, maxChars: input.maxChars }
      );
    }

    const candidates: Array<{
      section: OptionalSectionName;
      entry: ContextEntry | IdentityContextEntry;
    }> = [
      ...agentCoreMemory.map((entry) => ({ section: "agentCoreMemory" as const, entry })),
      ...[...unreadTranscript]
        .sort((left, right) => (right.seq ?? 0) - (left.seq ?? 0))
        .map((entry) => ({ section: "unreadTranscript" as const, entry })),
      ...agentDatedMemory.map((entry) => ({ section: "agentDatedMemory" as const, entry })),
      ...publicMemory.map((entry) => ({ section: "publicMemory" as const, entry })),
      ...identityGroups.selfIdentity.map((entry) => ({
        section: "selfIdentity" as const,
        entry
      })),
      ...identityGroups.userAuthoredIdentity.map((entry) => ({
        section: "userAuthoredIdentity" as const,
        entry
      })),
      ...identityGroups.observedIdentity.map((entry) => ({
        section: "observedIdentity" as const,
        entry
      }))
    ];

    for (const candidate of candidates) {
      const collection = sections[candidate.section] as ContextEntry[];
      collection.push(candidate.entry);
      const nextText = render();
      if (nextText.length > input.maxChars) {
        collection.pop();
        continue;
      }
      text = nextText;
    }

    sortTranscript(sections.unreadTranscript);
    text = render();
    const omitted: ContextPacketOmissions = {
      selfIdentity: identityGroups.selfIdentity.length - sections.selfIdentity.length,
      userAuthoredIdentity:
        identityGroups.userAuthoredIdentity.length - sections.userAuthoredIdentity.length,
      observedIdentity: identityGroups.observedIdentity.length - sections.observedIdentity.length,
      agentCoreMemory: agentCoreMemory.length - sections.agentCoreMemory.length,
      agentDatedMemory: agentDatedMemory.length - sections.agentDatedMemory.length,
      publicMemory: publicMemory.length - sections.publicMemory.length,
      generatedSummary: 0,
      unreadTranscript: unreadTranscript.length - sections.unreadTranscript.length
    };

    return {
      schema: CONTEXT_SCHEMA,
      roomId: input.roomId,
      targetActorId: input.targetActorId,
      afterSeq,
      throughSeq: input.throughSeq,
      maxChars: input.maxChars,
      charCount: text.length,
      sections,
      omitted,
      text
    };
  }

  #currentEventEntry(input: BuildContextPacketInput): ContextEntry {
    const event = input.currentEvent;
    if (event === undefined) {
      throw new GroupXError("INVALID_ENVELOPE", "currentEvent is required");
    }
    if (event.roomId !== input.roomId) {
      throw new GroupXError("INVALID_ENVELOPE", "Current event belongs to another room");
    }
    if (event.seq > input.throughSeq) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "Current event is newer than the requested context boundary"
      );
    }
    return eventEntry(event);
  }

  #readReplyChain(
    roomId: string,
    replyToEventId: string | undefined,
    throughSeq: number
  ): ContextEntry[] {
    const chain: ContextEntry[] = [];
    const seen = new Set<string>();
    let eventId = replyToEventId;
    while (eventId !== undefined) {
      if (seen.has(eventId)) {
        throw new GroupXError("CAUSAL_CYCLE", "Reply chain contains a cycle");
      }
      if (chain.length >= MAX_REPLY_DEPTH) {
        throw new GroupXError("INVALID_ENVELOPE", "Reply chain exceeds the supported depth");
      }
      seen.add(eventId);
      const event = this.#store.getEvent(eventId);
      if (event === undefined) {
        throw new GroupXError("STORE_UNAVAILABLE", `Reply event ${eventId} is missing`);
      }
      if (event.roomId !== roomId) {
        throw new GroupXError("INVALID_ENVELOPE", "Reply chain crosses room boundaries");
      }
      if (event.seq > throughSeq) {
        throw new GroupXError(
          "INVALID_ENVELOPE",
          "Reply chain contains an event newer than the context boundary"
        );
      }
      chain.push(eventEntry(event));
      eventId = event.replyToEventId;
    }
    return chain.reverse();
  }

  #readUnreadTranscript(
    roomId: string,
    afterSeq: number,
    throughSeq: number,
    excludedEventIds: ReadonlySet<string>
  ): ContextEntry[] {
    const events: ContextEntry[] = [];
    let cursor = afterSeq;
    while (cursor < throughSeq) {
      const page = this.#store.listEventsThrough({
        roomId,
        afterSeq: cursor,
        throughSeq,
        limit: QUERY_LIMIT
      });
      if (page.events.length === 0) break;
      for (const event of page.events) {
        if (event.eventType === "message.created" && !excludedEventIds.has(event.eventId)) {
          events.push(eventEntry(event));
        }
      }
      if (page.nextAfterSeq <= cursor) {
        throw new GroupXError("STORE_UNAVAILABLE", "Event cursor did not advance");
      }
      cursor = page.nextAfterSeq;
      if (!page.hasMore || cursor >= throughSeq) break;
    }
    return sortTranscript(events);
  }
}
