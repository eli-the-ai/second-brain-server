import { Router, type Request } from "express";
import type { Pool } from "pg";

export const apiRouter = Router();

function getDb(req: Request): Pool {
  return req.app.locals.db as Pool;
}

// GET /api/items — list items with optional filters
apiRouter.get("/items", async (req, res) => {
  try {
    const db = getDb(req);
    const { domain, status, q, limit = "50", offset = "0" } = req.query;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (domain && typeof domain === "string") {
      conditions.push(`domain = $${idx++}`);
      params.push(domain);
    }
    if (status && typeof status === "string") {
      conditions.push(`status = $${idx++}`);
      params.push(status);
    }
    if (q && typeof q === "string") {
      conditions.push(`(title ILIKE $${idx} OR body ILIKE $${idx})`);
      params.push(`%${q}%`);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const lim = Math.min(parseInt(limit as string, 10) || 50, 100);
    const off = parseInt(offset as string, 10) || 0;

    const { rows } = await db.query(
      `SELECT id, domain, title, status, tags, source_type, created_by, created_at, updated_at
       FROM knowledge_items ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, lim, off]
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) as total FROM knowledge_items ${where}`,
      params
    );

    res.json({
      items: rows,
      total: parseInt(countRows[0].total, 10),
      limit: lim,
      offset: off,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// GET /api/items/:id — single item detail
apiRouter.get("/items/:id", async (req, res) => {
  try {
    const db = getDb(req);
    const { rows } = await db.query(
      `SELECT * FROM knowledge_items WHERE id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }

    const { rows: relations } = await db.query(
      `SELECT r.*, ki.title as related_title, ki.domain as related_domain
       FROM item_relations r
       JOIN knowledge_items ki ON (
         CASE WHEN r.from_id = $1 THEN r.to_id ELSE r.from_id END = ki.id
       )
       WHERE r.from_id = $1 OR r.to_id = $1`,
      [req.params.id]
    );

    return res.json({ ...rows[0], relations });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// GET /api/search — keyword search
apiRouter.get("/search", async (req, res) => {
  try {
    const db = getDb(req);
    const { q, domain, limit = "20" } = req.query;

    if (!q || typeof q !== "string") {
      return res.status(400).json({ error: "Query parameter q is required" });
    }

    const conditions: string[] = [`tsv @@ websearch_to_tsquery('english', $1)`];
    const params: unknown[] = [q];
    let idx = 2;

    if (domain && typeof domain === "string") {
      conditions.push(`domain = $${idx++}`);
      params.push(domain);
    }

    const lim = Math.min(parseInt(limit as string, 10) || 20, 100);

    const { rows } = await db.query(
      `SELECT id, domain, title, status, tags, source_type, created_by, created_at,
              ts_rank(tsv, websearch_to_tsquery('english', $1)) as rank
       FROM knowledge_items
       WHERE ${conditions.join(" AND ")}
       ORDER BY rank DESC
       LIMIT $${idx}`,
      [...params, lim]
    );

    return res.json({ query: q, results: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// GET /api/inbox — review queue
apiRouter.get("/inbox", async (req, res) => {
  try {
    const db = getDb(req);
    const { classification = "needs_review", limit = "20" } = req.query;

    const lim = Math.min(parseInt(limit as string, 10) || 20, 100);

    const { rows } = await db.query(
      `SELECT id, original_text, classification, confidence, source_type, source_ref, created_by, created_at
       FROM inbox_log
       WHERE classification = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [classification, lim]
    );

    return res.json({ items: rows, count: rows.length, classification });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

// GET /api/stats — dashboard stats
apiRouter.get("/stats", async (req, res) => {
  try {
    const db = getDb(req);

    const [
      { rows: domainCounts },
      { rows: statusCounts },
      { rows: reviewQueue },
      { rows: totalItems },
      { rows: todayItems },
      { rows: securityToday },
    ] = await Promise.all([
      db.query(`SELECT domain, COUNT(*) as count FROM knowledge_items GROUP BY domain ORDER BY count DESC`),
      db.query(`SELECT status, COUNT(*) as count FROM knowledge_items GROUP BY status ORDER BY count DESC`),
      db.query(`SELECT COUNT(*) as count FROM inbox_log WHERE classification IN ('needs_review', 'security_hold')`),
      db.query(`SELECT COUNT(*) as count FROM knowledge_items`),
      db.query(`SELECT COUNT(*) as count FROM knowledge_items WHERE created_at >= CURRENT_DATE`),
      db.query(`SELECT COUNT(*) as count FROM security_events WHERE created_at >= CURRENT_DATE`),
    ]);

    res.json({
      total_items: parseInt(totalItems[0].count, 10),
      items_today: parseInt(todayItems[0].count, 10),
      review_queue: parseInt(reviewQueue[0].count, 10),
      security_events_today: parseInt(securityToday[0].count, 10),
      by_domain: domainCounts,
      by_status: statusCounts,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});
