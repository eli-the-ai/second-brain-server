import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

export function validateResourceId(id: string, label: string): string | null {
  if (/[/\\?#&]/.test(id)) {
    return `Invalid ${label}: contains forbidden characters`;
  }
  if (id.includes("..")) {
    return `Invalid ${label}: contains path traversal sequence`;
  }
  if (id.length === 0 || id.length > 500) {
    return `Invalid ${label}: must be 1–500 characters`;
  }
  return null;
}
