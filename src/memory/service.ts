import { GroupXError } from "../core/errors.js";
import type {
  CreateIdentityInput,
  CreateMemoryInput,
  IdentityQuery,
  IdentityRecord,
  MemoryQuery,
  MemoryRecord
} from "../storage/types.js";
import type {
  IdentityPerspective,
  MemoryApplicationStore,
  MemoryClock
} from "./types.js";

export type ExplicitMemoryInput = Omit<CreateMemoryInput, "createdAt">;
export type ExplicitIdentityInput = Omit<CreateIdentityInput, "createdAt">;

export interface SelfIdentityInput {
  callingActorId: string;
  kind: string;
  content: string;
  sourceEventId?: string;
  identityId?: string;
}

export interface UserAuthoredIdentityInput {
  authorActorId: string;
  subjectActorId: string;
  kind: string;
  content: string;
  sourceEventId?: string;
  identityId?: string;
}

export interface ObservedIdentityInput {
  authorActorId: string;
  subjectActorId: string;
  content: string;
  sourceEventId?: string;
  identityId?: string;
}

export const systemMemoryClock: MemoryClock = {
  now: () => new Date().toISOString()
};

function assertNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new GroupXError("INVALID_ENVELOPE", `${field} must not be blank`);
  }
}

function assertAgentActor(actorId: string, field: string): void {
  if (!actorId.startsWith("agent:") || actorId.length === "agent:".length) {
    throw new GroupXError("UNKNOWN_ACTOR", `${field} must be an agent actor id`);
  }
}

function assertUserActor(actorId: string, field: string): void {
  if (!actorId.startsWith("user:") || actorId.length === "user:".length) {
    throw new GroupXError("UNKNOWN_ACTOR", `${field} must be a user actor id`);
  }
}

/**
 * This is a provenance classification, not a truth or trust score.
 * An observation never becomes self identity merely because it concerns the target.
 */
export function classifyIdentityPerspective(
  identity: Pick<IdentityRecord, "authorActorId" | "subjectActorId">
): IdentityPerspective {
  if (identity.authorActorId === identity.subjectActorId) {
    return "self";
  }
  if (identity.authorActorId.startsWith("user:")) {
    return "user-authored";
  }
  return "observed";
}

function assertIdentitySemantics(identity: ExplicitIdentityInput): void {
  assertAgentActor(identity.subjectActorId, "subjectActorId");
  assertNonBlank(identity.authorActorId, "authorActorId");
  assertNonBlank(identity.kind, "kind");
  assertNonBlank(identity.content, "content");
  assertNonBlank(identity.sourceKind, "sourceKind");

  const perspective = classifyIdentityPerspective(identity);
  if (perspective === "self") {
    assertAgentActor(identity.authorActorId, "authorActorId");
    return;
  }
  if (perspective === "user-authored") {
    assertUserActor(identity.authorActorId, "authorActorId");
    return;
  }

  assertAgentActor(identity.authorActorId, "authorActorId");
  if (identity.kind !== "note") {
    throw new GroupXError(
      "INVALID_ENVELOPE",
      "An agent observation about another agent must use kind=note"
    );
  }
  if (identity.sourceKind !== "adapter") {
    throw new GroupXError(
      "INVALID_ENVELOPE",
      "An agent observation about another agent must use sourceKind=adapter"
    );
  }
}

function selfIdentityRecord(input: SelfIdentityInput): ExplicitIdentityInput {
  assertAgentActor(input.callingActorId, "callingActorId");
  return {
    ...(input.identityId === undefined ? {} : { identityId: input.identityId }),
    subjectActorId: input.callingActorId,
    authorActorId: input.callingActorId,
    kind: input.kind,
    content: input.content,
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
    sourceKind: "mcp"
  };
}

function userIdentityRecord(input: UserAuthoredIdentityInput): ExplicitIdentityInput {
  assertUserActor(input.authorActorId, "authorActorId");
  assertAgentActor(input.subjectActorId, "subjectActorId");
  return {
    ...(input.identityId === undefined ? {} : { identityId: input.identityId }),
    subjectActorId: input.subjectActorId,
    authorActorId: input.authorActorId,
    kind: input.kind,
    content: input.content,
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
    sourceKind: "web"
  };
}

