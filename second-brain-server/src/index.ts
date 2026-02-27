#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDbPool } from "./db/client.js";
import { createOllamaClient } from "./ollama/client.js";
import { registerAllTools } from "./tools/index.js";

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("Error: DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const embeddingModel =
    process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";
  const chatModel = process.env.OLLAMA_CHAT_MODEL || "llama3.2";

  const db = createDbPool(dbUrl);
  const ollama = createOllamaClient({
    baseUrl: ollamaUrl,
    embeddingModel,
    chatModel,
    timeoutMs: 30000,
  });

  const server = new McpServer(
    {
      name: "second-brain-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const brainUser = process.env.BRAIN_USER || null;
  if (brainUser) {
    console.error(`Authenticated as: ${brainUser}`);
  }

  registerAllTools(server, db, ollama, brainUser);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await db.end();
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(
    "Server error:",
    error instanceof Error ? error.message : "Unknown error"
  );
  process.exit(1);
});
