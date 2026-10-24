import type { TransactionExecutor } from './database';

interface PostgresMigration {
  id: number;
  name: string;
  up: (db: TransactionExecutor) => Promise<void>;
}

const MIGRATIONS: readonly PostgresMigration[] = [
  {
    id: 1,
    name: 'create_core_ticket_tables',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS tickets (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL UNIQUE,
          ticket_number TEXT,
          status TEXT NOT NULL CHECK (
            status IN ('open', 'claimed', 'pending', 'reopened', 'closed', 'archived')
          ),
          department_id TEXT,
          tag_id TEXT,
          owner_id TEXT,
          priority TEXT,
          claimed_by_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          participant_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          deleted_at TIMESTAMPTZ,
          deletion_reason TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_tickets_guild_status
          ON tickets (guild_id, status);
        CREATE INDEX IF NOT EXISTS idx_tickets_guild_ticket_number
          ON tickets (guild_id, ticket_number);
        CREATE INDEX IF NOT EXISTS idx_tickets_guild_owner
          ON tickets (guild_id, owner_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_department
          ON tickets (guild_id, department_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_tag
          ON tickets (guild_id, tag_id);
      `);
    },
  },
  {
    id: 2,
    name: 'create_domain_events',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ticket_events (
          id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK (
            event_type IN (
              'ticket.created',
              'ticket.status_changed',
              'ticket.metadata_changed',
              'ticket.deleted'
            )
          ),
          actor_id TEXT NOT NULL,
          actor_attribution TEXT NOT NULL CHECK (
            actor_attribution IN ('actorKnown', 'actorInferred', 'actorUnknown')
          ),
          actor_confidence TEXT NOT NULL CHECK (
            actor_confidence IN ('high', 'low', 'none')
          ),
          payload JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_created
          ON ticket_events (ticket_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_ticket_events_guild_created
          ON ticket_events (guild_id, created_at);
      `);
    },
  },
  {
    id: 3,
    name: 'create_outbox',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS outbox_events (
          id TEXT PRIMARY KEY,
          aggregate_type TEXT NOT NULL CHECK (aggregate_type = 'ticket'),
          aggregate_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          guild_id TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK (
            event_type IN (
              'ticket.created',
              'ticket.status_changed',
              'ticket.metadata_changed',
              'ticket.deleted'
            )
          ),
          payload JSONB NOT NULL DEFAULT '{}'::JSONB,
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'processing', 'published', 'failed')
          ),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          available_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          processed_at TIMESTAMPTZ,
          processing_started_at TIMESTAMPTZ,
          last_error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_outbox_pending
          ON outbox_events (status, available_at, created_at)
          WHERE status IN ('pending', 'failed');

        CREATE INDEX IF NOT EXISTS idx_outbox_processing
          ON outbox_events (status, processing_started_at)
          WHERE status = 'processing';

        CREATE INDEX IF NOT EXISTS idx_outbox_aggregate
          ON outbox_events (aggregate_type, aggregate_id, created_at);
      `);
    },
  },
  {
    id: 4,
    name: 'create_application_document_store_and_outbox_lease',
    up: async (db) => {
      await db.query(`
        ALTER TABLE outbox_events
          ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

        CREATE TABLE IF NOT EXISTS app_documents (
          document_key TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_app_documents_updated_at
          ON app_documents (updated_at);
      `);
    },
  },
  {
    id: 5,
    name: 'expand_domain_event_types',
    up: async (db) => {
      const eventTypes = [
        'ticket.created',
        'ticket.status_changed',
        'ticket.metadata_changed',
        'ticket.deleted',
        'ticket.claimed',
        'ticket.unclaimed',
        'ticket.pending',
        'ticket.resumed',
        'ticket.closed',
        'ticket.reopened',
        'ticket.archived',
        'ticket.priority.changed',
        'ticket.department.changed',
        'ticket.tag.changed',
        'ticket.participant.added',
        'ticket.participant.removed',
        'ticket.message.received',
      ];
      const accepted = eventTypes.map((type) => "'" + type + "'").join(', ');

      await db.query(
        'ALTER TABLE ticket_events DROP CONSTRAINT IF EXISTS ticket_events_event_type_check',
      );
      await db.query(
        'ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_event_type_check',
      );
      await db.query(
        'ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_event_type_check CHECK (event_type IN (' + accepted + '))',
      );
      await db.query(
        'ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_event_type_check CHECK (event_type IN (' + accepted + '))',
      );
    },
  },
  {
    id: 6,
    name: 'create_versioned_ticket_forms_and_creation_leases',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ticket_forms (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
          department_id TEXT NOT NULL,
          tag_id TEXT,
          current_version INTEGER NOT NULL CHECK (current_version >= 1),
          active BOOLEAN NOT NULL DEFAULT FALSE,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_forms_guild_department
          ON ticket_forms (guild_id, department_id, active);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_forms_active_mapping
          ON ticket_forms (guild_id, department_id, COALESCE(tag_id, ''))
          WHERE active = TRUE;

        CREATE TABLE IF NOT EXISTS ticket_form_versions (
          form_id TEXT NOT NULL REFERENCES ticket_forms(id) ON DELETE RESTRICT,
          version INTEGER NOT NULL CHECK (version >= 1),
          schema JSONB NOT NULL,
          snapshot JSONB NOT NULL,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (form_id, version)
        );

        CREATE TABLE IF NOT EXISTS ticket_form_submissions (
          interaction_id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          form_id TEXT NOT NULL,
          form_version INTEGER NOT NULL,
          ticket_id TEXT UNIQUE REFERENCES tickets(id) ON DELETE SET NULL,
          channel_id TEXT,
          submitted_by TEXT NOT NULL,
          form_snapshot JSONB NOT NULL,
          answers JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'attached', 'failed')),
          submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          attached_at TIMESTAMPTZ,
          last_error TEXT,
          FOREIGN KEY (form_id, form_version)
            REFERENCES ticket_form_versions(form_id, version)
            ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_form_submissions_recovery
          ON ticket_form_submissions (status, submitted_at)
          WHERE status IN ('pending', 'failed');

        CREATE INDEX IF NOT EXISTS idx_ticket_form_submissions_guild
          ON ticket_form_submissions (guild_id, submitted_at);

        CREATE TABLE IF NOT EXISTS ticket_creation_locks (
          guild_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          department_id TEXT NOT NULL,
          token TEXT NOT NULL UNIQUE,
          expires_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (guild_id, owner_id, department_id)
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_creation_locks_expiry
          ON ticket_creation_locks (expires_at);
      `);
    },
  },
  {
    id: 7,
    name: 'create_reusable_ticket_form_templates',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ticket_form_templates (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
          schema JSONB NOT NULL,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_form_templates_name
          ON ticket_form_templates (guild_id, LOWER(name));

        CREATE INDEX IF NOT EXISTS idx_ticket_form_templates_guild_created
          ON ticket_form_templates (guild_id, created_at DESC);
      `);
    },
  },
  {
    id: 8,
    name: 'create_conditional_ticket_form_sessions',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ticket_form_sessions (
          session_id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          submitted_by TEXT NOT NULL,
          form_id TEXT NOT NULL,
          form_version INTEGER NOT NULL,
          tag_id TEXT NOT NULL,
          form_snapshot JSONB NOT NULL,
          answers JSONB NOT NULL DEFAULT '{}'::jsonb,
          subject TEXT,
          description TEXT,
          next_step INTEGER NOT NULL DEFAULT 1 CHECK (next_step BETWEEN 1 AND 11),
          status TEXT NOT NULL DEFAULT 'collecting'
            CHECK (status IN ('collecting', 'submitting', 'completed', 'expired')),
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          FOREIGN KEY (form_id, form_version)
            REFERENCES ticket_form_versions(form_id, version)
            ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_form_sessions_expiry
          ON ticket_form_sessions (expires_at)
          WHERE status = 'collecting';

        CREATE INDEX IF NOT EXISTS idx_ticket_form_sessions_user
          ON ticket_form_sessions (guild_id, submitted_by, created_at DESC);
      `);
    },
  },
  {
    id: 9,
    name: 'create_durable_ticket_message_archive_and_recovery',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ticket_channel_archive (
          ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
          guild_id TEXT NOT NULL,
          original_channel_id TEXT NOT NULL,
          channel_name TEXT NOT NULL,
          topic TEXT NOT NULL DEFAULT '',
          parent_id TEXT,
          parent_name TEXT,
          permission_overwrites JSONB NOT NULL DEFAULT '[]'::JSONB,
          channel_type INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          nsfw BOOLEAN NOT NULL DEFAULT FALSE,
          rate_limit_per_user INTEGER NOT NULL DEFAULT 0,
          backfill_cursor TEXT,
          backfill_complete BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_channel_archive_guild
          ON ticket_channel_archive (guild_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS ticket_message_archive (
          message_id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          guild_id TEXT NOT NULL,
          original_channel_id TEXT NOT NULL,
          author_id TEXT NOT NULL,
          author_username TEXT NOT NULL,
          author_display_name TEXT NOT NULL,
          author_avatar_url TEXT,
          content TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL,
          edited_at TIMESTAMPTZ,
          deleted_at TIMESTAMPTZ,
          is_bot BOOLEAN NOT NULL DEFAULT FALSE,
          message_type INTEGER NOT NULL DEFAULT 0,
          embeds JSONB NOT NULL DEFAULT '[]'::JSONB,
          components JSONB NOT NULL DEFAULT '[]'::JSONB,
          attachments JSONB NOT NULL DEFAULT '[]'::JSONB,
          edit_history JSONB NOT NULL DEFAULT '[]'::JSONB,
          metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_message_archive_ticket_time
          ON ticket_message_archive (ticket_id, created_at, message_id);

        CREATE INDEX IF NOT EXISTS idx_ticket_message_archive_channel_time
          ON ticket_message_archive (original_channel_id, created_at);

        CREATE TABLE IF NOT EXISTS ticket_message_archive_attachments (
          attachment_id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES ticket_message_archive(message_id) ON DELETE CASCADE,
          guild_id TEXT NOT NULL,
          original_filename TEXT NOT NULL,
          content_type TEXT,
          size_bytes BIGINT NOT NULL DEFAULT 0,
          source_url TEXT NOT NULL,
          archived_bytes BYTEA,
          archive_status TEXT NOT NULL DEFAULT 'pending',
          archive_error TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_archive_attachments_message
          ON ticket_message_archive_attachments (message_id);

        CREATE TABLE IF NOT EXISTS ticket_recovery_events (
          id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          guild_id TEXT NOT NULL,
          original_channel_id TEXT NOT NULL,
          replacement_channel_id TEXT,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          intent TEXT NOT NULL DEFAULT 'unknown',
          actor_id TEXT NOT NULL DEFAULT 'unknown',
          actor_name TEXT NOT NULL DEFAULT 'Unknown actor',
          actor_attribution TEXT NOT NULL DEFAULT 'actorUnknown',
          confirmation_stage INTEGER NOT NULL DEFAULT 0,
          accidental_answer TEXT,
          answered_by TEXT,
          answered_by_name TEXT,
          answer_timestamp TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          resolved_at TIMESTAMPTZ,
          metadata JSONB NOT NULL DEFAULT '{}'::JSONB
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_recovery_events_latest
          ON ticket_recovery_events (guild_id, source, ticket_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_ticket_recovery_events_unresolved
          ON ticket_recovery_events (guild_id, source, status, created_at DESC);
      `);
    },
  },
  {
    id: 10,
    name: 'prevent_duplicate_pending_ticket_button_deletions',
    up: async (db) => {
      // Repair any duplicate pending intents written by older bot versions before
      // enforcing one in-flight destructive operation per actual Discord channel.
      await db.query(`
        WITH ranked AS (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY guild_id, metadata->>'channelIdAtDeletion'
              ORDER BY created_at DESC, id DESC
            ) AS sequence
          FROM ticket_recovery_events
          WHERE source = 'ticket_button'
            AND status = 'pending'
            AND NULLIF(metadata->>'channelIdAtDeletion', '') IS NOT NULL
        )
        UPDATE ticket_recovery_events AS events
        SET status = 'cancelled',
            updated_at = NOW(),
            resolved_at = COALESCE(events.resolved_at, NOW()),
            metadata = events.metadata || jsonb_build_object(
              'cancelReason', 'superseded_duplicate_pending_deletion_intent'
            )
        FROM ranked
        WHERE ranked.id = events.id
          AND ranked.sequence > 1;
      `);

      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_recovery_pending_button_channel
        ON ticket_recovery_events (guild_id, (metadata->>'channelIdAtDeletion'))
        WHERE source = 'ticket_button'
          AND status = 'pending'
          AND NULLIF(metadata->>'channelIdAtDeletion', '') IS NOT NULL;
      `);
    },
  },
  {
    id: 11,
    name: 'add_idempotent_ticket_recovery_replay_ledger',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ticket_recovery_replay_items (
          recovery_event_id TEXT NOT NULL REFERENCES ticket_recovery_events(id) ON DELETE CASCADE,
          original_message_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'completed'
            CHECK (status IN ('completed')),
          replayed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (recovery_event_id, original_message_id)
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_recovery_replay_items_message
          ON ticket_recovery_replay_items (original_message_id);
      `);
    },
  },
  {
    id: 12,
    name: 'add_sla_policy_and_ticket_csat_storage',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS support_sla_policies (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          department_id TEXT NOT NULL DEFAULT '*',
          priority TEXT NOT NULL DEFAULT '*',
          first_response_minutes INTEGER NOT NULL CHECK (first_response_minutes BETWEEN 1 AND 43200),
          resolution_minutes INTEGER NOT NULL CHECK (resolution_minutes BETWEEN 1 AND 43200),
          pause_while_pending BOOLEAN NOT NULL DEFAULT TRUE,
          warning_ratio NUMERIC(4,3) NOT NULL DEFAULT 0.800 CHECK (warning_ratio BETWEEN 0.500 AND 0.990),
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_support_sla_policy_scope
          ON support_sla_policies (guild_id, department_id, priority);
        CREATE INDEX IF NOT EXISTS idx_support_sla_policy_guild_enabled
          ON support_sla_policies (guild_id, enabled);

        CREATE TABLE IF NOT EXISTS support_csat_responses (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
          comment TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (guild_id, ticket_id, user_id),
          CHECK (length(comment) <= 500)
        );

        CREATE INDEX IF NOT EXISTS idx_support_csat_guild_created
          ON support_csat_responses (guild_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_support_csat_ticket
          ON support_csat_responses (ticket_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS support_sla_alerts (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          policy_id TEXT NOT NULL REFERENCES support_sla_policies(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL CHECK (target_type IN ('first_response','resolution')),
          progress TEXT NOT NULL CHECK (progress IN ('warning','breached')),
          policy_version INTEGER NOT NULL CHECK (policy_version > 0),
          cycle_started_at TIMESTAMPTZ NOT NULL,
          observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          detail TEXT NOT NULL DEFAULT '',
          UNIQUE (guild_id,ticket_id,policy_id,target_type,progress,policy_version,cycle_started_at)
        );
        CREATE INDEX IF NOT EXISTS idx_support_sla_alerts_guild_observed
          ON support_sla_alerts (guild_id, observed_at DESC);
      `);
    },
  },
  {
    id: 13,
    name: 'add_durable_recovery_replay_segment_ledger',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ticket_recovery_replay_segments (
          recovery_event_id TEXT NOT NULL REFERENCES ticket_recovery_events(id) ON DELETE CASCADE,
          original_message_id TEXT NOT NULL,
          segment_key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
          discord_message_id TEXT,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          attempt_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (recovery_event_id, original_message_id, segment_key)
        );
        CREATE INDEX IF NOT EXISTS idx_ticket_recovery_replay_segments_pending
          ON ticket_recovery_replay_segments (recovery_event_id, status, updated_at)
          WHERE status='pending';
        CREATE INDEX IF NOT EXISTS idx_ticket_recovery_replay_segments_message
          ON ticket_recovery_replay_segments (discord_message_id)
          WHERE discord_message_id IS NOT NULL;
      `);
    },
  },
  {
    id: 14,
    name: 'add_knowledge_base_quick_replies_and_safe_workflow_catalog',
    up: async (db) => {
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_guild_id_unique
          ON tickets (guild_id,id);

        CREATE TABLE IF NOT EXISTS knowledge_base_articles (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 160),
          summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 500),
          body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
          category TEXT NOT NULL DEFAULT 'General' CHECK (length(category) BETWEEN 1 AND 80),
          tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
          visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','staff')),
          allowed_role_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          search_vector TSVECTOR NOT NULL DEFAULT ''::TSVECTOR,
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          created_by TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          published_at TIMESTAMPTZ,
          archived_at TIMESTAMPTZ,
          UNIQUE (guild_id,slug)
        );
        CREATE OR REPLACE FUNCTION resolvx_refresh_knowledge_search_vector() RETURNS TRIGGER
        LANGUAGE plpgsql AS $search$
        BEGIN
          NEW.search_vector :=
            setweight(to_tsvector('english', COALESCE(NEW.title,'')), 'A') ||
            setweight(to_tsvector('english', COALESCE(NEW.category,'')), 'A') ||
            setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags,' '),'')), 'B') ||
            setweight(to_tsvector('english', COALESCE(NEW.summary,'')), 'B') ||
            setweight(to_tsvector('english', COALESCE(NEW.body,'')), 'C');
          RETURN NEW;
        END;
        $search$;

        DROP TRIGGER IF EXISTS trg_knowledge_base_search_vector ON knowledge_base_articles;
        CREATE TRIGGER trg_knowledge_base_search_vector
          BEFORE INSERT OR UPDATE OF title,summary,body,category,tags ON knowledge_base_articles
          FOR EACH ROW EXECUTE FUNCTION resolvx_refresh_knowledge_search_vector();

        CREATE INDEX IF NOT EXISTS idx_knowledge_base_articles_search
          ON knowledge_base_articles USING GIN (search_vector);
        CREATE INDEX IF NOT EXISTS idx_knowledge_base_articles_browse
          ON knowledge_base_articles (guild_id,status,category,updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_knowledge_base_articles_tags
          ON knowledge_base_articles USING GIN (tags);

        CREATE TABLE IF NOT EXISTS knowledge_base_article_revisions (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          article_id TEXT NOT NULL REFERENCES knowledge_base_articles(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision > 0),
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          body TEXT NOT NULL,
          category TEXT NOT NULL,
          tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          status TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
          visibility TEXT NOT NULL CHECK (visibility IN ('public','staff')),
          allowed_role_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          changed_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (article_id,revision)
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_base_revisions_article
          ON knowledge_base_article_revisions (article_id,revision DESC);

        CREATE TABLE IF NOT EXISTS knowledge_base_synonyms (
          guild_id TEXT NOT NULL,
          term TEXT NOT NULL,
          normalized_term TEXT NOT NULL,
          synonyms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (guild_id,normalized_term),
          CHECK (length(normalized_term) BETWEEN 1 AND 80),
          CHECK (cardinality(synonyms) <= 20)
        );

        CREATE TABLE IF NOT EXISTS knowledge_base_usage (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          article_id TEXT NOT NULL REFERENCES knowledge_base_articles(id) ON DELETE CASCADE,
          actor_id TEXT,
          event_type TEXT NOT NULL CHECK (event_type IN ('search_result','view','shared')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_base_usage_article_time
          ON knowledge_base_usage (guild_id,article_id,created_at DESC);

        CREATE TABLE IF NOT EXISTS knowledge_base_article_feedback (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          article_id TEXT NOT NULL REFERENCES knowledge_base_articles(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          helpful BOOLEAN NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (guild_id,article_id,user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_base_feedback_article
          ON knowledge_base_article_feedback (guild_id,article_id,helpful);

        CREATE TABLE IF NOT EXISTS quick_replies (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
          normalized_name TEXT NOT NULL,
          body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1800),
          category TEXT NOT NULL DEFAULT 'General' CHECK (length(category) BETWEEN 1 AND 80),
          tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          allowed_role_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_by TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (guild_id,normalized_name)
        );
        CREATE INDEX IF NOT EXISTS idx_quick_replies_guild_enabled
          ON quick_replies (guild_id,enabled,category,name);

        CREATE TABLE IF NOT EXISTS workflow_templates (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
          definition JSONB NOT NULL DEFAULT '{}'::JSONB,
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_by TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (guild_id,name)
        );

        CREATE TABLE IF NOT EXISTS related_ticket_links (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          left_ticket_id TEXT NOT NULL,
          right_ticket_id TEXT NOT NULL,
          linked_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (left_ticket_id <> right_ticket_id),
          UNIQUE (guild_id,left_ticket_id,right_ticket_id),
          FOREIGN KEY (guild_id,left_ticket_id) REFERENCES tickets(guild_id,id) ON DELETE CASCADE,
          FOREIGN KEY (guild_id,right_ticket_id) REFERENCES tickets(guild_id,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_related_ticket_links_right
          ON related_ticket_links (guild_id,right_ticket_id);
      `);
    },
  },
  {
    id: 15,
    name: 'preserve_quick_reply_and_workflow_template_revisions',
    up: async (db) => {
      await db.query(`
        ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE workflow_templates ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

        ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_guild_id_normalized_name_key;
        ALTER TABLE workflow_templates DROP CONSTRAINT IF EXISTS workflow_templates_guild_id_name_key;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_replies_active_name
          ON quick_replies (guild_id,normalized_name) WHERE deleted_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_templates_active_name
          ON workflow_templates (guild_id,LOWER(name)) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_workflow_templates_guild_active
          ON workflow_templates (guild_id,updated_at DESC) WHERE deleted_at IS NULL;

        CREATE TABLE IF NOT EXISTS quick_reply_revisions (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          quick_reply_id TEXT NOT NULL REFERENCES quick_replies(id) ON DELETE RESTRICT,
          version INTEGER NOT NULL CHECK (version > 0),
          name TEXT NOT NULL,
          body TEXT NOT NULL,
          category TEXT NOT NULL,
          tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          allowed_role_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          enabled BOOLEAN NOT NULL,
          operation TEXT NOT NULL CHECK (operation IN ('created','updated','deleted','baseline')),
          changed_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (quick_reply_id,version)
        );
        CREATE INDEX IF NOT EXISTS idx_quick_reply_revisions_history
          ON quick_reply_revisions (guild_id,quick_reply_id,version DESC);

        CREATE TABLE IF NOT EXISTS workflow_template_revisions (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          template_id TEXT NOT NULL REFERENCES workflow_templates(id) ON DELETE RESTRICT,
          version INTEGER NOT NULL CHECK (version > 0),
          name TEXT NOT NULL,
          definition JSONB NOT NULL,
          enabled BOOLEAN NOT NULL,
          deleted BOOLEAN NOT NULL DEFAULT FALSE,
          operation TEXT NOT NULL CHECK (operation IN ('created','updated','enabled','disabled','deleted','baseline')),
          changed_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (template_id,version)
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_template_revisions_history
          ON workflow_template_revisions (guild_id,template_id,version DESC);

        INSERT INTO quick_reply_revisions
          (id,guild_id,quick_reply_id,version,name,body,category,tags,allowed_role_ids,enabled,operation,changed_by,created_at)
        SELECT md5('quick-reply:' || id || ':' || version),guild_id,id,version,name,body,category,tags,allowed_role_ids,enabled,'baseline',updated_by,updated_at
        FROM quick_replies
        ON CONFLICT (quick_reply_id,version) DO NOTHING;

        INSERT INTO workflow_template_revisions
          (id,guild_id,template_id,version,name,definition,enabled,deleted,operation,changed_by,created_at)
        SELECT md5('workflow-template:' || id || ':' || version),guild_id,id,version,name,definition,enabled,FALSE,'baseline',updated_by,updated_at
        FROM workflow_templates
        ON CONFLICT (template_id,version) DO NOTHING;
      `);
    },
  },
  {
    id: 16,
    name: 'record_explicit_quick_reply_and_workflow_restore_operations',
    up: async (db) => {
      await db.query(`
        ALTER TABLE quick_reply_revisions
          DROP CONSTRAINT IF EXISTS quick_reply_revisions_operation_check;
        ALTER TABLE quick_reply_revisions
          ADD CONSTRAINT quick_reply_revisions_operation_check
          CHECK (operation IN ('created','updated','deleted','baseline','restored'));

        ALTER TABLE workflow_template_revisions
          DROP CONSTRAINT IF EXISTS workflow_template_revisions_operation_check;
        ALTER TABLE workflow_template_revisions
          ADD CONSTRAINT workflow_template_revisions_operation_check
          CHECK (operation IN ('created','updated','enabled','disabled','deleted','baseline','restored'));
      `);
    },
  },

  {
    id: 17,
    name: 'add_audited_manual_workflow_execution_ledger',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS workflow_execution_runs (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          ticket_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          template_id TEXT NOT NULL REFERENCES workflow_templates(id) ON DELETE RESTRICT,
          template_version INTEGER NOT NULL CHECK (template_version > 0),
          template_name TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          interaction_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running','completed','failed','needs_review','not_matched')),
          definition JSONB NOT NULL,
          condition_evaluation JSONB NOT NULL DEFAULT '{}'::JSONB,
          current_step_index INTEGER,
          result JSONB NOT NULL DEFAULT '{}'::JSONB,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (guild_id,interaction_id),
          FOREIGN KEY (guild_id,ticket_id) REFERENCES tickets(guild_id,id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_execution_runs_ticket_time
          ON workflow_execution_runs (guild_id,ticket_id,created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workflow_execution_runs_status
          ON workflow_execution_runs (guild_id,status,updated_at DESC);

        CREATE TABLE IF NOT EXISTS workflow_execution_steps (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES workflow_execution_runs(id) ON DELETE RESTRICT,
          step_index INTEGER NOT NULL CHECK (step_index >= 0),
          action_type TEXT NOT NULL CHECK (action_type IN ('assign_department','set_priority','add_tag','send_quick_reply')),
          action_value TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','needs_review')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          marker TEXT,
          destination_message_id TEXT,
          result JSONB NOT NULL DEFAULT '{}'::JSONB,
          error_code TEXT,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (run_id,step_index),
          UNIQUE (marker)
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_execution_steps_run
          ON workflow_execution_steps (run_id,step_index);
        CREATE INDEX IF NOT EXISTS idx_workflow_execution_steps_recovery
          ON workflow_execution_steps (guild_id,status,updated_at DESC);
      `);
    },
  },

  {
    id: 18,
    name: 'ensure_durable_recovery_replay_segments_after_premerge_stage4_versions',
    up: async (db) => {
      // Some pre-merge Stage 4 test databases may have recorded id 13 for the
      // Knowledge Base before Stage 3 claimed id 13 for the recovery ledger.
      // This forward-compatible, idempotent guard repairs those databases
      // without reusing or rewriting any existing migration marker.
      await db.query(`
        CREATE TABLE IF NOT EXISTS ticket_recovery_replay_segments (
          recovery_event_id TEXT NOT NULL REFERENCES ticket_recovery_events(id) ON DELETE CASCADE,
          original_message_id TEXT NOT NULL,
          segment_key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
          discord_message_id TEXT,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          attempt_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (recovery_event_id, original_message_id, segment_key)
        );
        CREATE INDEX IF NOT EXISTS idx_ticket_recovery_replay_segments_pending
          ON ticket_recovery_replay_segments (recovery_event_id, status, updated_at)
          WHERE status='pending';
        CREATE INDEX IF NOT EXISTS idx_ticket_recovery_replay_segments_message
          ON ticket_recovery_replay_segments (discord_message_id)
          WHERE discord_message_id IS NOT NULL;
      `);
    },
  },
];

 /** Latest migration identifier required by this application version. */
export const CURRENT_POSTGRES_MIGRATION_ID = MIGRATIONS[MIGRATIONS.length - 1]!.id;

export async function runPostgresMigrations(
  db: TransactionExecutor,
): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await db.query<{ id: number }>(
    'SELECT id FROM schema_migrations ORDER BY id ASC',
  );
  const appliedIds = new Set(applied.rows.map((row) => Number(row.id)));

  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue;

    await db.query('BEGIN');

    try {
      await migration.up(db);

      await db.query(
        'INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, NOW())',
        [migration.id, migration.name],
      );

      await db.query('COMMIT');
    } catch (error) {
      try {
        await db.query('ROLLBACK');
      } catch {
        // Preserve the original migration failure.
      }

      throw new Error(
        `ResolvX PostgreSQL migration ${migration.id} (${migration.name}) failed. The migration marker was not recorded.`,
        { cause: error },
      );
    }
  }
}
