import type { ClassificationResult, Domain } from "../shared/types.js";
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  classificationPrompt,
  SUMMARIZATION_SYSTEM_PROMPT,
  summarizationPrompt,
} from "./prompts.js";

const VALID_DOMAINS: Domain[] = [
  "projects",
  "people",
  "ideas",
  "admin",
  "ai_best_practices",
];

export interface OllamaConfig {
  baseUrl: string;
  embeddingModel: string;
  chatModel: string;
  timeoutMs: number;
}

export class OllamaClient {
  constructor(private config: OllamaConfig) {}

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.config.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.embeddingModel,
        input: text,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed error: ${response.status}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  async classify(text: string): Promise<ClassificationResult> {
    const raw = await this.generate(
      classificationPrompt(text),
      CLASSIFICATION_SYSTEM_PROMPT
    );

    // Extract JSON from the response (Ollama may wrap it in markdown)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Ollama classification returned non-JSON response");
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      domain?: string;
      confidence?: number;
      title?: string;
      extracted?: Record<string, unknown>;
    };

    // Validate domain
    const domain = parsed.domain as Domain;
    if (!VALID_DOMAINS.includes(domain)) {
      throw new Error(`Ollama returned invalid domain: ${parsed.domain}`);
    }

    return {
      domain,
      confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
      title: (parsed.title ?? text.split("\n")[0]).substring(0, 80),
      extracted: parsed.extracted ?? {},
    };
  }

  async summarize(text: string, maxWords: number): Promise<string> {
    return this.generate(
      summarizationPrompt(text, maxWords),
      SUMMARIZATION_SYSTEM_PROMPT
    );
  }

  async generate(prompt: string, system?: string): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.chatModel,
        prompt,
        system,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Ollama generate error: ${response.status}`);
    }

    const data = (await response.json()) as { response: string };
    return data.response;
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export function createOllamaClient(config: OllamaConfig): OllamaClient {
  return new OllamaClient(config);
}
