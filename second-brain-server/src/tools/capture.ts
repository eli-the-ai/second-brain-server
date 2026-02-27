import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbPool } from "../db/client.js";
import type { OllamaClient } from "../ollama/client.js";
import { jsonResult, errorResult } from "../utils.js";
import { classifyByKeyword, needsReview } from "../shared/classification.js";
import { DOMAINS } from "../shared/domains.js";
import { scanContent } from "../security/scanner.js";
import type { Domain, SourceType } from "../shared/types.js";

export function registerCaptureTools(
  server: McpServer,
  db: DbPool,
  ollama: OllamaClient
): void {
  server.tool(
    "capture_thought",
    "Ingest raw text into the Second Brain. Runs security scan, classifies via AI (or keyword fallback), and files into the appropriate domain. Items below confidence threshold route to needs_review.",
    {
      text: z.string().describe("The raw text to capture"),
      source_type: z
        .enum(["manual", "outlook_email", "github_issue", "github_pr", "calendar_event", "rss_feed", "slack"])
        .optional()
        .describe("Where this content came from (default: manual)"),
      source_ref: z
        .string()
        .optional()
        .describe("External reference ID (email ID, issue URL, etc.)"),
      created_by: z
        .string()
        .optional()
        .describe("Team member who captured this"),
    },
    async (args) => {
      try {
        const sourceType = (args.source_type ?? "manual") as SourceType;

        // Step 1: Security scan
        const scanResult = scanContent(args.text);

        if (scanResult.pii_findings.length > 0) {
          // Quarantine: log to security_events and inbox_log, don't store in knowledge_items
          await db.query(
            `INSERT INTO security_events (item_text, event_type, details, action_taken)
             VALUES ($1, $2, $3, $4)`,
            [
              args.text.substring(0, 500),
              "pii_detected",
              JSON.stringify({ findings: scanResult.pii_findings }),
              "quarantined",
            ]
          );

          await db.query(
            `INSERT INTO inbox_log (original_text, classification, confidence, source_type, source_ref, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              args.text,
              "security_hold",
              0,
              sourceType,
              args.source_ref ?? null,
              args.created_by ?? null,
            ]
          );

          return jsonResult({
            status: "quarantined",
            reason: "PII detected",
            pii_types: scanResult.pii_findings.map((f) => f.type),
            message:
              "Content contains PII and has been quarantined. Use list_quarantined and release_quarantined to review.",
          });
        }

        // Log injection attempts but continue with sanitized text
        if (scanResult.injection_attempts.length > 0) {
          await db.query(
            `INSERT INTO security_events (item_text, event_type, details, action_taken)
             VALUES ($1, $2, $3, $4)`,
            [
              args.text.substring(0, 500),
              "injection_attempt",
              JSON.stringify({ attempts: scanResult.injection_attempts }),
              "sanitized",
            ]
          );
        }

        const cleanText = scanResult.sanitized_text;

        // Step 2: Classify — try Ollama first, fall back to keyword
        let classification;
        let classifierUsed = "keyword";
        try {
          classification = await ollama.classify(cleanText);
          classifierUsed = "ollama";
        } catch {
          classification = classifyByKeyword(cleanText);
        }

        // Step 3: Generate embedding (best-effort, null if Ollama unreachable)
        let embedding: number[] | null = null;
        try {
          embedding = await ollama.embed(cleanText);
        } catch {
          // Embedding will be null — can be backfilled with reindex_embeddings
        }

        // Step 4: Check confidence (Bouncer pattern)
        const review = needsReview(classification.confidence);
        const classificationLabel = review
          ? "needs_review"
          : classification.domain;

        // Step 5: Store in knowledge_items (unless needs_review)
        let storedItemId: string | null = null;

        if (!review) {
          const { rows } = await db.query(
            `INSERT INTO knowledge_items (domain, title, body, source_type, source_ref, created_by, metadata, tags, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [
              classification.domain,
              classification.title,
              cleanText,
              sourceType,
              args.source_ref ?? null,
              args.created_by ?? null,
              JSON.stringify(classification.extracted),
              [],
              embedding ? JSON.stringify(embedding) : null,
            ]
          );
          storedItemId = rows[0].id;
        }

        // Step 5: Write audit trail (inbox_log)
        await db.query(
          `INSERT INTO inbox_log (original_text, classification, confidence, stored_item_id, source_type, source_ref, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            args.text,
            classificationLabel,
            classification.confidence,
            storedItemId,
            sourceType,
            args.source_ref ?? null,
            args.created_by ?? null,
          ]
        );

        return jsonResult({
          status: review ? "needs_review" : "filed",
          domain: classification.domain,
          confidence: classification.confidence,
          title: classification.title,
          item_id: storedItemId,
          classifier: classifierUsed,
          has_embedding: embedding !== null,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "capture_with_domain",
    "Ingest text directly into a specified domain, bypassing classification. Use when you know the correct domain.",
    {
      text: z.string().describe("The text to capture"),
      domain: z
        .enum(DOMAINS as [string, ...string[]])
        .describe("Target domain"),
      title: z.string().optional().describe("Custom title (auto-extracted if omitted)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags to apply"),
      source_type: z
        .enum(["manual", "outlook_email", "github_issue", "github_pr", "calendar_event", "rss_feed", "slack"])
        .optional(),
      source_ref: z.string().optional(),
      created_by: z.string().optional(),
    },
    async (args) => {
      try {
        const sourceType = (args.source_type ?? "manual") as SourceType;
        const domain = args.domain as Domain;

        // Security scan
        const scanResult = scanContent(args.text);
        if (scanResult.pii_findings.length > 0) {
          return jsonResult({
            status: "quarantined",
            reason: "PII detected",
            pii_types: scanResult.pii_findings.map((f) => f.type),
          });
        }

        const cleanText = scanResult.sanitized_text;
        const title =
          args.title ?? cleanText.split("\n")[0].substring(0, 80);

        // Generate embedding (best-effort)
        let embedding: number[] | null = null;
        try {
          embedding = await ollama.embed(cleanText);
        } catch {
          // Will be null — backfill later with reindex_embeddings
        }

        const { rows } = await db.query(
          `INSERT INTO knowledge_items (domain, title, body, source_type, source_ref, created_by, tags, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            domain,
            title,
            cleanText,
            sourceType,
            args.source_ref ?? null,
            args.created_by ?? null,
            args.tags ?? [],
            embedding ? JSON.stringify(embedding) : null,
          ]
        );

        // Audit trail
        await db.query(
          `INSERT INTO inbox_log (original_text, classification, confidence, stored_item_id, source_type, source_ref, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [args.text, domain, 1.0, rows[0].id, sourceType, args.source_ref ?? null, args.created_by ?? null]
        );

        return jsonResult({
          status: "filed",
          domain,
          title,
          item_id: rows[0].id,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "capture_batch",
    "Ingest multiple items at once. Each item runs through the full capture pipeline independently.",
    {
      items: z
        .array(
          z.object({
            text: z.string(),
            source_type: z
              .enum(["manual", "outlook_email", "github_issue", "github_pr", "calendar_event", "rss_feed", "slack"])
              .optional(),
            source_ref: z.string().optional(),
          })
        )
        .min(1)
        .max(50)
        .describe("Array of items to capture (max 50)"),
      created_by: z.string().optional(),
    },
    async (args) => {
      try {
        const results = [];
        for (const item of args.items) {
          const sourceType = (item.source_type ?? "manual") as SourceType;
          const scanResult = scanContent(item.text);

          if (scanResult.pii_findings.length > 0) {
            results.push({ status: "quarantined", text_preview: item.text.substring(0, 50) });
            continue;
          }

          const cleanText = scanResult.sanitized_text;

          // Classify — Ollama with keyword fallback
          let classification;
          try {
            classification = await ollama.classify(cleanText);
          } catch {
            classification = classifyByKeyword(cleanText);
          }
          const review = needsReview(classification.confidence);

          // Embed (best-effort)
          let embedding: number[] | null = null;
          try {
            embedding = await ollama.embed(cleanText);
          } catch {
            // skip
          }

          let storedItemId: string | null = null;
          if (!review) {
            const { rows } = await db.query(
              `INSERT INTO knowledge_items (domain, title, body, source_type, source_ref, created_by, metadata, embedding)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
              [
                classification.domain,
                classification.title,
                cleanText,
                sourceType,
                item.source_ref ?? null,
                args.created_by ?? null,
                JSON.stringify(classification.extracted),
                embedding ? JSON.stringify(embedding) : null,
              ]
            );
            storedItemId = rows[0].id;
          }

          await db.query(
            `INSERT INTO inbox_log (original_text, classification, confidence, stored_item_id, source_type, source_ref, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              item.text,
              review ? "needs_review" : classification.domain,
              classification.confidence,
              storedItemId,
              sourceType,
              item.source_ref ?? null,
              args.created_by ?? null,
            ]
          );

          results.push({
            status: review ? "needs_review" : "filed",
            domain: classification.domain,
            confidence: classification.confidence,
            item_id: storedItemId,
          });
        }

        return jsonResult({
          total: args.items.length,
          filed: results.filter((r) => r.status === "filed").length,
          needs_review: results.filter((r) => r.status === "needs_review").length,
          quarantined: results.filter((r) => r.status === "quarantined").length,
          results,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
