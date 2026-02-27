import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbPool } from "../db/client.js";
import type { OllamaClient } from "../ollama/client.js";
import { jsonResult, errorResult } from "../utils.js";
import {
  DOMAINS,
  MAX_NOTIFICATIONS_PER_DAY,
  DAILY_BRIEF_MAX_WORDS,
  WEEKLY_BRIEF_MAX_WORDS,
  NATE_JONES_HIGHLIGHT_WORDS,
} from "../shared/domains.js";

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function truncateToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "...";
}

async function checkNotificationCap(db: DbPool): Promise<{
  canSend: boolean;
  sentToday: number;
}> {
  const { rows } = await db.query(
    `SELECT COUNT(*) as count FROM notification_log WHERE sent_at >= CURRENT_DATE`
  );
  const sentToday = parseInt(rows[0].count, 10);
  return { canSend: sentToday < MAX_NOTIFICATIONS_PER_DAY, sentToday };
}

async function logNotification(
  db: DbPool,
  channel: string,
  digestType: string,
  wordCount: number
): Promise<void> {
  await db.query(
    `INSERT INTO notification_log (channel, digest_type, word_count) VALUES ($1, $2, $3)`,
    [channel, digestType, wordCount]
  );
}

export function registerDigestTools(
  server: McpServer,
  db: DbPool,
  ollama: OllamaClient
): void {
  server.tool(
    "generate_daily_digest",
    `Generate a structured daily brief (max ${DAILY_BRIEF_MAX_WORDS} words). Includes new items by domain, review queue status, and a ~${NATE_JONES_HIGHLIGHT_WORDS}-word Nate Jones highlight.`,
    {
      date: z
        .string()
        .optional()
        .describe("Date to generate digest for (ISO format, default: today)"),
    },
    async (args) => {
      try {
        const targetDate = args.date ?? new Date().toISOString().split("T")[0];
        const nextDay = new Date(
          new Date(targetDate).getTime() + 86400000
        )
          .toISOString()
          .split("T")[0];

        // New items today by domain
        const domainSummaries: Record<string, number> = {};
        for (const domain of DOMAINS) {
          const { rows } = await db.query(
            `SELECT COUNT(*) as count FROM knowledge_items
             WHERE domain = $1 AND created_at >= $2 AND created_at < $3`,
            [domain, targetDate, nextDay]
          );
          domainSummaries[domain] = parseInt(rows[0].count, 10);
        }

        // Review queue
        const { rows: reviewRows } = await db.query(
          `SELECT COUNT(*) as count FROM inbox_log
           WHERE classification = 'needs_review' AND stored_item_id IS NULL`
        );
        const reviewCount = parseInt(reviewRows[0].count, 10);

        // Recent items for summarization (top 10 by domain priority)
        const { rows: recentItems } = await db.query(
          `SELECT title, domain, source_type FROM knowledge_items
           WHERE created_at >= $1 AND created_at < $2
           ORDER BY created_at DESC LIMIT 10`,
          [targetDate, nextDay]
        );

        // Nate Jones content (most recent RSS from his feed)
        const { rows: nateContent } = await db.query(
          `SELECT title, body FROM knowledge_items
           WHERE source_type = 'rss_feed'
             AND (body ILIKE '%nate jones%' OR body ILIKE '%nate%newsletter%'
                  OR metadata::text ILIKE '%natesnewsletter%')
           ORDER BY created_at DESC LIMIT 1`
        );

        let nateHighlight = "No recent Nate Jones content available.";
        if (nateContent.length > 0) {
          try {
            nateHighlight = await ollama.summarize(
              `${nateContent[0].title}\n\n${nateContent[0].body}`,
              NATE_JONES_HIGHLIGHT_WORDS
            );
          } catch {
            nateHighlight = truncateToWords(
              `${nateContent[0].title}: ${nateContent[0].body}`,
              NATE_JONES_HIGHLIGHT_WORDS
            );
          }
        }

        // Build digest sections
        const sections: string[] = [];

        sections.push(`# Daily Brief — ${targetDate}`);
        sections.push("");

        // Domain summary
        sections.push("## New Items");
        for (const domain of DOMAINS) {
          if (domainSummaries[domain] > 0) {
            sections.push(`- **${domain}**: ${domainSummaries[domain]} new`);
          }
        }
        const totalNew = Object.values(domainSummaries).reduce((a, b) => a + b, 0);
        if (totalNew === 0) {
          sections.push("_No new items today._");
        }
        sections.push("");

        // Highlights
        if (recentItems.length > 0) {
          sections.push("## Highlights");
          for (const item of recentItems.slice(0, 5)) {
            sections.push(`- [${item.domain}] ${item.title}`);
          }
          sections.push("");
        }

        // Review queue
        if (reviewCount > 0) {
          sections.push(`## Review Queue`);
          sections.push(`${reviewCount} item(s) need review.`);
          sections.push("");
        }

        // Nate Jones section (required in every digest)
        sections.push("## Nate Jones Highlight");
        sections.push(nateHighlight);

        const digestBody = sections.join("\n");
        const wordCount = countWords(digestBody);

        // Try to summarize if over limit
        let finalDigest = digestBody;
        if (wordCount > DAILY_BRIEF_MAX_WORDS) {
          try {
            finalDigest = await ollama.summarize(digestBody, DAILY_BRIEF_MAX_WORDS);
          } catch {
            finalDigest = truncateToWords(digestBody, DAILY_BRIEF_MAX_WORDS);
          }
        }

        return jsonResult({
          type: "daily",
          date: targetDate,
          digest: finalDigest,
          word_count: countWords(finalDigest),
          max_words: DAILY_BRIEF_MAX_WORDS,
          stats: {
            new_items: totalNew,
            by_domain: domainSummaries,
            review_queue: reviewCount,
          },
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "generate_weekly_digest",
    `Generate a structured weekly summary (max ${WEEKLY_BRIEF_MAX_WORDS} words). Covers the past 7 days with trends, top items, and Nate Jones highlight.`,
    {
      end_date: z
        .string()
        .optional()
        .describe("End date of the week (ISO format, default: today). Digest covers 7 days ending on this date."),
    },
    async (args) => {
      try {
        const endDate = args.end_date ?? new Date().toISOString().split("T")[0];
        const startDate = new Date(
          new Date(endDate).getTime() - 7 * 86400000
        )
          .toISOString()
          .split("T")[0];

        // Items by domain this week
        const domainSummaries: Record<string, number> = {};
        for (const domain of DOMAINS) {
          const { rows } = await db.query(
            `SELECT COUNT(*) as count FROM knowledge_items
             WHERE domain = $1 AND created_at >= $2 AND created_at < $3`,
            [domain, startDate, endDate]
          );
          domainSummaries[domain] = parseInt(rows[0].count, 10);
        }

        // Top items by domain (most recent per domain)
        const { rows: topItems } = await db.query(
          `SELECT DISTINCT ON (domain) domain, title, source_type, created_at
           FROM knowledge_items
           WHERE created_at >= $1 AND created_at < $2
           ORDER BY domain, created_at DESC`,
          [startDate, endDate]
        );

        // Items completed/archived this week
        const { rows: completedRows } = await db.query(
          `SELECT COUNT(*) as count FROM knowledge_items
           WHERE status IN ('completed', 'archived') AND updated_at >= $1 AND updated_at < $2`,
          [startDate, endDate]
        );
        const completedCount = parseInt(completedRows[0].count, 10);

        // Security events this week
        const { rows: securityRows } = await db.query(
          `SELECT COUNT(*) as count FROM security_events
           WHERE created_at >= $1 AND created_at < $2`,
          [startDate, endDate]
        );
        const securityCount = parseInt(securityRows[0].count, 10);

        // Nate Jones content from the week
        const { rows: nateContent } = await db.query(
          `SELECT title, body FROM knowledge_items
           WHERE source_type = 'rss_feed'
             AND created_at >= $1 AND created_at < $2
             AND (body ILIKE '%nate jones%' OR body ILIKE '%nate%newsletter%'
                  OR metadata::text ILIKE '%natesnewsletter%')
           ORDER BY created_at DESC LIMIT 1`,
          [startDate, endDate]
        );

        let nateHighlight = "No Nate Jones content this week.";
        if (nateContent.length > 0) {
          try {
            nateHighlight = await ollama.summarize(
              `${nateContent[0].title}\n\n${nateContent[0].body}`,
              NATE_JONES_HIGHLIGHT_WORDS
            );
          } catch {
            nateHighlight = truncateToWords(
              `${nateContent[0].title}: ${nateContent[0].body}`,
              NATE_JONES_HIGHLIGHT_WORDS
            );
          }
        }

        // Build weekly digest
        const sections: string[] = [];
        sections.push(`# Weekly Summary — ${startDate} to ${endDate}`);
        sections.push("");

        const totalNew = Object.values(domainSummaries).reduce((a, b) => a + b, 0);
        sections.push(`## Overview`);
        sections.push(`${totalNew} new items captured. ${completedCount} items completed/archived.`);
        if (securityCount > 0) {
          sections.push(`${securityCount} security event(s) flagged.`);
        }
        sections.push("");

        sections.push("## By Domain");
        for (const domain of DOMAINS) {
          if (domainSummaries[domain] > 0) {
            const topItem = topItems.find((i: { domain: string }) => i.domain === domain);
            sections.push(
              `- **${domain}**: ${domainSummaries[domain]} items${topItem ? ` — latest: "${topItem.title}"` : ""}`
            );
          }
        }
        sections.push("");

        sections.push("## Nate Jones Highlight");
        sections.push(nateHighlight);

        const digestBody = sections.join("\n");
        let finalDigest = digestBody;
        if (countWords(digestBody) > WEEKLY_BRIEF_MAX_WORDS) {
          try {
            finalDigest = await ollama.summarize(digestBody, WEEKLY_BRIEF_MAX_WORDS);
          } catch {
            finalDigest = truncateToWords(digestBody, WEEKLY_BRIEF_MAX_WORDS);
          }
        }

        return jsonResult({
          type: "weekly",
          start_date: startDate,
          end_date: endDate,
          digest: finalDigest,
          word_count: countWords(finalDigest),
          max_words: WEEKLY_BRIEF_MAX_WORDS,
          stats: {
            new_items: totalNew,
            completed: completedCount,
            by_domain: domainSummaries,
            security_events: securityCount,
          },
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "send_digest_slack",
    "[DESTRUCTIVE] Send a digest to the Slack webhook. Enforces the daily notification cap. Requires confirm: true.",
    {
      digest: z.string().describe("The digest text to send"),
      digest_type: z
        .enum(["daily", "weekly"])
        .describe("Type of digest being sent"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to send. Omit to see preview."),
    },
    async (args) => {
      try {
        const { canSend, sentToday } = await checkNotificationCap(db);

        if (!args.confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `CONFIRMATION REQUIRED — send_digest_slack`,
                  ``,
                  `Digest type: ${args.digest_type}`,
                  `Word count: ${countWords(args.digest)}`,
                  `Notifications sent today: ${sentToday}/${MAX_NOTIFICATIONS_PER_DAY}`,
                  `Can send: ${canSend ? "yes" : "NO — daily cap reached"}`,
                  ``,
                  `Preview:`,
                  args.digest.substring(0, 300) + (args.digest.length > 300 ? "..." : ""),
                  ``,
                  `To proceed, call send_digest_slack again with confirm: true.`,
                ].join("\n"),
              },
            ],
          };
        }

        if (!canSend) {
          return errorResult(
            `Daily notification cap reached (${sentToday}/${MAX_NOTIFICATIONS_PER_DAY}). Try again tomorrow.`
          );
        }

        const webhookUrl = process.env.SLACK_WEBHOOK;
        if (!webhookUrl) {
          return errorResult("SLACK_WEBHOOK environment variable not set.");
        }

        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: args.digest,
            unfurl_links: false,
          }),
        });

        if (!response.ok) {
          return errorResult(`Slack webhook returned ${response.status}: ${await response.text()}`);
        }

        await logNotification(db, "slack", args.digest_type, countWords(args.digest));

        return jsonResult({
          status: "sent",
          channel: "slack",
          digest_type: args.digest_type,
          word_count: countWords(args.digest),
          notifications_today: sentToday + 1,
          cap: MAX_NOTIFICATIONS_PER_DAY,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "send_digest_email",
    "[DESTRUCTIVE] Prepare a digest email payload for delivery via Outlook MCP. Enforces the daily notification cap. Requires confirm: true.",
    {
      digest: z.string().describe("The digest text to send"),
      digest_type: z
        .enum(["daily", "weekly"])
        .describe("Type of digest being sent"),
      recipients: z
        .array(z.string())
        .describe("Email addresses to send to"),
      subject: z
        .string()
        .optional()
        .describe("Email subject (auto-generated if omitted)"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to send. Omit to see preview."),
    },
    async (args) => {
      try {
        const { canSend, sentToday } = await checkNotificationCap(db);

        const subject =
          args.subject ??
          `Second Brain ${args.digest_type === "daily" ? "Daily" : "Weekly"} Brief — ${new Date().toISOString().split("T")[0]}`;

        if (!args.confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `CONFIRMATION REQUIRED — send_digest_email`,
                  ``,
                  `Subject: ${subject}`,
                  `Recipients: ${args.recipients.join(", ")}`,
                  `Digest type: ${args.digest_type}`,
                  `Word count: ${countWords(args.digest)}`,
                  `Notifications sent today: ${sentToday}/${MAX_NOTIFICATIONS_PER_DAY}`,
                  `Can send: ${canSend ? "yes" : "NO — daily cap reached"}`,
                  ``,
                  `Preview:`,
                  args.digest.substring(0, 300) + (args.digest.length > 300 ? "..." : ""),
                  ``,
                  `To proceed, call send_digest_email again with confirm: true.`,
                  `Note: This returns the email payload. Use the Outlook MCP to actually send it.`,
                ].join("\n"),
              },
            ],
          };
        }

        if (!canSend) {
          return errorResult(
            `Daily notification cap reached (${sentToday}/${MAX_NOTIFICATIONS_PER_DAY}). Try again tomorrow.`
          );
        }

        await logNotification(db, "email", args.digest_type, countWords(args.digest));

        return jsonResult({
          status: "prepared",
          channel: "email",
          email_payload: {
            subject,
            body: args.digest,
            toRecipients: args.recipients,
            contentType: "text",
          },
          digest_type: args.digest_type,
          word_count: countWords(args.digest),
          notifications_today: sentToday + 1,
          cap: MAX_NOTIFICATIONS_PER_DAY,
          instructions:
            "Pass the email_payload to the Outlook MCP's send_email tool to deliver this digest.",
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