function observedIdentityRecord(input: ObservedIdentityInput): ExplicitIdentityInput {
  assertAgentActor(input.authorActorId, "authorActorId");
  assertAgentActor(input.subjectActorId, "subjectActorId");
  if (input.authorActorId === input.subjectActorId) {
    throw new GroupXError(
      "INVALID_ENVELOPE",
      "An observed identity requires different author and subject actors"
    );
  }
  return {
    ...(input.identityId === undefined ? {} : { identityId: input.identityId }),
    subjectActorId: input.subjectActorId,
    authorActorId: input.authorActorId,
    kind: "note",
    content: input.content,
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
    sourceKind: "adapter"
  };
}

/**
 * Explicit application service only. It has no chat-ingestion or automatic
 * memory-extraction entry point; ordinary submitted text is stored unchanged.
 */
export class GroupXMemoryService {
  readonly #store: MemoryApplicationStore;
  readonly #clock: MemoryClock;

  constructor(store: MemoryApplicationStore, clock: MemoryClock = systemMemoryClock) {
    this.#store = store;
    this.#clock = clock;
  }

  remember(input: ExplicitMemoryInput): MemoryRecord {
    assertNonBlank(input.content, "content");
    assertNonBlank(input.sourceKind, "sourceKind");
    return this.#store.rememberMemory({ ...input, createdAt: this.#clock.now() });
  }

  search(input: MemoryQuery = {}): MemoryRecord[] {
    return this.#store.searchMemory(input);
  }

  supersede(memoryId: string, replacement: ExplicitMemoryInput): MemoryRecord {
    assertNonBlank(memoryId, "memoryId");
    assertNonBlank(replacement.content, "content");
    assertNonBlank(replacement.sourceKind, "sourceKind");
    return this.#store.supersedeMemory(memoryId, {
      ...replacement,
      createdAt: this.#clock.now()
    });
  }

  retract(memoryId: string): MemoryRecord {
    assertNonBlank(memoryId, "memoryId");
    return this.#store.retractMemory(memoryId, this.#clock.now());
  }

  rememberIdentity(input: ExplicitIdentityInput): IdentityRecord {
    assertIdentitySemantics(input);
    return this.#store.rememberIdentity({ ...input, createdAt: this.#clock.now() });
  }

  rememberSelfIdentity(input: SelfIdentityInput): IdentityRecord {
    return this.rememberIdentity(selfIdentityRecord(input));
  }

  rememberUserAuthoredIdentity(input: UserAuthoredIdentityInput): IdentityRecord {
    return this.rememberIdentity(userIdentityRecord(input));
  }

  rememberObservedIdentity(input: ObservedIdentityInput): IdentityRecord {
    return this.rememberIdentity(observedIdentityRecord(input));
  }

  searchIdentity(input: IdentityQuery = {}): IdentityRecord[] {
    return this.#store.readIdentity(input);
  }

  supersedeIdentity(identityId: string, replacement: ExplicitIdentityInput): IdentityRecord {
    assertNonBlank(identityId, "identityId");
    assertIdentitySemantics(replacement);
    return this.#store.supersedeIdentity(identityId, {
      ...replacement,
      createdAt: this.#clock.now()
    });
  }

  supersedeSelfIdentity(identityId: string, replacement: SelfIdentityInput): IdentityRecord {
    return this.supersedeIdentity(identityId, selfIdentityRecord(replacement));
  }

  supersedeUserAuthoredIdentity(
    identityId: string,
    replacement: UserAuthoredIdentityInput
  ): IdentityRecord {
    return this.supersedeIdentity(identityId, userIdentityRecord(replacement));
  }

  supersedeObservedIdentity(
    identityId: string,
    replacement: ObservedIdentityInput
  ): IdentityRecord {
    return this.supersedeIdentity(identityId, observedIdentityRecord(replacement));
  }

  retractIdentity(identityId: string): IdentityRecord {
    assertNonBlank(identityId, "identityId");
    return this.#store.retractIdentity(identityId, this.#clock.now());
  }
}
