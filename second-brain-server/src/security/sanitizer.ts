/**
 * Input sanitization for content entering the knowledge base.
 * Strips injection attempts and dangerous content.
 */

const HTML_TAG_PATTERN = /<\/?[^>]+(>|$)/g;
const SCRIPT_PATTERN = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const EVENT_HANDLER_PATTERN = /\bon\w+\s*=\s*["'][^"']*["']/gi;
const SQL_INJECTION_PATTERNS = [
  /('|"|;)\s*(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|EXEC)\b/gi,
  /\bOR\s+1\s*=\s*1\b/gi,
  /\bUNION\s+SELECT\b/gi,
  /--\s*$/gm,
];

const PROMPT_INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)\b/gi,
  /\byou\s+are\s+now\b/gi,
  /\bsystem\s*:\s*/gi,
  /\b(jailbreak|DAN|do anything now)\b/gi,
  /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/g,
];

export interface SanitizationResult {
  text: string;
  injectionAttempts: string[];
}

export function sanitizeInput(text: string): SanitizationResult {
  const injectionAttempts: string[] = [];
  let sanitized = text;

  // Check for script tags
  if (SCRIPT_PATTERN.test(sanitized)) {
    injectionAttempts.push("script_tag");
    sanitized = sanitized.replace(SCRIPT_PATTERN, "[SCRIPT REMOVED]");
  }

  // Check for event handlers
  if (EVENT_HANDLER_PATTERN.test(sanitized)) {
    injectionAttempts.push("event_handler");
    sanitized = sanitized.replace(EVENT_HANDLER_PATTERN, "");
  }

  // Strip remaining HTML tags but keep content
  sanitized = sanitized.replace(HTML_TAG_PATTERN, "");

  // Check for SQL injection patterns
  for (const pattern of SQL_INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      injectionAttempts.push("sql_injection");
      break;
    }
  }

  // Check for prompt injection patterns
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      injectionAttempts.push("prompt_injection");
      break;
    }
  }

  return { text: sanitized, injectionAttempts };
}
