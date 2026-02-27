import type { ClassificationResult, Domain } from "./types.js";
import { CONFIDENCE_THRESHOLD } from "./domains.js";

/**
 * Keyword-based fallback classifier.
 * Ported from the Python prototype's signal map.
 * Used when Ollama is unreachable.
 */
const SIGNAL_MAP: Record<Domain, RegExp> = {
  projects:
    /\b(project|build|launch|ship|deadline|milestone|sprint|deploy|release|feature|bug|ticket|task|deliverable|website|site|page|redesign|migration)\b/i,
  people:
    /\b(met with|talked with|spoke with|called|emailed|meeting with|conversation with|discussed with|follow up with|check in with|introduced to|team member|colleague|contact)\b/i,
  ideas:
    /\b(idea|thought|concept|what if|imagine|explore|brainstorm|hypothesis|prototype|experiment|could we|might be|interesting|research)\b/i,
  admin:
    /\b(bill|invoice|receipt|payment|tax|legal|compliance|budget|expense|purchase|license|renewal|contract|policy|schedule|logistics|approval)\b/i,
  ai_best_practices:
    /\b(prompt|model|LLM|fine.?tune|embedding|RAG|vector|agent|agentic|Claude|GPT|Ollama|MCP|token|inference|AI|machine learning|neural|transformer|training|benchmark)\b/i,
};

/** Weights for tiebreaking — higher = checked last (lower priority) */
const DOMAIN_PRIORITY: Record<Domain, number> = {
  projects: 1,
  people: 2,
  ai_best_practices: 3,
  ideas: 4,
  admin: 5,
};

export function classifyByKeyword(text: string): ClassificationResult {
  const scores: { domain: Domain; count: number }[] = [];

  for (const [domain, pattern] of Object.entries(SIGNAL_MAP) as [
    Domain,
    RegExp,
  ][]) {
    const matches = text.match(new RegExp(pattern, "gi"));
    if (matches) {
      scores.push({ domain, count: matches.length });
    }
  }

  if (scores.length === 0) {
    return {
      domain: "ideas",
      confidence: 0.3,
      title: extractTitle(text),
      extracted: {},
    };
  }

  // Sort by match count (desc), then by priority (asc) for ties
  scores.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return DOMAIN_PRIORITY[a.domain] - DOMAIN_PRIORITY[b.domain];
  });

  const best = scores[0];
  const totalMatches = scores.reduce((sum, s) => sum + s.count, 0);
  const confidence = Math.min(0.9, best.count / Math.max(totalMatches, 1));

  return {
    domain: best.domain,
    confidence,
    title: extractTitle(text),
    extracted: {},
  };
}

function extractTitle(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length <= 80) return firstLine;
  return firstLine.substring(0, 77) + "...";
}

export function needsReview(confidence: number): boolean {
  return confidence < CONFIDENCE_THRESHOLD;
}
