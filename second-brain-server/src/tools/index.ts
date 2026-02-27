import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DbPool } from "../db/client.js";
import type { OllamaClient } from "../ollama/client.js";
import { registerCaptureTools } from "./capture.js";
import { registerKnowledgeTools } from "./knowledge.js";
import { registerSearchTools } from "./search.js";
import { registerReviewTools } from "./review.js";
import { registerSecurityTools } from "./security.js";
import { registerAdminTools } from "./admin.js";
import { registerIngestTools } from "./ingest.js";

export function registerAllTools(
  server: McpServer,
  db: DbPool,
  ollama: OllamaClient
): void {
  registerCaptureTools(server, db, ollama);
  registerKnowledgeTools(server, db, ollama);
  registerSearchTools(server, db, ollama);
  registerReviewTools(server, db, ollama);
  registerSecurityTools(server, db);
  registerAdminTools(server, db, ollama);
  registerIngestTools(server, db, ollama);
}
