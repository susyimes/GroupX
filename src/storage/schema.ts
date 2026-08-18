export const CURRENT_SCHEMA_VERSION = 8;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_groupx_store",
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE actors (
        actor_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'system')),
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_instances (
        instance_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        adapter_id TEXT NOT NULL,
        process_started_at TEXT NOT NULL,
        process_ended_at TEXT,
        status TEXT NOT NULL
      );

      CREATE TABLE session_bindings (
        binding_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES agent_instances(instance_id),
        actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        native_session_id TEXT,
        protocol TEXT NOT NULL,
        protocol_version TEXT,
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_ready_at TEXT,
        closed_at TEXT
      );

      CREATE INDEX session_bindings_actor_status_idx
        ON session_bindings(actor_id, status);

      CREATE TABLE client_commands (
        command_id TEXT PRIMARY KEY,
        source_binding_id TEXT NOT NULL REFERENCES session_bindings(binding_id),
        client_command_id TEXT NOT NULL,
        command_type TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        result_json TEXT,
        accepted_at TEXT NOT NULL,
        UNIQUE(source_binding_id, client_command_id)
      );

      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        schema_version TEXT NOT NULL,
        room_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'system')),
        actor_display_name TEXT NOT NULL,
        instance_id TEXT REFERENCES agent_instances(instance_id),
        targets_json TEXT NOT NULL,
        reply_to_event_id TEXT REFERENCES events(event_id),
        causation_id TEXT,
        correlation_id TEXT NOT NULL,
        idempotency_key TEXT,
        occurred_at TEXT NOT NULL,
        body_json TEXT NOT NULL,
        provenance_json TEXT,
        UNIQUE(room_id, event_type, idempotency_key)
      );

      CREATE INDEX events_room_seq_idx ON events(room_id, seq);
      CREATE INDEX events_correlation_seq_idx ON events(correlation_id, seq);

      CREATE TABLE turns (
        turn_id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL REFERENCES events(event_id),
        target_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        adapter_id TEXT NOT NULL,
        binding_id TEXT REFERENCES session_bindings(binding_id),
        native_turn_id TEXT,
        parent_turn_id TEXT REFERENCES turns(turn_id),
        root_correlation_id TEXT NOT NULL,
        hop_count INTEGER NOT NULL CHECK (hop_count >= 0),
        queued_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
        enqueue_seq INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'dispatching', 'running', 'cancelling', 'completed',
          'failed', 'cancelled', 'interrupted'
        )),
        partial_text TEXT,
        response_event_id TEXT REFERENCES events(event_id),
        terminal_event_id TEXT REFERENCES events(event_id),
        error_code TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        terminal_at TEXT,
        UNIQUE(source_event_id, target_actor_id)
      );

      CREATE INDEX turns_target_status_enqueue_idx
        ON turns(target_actor_id, status, enqueue_seq);
      CREATE INDEX turns_correlation_idx ON turns(root_correlation_id);

      CREATE TABLE turn_attempts (
        attempt_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(turn_id),
        binding_id TEXT NOT NULL REFERENCES session_bindings(binding_id),
        instance_id TEXT NOT NULL REFERENCES agent_instances(instance_id),
        context_through_seq INTEGER NOT NULL CHECK (context_through_seq >= 0),
        native_turn_id TEXT,
        claimed_at TEXT NOT NULL,
        started_at TEXT,
        terminal_at TEXT,
        delivery_certainty TEXT NOT NULL CHECK (delivery_certainty IN (
          'not_delivered', 'delivered', 'unknown', 'terminal'
        ))
      );

      CREATE INDEX turn_attempts_turn_claimed_idx
        ON turn_attempts(turn_id, claimed_at);

      CREATE TABLE delivery_cursors (
        actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        room_id TEXT NOT NULL,
        last_delivered_seq INTEGER NOT NULL CHECK (last_delivered_seq >= 0),
        last_summary_seq INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(actor_id, room_id)
      );

      CREATE TABLE memory_records (
        memory_id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('room', 'agent', 'correlation')),
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'fact', 'decision', 'preference', 'instruction', 'constraint',
          'summary', 'note'
        )),
        author_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        subject_actor_id TEXT REFERENCES actors(actor_id),
        content TEXT NOT NULL,
        source_event_id TEXT REFERENCES events(event_id),
        source_kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retracted')),
        supersedes_memory_id TEXT REFERENCES memory_records(memory_id),
        created_at TEXT NOT NULL,
        retracted_at TEXT
      );

      CREATE INDEX memory_scope_status_created_idx
        ON memory_records(scope_type, scope_id, status, created_at DESC);
      CREATE INDEX memory_author_subject_idx
        ON memory_records(author_actor_id, subject_actor_id);

      CREATE VIRTUAL TABLE memory_records_fts USING fts5(
        memory_id UNINDEXED,
        content,
        content='memory_records',
        content_rowid='rowid'
      );

      CREATE TRIGGER memory_records_ai AFTER INSERT ON memory_records BEGIN
        INSERT INTO memory_records_fts(rowid, memory_id, content)
        VALUES (new.rowid, new.memory_id, new.content);
      END;
      CREATE TRIGGER memory_records_ad AFTER DELETE ON memory_records BEGIN
        INSERT INTO memory_records_fts(memory_records_fts, rowid, memory_id, content)
        VALUES ('delete', old.rowid, old.memory_id, old.content);
      END;
      CREATE TRIGGER memory_records_au AFTER UPDATE OF content ON memory_records BEGIN
        INSERT INTO memory_records_fts(memory_records_fts, rowid, memory_id, content)
        VALUES ('delete', old.rowid, old.memory_id, old.content);
        INSERT INTO memory_records_fts(rowid, memory_id, content)
        VALUES (new.rowid, new.memory_id, new.content);
      END;

      CREATE TABLE identity_records (
        identity_id TEXT PRIMARY KEY,
        subject_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        author_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source_event_id TEXT REFERENCES events(event_id),
        source_kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retracted')),
        supersedes_identity_id TEXT REFERENCES identity_records(identity_id),
        created_at TEXT NOT NULL,
        retracted_at TEXT
      );

      CREATE INDEX identity_subject_status_created_idx
        ON identity_records(subject_actor_id, status, created_at DESC);
      CREATE INDEX identity_author_idx ON identity_records(author_actor_id);

      CREATE VIRTUAL TABLE identity_records_fts USING fts5(
        identity_id UNINDEXED,
        content,
        content='identity_records',
        content_rowid='rowid'
      );

      CREATE TRIGGER identity_records_ai AFTER INSERT ON identity_records BEGIN
        INSERT INTO identity_records_fts(rowid, identity_id, content)
        VALUES (new.rowid, new.identity_id, new.content);
      END;
      CREATE TRIGGER identity_records_ad AFTER DELETE ON identity_records BEGIN
        INSERT INTO identity_records_fts(identity_records_fts, rowid, identity_id, content)
        VALUES ('delete', old.rowid, old.identity_id, old.content);
      END;
      CREATE TRIGGER identity_records_au AFTER UPDATE OF content ON identity_records BEGIN
        INSERT INTO identity_records_fts(identity_records_fts, rowid, identity_id, content)
        VALUES ('delete', old.rowid, old.identity_id, old.content);
        INSERT INTO identity_records_fts(rowid, identity_id, content)
        VALUES (new.rowid, new.identity_id, new.content);
      END;

      CREATE TABLE summaries (
        summary_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        from_seq INTEGER NOT NULL,
        through_seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        generator_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (from_seq <= through_seq)
      );

    `
  },
  {
    version: 2,
    name: "turn_attempt_dispatch_reliability",
    sql: `
      ALTER TABLE turn_attempts
        ADD COLUMN dispatch_phase TEXT NOT NULL DEFAULT 'prepared'
        CHECK (dispatch_phase IN ('prepared', 'prompt_invoked', 'native_started', 'terminal'));

      ALTER TABLE turn_attempts
        ADD COLUMN prompt_invoked_at TEXT;

      UPDATE turn_attempts
      SET dispatch_phase = CASE
        WHEN terminal_at IS NOT NULL THEN 'terminal'
        WHEN delivery_certainty = 'delivered' OR started_at IS NOT NULL THEN 'native_started'
        ELSE 'prompt_invoked'
      END,
      prompt_invoked_at = CASE
        WHEN terminal_at IS NULL
          AND delivery_certainty <> 'delivered'
          AND started_at IS NULL
        THEN claimed_at
        ELSE prompt_invoked_at
      END,
      delivery_certainty = CASE
        WHEN terminal_at IS NULL
          AND delivery_certainty <> 'delivered'
          AND started_at IS NULL
        THEN 'unknown'
        ELSE delivery_certainty
      END;

      CREATE UNIQUE INDEX turn_attempts_one_current_idx
        ON turn_attempts(turn_id)
        WHERE terminal_at IS NULL;
    `
  },
  {
    version: 3,
    name: "remove_groupx_approval_store",
    sql: `
      DROP TABLE IF EXISTS approval_requests;
    `
  },
  {
    version: 4,
    name: "snapshot_runtime_transport",
    sql: `
      ALTER TABLE agent_instances
        ADD COLUMN transport TEXT
        CHECK (transport IN ('direct', 'structured'));

      ALTER TABLE session_bindings
        ADD COLUMN transport TEXT
        CHECK (transport IN ('direct', 'structured'));

      ALTER TABLE turns
        ADD COLUMN transport TEXT NOT NULL DEFAULT 'structured'
        CHECK (transport IN ('direct', 'structured'));

      UPDATE agent_instances
      SET transport = 'structured'
      WHERE actor_id IN (SELECT actor_id FROM actors WHERE kind = 'agent');

      UPDATE session_bindings
      SET transport = 'structured'
      WHERE actor_id IN (SELECT actor_id FROM actors WHERE kind = 'agent');
    `
  },
  {
    version: 5,
    name: "durable_room_context_checkpoints",
    sql: `
      UPDATE summaries
      SET status = 'superseded'
      WHERE status = 'active'
        AND summary_id NOT IN (
          SELECT summary_id FROM summaries AS newest
          WHERE newest.room_id = summaries.room_id
            AND newest.status = 'active'
          ORDER BY newest.through_seq DESC, newest.created_at DESC, newest.summary_id DESC
          LIMIT 1
        );

      ALTER TABLE turn_attempts
        ADD COLUMN summary_through_seq INTEGER
        CHECK (summary_through_seq IS NULL OR summary_through_seq >= 0);

      CREATE INDEX IF NOT EXISTS summaries_room_status_through_idx
        ON summaries(room_id, status, through_seq DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS summaries_one_active_room_idx
        ON summaries(room_id)
        WHERE status = 'active';
    `
  },
  {
    version: 6,
    name: "split_agent_core_and_dated_memory",
    sql: `
      ALTER TABLE memory_records
        ADD COLUMN agent_memory_type TEXT
        CHECK (agent_memory_type IN ('core', 'dated'));

      UPDATE memory_records
      SET agent_memory_type = 'core'
      WHERE scope_type = 'agent';

      CREATE INDEX memory_agent_type_status_created_idx
        ON memory_records(scope_type, scope_id, agent_memory_type, status, created_at DESC);

      CREATE TRIGGER memory_records_agent_type_bi
      BEFORE INSERT ON memory_records
      WHEN (NEW.scope_type = 'agent' AND NEW.agent_memory_type IS NULL)
        OR (NEW.scope_type <> 'agent' AND NEW.agent_memory_type IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'agent_memory_type must match agent scope');
      END;

      CREATE TRIGGER memory_records_agent_type_bu
      BEFORE UPDATE OF scope_type, agent_memory_type ON memory_records
      WHEN (NEW.scope_type = 'agent' AND NEW.agent_memory_type IS NULL)
        OR (NEW.scope_type <> 'agent' AND NEW.agent_memory_type IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'agent_memory_type must match agent scope');
      END;
    `
  },
  {
    version: 7,
    name: "batch_agent_dated_memory",
    sql: `
      CREATE TABLE agent_dated_memory_rollups (
        room_id TEXT NOT NULL,
        actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        local_date TEXT NOT NULL,
        memory_id TEXT REFERENCES memory_records(memory_id),
        summarized_through_seq INTEGER NOT NULL DEFAULT 0
          CHECK (summarized_through_seq >= 0),
        pending_through_seq INTEGER CHECK (
          pending_through_seq IS NULL OR pending_through_seq >= 0
        ),
        pending_turns INTEGER NOT NULL DEFAULT 0 CHECK (pending_turns >= 0),
        pending_chars INTEGER NOT NULL DEFAULT 0 CHECK (pending_chars >= 0),
        first_pending_at TEXT,
        last_pending_at TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        last_attempt_at TEXT,
        next_attempt_at TEXT,
        last_error_code TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(room_id, actor_id, local_date),
        CHECK (
          (pending_turns = 0 AND pending_chars = 0 AND pending_through_seq IS NULL
            AND first_pending_at IS NULL AND last_pending_at IS NULL)
          OR
          (pending_turns > 0 AND pending_through_seq IS NOT NULL
            AND first_pending_at IS NOT NULL AND last_pending_at IS NOT NULL)
        )
      );

      CREATE TABLE agent_dated_memory_sources (
        turn_id TEXT PRIMARY KEY REFERENCES turns(turn_id),
        room_id TEXT NOT NULL,
        actor_id TEXT NOT NULL REFERENCES actors(actor_id),
        local_date TEXT NOT NULL,
        source_event_id TEXT NOT NULL REFERENCES events(event_id),
        source_seq INTEGER NOT NULL CHECK (source_seq >= 0),
        response_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
        response_seq INTEGER NOT NULL CHECK (response_seq >= 0),
        source_chars INTEGER NOT NULL CHECK (source_chars >= 0),
        terminal_at TEXT NOT NULL,
        processed_at TEXT,
        memory_id TEXT REFERENCES memory_records(memory_id),
        FOREIGN KEY(room_id, actor_id, local_date)
          REFERENCES agent_dated_memory_rollups(room_id, actor_id, local_date)
      );

      CREATE INDEX agent_dated_memory_rollups_pending_idx
        ON agent_dated_memory_rollups(room_id, pending_turns, next_attempt_at, local_date);
      CREATE INDEX agent_dated_memory_sources_pending_idx
        ON agent_dated_memory_sources(room_id, actor_id, local_date, processed_at, response_seq);
    `
  },
  {
    version: 8,
    name: "live_supervision_pairs",
    sql: `
      CREATE TABLE supervision_pairs (
        pair_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL REFERENCES events(event_id),
        watch_event_id TEXT NOT NULL REFERENCES events(event_id),
        pair_event_id TEXT NOT NULL REFERENCES events(event_id),
        mode TEXT NOT NULL CHECK (mode = 'live_steer'),
        created_at TEXT NOT NULL
      );

      CREATE INDEX supervision_pairs_correlation_idx
        ON supervision_pairs(correlation_id);

      CREATE TABLE supervision_pair_turns (
        turn_id TEXT PRIMARY KEY REFERENCES turns(turn_id),
        pair_id TEXT NOT NULL REFERENCES supervision_pairs(pair_id),
        role TEXT NOT NULL CHECK (role IN ('worker', 'observer')),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX supervision_pair_turns_pair_role_idx
        ON supervision_pair_turns(pair_id, role);

      CREATE TABLE supervision_steer_counts (
        subject_turn_id TEXT PRIMARY KEY REFERENCES turns(turn_id),
        steer_count INTEGER NOT NULL CHECK (steer_count >= 0)
      );
    `
  }
];
