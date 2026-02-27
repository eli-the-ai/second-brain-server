-- 004_cms_columns.sql
-- CMS groundwork: publish workflow columns on knowledge_items

-- Publish lifecycle status
CREATE TYPE publish_status AS ENUM (
  'draft',
  'in_review',
  'published',
  'unpublished'
);

-- Add CMS columns to knowledge_items
ALTER TABLE knowledge_items
  ADD COLUMN publish_status publish_status NOT NULL DEFAULT 'draft',
  ADD COLUMN slug           TEXT,
  ADD COLUMN excerpt        TEXT,
  ADD COLUMN publish_at     TIMESTAMPTZ,
  ADD COLUMN published_at   TIMESTAMPTZ,
  ADD COLUMN published_by   TEXT;

-- Slugs must be unique when set (null is allowed for non-published items)
CREATE UNIQUE INDEX idx_knowledge_slug ON knowledge_items(slug) WHERE slug IS NOT NULL;

-- Fast lookup for published content
CREATE INDEX idx_knowledge_publish_status ON knowledge_items(publish_status);
CREATE INDEX idx_knowledge_published_at ON knowledge_items(published_at DESC) WHERE publish_status = 'published';
