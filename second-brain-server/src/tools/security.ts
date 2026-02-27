import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbPool } from "../db/client.js";
import { jsonResult, errorResult } from "../utils.js";
import { scanContent } from "../security/scanner.js";
import { redactPii } from "../security/pii-detector.js";
import { classifyByKeyword, needsReview } from "../shared/classification.js";
import { DOMAINS } from "../shared/domains.js";
import type { Domain } from "../shared/types.js";

export function registerSecurityTools(
  server: McpServer,
  db: DbPool
): void {
  server.tool(
    "scan_content",
    "Run a security scan on text. Returns PII findings, injection attempts, and policy violations without storing anything.",
    {
      text: z.string().describe("The text to scan"),
    },
    async (args) => {
      try {
        const result = scanContent(args.text);
        return jsonResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "list_quarantined",
    "List items in security_hold status awaiting review.",
    {
      limit: z.number().min(1).max(100).optional().describe("Max items (default 20)"),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 20;
        const { rows } = await db.query(
          `SELECT id, original_text, confidence, source_type, source_ref, created_by, created_at
           FROM inbox_log
           WHERE classification = 'security_hold'
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit]
        );

        return jsonResult({ items: rows, count: rows.length });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "release_quarantined",
    "[DESTRUCTIVE] Release a quarantined item after review. PII is redacted before filing. Requires confirm: true.",
    {
      inbox_id: z.string().uuid().describe("The quarantined inbox_log entry ID"),
      target_domain: z
        .enum(DOMAINS as [string, ...string[]])
        .optional()
        .describe("Domain to file into (auto-classifies if omitted)"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to release. Omit to see preview."),
    },
    async (args) => {
      try {
        const { rows: inboxRows } = await db.query(
          `SELECT * FROM inbox_log WHERE id = $1 AND classification = 'security_hold'`,
          [args.inbox_id]
        );

        if (inboxRows.length === 0) {
          return errorResult(`Quarantined entry not found: ${args.inbox_id}`);
        }

        const entry = inboxRows[0];
        const scan = scanContent(entry.original_text);

        if (!args.confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `CONFIRMATION REQUIRED — release_quarantined`,
                  ``,
                  `Quarantined item:`,
                  `  Text preview: ${entry.original_text.substring(0, 200)}...`,
                  `  PII found: ${scan.pii_findings.map((f: { type: string }) => f.type).join(", ")}`,
                  `  Injection attempts: ${scan.injection_attempts.join(", ") || "none"}`,
                  ``,
                  `On release:`,
                  `  1. PII will be redacted before storing`,
                  `  2. Content will be classified and filed into the knowledge base`,
                  `  3. Original text remains in inbox_log for audit`,
                  ``,
                  `To proceed, call release_quarantined again with confirm: true.`,
                ].join("\n"),
              },
            ],
          };
        }

        // Redact PII and file
        const redactedText = redactPii(
          scan.sanitized_text,
          scan.pii_findings
        );

        const domain = args.target_domain
          ? (args.target_domain as Domain)
          : classifyByKeyword(redactedText).domain;

        const title = redactedText.split("\n")[0].substring(0, 80);

        const { rows } = await db.query(
          `INSERT INTO knowledge_items (domain, title, body, source_type, source_ref, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [domain, title, redactedText, entry.source_type, entry.source_ref, entry.created_by]
        );

        await db.query(
          `UPDATE inbox_log SET classification = $1, stored_item_id = $2, review_notes = 'released from quarantine, PII redacted'
           WHERE id = $3`,
          [domain, rows[0].id, args.inbox_id]
        );

        return jsonResult({
          status: "released",
          domain,
          item_id: rows[0].id,
          pii_redacted: scan.pii_findings.length,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
