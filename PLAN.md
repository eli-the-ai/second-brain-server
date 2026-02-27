# Second Brain MCP Server — Implementation Plan

## Context

The ORU web team (2-5 people) needs a "second brain" to capture, classify, and surface knowledge across projects, people, AI best practices, and admin. The existing Python prototype (`/Documents/task-management`) proved the concept — now we're building the production version as a TypeScript MCP server backed by PostgreSQL + pgvector on a VPN with Ollama for local AI.

This is the foundation for the team's future self-hosted AI-operated CMS.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  SOURCES                                                │
│  Outlook · GitHub · Calendar · Gmail · RSS · Manual     │
└───────────────┬─────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────┐
│  second-brain-server (MCP over stdio)                   │
│  24 tools · TypeScript · follows existing MCP patterns  │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Capture  │  │ Search   │  │ Digest   │              │
│  │ + Ingest │  │ (hybrid) │  │ + Report │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       │              │              │                    │
│  ┌────▼──────────────▼──────────────▼────┐              │
│  │  PostgreSQL + pgvector (on VPN)       │              │
│  │  Ollama (embeddings + classification) │              │
│  └───────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────┘
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
  Slack     Outlook     Web Dashboard
  webhook   email       (Express app)
```

**4 Claude Code Agents** orchestrate the tools:
- **Intake Agent** — monitors sources, feeds content in
- **Security Agent** — validates content inline before it enters the knowledge base
- **Triage Agent** — reviews low-confidence items
- **Reporting Agent** — generates and delivers digests

---

## Project Structure

```
second-brain-server/
├── src/
│   ├── index.ts                    # MCP entry point (same pattern as mcp-github-server)
│   ├── utils.ts                    # jsonResult, errorResult (copy from existing)
│   ├── db/
│   │   ├── client.ts               # pg Pool + connection validation
│   │   ├── migrate.ts              # SQL migration runner
│   │   └── migrations/
│   │       ├── 001_core_tables.sql
│   │       ├── 002_pgvector.sql
│   │       └── 003_fulltext.sql
│   ├── ollama/
│   │   ├── client.ts               # HTTP client (embed, classify, summarize)
│   │   └── prompts.ts              # Classification/summarization prompt templates
│   ├── security/
│   │   ├── scanner.ts              # Main scan function (called by capture pipeline)
│   │   ├── pii-detector.ts         # PII pattern matching (SSN, student IDs, credentials)
│   │   ├── sanitizer.ts            # Input cleaning (HTML, injection prevention)
│   │   └── allowlists.ts           # Configurable source allowlists
│   ├── shared/
│   │   ├── types.ts                # TypeScript interfaces
│   │   ├── domains.ts              # Domain enum, constants, confidence threshold
│   │   └── classification.ts       # Keyword fallback classifier (ported from Python)
│   └── tools/
│       ├── index.ts                # registerAllTools(server, db, ollama)
│       ├── capture.ts              # capture_thought, capture_with_domain, capture_batch
│       ├── knowledge.ts            # list_items, get_item, update_item, delete_item, relate/unrelate
│       ├── search.ts               # search_semantic, search_keyword, search_hybrid, find_related
│       ├── review.ts               # list_needs_review, fix_classification, dismiss_review, inbox_stats
│       ├── digest.ts               # generate_daily/weekly_digest, send_digest_slack/email
│       ├── ingest.ts               # ingest_email/github/calendar/rss
│       └── admin.ts                # system_stats, reindex_embeddings, notification_status
├── dashboard/                      # Separate Express web app (shares DB)
│   └── src/
│       ├── server.ts
│       ├── routes/ (api, views, webhooks)
│       ├── templates/ (EJS)
│       └── static/
├── agents/                         # Claude Code prompt files (4 runtime + 1 dev-time)
│   ├── intake-agent.md             # Runtime: monitors sources, feeds content in
│   ├── security-agent.md           # Runtime: periodic audits + quarantine review
│   ├── triage-agent.md             # Runtime: reviews low-confidence items
│   ├── reporting-agent.md          # Runtime: generates and delivers digests
│   └── testing-agent.md            # Dev-time: validates tools, classification, search quality
├── tests/
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Database Schema (PostgreSQL + pgvector)

