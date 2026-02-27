import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbPool } from "../db/client.js";
import type { OllamaClient } from "../ollama/client.js";
import { jsonResult, errorResult } from "../utils.js";
import { DOMAINS, ITEM_STATUSES } from "../shared/domains.js";

export function registerKnowledgeTools(
  server: McpServer,
  db: DbPool,
  ollama: OllamaClient
): void {
  server.tool(
    "list_items",
    "List knowledge items with optional filtering by domain, status, tags, and date range. Paginated.",
    {
      domain: z.enum(DOMAINS as [string, ...string[]]).optional().describe("Filter by domain"),
      status: z.enum(ITEM_STATUSES as [string, ...string[]]).optional().describe("Filter by status"),
      tags: z.array(z.string()).optional().describe("Filter by tags (items must have ALL specified tags)"),
      since: z.string().optional().describe("ISO date — only items created after this date"),
      limit: z.number().min(1).max(100).optional().describe("Max items to return (default 50)"),
      offset: z.number().min(0).optional().describe("Pagination offset"),
    },
    async (args) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (args.domain) {
          conditions.push(`domain = $${paramIdx++}`);
          params.push(args.domain);
        }
        if (args.status) {
          conditions.push(`status = $${paramIdx++}`);
          params.push(args.status);
        }
        if (args.tags && args.tags.length > 0) {
          conditions.push(`tags @> $${paramIdx++}`);
          params.push(args.tags);
        }
        if (args.since) {
          conditions.push(`created_at >= $${paramIdx++}`);
          params.push(args.since);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limit = args.limit ?? 50;
        const offset = args.offset ?? 0;

        const { rows } = await db.query(
          `SELECT id, domain, title, status, tags, source_type, created_by, created_at, updated_at
           FROM knowledge_items ${where}
           ORDER BY created_at DESC
           LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
          [...params, limit, offset]
        );

        const { rows: countRows } = await db.query(
          `SELECT COUNT(*) as total FROM knowledge_items ${where}`,
          params
        );

        return jsonResult({
          items: rows,
          total: parseInt(countRows[0].total, 10),
          limit,
          offset,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_item",
    "Get a single knowledge item by ID, including its relations to other items.",
    {
      id: z.string().uuid().describe("The item ID"),
    },
    async (args) => {
      try {
        const { rows } = await db.query(
          `SELECT * FROM knowledge_items WHERE id = $1`,
          [args.id]
        );

        if (rows.length === 0) {
          return errorResult(`Item not found: ${args.id}`);
        }

        const { rows: relations } = await db.query(
          `SELECT r.*, ki.title as related_title, ki.domain as related_domain
           FROM item_relations r
           JOIN knowledge_items ki ON (
             CASE WHEN r.from_id = $1 THEN r.to_id ELSE r.from_id END = ki.id
           )
           WHERE r.from_id = $1 OR r.to_id = $1`,
          [args.id]
        );

        return jsonResult({ ...rows[0], relations });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "update_item",
    "Update fields on an existing knowledge item. Only include fields you want to change.",
    {
      id: z.string().uuid().describe("The item ID"),
      title: z.string().optional().describe("New title"),
      body: z.string().optional().describe("New body text"),
      status: z.enum(ITEM_STATUSES as [string, ...string[]]).optional().describe("New status"),
      domain: z.enum(DOMAINS as [string, ...string[]]).optional().describe("Move to different domain"),
      tags: z.array(z.string()).optional().describe("Replace tags"),
      metadata: z.record(z.unknown()).optional().describe("Merge into metadata"),
    },
    async (args) => {
      try {
        const sets: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (args.title !== undefined) {
          sets.push(`title = $${paramIdx++}`);
          params.push(args.title);
        }
        if (args.body !== undefined) {
          sets.push(`body = $${paramIdx++}`);
          params.push(args.body);
        }
        if (args.status !== undefined) {
          sets.push(`status = $${paramIdx++}`);
          params.push(args.status);
        }
        if (args.domain !== undefined) {
          sets.push(`domain = $${paramIdx++}`);
          params.push(args.domain);
        }
        if (args.tags !== undefined) {
          sets.push(`tags = $${paramIdx++}`);
          params.push(args.tags);
        }
        if (args.metadata !== undefined) {
          sets.push(`metadata = metadata || $${paramIdx++}`);
          params.push(JSON.stringify(args.metadata));
        }

        if (sets.length === 0) {
          return errorResult("No fields to update");
        }

        // Re-embed if title or body changed
        if (args.title !== undefined || args.body !== undefined) {
          try {
            // Fetch current item to build full text for embedding
            const { rows: current } = await db.query(
              `SELECT title, body FROM knowledge_items WHERE id = $1`,
              [args.id]
            );
            if (current.length > 0) {
              const newTitle = args.title ?? current[0].title;
              const newBody = args.body ?? current[0].body;
              const embedding = await ollama.embed(`${newTitle}\n\n${newBody}`);
              sets.push(`embedding = $${paramIdx++}`);
              params.push(JSON.stringify(embedding));
            }
          } catch {
            // Ollama unavailable — embedding will be stale until reindex
          }
        }

        sets.push(`updated_at = now()`);

        const { rows } = await db.query(
          `UPDATE knowledge_items SET ${sets.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
          [...params, args.id]
        );

        if (rows.length === 0) {
          return errorResult(`Item not found: ${args.id}`);
        }

        return jsonResult(rows[0]);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "delete_item",
    "[DESTRUCTIVE] Permanently delete a knowledge item. Requires confirm: true to execute.",
    {
      id: z.string().uuid().describe("The item ID to delete"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to execute. Omit to see a preview/warning first."),
    },
    async (args) => {
      try {
        const { rows } = await db.query(
          `SELECT id, domain, title, status, created_at FROM knowledge_items WHERE id = $1`,
          [args.id]
        );

        if (rows.length === 0) {
          return errorResult(`Item not found: ${args.id}`);
        }

        if (!args.confirm) {
          const item = rows[0];
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `CONFIRMATION REQUIRED — delete_item`,
                  ``,
                  `You are about to permanently delete:`,
                  `  Title: ${item.title}`,
                  `  Domain: ${item.domain}`,
                  `  Status: ${item.status}`,
                  `  Created: ${item.created_at}`,
                  ``,
                  `Possible consequences:`,
                  `  1. The item will be permanently removed from the knowledge base.`,
                  `  2. All relations to/from this item will be deleted.`,
                  `  3. This action cannot be undone.`,
                  ``,
                  `To proceed, call delete_item again with confirm: true.`,
                ].join("\n"),
              },
            ],
          };
        }

        await db.query(`DELETE FROM knowledge_items WHERE id = $1`, [args.id]);
        return jsonResult({ status: "deleted", id: args.id });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "relate_items",
    "Create a relationship between two knowledge items.",
    {
      from_id: z.string().uuid().describe("Source item ID"),
      to_id: z.string().uuid().describe("Target item ID"),
      relation: z
        .enum(["related", "blocks", "parent_of", "references"])
        .optional()
        .describe("Relation type (default: related)"),
    },
    async (args) => {
      try {
        const relation = args.relation ?? "related";
        await db.query(
          `INSERT INTO item_relations (from_id, to_id, relation)
           VALUES ($1, $2, $3)
           ON CONFLICT (from_id, to_id, relation) DO NOTHING`,
          [args.from_id, args.to_id, relation]
        );
        return jsonResult({ status: "linked", from_id: args.from_id, to_id: args.to_id, relation });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "unrelate_items",
    "Remove a relationship between two knowledge items.",
    {
      from_id: z.string().uuid().describe("Source item ID"),
      to_id: z.string().uuid().describe("Target item ID"),
    },
    async (args) => {
      try {
        const { rowCount } = await db.query(
          `DELETE FROM item_relations WHERE from_id = $1 AND to_id = $2`,
          [args.from_id, args.to_id]
        );
        return jsonResult({ status: "unlinked", removed: rowCount });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
