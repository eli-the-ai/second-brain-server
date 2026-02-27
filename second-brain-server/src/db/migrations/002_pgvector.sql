-- 002_pgvector.sql
-- Vector embeddings for semantic search

CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to knowledge items
-- nomic-embed-text produces 768-dimensional vectors
ALTER TABLE knowledge_items ADD COLUMN embedding vector(768);

-- HNSW index for approximate nearest neighbor search (cosine distance)
-- m=16, ef_construction=64 are good defaults for datasets under 100k items
CREATE INDEX idx_knowledge_embedding ON knowledge_items
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Also add embedding to inbox_log for searching unprocessed items
ALTER TABLE inbox_log ADD COLUMN embedding vector(768);
