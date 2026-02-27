import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbPool } from "../db/client.js";
import type { OllamaClient } from "../ollama/client.js";
import { jsonResult, errorResult } from "../utils.js";
import { DOMAINS } from "../shared/domains.js";

export function registerSearchTools(
  server: McpServer,
  db: DbPool,
  ollama: OllamaClient
): void {
  server.tool(
    "search_semantic",
    "Find knowledge items semantically similar to a query using vector search (pgvector). Requires Ollama for embedding the query.",
    {
      query: z.string().describe("Natural language search query"),
      domain: z
        .enum(DOMAINS as [string, ...string[]])
        .optional()
        .describe("Filter results to a specific domain"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default 10)"),
      min_similarity: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Minimum cosine similarity threshold (default 0.3)"),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 10;
        const minSimilarity = args.min_similarity ?? 0.3;

        // Generate embedding for the query
        let queryEmbedding: number[];
        try {
          queryEmbedding = await ollama.embed(args.query);
        } catch (err) {
          return errorResult(
            `Ollama unavailable for embedding: ${err instanceof Error ? err.message : String(err)}. Semantic search requires Ollama. Use search_keyword as a fallback.`
          );
        }

        const conditions = ["embedding IS NOT NULL"];
        const params: unknown[] = [JSON.stringify(queryEmbedding)];
        let paramIdx = 2;

        if (args.domain) {
          conditions.push(`domain = $${paramIdx++}`);
          params.push(args.domain);
        }

        // Cosine distance: 1 - (a <=> b) gives similarity (0 to 1)
        const { rows } = await db.query(
          `SELECT id, domain, title, body, status, tags, source_type, created_at,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM knowledge_items
           WHERE ${conditions.join(" AND ")}
             AND 1 - (embedding <=> $1::vector) >= $${paramIdx++}
           ORDER BY embedding <=> $1::vector
           LIMIT $${paramIdx}`,
          [...params, minSimilarity, limit]
        );

        return jsonResult({
          query: args.query,
          method: "semantic",
          results: rows,
          count: rows.length,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "search_keyword",
    "Full-text keyword search across all knowledge items using PostgreSQL tsquery with ranking.",
    {
      query: z.string().describe("Search keywords"),
      domain: z
        .enum(DOMAINS as [string, ...string[]])
        .optional()
        .describe("Filter results to a specific domain"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default 20)"),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 20;

        // Convert user query to tsquery — websearch_to_tsquery handles natural language
        const conditions: string[] = [
          "tsv @@ websearch_to_tsquery('english', $1)",
        ];
        const params: unknown[] = [args.query];
        let paramIdx = 2;

        if (args.domain) {
          conditions.push(`domain = $${paramIdx++}`);
          params.push(args.domain);
        }

        const { rows } = await db.query(
          `SELECT id, domain, title, body, status, tags, source_type, created_at,
                  ts_rank(tsv, websearch_to_tsquery('english', $1)) AS rank
           FROM knowledge_items
           WHERE ${conditions.join(" AND ")}
           ORDER BY rank DESC
           LIMIT $${paramIdx}`,
          [...params, limit]
        );

        return jsonResult({
          query: args.query,
          method: "keyword",
          results: rows,
          count: rows.length,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "search_hybrid",
    "Combined semantic + keyword search with Reciprocal Rank Fusion for best results. This is the recommended default search method.",
    {
      query: z.string().describe("Natural language search query"),
      domain: z
        .enum(DOMAINS as [string, ...string[]])
        .optional()
        .describe("Filter results to a specific domain"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default 10)"),
      semantic_weight: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Weight for semantic results vs keyword (default 0.6)"),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 10;
        const semanticWeight = args.semantic_weight ?? 0.6;
        const keywordWeight = 1 - semanticWeight;
        const k = 60; // RRF constant

        // Attempt semantic search
        let semanticResults: { id: string; rank: number }[] = [];
        let semanticAvailable = true;

        try {
          const queryEmbedding = await ollama.embed(args.query);
          const domainFilter = args.domain
            ? `AND domain = '${args.domain}'`
            : "";

          const { rows } = await db.query(
            `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
             FROM knowledge_items
             WHERE embedding IS NOT NULL ${domainFilter}
             ORDER BY embedding <=> $1::vector
             LIMIT $2`,
            [JSON.stringify(queryEmbedding), limit * 2]
          );

          semanticResults = rows.map(
            (r: { id: string; similarity: number }, i: number) => ({
              id: r.id,
              rank: i + 1,
            })
          );
        } catch {
          semanticAvailable = false;
        }

        // Keyword search
        const domainCondition = args.domain
          ? `AND domain = $2`
          : "";
        const keywordParams: unknown[] = [args.query];
        if (args.domain) keywordParams.push(args.domain);
        keywordParams.push(limit * 2);

        const { rows: keywordRows } = await db.query(
          `SELECT id, ts_rank(tsv, websearch_to_tsquery('english', $1)) AS rank
           FROM knowledge_items
           WHERE tsv @@ websearch_to_tsquery('english', $1) ${domainCondition}
           ORDER BY rank DESC
           LIMIT $${keywordParams.length}`,
          keywordParams
        );

        const keywordResults = keywordRows.map(
          (r: { id: string; rank: number }, i: number) => ({
            id: r.id,
            rank: i + 1,
          })
        );

        // Reciprocal Rank Fusion
        const scores = new Map<string, number>();

        for (const item of semanticResults) {
          const rrf = semanticWeight / (k + item.rank);
          scores.set(item.id, (scores.get(item.id) ?? 0) + rrf);
        }

        for (const item of keywordResults) {
          const rrf = keywordWeight / (k + item.rank);
          scores.set(item.id, (scores.get(item.id) ?? 0) + rrf);
        }

        // Sort by fused score and take top N
        const rankedIds = [...scores.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([id]) => id);

        if (rankedIds.length === 0) {
          return jsonResult({
            query: args.query,
            method: "hybrid",
            results: [],
            count: 0,
            semantic_available: semanticAvailable,
          });
        }

        // Fetch full items in ranked order
        const placeholders = rankedIds.map((_, i) => `$${i + 1}`).join(",");
        const { rows: items } = await db.query(
          `SELECT id, domain, title, body, status, tags, source_type, created_at
           FROM knowledge_items
           WHERE id IN (${placeholders})`,
          rankedIds
        );

        // Restore ranked order and attach scores
        const itemMap = new Map(items.map((r: { id: string }) => [r.id, r]));
        const orderedResults = rankedIds
          .filter((id) => itemMap.has(id))
          .map((id) => ({
            ...itemMap.get(id),
            rrf_score: scores.get(id),
          }));

        return jsonResult({
          query: args.query,
          method: "hybrid",
          results: orderedResults,
          count: orderedResults.length,
          semantic_available: semanticAvailable,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "find_related",
    "Find knowledge items semantically similar to an existing item using its stored embedding.",
    {
      id: z.string().uuid().describe("The item ID to find neighbors for"),
      limit: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe("Max results (default 5)"),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 5;

        // Get the source item's embedding
        const { rows: sourceRows } = await db.query(
          `SELECT id, title, domain, embedding FROM knowledge_items WHERE id = $1`,
          [args.id]
        );

        if (sourceRows.length === 0) {
          return errorResult(`Item not found: ${args.id}`);
        }

        const source = sourceRows[0];

        if (!source.embedding) {
          return errorResult(
            `Item ${args.id} has no embedding. Run reindex_embeddings to generate embeddings.`
          );
        }

        // Find nearest neighbors (excluding self)
        const { rows } = await db.query(
          `SELECT id, domain, title, body, status, tags, source_type, created_at,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM knowledge_items
           WHERE id != $2
             AND embedding IS NOT NULL
           ORDER BY embedding <=> $1::vector
           LIMIT $3`,
          [source.embedding, args.id, limit]
        );

        return jsonResult({
          source_id: args.id,
          source_title: source.title,
          source_domain: source.domain,
          method: "find_related",
          results: rows,
          count: rows.length,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
