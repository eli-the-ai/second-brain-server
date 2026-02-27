export type Domain =
  | "projects"
  | "people"
  | "ideas"
  | "admin"
  | "ai_best_practices";

export type ItemStatus = "active" | "on_hold" | "completed" | "archived";

export type SourceType =
  | "manual"
  | "outlook_email"
  | "github_issue"
  | "github_pr"
  | "calendar_event"
  | "rss_feed"
  | "slack";

export interface KnowledgeItem {
  id: string;
  domain: Domain;
  title: string;
  body: string;
  status: ItemStatus;
  metadata: Record<string, unknown>;
  tags: string[];
  source_type: SourceType;
  source_ref: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface InboxLogEntry {
  id: string;
  original_text: string;
  classification: string;
  confidence: number;
  stored_item_id: string | null;
  review_notes: string | null;
  source_type: SourceType;
  source_ref: string | null;
  created_by: string | null;
  created_at: Date;
}

export interface ItemRelation {
  id: string;
  from_id: string;
  to_id: string;
  relation: "related" | "blocks" | "parent_of" | "references";
  created_at: Date;
}

export interface NotificationLogEntry {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  sent_at: Date;
}

export interface SecurityEvent {
  id: string;
  item_text: string;
  event_type: string;
  details: Record<string, unknown>;
  action_taken: string;
  created_at: Date;
}

export interface ClassificationResult {
  domain: Domain;
  confidence: number;
  title: string;
  extracted: Record<string, unknown>;
}

export interface SecurityScanResult {
  safe: boolean;
  pii_findings: PiiFinding[];
  injection_attempts: string[];
  policy_violations: string[];
  sanitized_text: string;
}

export interface PiiFinding {
  type: string;
  match: string;
  redacted: string;
  position: number;
}
