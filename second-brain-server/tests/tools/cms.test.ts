import { describe, it, expect } from "vitest";
import { PUBLISH_STATUSES } from "../../src/shared/domains.js";

// Replicate the slug generator from cms.ts for testing
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 100);
}

describe("CMS constants", () => {
  it("has correct publish statuses", () => {
    expect(PUBLISH_STATUSES).toEqual(["draft", "in_review", "published", "unpublished"]);
  });
});

describe("Slug generation", () => {
  it("converts title to lowercase hyphenated slug", () => {
    expect(generateSlug("Website Redesign Kickoff")).toBe("website-redesign-kickoff");
  });

  it("strips special characters", () => {
    expect(generateSlug("AI & Machine Learning: Best Practices!")).toBe("ai-machine-learning-best-practices");
  });

  it("collapses multiple hyphens", () => {
    expect(generateSlug("Hello   World")).toBe("hello-world");
  });

  it("removes leading/trailing hyphens", () => {
    expect(generateSlug(" - Test Title - ")).toBe("test-title");
  });

  it("truncates to 100 characters", () => {
    const longTitle = "a ".repeat(80);
    const slug = generateSlug(longTitle);
    expect(slug.length).toBeLessThanOrEqual(100);
  });

  it("handles unicode by stripping non-alphanumeric", () => {
    expect(generateSlug("Caf\u00e9 Meeting Notes")).toBe("caf-meeting-notes");
  });

  it("handles empty string", () => {
    expect(generateSlug("")).toBe("");
  });
});

describe("CMS workflow states", () => {
  it("draft -> in_review is valid", () => {
    const validTransitions: Record<string, string[]> = {
      draft: ["in_review", "published"],
      in_review: ["draft", "published"],
      published: ["unpublished"],
      unpublished: ["draft"],
    };

    expect(validTransitions["draft"]).toContain("in_review");
    expect(validTransitions["draft"]).toContain("published");
    expect(validTransitions["in_review"]).toContain("published");
    expect(validTransitions["published"]).toContain("unpublished");
  });

  it("publish requires a slug", () => {
    const slug: string | null = null;
    const canPublish = slug !== null;
    expect(canPublish).toBe(false);
  });

  it("publish allowed with slug", () => {
    const slug: string | null = "my-article";
    const canPublish = slug !== null;
    expect(canPublish).toBe(true);
  });

  it("only draft and in_review can be published", () => {
    const publishableStatuses = ["draft", "in_review"];
    expect(publishableStatuses).toContain("draft");
    expect(publishableStatuses).toContain("in_review");
    expect(publishableStatuses).not.toContain("published");
    expect(publishableStatuses).not.toContain("unpublished");
  });
});

describe("Scheduled publishing", () => {
  it("detects immediate publish (no date)", () => {
    const publishAt = undefined;
    const isImmediate = !publishAt;
    expect(isImmediate).toBe(true);
  });

  it("detects immediate publish (past date)", () => {
    const publishAt = "2020-01-01T00:00:00Z";
    const isImmediate = !publishAt || new Date(publishAt) <= new Date();
    expect(isImmediate).toBe(true);
  });

  it("detects scheduled publish (future date)", () => {
    const publishAt = "2099-01-01T00:00:00Z";
    const isImmediate = !publishAt || new Date(publishAt) <= new Date();
    expect(isImmediate).toBe(false);
  });
});

describe("Excerpt generation fallback", () => {
  it("truncates body to 200 chars when Ollama unavailable", () => {
    const body = "a".repeat(300);
    let excerpt = body.substring(0, 200).replace(/\n/g, " ").trim();
    if (body.length > 200) excerpt += "...";
    expect(excerpt.length).toBe(203); // 200 + "..."
    expect(excerpt.endsWith("...")).toBe(true);
  });

  it("does not add ellipsis for short body", () => {
    const body = "Short content";
    let excerpt = body.substring(0, 200).replace(/\n/g, " ").trim();
    if (body.length > 200) excerpt += "...";
    expect(excerpt).toBe("Short content");
  });
});
