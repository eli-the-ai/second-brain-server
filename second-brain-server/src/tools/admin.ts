import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbPool } from "../db/client.js";
import type { OllamaClient } from "../ollama/client.js";
import { jsonResult, errorResult } from "../utils.js";
import { DOMAINS, MAX_NOTIFICATIONS_PER_DAY } from "../shared/domains.js";

export function registerAdminTools(
  server: McpServer,
  db: DbPool,
  ollama: OllamaClient
): void {
  server.tool(
    "system_stats",
    "Get overall system health: item counts by domain, review queue size, notification count today, security events, embedding coverage.",
    {},
    async () => {
      try {
        const { rows: domainCounts } = await db.query(
          `SELECT domain, COUNT(*) as count FROM knowledge_items GROUP BY domain ORDER BY count DESC`
        );

        const { rows: statusCounts } = await db.query(
          `SELECT status, COUNT(*) as count FROM knowledge_items GROUP BY status ORDER BY count DESC`
        );

        const { rows: reviewQueue } = await db.query(
          `SELECT COUNT(*) as count FROM inbox_log WHERE classification IN ('needs_review', 'security_hold')`
        );

        const { rows: notifToday } = await db.query(
          `SELECT COUNT(*) as count FROM notification_log WHERE sent_at >= CURRENT_DATE`
        );

        const { rows: securityToday } = await db.query(
          `SELECT COUNT(*) as count FROM security_events WHERE created_at >= CURRENT_DATE`
        );

        const { rows: totalItems } = await db.query(
          `SELECT COUNT(*) as count FROM knowledge_items`
        );

        const { rows: embeddedItems } = await db.query(
          `SELECT COUNT(*) as count FROM knowledge_items WHERE embedding IS NOT NULL`
        );

        const ollamaOnline = await ollama.ping();

        return jsonResult({
          total_items: parseInt(totalItems[0].count, 10),
          items_with_embeddings: parseInt(embeddedItems[0].count, 10),
          by_domain: domainCounts,
          by_status: statusCounts,
          review_queue: parseInt(reviewQueue[0].count, 10),
          notifications_today: parseInt(notifToday[0].count, 10),
          notification_limit: MAX_NOTIFICATIONS_PER_DAY,
          security_events_today: parseInt(securityToday[0].count, 10),
          ollama_online: ollamaOnline,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "reindex_embeddings",
    "[DESTRUCTIVE] Regenerate embeddings for all items (or a specific domain). Requires Ollama to be online. Requires confirm: true.",
    {
      domain: z
        .enum(DOMAINS as [string, ...string[]])
        .optional()
        .describe("Only reindex items in this domain (all domains if omitted)"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to execute. Omit to see preview."),
    },
    async (args) => {
      try {
        const domainFilter = args.domain ? `WHERE domain = $1` : "";
        const domainParams = args.domain ? [args.domain] : [];

        const { rows: countRows } = await db.query(
          `SELECT COUNT(*) as count FROM knowledge_items ${domainFilter}`,
          domainParams
        );
        const totalCount = parseInt(countRows[0].count, 10);

        if (!args.confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `CONFIRMATION REQUIRED — reindex_embeddings`,
                  ``,
                  `This will regenerate embeddings for ${totalCount} items${args.domain ? ` in domain "${args.domain}"` : " across all domains"}.`,
                  ``,
                  `Requirements:`,
                  `  - Ollama must be online and reachable`,
                  `  - This may take several minutes for large datasets`,
                  ``,
                  `To proceed, call reindex_embeddings again with confirm: true.`,
                ].join("\n"),
              },
            ],
          };
        }

        // Verify Ollama is reachable
        const online = await ollama.ping();
        if (!online) {
          return errorResult(
            "Ollama is not reachable. Cannot reindex embeddings."
          );
        }

        // Process in batches of 10
        const batchSize = 10;
        let processed = 0;
        let failed = 0;
        let offset = 0;

        while (offset < totalCount) {
          const { rows: batch } = await db.query(
            `SELECT id, title, body FROM knowledge_items ${domainFilter}
             ORDER BY created_at
             LIMIT $${domainParams.length + 1} OFFSET $${domainParams.length + 2}`,
            [...domainParams, batchSize, offset]
          );

          for (const item of batch) {
            try {
              const text = `${item.title}\n\n${item.body}`;
              const embedding = await ollama.embed(text);
              await db.query(
                `UPDATE knowledge_items SET embedding = $1 WHERE id = $2`,
                [JSON.stringify(embedding), item.id]
              );
              processed++;
            } catch {
              failed++;
            }
          }

          offset += batchSize;
        }

        return jsonResult({
          status: "complete",
          total: totalCount,
          processed,
          failed,
          domain: args.domain ?? "all",
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "notification_status",
    "Check today's notification send count against the daily cap.",
    {},
    async () => {
      try {
        const { rows } = await db.query(
          `SELECT channel, COUNT(*) as count FROM notification_log WHERE sent_at >= CURRENT_DATE GROUP BY channel`
        );

        const totalToday = rows.reduce(
          (sum: number, r: { count: string }) => sum + parseInt(r.count, 10),
          0
        );

        return jsonResult({
          sent_today: totalToday,
          limit: MAX_NOTIFICATIONS_PER_DAY,
          can_send: totalToday < MAX_NOTIFICATIONS_PER_DAY,
          remaining: Math.max(0, MAX_NOTIFICATIONS_PER_DAY - totalToday),
          by_channel: rows,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
