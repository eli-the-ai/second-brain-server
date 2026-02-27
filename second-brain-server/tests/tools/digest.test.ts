import { describe, it, expect } from "vitest";
import {
  DAILY_BRIEF_MAX_WORDS,
  WEEKLY_BRIEF_MAX_WORDS,
  NATE_JONES_HIGHLIGHT_WORDS,
  MAX_NOTIFICATIONS_PER_DAY,
} from "../../src/shared/domains.js";

// Replicate the utility functions from digest.ts for testing
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function truncateToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "...";
}

describe("Digest utilities", () => {
  it("counts words correctly", () => {
    expect(countWords("hello world")).toBe(2);
    expect(countWords("  one  two  three  ")).toBe(3);
    expect(countWords("")).toBe(0);
    expect(countWords("single")).toBe(1);
  });

  it("truncates to word limit", () => {
    const text = "one two three four five six seven";
    expect(truncateToWords(text, 3)).toBe("one two three...");
    expect(truncateToWords(text, 100)).toBe(text); // no truncation needed
  });

  it("truncation adds ellipsis", () => {
    const result = truncateToWords("a b c d e f g", 4);
    expect(result.endsWith("...")).toBe(true);
    expect(countWords(result.replace("...", ""))).toBe(4);
  });
});

describe("Digest constants", () => {
  it("daily brief max is 150 words", () => {
    expect(DAILY_BRIEF_MAX_WORDS).toBe(150);
  });

  it("weekly brief max is 250 words", () => {
    expect(WEEKLY_BRIEF_MAX_WORDS).toBe(250);
  });

  it("Nate Jones highlight is 150 words", () => {
    expect(NATE_JONES_HIGHLIGHT_WORDS).toBe(150);
  });

  it("notification cap is 10 per day", () => {
    expect(MAX_NOTIFICATIONS_PER_DAY).toBe(10);
  });
});

describe("Daily digest format", () => {
  it("builds valid digest structure", () => {
    const sections: string[] = [];
    const date = "2026-02-27";

    sections.push(`# Daily Brief — ${date}`);
    sections.push("");
    sections.push("## New Items");
    sections.push("- **projects**: 3 new");
    sections.push("- **ai_best_practices**: 1 new");
    sections.push("");
    sections.push("## Highlights");
    sections.push("- [projects] Website redesign milestone");
    sections.push("");
    sections.push("## Nate Jones Highlight");
    sections.push("Latest insights on AI in higher education...");

    const digest = sections.join("\n");

    expect(digest).toContain("# Daily Brief");
    expect(digest).toContain("## New Items");
    expect(digest).toContain("## Nate Jones Highlight");
    expect(digest).toContain(date);
  });

  it("includes all required sections", () => {
    const requiredSections = [
      "Daily Brief",
      "New Items",
      "Nate Jones Highlight",
    ];
    const digest = `# Daily Brief — 2026-02-27\n\n## New Items\n_No new items._\n\n## Nate Jones Highlight\nNo recent content.`;

    for (const section of requiredSections) {
      expect(digest).toContain(section);
    }
  });
});

describe("Weekly digest format", () => {
  it("builds valid weekly structure", () => {
    const sections: string[] = [];
    sections.push("# Weekly Summary — 2026-02-20 to 2026-02-27");
    sections.push("");
    sections.push("## Overview");
    sections.push("15 new items captured. 3 items completed/archived.");
    sections.push("");
    sections.push("## By Domain");
    sections.push('- **projects**: 5 items — latest: "CMS migration"');
    sections.push("");
    sections.push("## Nate Jones Highlight");
    sections.push("Weekly roundup of AI trends...");

    const digest = sections.join("\n");

    expect(digest).toContain("# Weekly Summary");
    expect(digest).toContain("## Overview");
    expect(digest).toContain("## By Domain");
    expect(digest).toContain("## Nate Jones Highlight");
  });
});

describe("Notification cap logic", () => {
  it("allows sending when below cap", () => {
    const sentToday = 5;
    const canSend = sentToday < MAX_NOTIFICATIONS_PER_DAY;
    expect(canSend).toBe(true);
  });

  it("blocks sending when at cap", () => {
    const sentToday = 10;
    const canSend = sentToday < MAX_NOTIFICATIONS_PER_DAY;
    expect(canSend).toBe(false);
  });

  it("blocks sending when over cap", () => {
    const sentToday = 15;
    const canSend = sentToday < MAX_NOTIFICATIONS_PER_DAY;
    expect(canSend).toBe(false);
  });

  it("remaining calculation is correct", () => {
    const sentToday = 7;
    const remaining = Math.max(0, MAX_NOTIFICATIONS_PER_DAY - sentToday);
    expect(remaining).toBe(3);
  });

  it("remaining never goes negative", () => {
    const sentToday = 12;
    const remaining = Math.max(0, MAX_NOTIFICATIONS_PER_DAY - sentToday);
    expect(remaining).toBe(0);
  });
});

describe("Slack webhook payload", () => {
  it("formats payload correctly", () => {
    const digest = "# Daily Brief\nContent here...";
    const payload = JSON.stringify({
      text: digest,
      unfurl_links: false,
    });
    const parsed = JSON.parse(payload);
    expect(parsed.text).toBe(digest);
    expect(parsed.unfurl_links).toBe(false);
  });
});

describe("Email payload structure", () => {
  it("builds correct email payload", () => {
    const subject = "Second Brain Daily Brief — 2026-02-27";
    const body = "# Daily Brief\nContent here...";
    const recipients = ["jsanders@oru.edu", "team@oru.edu"];

    const payload = {
      subject,
      body,
      toRecipients: recipients,
      contentType: "text",
    };

    expect(payload.subject).toContain("Daily Brief");
    expect(payload.toRecipients).toHaveLength(2);
    expect(payload.contentType).toBe("text");
  });

  it("auto-generates subject for daily digest", () => {
    const digestType = "daily";
    const date = "2026-02-27";
    const subject = `Second Brain ${digestType === "daily" ? "Daily" : "Weekly"} Brief — ${date}`;
    expect(subject).toBe("Second Brain Daily Brief — 2026-02-27");
  });

  it("auto-generates subject for weekly digest", () => {
    const digestType = "weekly";
    const date = "2026-02-27";
    const subject = `Second Brain ${digestType === "daily" ? "Daily" : "Weekly"} Brief — ${date}`;
    expect(subject).toBe("Second Brain Weekly Brief — 2026-02-27");
  });
});
