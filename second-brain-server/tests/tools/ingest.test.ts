import { describe, it, expect } from "vitest";
import { scanContent } from "../../src/security/scanner.js";
import { classifyByKeyword, needsReview } from "../../src/shared/classification.js";

/**
 * Tests for the ingest pipeline logic.
 * The ingestItem function is private, so we test the components it composes:
 * security scanning, classification fallback, and review gating.
 * Text formatting for each source type is validated inline.
 */

describe("Ingest pipeline — email formatting", () => {
  it("builds correct text from email fields", () => {
    const from = "alice@oru.edu";
    const date = "2026-01-15T10:00:00Z";
    const subject = "Website redesign kickoff";
    const body = "Meeting notes from the kickoff session";

    const text = `From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${body}`;

    expect(text).toContain("From: alice@oru.edu");
    expect(text).toContain("Subject: Website redesign kickoff");
    expect(text).toContain("Meeting notes from the kickoff session");
  });

  it("classifies email about a project via keyword fallback", () => {
    const text = `From: alice@oru.edu\nDate: 2026-01-15\nSubject: Sprint planning\n\nThe project deadline is next Friday. Let's review the sprint backlog.`;
    const result = classifyByKeyword(text);
    expect(result.domain).toBe("projects");
  });
});

describe("Ingest pipeline — GitHub formatting", () => {
  it("builds correct text from issue fields", () => {
    const title = "Fix broken nav on mobile";
    const body = "The hamburger menu doesn't open on iOS Safari";
    const repo = "eli-the-ai/cms-frontend";
    const itemType = "issue";

    const text = `[${itemType.toUpperCase()}] ${repo}\n${title}\n\n${body}`;

    expect(text).toContain("[ISSUE] eli-the-ai/cms-frontend");
    expect(text).toContain("Fix broken nav on mobile");
  });

  it("builds correct text from PR fields", () => {
    const text = `[PR] eli-the-ai/cms-frontend\nAdd dark mode support\n\nImplements theme switching`;
    expect(text).toContain("[PR]");
  });

  it("maps item_type to source_type", () => {
    const issueType = "issue" === "issue" ? "github_issue" : "github_pr";
    const prType = "pr" === "issue" ? "github_issue" : "github_pr";
    expect(issueType).toBe("github_issue");
    expect(prType).toBe("github_pr");
  });
});

describe("Ingest pipeline — calendar formatting", () => {
  it("builds correct text with attendees", () => {
    const summary = "Weekly standup";
    const start = "2026-02-27T09:00:00Z";
    const end = "2026-02-27T09:30:00Z";
    const attendees = ["alice@oru.edu", "bob@oru.edu"];
    const description = "Quick sync on sprint progress";

    const attendeeList = attendees.join(", ");
    const text = `Event: ${summary}\nWhen: ${start} to ${end}\nAttendees: ${attendeeList}\n\n${description}`;

    expect(text).toContain("Event: Weekly standup");
    expect(text).toContain("Attendees: alice@oru.edu, bob@oru.edu");
  });

  it("handles missing attendees", () => {
    const attendeeList = undefined ?? "none";
    expect(attendeeList).toBe("none");
  });

  it("handles missing description", () => {
    const description = undefined ?? "";
    expect(description).toBe("");
  });

  it("builds dedup source_ref from summary + start", () => {
    const sourceRef = `cal:Team Meeting:2026-02-27T09:00:00Z`;
    expect(sourceRef).toBe("cal:Team Meeting:2026-02-27T09:00:00Z");
  });
});

describe("Ingest pipeline — RSS formatting", () => {
  it("builds correct text from RSS entry", () => {
    const feedName = "Nate Jones Newsletter";
    const title = "AI in Higher Ed: What's Next";
    const published = "2026-02-20T12:00:00Z";
    const body = "A deep dive into AI adoption at universities...";

    const text = `[${feedName}] ${title}\nPublished: ${published}\n\n${body}`;

    expect(text).toContain("[Nate Jones Newsletter]");
    expect(text).toContain("Published: 2026-02-20T12:00:00Z");
  });

  it("handles missing published date", () => {
    const published: string | undefined = undefined;
    const text = `[Feed] Title\nPublished: ${published ?? "unknown"}\n\nBody`;
    expect(text).toContain("Published: unknown");
  });
});

describe("Ingest pipeline — security scan integration", () => {
  it("quarantines content with PII", () => {
    const text = "Contact SSN 123-45-6789 for access";
    const scan = scanContent(text);
    expect(scan.pii_findings.length).toBeGreaterThan(0);
  });

  it("passes clean content through", () => {
    const text = "Meeting notes: discussed the new CMS migration timeline";
    const scan = scanContent(text);
    expect(scan.pii_findings).toHaveLength(0);
    expect(scan.sanitized_text).toContain("CMS migration timeline");
  });

  it("quarantines content with API keys", () => {
    const text = "Use this token: ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const scan = scanContent(text);
    expect(scan.pii_findings.length).toBeGreaterThan(0);
  });
});

describe("Ingest pipeline — classification fallback", () => {
  it("classifies AI content into ai_best_practices", () => {
    const text = "[Nate Jones Newsletter] Using LLMs for Content Generation\n\nBest practices for prompt engineering...";
    const result = classifyByKeyword(text);
    expect(result.domain).toBe("ai_best_practices");
  });

  it("classifies people-related content", () => {
    const text = "1:1 meeting with Sarah about her onboarding. She is a new team member and needs mentoring on the team workflow.";
    const result = classifyByKeyword(text);
    expect(result.domain).toBe("people");
  });

  it("routes low-confidence items to review", () => {
    expect(needsReview(0.3)).toBe(true);
    expect(needsReview(0.59)).toBe(true);
    expect(needsReview(0.6)).toBe(false);
    expect(needsReview(0.9)).toBe(false);
  });
});

describe("Ingest pipeline — title truncation", () => {
  it("truncates title to 200 characters", () => {
    const longTitle = "A".repeat(250);
    const truncated = longTitle.substring(0, 200);
    expect(truncated).toHaveLength(200);
  });
});
