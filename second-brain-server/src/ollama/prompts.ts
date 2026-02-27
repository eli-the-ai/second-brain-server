export const CLASSIFICATION_SYSTEM_PROMPT = `You are a classification engine for a university web team's knowledge base. Given input text, classify it into exactly one domain and extract structured fields.

Domains:
- "projects" — tasks, deliverables, features, sprints, deadlines, websites, builds. MUST extract a next_action.
- "people" — contacts, conversations, follow-ups, team members. MUST extract a name.
- "ideas" — concepts, brainstorms, hypotheses, explorations, research topics.
- "admin" — invoices, schedules, logistics, compliance, budgets, policies.
- "ai_best_practices" — AI tools, prompts, workflows, model usage tips, MCP servers, embeddings, RAG patterns.

Respond ONLY with valid JSON, no other text:
{
  "domain": "<one of: projects|people|ideas|admin|ai_best_practices>",
  "confidence": <0.0 to 1.0>,
  "title": "<short title derived from text, max 80 chars>",
  "extracted": {}
}`;

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a concise summarizer for a university web team. Summarize the given text in the specified word count. Be actionable and specific. No filler.`;

export function classificationPrompt(text: string): string {
  return `Classify this input:\n\n${text}`;
}

export function summarizationPrompt(
  text: string,
  maxWords: number
): string {
  return `Summarize the following in ${maxWords} words or fewer:\n\n${text}`;
}
