import type { SecurityScanResult } from "../shared/types.js";
import { detectPii, redactPii } from "./pii-detector.js";
import { sanitizeInput } from "./sanitizer.js";

/**
 * Main security scan function.
 * Called by the capture pipeline before classification and storage.
 *
 * Pipeline: Source → Security scan → Classification → Storage
 */
export function scanContent(text: string): SecurityScanResult {
  // Step 1: Detect PII
  const piiFindings = detectPii(text);

  // Step 2: Sanitize input (HTML, SQL, prompt injection)
  const { text: sanitizedText, injectionAttempts } = sanitizeInput(text);

  // Step 3: Redact PII from the sanitized text
  const finalText =
    piiFindings.length > 0 ? redactPii(sanitizedText, piiFindings) : sanitizedText;

  // Item is safe if no PII found and no injection attempts
  const safe = piiFindings.length === 0 && injectionAttempts.length === 0;

  return {
    safe,
    pii_findings: piiFindings,
    injection_attempts: injectionAttempts,
    policy_violations: [],
    sanitized_text: finalText,
  };
}
