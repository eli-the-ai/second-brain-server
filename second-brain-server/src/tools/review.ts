import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbPool } from "../db/client.js";
import type { OllamaClient } from "../ollama/client.js";
import { jsonResult, errorResult } from "../utils.js";
import { DOMAINS } from "../shared/domains.js";
import type { Domain } from "../shared/types.js";

export function registerReviewTools(
  server: McpServer,
  db: DbPool,
  _ollama: OllamaClient
): void {
  server.tool(
    "list_needs_review",
    "List all inbox entries that need human review (low confidence or security hold).",
    {
      limit: z.number().min(1).max(100).optional().describe("Max items (default 20)"),
      since: z.string().optional().describe("ISO date — only items after this date"),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 20;
        const conditions = ["classification IN ('needs_review', 'security_hold')"];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (args.since) {
          conditions.push(`created_at >= $${paramIdx++}`);
          params.push(args.since);
        }

        const { rows } = await db.query(
          `SELECT id, original_text, classification, confidence, source_type, source_ref, created_by, created_at
           FROM inbox_log
           WHERE ${conditions.join(" AND ")}
           ORDER BY created_at DESC
           LIMIT $${paramIdx}`,
          [...params, limit]
        );

        return jsonResult({ items: rows, count: rows.length });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "fix_classification",
    "Correct a needs_review item by filing it into the correct domain. Creates a knowledge item and updates the inbox log.",
    {
      inbox_id: z.string().uuid().describe("The inbox_log entry ID"),
      correct_domain: z
        .enum(DOMAINS as [string, ...string[]])
        .describe("The correct domain to file into"),
      title: z.string().optional().describe("Custom title (auto-extracted if omitted)"),
      tags: z.array(z.string()).optional().describe("Tags to apply"),
    },
    async (args) => {
      try {
        const domain = args.correct_domain as Domain;

        // Fetch the inbox entry
        const { rows: inboxRows } = await db.query(
          `SELECT * FROM inbox_log WHERE id = $1`,
          [args.inbox_id]
        );

        if (inboxRows.length === 0) {
          return errorResult(`Inbox entry not found: ${args.inbox_id}`);
        }

        const entry = inboxRows[0];

        if (entry.stored_item_id) {
          return errorResult("This item has already been filed");
        }

        const title =
          args.title ?? entry.original_text.split("\n")[0].substring(0, 80);

        // Create knowledge item
        const { rows } = await db.query(
          `INSERT INTO knowledge_items (domain, title, body, source_type, source_ref, created_by, tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            domain,
            title,
            entry.original_text,
            entry.source_type,
            entry.source_ref,
            entry.created_by,
            args.tags ?? [],
          ]
        );

        // Update inbox log
        await db.query(
          `UPDATE inbox_log SET classification = $1, stored_item_id = $2, review_notes = 'manually classified'
           WHERE id = $3`,
          [domain, rows[0].id, args.inbox_id]
        );

        return jsonResult({
          status: "filed",
          domain,
          title,
          item_id: rows[0].id,
          inbox_id: args.inbox_id,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "dismiss_review",
    "Dismiss a needs_review item without filing it (noise, duplicate, etc.).",
    {
      inbox_id: z.string().uuid().describe("The inbox_log entry ID"),
      reason: z.string().optional().describe("Why this was dismissed"),
    },
    async (args) => {
      try {
        const { rowCount } = await db.query(
          `UPDATE inbox_log SET classification = 'dismissed', review_notes = $1
           WHERE id = $2 AND classification IN ('needs_review', 'security_hold')`,
          [args.reason ?? "dismissed by reviewer", args.inbox_id]
        );

        if (rowCount === 0) {
          return errorResult(
            `Inbox entry not found or already processed: ${args.inbox_id}`
          );
        }

        return jsonResult({
          status: "dismissed",
          inbox_id: args.inbox_id,
          reason: args.reason ?? "dismissed by reviewer",
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_inbox_stats",
    "Get counts of items by classification status in the inbox log.",
    {},
    async () => {
      try {
        const { rows } = await db.query(
          `SELECT classification, COUNT(*) as count FROM inbox_log GROUP BY classification ORDER BY count DESC`
        );

        const { rows: recentRows } = await db.query(
          `SELECT COUNT(*) as today FROM inbox_log WHERE created_at >= CURRENT_DATE`
        );

        return jsonResult({
          by_classification: rows,
          captured_today: parseInt(recentRows[0].today, 10),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
