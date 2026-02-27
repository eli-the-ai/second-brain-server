import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbPool } from "../db/client.js";
import type { OllamaClient } from "../ollama/client.js";
import { jsonResult, errorResult } from "../utils.js";
import { DOMAINS, PUBLISH_STATUSES } from "../shared/domains.js";

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 100);
}

export function registerCmsTools(
  server: McpServer,
  db: DbPool,
  ollama: OllamaClient
): void {
  server.tool(
    "cms_set_draft",
    "Prepare a knowledge item for publishing by setting its CMS fields (slug, excerpt). Moves it to 'draft' publish status.",
    {
      id: z.string().uuid().describe("Knowledge item ID"),
      slug: z.string().optional().describe("URL slug (auto-generated from title if omitted)"),
      excerpt: z.string().optional().describe("Short excerpt/summary for listings (auto-generated if omitted)"),
    },
    async (args) => {
      try {
        const { rows: current } = await db.query(
          `SELECT id, title, body, publish_status FROM knowledge_items WHERE id = $1`,
          [args.id]
        );

        if (current.length === 0) {
          return errorResult(`Item not found: ${args.id}`);
        }

        const item = current[0];
        const slug = args.slug ?? generateSlug(item.title);

        // Check slug uniqueness
        const { rows: slugCheck } = await db.query(
          `SELECT id FROM knowledge_items WHERE slug = $1 AND id != $2`,
          [slug, args.id]
        );
        if (slugCheck.length > 0) {
          return errorResult(`Slug "${slug}" is already in use by another item.`);
        }

        // Auto-generate excerpt if not provided
        let excerpt = args.excerpt;
        if (!excerpt) {
          try {
            excerpt = await ollama.summarize(item.body, 30);
          } catch {
            excerpt = item.body.substring(0, 200).replace(/\n/g, " ").trim();
            if (item.body.length > 200) excerpt += "...";
          }
        }

        const { rows } = await db.query(
          `UPDATE knowledge_items
           SET publish_status = 'draft', slug = $1, excerpt = $2, updated_at = now()
           WHERE id = $3
           RETURNING id, title, publish_status, slug, excerpt`,
          [slug, excerpt, args.id]
        );

        return jsonResult(rows[0]);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "cms_submit_for_review",
    "Submit a draft item for editorial review. Moves publish status to 'in_review'.",
    {
      id: z.string().uuid().describe("Knowledge item ID"),
    },
    async (args) => {
      try {
        const { rows } = await db.query(
          `UPDATE knowledge_items
           SET publish_status = 'in_review', updated_at = now()
           WHERE id = $1 AND publish_status = 'draft'
           RETURNING id, title, publish_status, slug`,
          [args.id]
        );

        if (rows.length === 0) {
          return errorResult(`Item not found or not in 'draft' status: ${args.id}`);
        }

        return jsonResult({ status: "submitted", ...rows[0] });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "cms_publish",
    "[DESTRUCTIVE] Publish a knowledge item, making it publicly visible. Requires confirm: true. Item must have a slug and be in 'draft' or 'in_review' status.",
    {
      id: z.string().uuid().describe("Knowledge item ID"),
      publish_at: z
        .string()
        .optional()
        .describe("Schedule publish for a future date (ISO format). Omit to publish immediately."),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to publish. Omit to see preview."),
    },
    async (args) => {
      try {
        const { rows: current } = await db.query(
          `SELECT id, title, publish_status, slug, excerpt FROM knowledge_items WHERE id = $1`,
          [args.id]
        );

        if (current.length === 0) {
          return errorResult(`Item not found: ${args.id}`);
        }

        const item = current[0];

        if (!item.slug) {
          return errorResult("Item must have a slug before publishing. Use cms_set_draft first.");
        }

        if (item.publish_status !== "draft" && item.publish_status !== "in_review") {
          return errorResult(`Item is in '${item.publish_status}' status. Only draft or in_review items can be published.`);
        }

        if (!args.confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `CONFIRMATION REQUIRED — cms_publish`,
                  ``,
                  `You are about to publish:`,
                  `  Title: ${item.title}`,
                  `  Slug: ${item.slug}`,
                  `  Excerpt: ${item.excerpt || "(none)"}`,
                  `  Scheduled: ${args.publish_at || "immediately"}`,
                  ``,
                  `This will make the content publicly visible.`,
                  `To proceed, call cms_publish again with confirm: true.`,
                ].join("\n"),
              },
            ],
          };
        }

        const now = new Date().toISOString();
        const publishAt = args.publish_at ?? now;
        const isImmediate = !args.publish_at || new Date(args.publish_at) <= new Date();

        const { rows } = await db.query(
          `UPDATE knowledge_items
           SET publish_status = $1,
               publish_at = $2,
               published_at = $3,
               published_by = $4,
               updated_at = now()
           WHERE id = $5
           RETURNING id, title, publish_status, slug, publish_at, published_at`,
          [
            isImmediate ? "published" : "draft",
            publishAt,
            isImmediate ? now : null,
            process.env.BRAIN_USER || null,
            args.id,
          ]
        );

        return jsonResult({
          status: isImmediate ? "published" : "scheduled",
          ...rows[0],
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "cms_unpublish",
    "[DESTRUCTIVE] Unpublish a published item, removing it from public view. Requires confirm: true.",
    {
      id: z.string().uuid().describe("Knowledge item ID"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to unpublish. Omit to see preview."),
    },
    async (args) => {
      try {
        const { rows: current } = await db.query(
          `SELECT id, title, publish_status, slug, published_at FROM knowledge_items WHERE id = $1`,
          [args.id]
        );

        if (current.length === 0) {
          return errorResult(`Item not found: ${args.id}`);
        }

        const item = current[0];

        if (item.publish_status !== "published") {
          return errorResult(`Item is not published (current status: ${item.publish_status}).`);
        }

        if (!args.confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `CONFIRMATION REQUIRED — cms_unpublish`,
                  ``,
                  `You are about to unpublish:`,
                  `  Title: ${item.title}`,
                  `  Slug: ${item.slug}`,
                  `  Published: ${item.published_at}`,
                  ``,
                  `This will remove it from public view.`,
                  `To proceed, call cms_unpublish again with confirm: true.`,
                ].join("\n"),
              },
            ],
          };
        }

        const { rows } = await db.query(
          `UPDATE knowledge_items
           SET publish_status = 'unpublished', updated_at = now()
           WHERE id = $1
           RETURNING id, title, publish_status, slug`,
          [args.id]
        );

        return jsonResult({ status: "unpublished", ...rows[0] });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "cms_list_content",
    "List knowledge items by publish status. Use to see drafts, items in review, published content, etc.",
    {
      publish_status: z
        .enum(PUBLISH_STATUSES as [string, ...string[]])
        .optional()
        .describe("Filter by publish status (default: all)"),
      domain: z
        .enum(DOMAINS as [string, ...string[]])
        .optional()
        .describe("Filter by domain"),
      limit: z.number().min(1).max(100).optional().describe("Max items (default 50)"),
      offset: z.number().min(0).optional().describe("Pagination offset"),
    },
    async (args) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (args.publish_status) {
          conditions.push(`publish_status = $${idx++}`);
          params.push(args.publish_status);
        }
        if (args.domain) {
          conditions.push(`domain = $${idx++}`);
          params.push(args.domain);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limit = args.limit ?? 50;
        const offset = args.offset ?? 0;

        const { rows } = await db.query(
          `SELECT id, domain, title, slug, excerpt, publish_status, status, published_at, published_by, created_by, created_at, updated_at
           FROM knowledge_items ${where}
           ORDER BY COALESCE(published_at, created_at) DESC
           LIMIT $${idx++} OFFSET $${idx++}`,
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
    "cms_update_slug",
    "Change the URL slug for a knowledge item. Validates uniqueness.",
    {
      id: z.string().uuid().describe("Knowledge item ID"),
      slug: z.string().describe("New URL slug"),
    },
    async (args) => {
      try {
        // Check uniqueness
        const { rows: slugCheck } = await db.query(
          `SELECT id FROM knowledge_items WHERE slug = $1 AND id != $2`,
          [args.slug, args.id]
        );
        if (slugCheck.length > 0) {
          return errorResult(`Slug "${args.slug}" is already in use.`);
        }

        const { rows } = await db.query(
          `UPDATE knowledge_items SET slug = $1, updated_at = now() WHERE id = $2 RETURNING id, title, slug, publish_status`,
          [args.slug, args.id]
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
}
