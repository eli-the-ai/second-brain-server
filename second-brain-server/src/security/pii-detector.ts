import type { PiiFinding } from "../shared/types.js";

interface PiiPattern {
  type: string;
  pattern: RegExp;
  redactWith: string;
}

const PII_PATTERNS: PiiPattern[] = [
  {
    type: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    redactWith: "[SSN REDACTED]",
  },
  {
    type: "ssn_no_dash",
    pattern: /\b\d{9}\b/g,
    redactWith: "[SSN REDACTED]",
  },
  {
    type: "credit_card",
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    redactWith: "[CC REDACTED]",
  },
  {
    type: "student_id",
    // Common university student ID formats: 6-10 digit numbers prefixed with common patterns
    pattern: /\b(?:student[_\s-]?id|sid|id#?)\s*[:=]?\s*\d{6,10}\b/gi,
    redactWith: "[STUDENT ID REDACTED]",
  },
  {
    type: "api_key",
    // Common API key patterns: sk-, ghp_, xoxb-, etc.
    pattern:
      /\b(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|xoxb-[a-zA-Z0-9-]+|AKIA[A-Z0-9]{16})\b/g,
    redactWith: "[API KEY REDACTED]",
  },
  {
    type: "password",
    pattern:
      /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/gi,
    redactWith: "[PASSWORD REDACTED]",
  },
  {
    type: "email_address",
    // Only flag emails that look like student/personal emails in sensitive context
    pattern:
      /\b(?:student[_\s-]?email|personal[_\s-]?email)\s*[:=]?\s*[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/gi,
    redactWith: "[PERSONAL EMAIL REDACTED]",
  },
];

export function detectPii(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];

  for (const { type, pattern, redactWith } of PII_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      findings.push({
        type,
        match: match[0],
        redacted: redactWith,
        position: match.index,
      });
    }
  }

  return findings;
}

export function redactPii(text: string, findings: PiiFinding[]): string {
  let result = text;
  // Process from end to start so positions don't shift
  const sorted = [...findings].sort((a, b) => b.position - a.position);
  for (const finding of sorted) {
    result =
      result.substring(0, finding.position) +
      finding.redacted +
      result.substring(finding.position + finding.match.length);
  }
  return result;
}