**5 domains** (extended from Python's 4 buckets): `projects`, `people`, `ideas`, `admin`, `ai_best_practices`

### Core Tables

- **`knowledge_items`** — Unified content table with `domain` enum, `title`, `body`, `status`, `tags[]`, `metadata` JSONB (domain-specific fields), `source_type`, `source_ref`, `embedding vector(768)`, full-text `tsvector`
- **`inbox_log`** — Audit trail: original text, classification, confidence score, link to stored item
- **`item_relations`** — Cross-domain links (related, blocks, parent_of, references)
- **`notification_log`** — Tracks Slack/email sends, enforces 10/day cap

### Key Design Decisions
- Unified table (not per-domain) — simpler queries, easier CMS evolution
- 768-dim vectors match `nomic-embed-text` (Ollama)
- HNSW index for fast approximate nearest-neighbor search
- JSONB `metadata` holds domain-specific fields (Projects get `next_action`, People get `contact_info`, etc.)

---

## Security Agent (inline, not post-hoc)

The Security Agent runs as a **middleware step inside the capture pipeline** — every item passes through it before classification and storage. It is NOT a separate cron job.

**Pipeline flow**: Source → **Security scan** → Classification → Storage

**What it checks**:
- **PII detection** — flags SSNs, student IDs (FERPA compliance matters at a university), passwords, API keys, credit card numbers before they enter the DB
- **Input sanitization** — strips HTML injection, SQL injection attempts, and prompt injection payloads from ingested content
- **Source validation** — verifies email senders and RSS feed URLs against configurable allowlists
- **Content policy** — flags content that shouldn't be stored (FERPA-protected student records, HIPAA data if applicable)
- **Embedding safety** — detects prompt injection patterns that could poison vector search results

**Implementation**: `src/security/` module with:
- `scanner.ts` — Main scan function called by capture pipeline
- `pii-detector.ts` — Regex + pattern matching for PII (SSN, student ID formats, credentials)
- `allowlists.ts` — Configurable source allowlists (loaded from DB or config)
- `sanitizer.ts` — Input cleaning (HTML stripping, injection prevention)

**Behavior on detection**:
- PII found → item quarantined in `inbox_log` with `classification: 'security_hold'`, NOT stored in `knowledge_items`
- Injection attempt → content sanitized, original logged for audit
- Unknown source → routed to `needs_review` with security flag

**Agent prompt** (`agents/security-agent.md`): Used for periodic audits of existing items and reviewing quarantined content.

**New DB additions**:
- `security_hold` added to inbox_log classification options
- `security_events` table for audit trail of detections

---

## Testing Agent (dev-time only)

Runs during development, NOT in production alongside the runtime agents. Triggered manually or in CI.

**What it validates**:
- **Tool smoke tests** — calls each MCP tool with sample data, verifies responses
- **Classification accuracy** — runs a test corpus through `capture_thought`, checks domain assignments
- **Security scanner** — feeds known PII and injection payloads, confirms they're caught
- **Search quality** — ingests test items, runs queries, checks relevance ranking
- **Digest format** — generates digest, validates word count limits and Nate Jones section
- **Pipeline integrity** — end-to-end: capture → classify → store → search → retrieve

**Agent prompt** (`agents/testing-agent.md`): Orchestrates the above checks using the MCP tools directly, reports pass/fail summary.

---

## MCP Tools (27 total)

### Capture (3)
| Tool | Purpose |
|------|---------|
| `capture_thought` | Ingest raw text → Ollama classifies → files or routes to needs_review (confidence < 0.6) |
| `capture_with_domain` | Direct filing when user knows the domain |
| `capture_batch` | Bulk import multiple items |

### Knowledge CRUD (6)
| Tool | Purpose |
|------|---------|
| `list_items` | Filter by domain, status, tags, date range (paginated) |
| `get_item` | Single item + relations |
| `update_item` | Modify fields, re-embeds if title/body changes |
| `delete_item` | **[DESTRUCTIVE]** confirmation gate |
| `relate_items` | Link two items |
| `unrelate_items` | Remove link |

### Search (4)
| Tool | Purpose |
|------|---------|
| `search_semantic` | Vector similarity via pgvector |
| `search_keyword` | PostgreSQL full-text search |
| `search_hybrid` | Reciprocal Rank Fusion of both (recommended default) |
| `find_related` | Neighbors of an existing item's embedding |

### Review Queue (4)
| Tool | Purpose |
|------|---------|
| `list_needs_review` | Items below confidence threshold |
| `fix_classification` | Reclassify and file correctly |
| `dismiss_review` | Mark as noise/duplicate |
| `get_inbox_stats` | Counts by classification status |

### Ingestion (4)
| Tool | Purpose |
|------|---------|
| `ingest_email_summary` | From Outlook MCP output |
| `ingest_github_item` | From GitHub MCP output |
| `ingest_calendar_event` | From Calendar MCP output |
| `ingest_rss_entry` | RSS feeds (Nate Jones Substack, etc.) |

### Digest & Delivery (4)
| Tool | Purpose |
|------|---------|
| `generate_daily_digest` | Structured daily brief (includes Nate Jones section) |
| `generate_weekly_digest` | Weekly summary |
| `send_digest_slack` | **[DESTRUCTIVE]** Send to Slack webhook (checks 10/day cap) |
| `send_digest_email` | **[DESTRUCTIVE]** Prepare email payload for Outlook MCP |

### Security (3)
| Tool | Purpose |
|------|---------|
| `scan_content` | Run security scan on text — returns PII findings, injection attempts, policy violations |
| `list_quarantined` | List items in security_hold status |
| `release_quarantined` | **[DESTRUCTIVE]** Release a quarantined item after review (redacts PII, then files normally) |

### Admin (3)
| Tool | Purpose |
|------|---------|
| `system_stats` | Item counts, queue size, notification count |
| `reindex_embeddings` | **[DESTRUCTIVE]** Regenerate all vectors |
| `notification_status` | Today's send count vs cap |

---

## Ollama Integration

- **Embeddings**: `nomic-embed-text` via `POST /api/embed` → 768-dim vectors
- **Classification**: `llama3.2` or `mistral` via `POST /api/generate` with JSON-only prompt
- **Summarization**: Same chat model for digest content
- **Fallback**: Keyword classifier (ported from Python's signal map) when Ollama is unreachable

---

## Brief Delivery Rules (carried from existing system)

- Daily brief: ≤ 150 words body, once/day
- Weekly brief: ≤ 250 words body, once/week (Sunday)
- Every brief MUST include ~150-word Nate Jones highlight from Substack RSS
- Max 10 notifications/day (hard stop)
- Deliver via Slack webhook + Outlook email

---

## Implementation Phases

### Phase 1: Foundation (first)
> Goal: MCP server boots, connects to PostgreSQL, `capture_thought` works end-to-end

- Project scaffolding (package.json, tsconfig matching existing servers)
- `src/index.ts` entry point (replicate mcp-github-server pattern)
- `src/utils.ts` (jsonResult, errorResult)
- `src/db/client.ts` + `001_core_tables.sql` migration
- `src/shared/` types, domains, keyword classifier
- `src/tools/capture.ts` (keyword classification only, no Ollama yet)
- `src/tools/knowledge.ts` (CRUD)
- `src/tools/review.ts` (needs_review queue)
- `src/tools/index.ts` registerAllTools
- Tests for capture pipeline + CRUD
- Register in `~/.claude/settings.json` and verify

### Phase 2: Intelligence
> Goal: Ollama embeddings + semantic search

- `src/ollama/client.ts` + `src/ollama/prompts.ts`
- `002_pgvector.sql` + `003_fulltext.sql` migrations
- Update capture pipeline to use Ollama with keyword fallback
- `src/tools/search.ts` (all 4 search tools)
- Tune similarity thresholds

### Phase 3: Ingestion + Agents
> Goal: Auto-ingest from external sources

- `src/tools/ingest.ts` (all 4 ingest tools)
- `agents/intake-agent.md` prompt
- `agents/triage-agent.md` prompt
- Deduplication via `source_ref`
- Cron scheduling for intake runs

### Phase 4: Delivery
> Goal: Digests and notifications

- `src/tools/digest.ts` (generate + send)
- Notification cap enforcement
- RSS fetching for Nate Jones content
- `agents/reporting-agent.md` prompt
- `src/tools/admin.ts`
- Cron for daily/weekly briefs

### Phase 5: Web Dashboard
> Goal: Visual interface for the knowledge base

- Express app in `dashboard/`
- API routes (items, search, inbox, stats)
- EJS templates (dashboard, review queue, item detail)
- Slack slash command webhook for quick capture
- Basic auth, deploy on VPN

### Phase 6: CMS Groundwork
> Goal: Extend toward AI-operated CMS

- CMS metadata fields (publish status, slug)
- Public-facing content routes
- Content workflow tools (draft → review → publish)

---

## Key Files to Reuse

| Source File | What to Reuse |
|---|---|
| `mcp-github-server/src/index.ts` | Entry point pattern (McpServer + StdioServerTransport + SIGINT) |
| `mcp-github-server/src/tools/index.ts` | registerAllTools aggregation pattern |
| `mcp-github-server/src/utils.ts` | jsonResult/errorResult helpers |
| `outlook-mcp-server/src/tools/compose.ts` | Confirmation gate pattern for destructive ops |
| `task-management/INSTRUCTIONS.MD` | 8 architectural building blocks |
| `task-management/brief-instructions.md` | Digest delivery rules and Nate Jones format |

---

## Verification

1. **Phase 1**: `capture_thought` with test text → check PostgreSQL has the item → `list_items` returns it → `fix_classification` moves a needs_review item
2. **Phase 2**: `search_hybrid` returns relevant results → `find_related` surfaces neighbors
3. **Phase 3**: Run Intake Agent → verify emails/issues/events appear in knowledge base
4. **Phase 4**: `generate_daily_digest` produces correct format → `send_digest_slack` delivers to Slack
5. **Phase 5**: Browse dashboard, search, review queue works in browser

## Environment Variables

```
DATABASE_URL=postgresql://user:pass@vpn-host:5432/secondbrain
OLLAMA_URL=http://vpn-host:11434
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
OLLAMA_CHAT_MODEL=llama3.2
SLACK_WEBHOOK=https://hooks.slack.com/services/...
```
