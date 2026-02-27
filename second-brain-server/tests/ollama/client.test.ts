import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaClient } from "../../src/ollama/client.js";

const TEST_CONFIG = {
  baseUrl: "http://localhost:11434",
  embeddingModel: "nomic-embed-text",
  chatModel: "llama3.2",
  timeoutMs: 5000,
};

describe("OllamaClient", () => {
  let client: OllamaClient;

  beforeEach(() => {
    client = new OllamaClient(TEST_CONFIG);
    vi.restoreAllMocks();
  });

  describe("embed", () => {
    it("returns embedding vector from Ollama API", async () => {
      const fakeEmbedding = Array.from({ length: 768 }, (_, i) => i * 0.001);
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ embeddings: [fakeEmbedding] }), {
          status: 200,
        })
      );

      const result = await client.embed("test text");
      expect(result).toHaveLength(768);
      expect(result[0]).toBe(0);
      expect(result[1]).toBeCloseTo(0.001);
    });

    it("sends correct request body", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ embeddings: [[0.1]] }), { status: 200 })
      );

      await client.embed("hello world");

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:11434/api/embed",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            model: "nomic-embed-text",
            input: "hello world",
          }),
        })
      );
    });

    it("throws on non-200 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("error", { status: 500 })
      );

      await expect(client.embed("test")).rejects.toThrow("Ollama embed error: 500");
    });
  });

  describe("embedBatch", () => {
    it("returns embeddings for multiple texts", async () => {
      const fakeEmbed = [0.1, 0.2, 0.3];
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      // Each call needs its own Response (body can only be read once)
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ embeddings: [fakeEmbed] }), { status: 200 })
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ embeddings: [fakeEmbed] }), { status: 200 })
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ embeddings: [fakeEmbed] }), { status: 200 })
      );

      const results = await client.embedBatch(["text1", "text2", "text3"]);
      expect(results).toHaveLength(3);
      expect(results[0]).toEqual(fakeEmbed);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe("classify", () => {
    it("parses valid classification JSON", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            response: JSON.stringify({
              domain: "projects",
              confidence: 0.85,
              title: "Website redesign deadline",
              extracted: { next_action: "review mockups" },
            }),
          }),
          { status: 200 }
        )
      );

      const result = await client.classify("Website redesign deadline is Friday");
      expect(result.domain).toBe("projects");
      expect(result.confidence).toBe(0.85);
      expect(result.title).toBe("Website redesign deadline");
      expect(result.extracted).toEqual({ next_action: "review mockups" });
    });

    it("extracts JSON from markdown-wrapped response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            response:
              '```json\n{"domain": "people", "confidence": 0.7, "title": "Meeting with Sarah", "extracted": {}}\n```',
          }),
          { status: 200 }
        )
      );

      const result = await client.classify("Met with Sarah about enrollment page");
      expect(result.domain).toBe("people");
      expect(result.confidence).toBe(0.7);
    });

    it("throws on invalid domain", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            response: JSON.stringify({
              domain: "invalid_domain",
              confidence: 0.9,
              title: "Test",
              extracted: {},
            }),
          }),
          { status: 200 }
        )
      );

      await expect(
        client.classify("test text")
      ).rejects.toThrow("invalid domain");
    });

    it("throws on non-JSON response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ response: "I cannot classify this text." }),
          { status: 200 }
        )
      );

      await expect(
        client.classify("test text")
      ).rejects.toThrow("non-JSON response");
    });

    it("clamps confidence to 0-1 range", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            response: JSON.stringify({
              domain: "ideas",
              confidence: 1.5,
              title: "Clamped",
              extracted: {},
            }),
          }),
          { status: 200 }
        )
      );

      const result = await client.classify("test");
      expect(result.confidence).toBe(1);
    });
  });

  describe("summarize", () => {
    it("returns summary text", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ response: "This is a concise summary." }),
          { status: 200 }
        )
      );

      const result = await client.summarize("Long text here...", 50);
      expect(result).toBe("This is a concise summary.");
    });
  });

  describe("ping", () => {
    it("returns true when Ollama is reachable", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [] }), { status: 200 })
      );

      const result = await client.ping();
      expect(result).toBe(true);
    });

    it("returns false when Ollama is unreachable", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("Connection refused")
      );

      const result = await client.ping();
      expect(result).toBe(false);
    });

    it("returns false on non-200 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("error", { status: 500 })
      );

      const result = await client.ping();
      expect(result).toBe(false);
    });
  });
});
