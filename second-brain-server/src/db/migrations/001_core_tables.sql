-- 001_core_tables.sql
-- Core schema for Second Brain knowledge management

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Domain enum (5 buckets, extended from Python prototype's 4)
CREATE TYPE domain AS ENUM (
  'projects',
  'people',
  'ideas',
  'admin',
  'ai_best_practices'
);

-- Item lifecycle status
CREATE TYPE item_status AS ENUM (
  'active',
  'on_hold',
  'completed',
  'archived'
);

-- Ingestion source tracking
CREATE TYPE source_type AS ENUM (
  'manual',
  'outlook_email',
  'github_issue',
  'github_pr',
  'calendar_event',
  'rss_feed',
  'slack'
);

-- ============================================================
-- KNOWLEDGE ITEMS (unified table, domain-typed)
-- ============================================================
CREATE TABLE knowledge_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain        domain NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  status        item_status NOT NULL DEFAULT 'active',

  -- Domain-specific structured fields:
  -- Projects: { next_action, due_date, related_people[] }
  -- People:   { relationship, contact_info, last_interaction }
  -- Ideas:    { related_projects[] }
  -- Admin:    { category, due_date }
  -- AI Best Practices: { tool, use_case, source_url }
  metadata      JSONB NOT NULL DEFAULT '{}',

  tags          TEXT[] NOT NULL DEFAULT '{}',
  source_type   source_type NOT NULL DEFAULT 'manual',
  source_ref    TEXT,

  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- INBOX LOG (audit trail — every ingested item gets a receipt)
-- ============================================================
CREATE TABLE inbox_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  original_text   TEXT NOT NULL,
  classification  TEXT NOT NULL,
  confidence      REAL NOT NULL,
  stored_item_id  UUID REFERENCES knowledge_items(id) ON DELETE SET NULL,
  review_notes    TEXT,
  source_type     source_type NOT NULL DEFAULT 'manual',
  source_ref      TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- RELATIONSHIPS (items can relate across domains)
-- ============================================================
CREATE TABLE item_relations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_id     UUID NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  to_id       UUID NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL DEFAULT 'related',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(from_id, to_id, relation)
);

-- ============================================================
-- NOTIFICATION LOG (tracks sends, enforces daily cap)
-- ============================================================
CREATE TABLE notification_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel     TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  subject     TEXT,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SECURITY EVENTS (audit trail for security scanner)
-- ============================================================
CREATE TABLE security_events (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_text     TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  details       JSONB NOT NULL DEFAULT '{}',
  action_taken  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_knowledge_domain ON knowledge_items(domain);
CREATE INDEX idx_knowledge_status ON knowledge_items(status);
CREATE INDEX idx_knowledge_tags ON knowledge_items USING GIN(tags);
CREATE INDEX idx_knowledge_metadata ON knowledge_items USING GIN(metadata);
CREATE INDEX idx_knowledge_source ON knowledge_items(source_type, source_ref);
CREATE INDEX idx_knowledge_created ON knowledge_items(created_at DESC);
CREATE INDEX idx_inbox_classification ON inbox_log(classification);
CREATE INDEX idx_inbox_created ON inbox_log(created_at DESC);
CREATE INDEX idx_notification_sent ON notification_log(sent_at);
CREATE INDEX idx_notification_channel_day ON notification_log(channel, sent_at);
CREATE INDEX idx_security_events_type ON security_events(event_type);
CREATE INDEX idx_security_events_created ON security_events(created_at DESC);
