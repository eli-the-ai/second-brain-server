import { describe, it, expect } from "vitest";
import {
  classifyByKeyword,
  needsReview,
} from "../../src/shared/classification.js";

describe("Keyword Classifier", () => {
  it("classifies project-related text", () => {
    const result = classifyByKeyword(
      "The website redesign project has a deadline next Friday. We need to deploy the new homepage."
    );
    expect(result.domain).toBe("projects");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("classifies people-related text", () => {
    const result = classifyByKeyword(
      "Met with Sarah from admissions. Discussed with her about the enrollment page updates."
    );
    expect(result.domain).toBe("people");
  });

  it("classifies AI best practices text", () => {
    const result = classifyByKeyword(
      "New RAG pattern for embedding documents. Use nomic-embed-text model with Claude for better prompt responses."
    );
    expect(result.domain).toBe("ai_best_practices");
  });

  it("classifies admin text", () => {
    const result = classifyByKeyword(
      "Invoice from hosting provider. Payment due by end of month. Budget approval needed."
    );
    expect(result.domain).toBe("admin");
  });

  it("classifies ideas text", () => {
    const result = classifyByKeyword(
      "What if we could brainstorm a new concept for the student portal? Interesting idea to explore."
    );
    expect(result.domain).toBe("ideas");
  });

  it("falls back to ideas with low confidence for ambiguous text", () => {
    const result = classifyByKeyword("Hello world");
    expect(result.domain).toBe("ideas");
    expect(result.confidence).toBeLessThan(0.6);
  });

  it("extracts title from first line", () => {
    const result = classifyByKeyword("Short title\nMore details here about the project deadline.");
    expect(result.title).toBe("Short title");
  });

  it("truncates long titles", () => {
    const longLine =
      "This is a very long title that exceeds the maximum allowed length for a title field in the knowledge base system and should be truncated";
    const result = classifyByKeyword(longLine);
    expect(result.title.length).toBeLessThanOrEqual(80);
    expect(result.title).toContain("...");
  });
});

describe("needsReview", () => {
  it("returns true for low confidence", () => {
    expect(needsReview(0.3)).toBe(true);
    expect(needsReview(0.5)).toBe(true);
    expect(needsReview(0.59)).toBe(true);
  });

  it("returns false for high confidence", () => {
    expect(needsReview(0.6)).toBe(false);
    expect(needsReview(0.8)).toBe(false);
    expect(needsReview(1.0)).toBe(false);
  });
});
