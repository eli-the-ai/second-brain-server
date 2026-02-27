import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbPool } from "../db/client.js";
import type { OllamaClient } from "../ollama/client.js";
import { jsonResult, errorResult } from "../utils.js";
import { classifyByKeyword, needsReview } from "../shared/classification.js";
import { scanContent } from "../security/scanner.js";

async function ingestItem(
  db: DbPool,
  ollama: OllamaClient,
  text: string,
  title: string,
  sourceType: string,
  sourceRef: string | null,
  createdBy: string | null
): Promise<{
  status: string;
  domain?: string;
  confidence?: number;
  item_id?: string;
  reason?: string;
}> {
  // Dedup check
  if (sourceRef) {
    const { rows: existing } = await db.query(
      `SELECT id FROM knowledge_items WHERE source_ref = $1 LIMIT 1`,
      [sourceRef]
    );
    if (existing.length > 0) {
      return { status: "skipped", reason: "duplicate", item_id: existing[0].id };
    }
  }

  // Security scan
  const scan = scanContent(text);
  if (scan.pii_findings.length > 0) {
    await db.query(
      `INSERT INTO security_events (item_text, event_type, details, action_taken)
       VALUES ($1, $2, $3, $4)`,
      [text.substring(0, 500), "pii_detected", JSON.stringify({ findings: scan.pii_findings }), "quarantined"]
    );
    await db.query(
      `INSERT INTO inbox_log (original_text, classification, confidence, source_type, source_ref, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [text, "security_hold", 0, sourceType, sourceRef, createdBy]
    );
    return { status: "quarantined", reason: "PII detected" };
  }

  const cleanText = scan.sanitized_text;

  // Classify
  let classification;
  try {
    classification = await ollama.classify(cleanText);
  } catch {
    classification = classifyByKeyword(cleanText);
  }

  // Embed
  let embedding: number[] | null = null;
  try {
    embedding = await ollama.embed(cleanText);
  } catch {
    // skip
  }

  const review = needsReview(classification.confidence);
  let storedItemId: string | null = null;

  if (!review) {
    const { rows } = await db.query(
      `INSERT INTO knowledge_items (domain, title, body, source_type, source_ref, created_by, metadata, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        classification.domain,
        title.substring(0, 200),
        cleanText,
        sourceType,
        sourceRef,
        createdBy,
        JSON.stringify(classification.extracted),
        embedding ? JSON.stringify(embedding) : null,
      ]
    );
    storedItemId = rows[0].id;
  }

  await db.query(
    `INSERT INTO inbox_log (original_text, classification, confidence, stored_item_id, source_type, source_ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [text, review ? "needs_review" : classification.domain, classification.confidence, storedItemId, sourceType, sourceRef, createdBy]
  );

  return {
    status: review ? "needs_review" : "filed",
    domain: classification.domain,
    confidence: classification.confidence,
    item_id: storedItemId ?? undefined,
  };
}

export function registerIngestTools(
  server: McpServer,
  db: DbPool,
  ollama: OllamaClient,
  defaultUser: string | null
): void {
  server.tool(
    "ingest_email_summary",
    "Process an email summary (from Outlook/Gmail MCP) into the knowledge base. Deduplicates by message_id.",
    {
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text"),
      from: z.string().describe("Sender email address"),
      date: z.string().describe("Email date (ISO format)"),
      message_id: z.string().optional().describe("Unique message ID for deduplication"),
    },
    async (args) => {
      try {
        const text = `From: ${args.from}\nDate: ${args.date}\nSubject: ${args.subject}\n\n${args.body}`;
        const result = await ingestItem(db, ollama, text, args.subject, "outlook_email", args.message_id ?? null, defaultUser);
        return jsonResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "ingest_github_item",
    "Process a GitHub issue or PR summary into the knowledge base. Deduplicates by URL.",
    {
      title: z.string().describe("Issue/PR title"),
      body: z.string().describe("Issue/PR body text"),
      url: z.string().describe("GitHub URL (used for deduplication)"),
      item_type: z.enum(["issue", "pr"]).describe("Issue or pull request"),
      repo: z.string().describe("Repository name (owner/repo)"),
    },
    async (args) => {
      try {
        const text = `[${args.item_type.toUpperCase()}] ${args.repo}\n${args.title}\n\n${args.body}`;
        const sourceType = args.item_type === "issue" ? "github_issue" : "github_pr";
        const result = await ingestItem(db, ollama, text, args.title, sourceType, args.url, defaultUser);
        return jsonResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "ingest_calendar_event",
    "Process a calendar event into the knowledge base. Deduplicates by event summary + start time.",
    {
      summary: z.string().describe("Event title"),
      description: z.string().optional().describe("Event description"),
      start: z.string().describe("Start time (ISO format)"),
      end: z.string().describe("End time (ISO format)"),
      attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
    },
    async (args) => {
      try {
        const attendeeList = args.attendees?.join(", ") ?? "none";
        const text = `Event: ${args.summary}\nWhen: ${args.start} to ${args.end}\nAttendees: ${attendeeList}\n\n${args.description ?? ""}`;
        const sourceRef = `cal:${args.summary}:${args.start}`;
        const result = await ingestItem(db, ollama, text, args.summary, "calendar_event", sourceRef, defaultUser);
        return jsonResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "ingest_rss_entry",
    "Process an RSS feed entry into the knowledge base. Used for Nate Jones content and other feeds. Deduplicates by URL.",
    {
      title: z.string().describe("Article/post title"),
      body: z.string().describe("Article body or description"),
      url: z.string().describe("Article URL (used for deduplication)"),
      feed_name: z.string().describe("Name of the RSS feed source"),
      published: z.string().optional().describe("Publication date (ISO format)"),
    },
    async (args) => {
      try {
        const text = `[${args.feed_name}] ${args.title}\nPublished: ${args.published ?? "unknown"}\n\n${args.body}`;
        const result = await ingestItem(db, ollama, text, args.title, "rss_feed", args.url, defaultUser);
        return jsonResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
