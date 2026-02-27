-- 003_fulltext.sql
-- Full-text search with weighted tsvector

-- Weighted tsvector: title gets weight A (highest), body gets weight B
ALTER TABLE knowledge_items ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED;

CREATE INDEX idx_knowledge_tsv ON knowledge_items USING GIN(tsv);
