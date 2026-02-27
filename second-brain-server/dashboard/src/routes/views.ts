import { Router, type Request } from "express";
import type { Pool } from "pg";

export const viewsRouter = Router();

function getDb(req: Request): Pool {
  return req.app.locals.db as Pool;
}

// Dashboard home
viewsRouter.get("/", async (req, res) => {
  try {
    const db = getDb(req);

    const [
      { rows: domainCounts },
      { rows: totalItems },
      { rows: reviewQueue },
      { rows: recentItems },
      { rows: todayItems },
    ] = await Promise.all([
      db.query(`SELECT domain, COUNT(*) as count FROM knowledge_items GROUP BY domain ORDER BY count DESC`),
      db.query(`SELECT COUNT(*) as count FROM knowledge_items`),
      db.query(`SELECT COUNT(*) as count FROM inbox_log WHERE classification IN ('needs_review', 'security_hold')`),
      db.query(`SELECT id, domain, title, status, created_by, created_at FROM knowledge_items ORDER BY created_at DESC LIMIT 10`),
      db.query(`SELECT COUNT(*) as count FROM knowledge_items WHERE created_at >= CURRENT_DATE`),
    ]);

    res.render("dashboard", {
      title: "Second Brain",
      totalItems: parseInt(totalItems[0].count, 10),
      itemsToday: parseInt(todayItems[0].count, 10),
      reviewCount: parseInt(reviewQueue[0].count, 10),
      domainCounts,
      recentItems,
    });
  } catch (err) {
    res.status(500).render("error", { message: err instanceof Error ? err.message : "Unknown error" });
  }
});

// Items list
viewsRouter.get("/items", async (req, res) => {
  try {
    const db = getDb(req);
    const { domain, status, q, page = "1" } = req.query;
    const limit = 25;
    const offset = (Math.max(parseInt(page as string, 10) || 1, 1) - 1) * limit;

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

    const { rows } = await db.query(
      `SELECT id, domain, title, status, tags, source_type, created_by, created_at
       FROM knowledge_items ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) as total FROM knowledge_items ${where}`,
      params
    );

    const total = parseInt(countRows[0].total, 10);
    const totalPages = Math.ceil(total / limit);
    const currentPage = Math.floor(offset / limit) + 1;

    res.render("items", {
      title: "Knowledge Items",
      items: rows,
      total,
      currentPage,
      totalPages,
      filters: { domain, status, q },
      domains: ["projects", "people", "ideas", "admin", "ai_best_practices"],
      statuses: ["active", "on_hold", "completed", "archived"],
    });
  } catch (err) {
    res.status(500).render("error", { message: err instanceof Error ? err.message : "Unknown error" });
  }
});

// Item detail
viewsRouter.get("/items/:id", async (req, res) => {
  try {
    const db = getDb(req);
    const { rows } = await db.query(
      `SELECT * FROM knowledge_items WHERE id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).render("error", { message: "Item not found" });
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

    return res.render("item-detail", {
      title: rows[0].title,
      item: rows[0],
      relations,
    });
  } catch (err) {
    res.status(500).render("error", { message: err instanceof Error ? err.message : "Unknown error" });
  }
});

// Review queue
viewsRouter.get("/review", async (req, res) => {
  try {
    const db = getDb(req);

    const { rows } = await db.query(
      `SELECT id, original_text, classification, confidence, source_type, source_ref, created_by, created_at
       FROM inbox_log
       WHERE classification IN ('needs_review', 'security_hold')
       ORDER BY created_at DESC
       LIMIT 50`
    );

    const { rows: statsRows } = await db.query(
      `SELECT classification, COUNT(*) as count FROM inbox_log GROUP BY classification ORDER BY count DESC`
    );

    res.render("review", {
      title: "Review Queue",
      items: rows,
      stats: statsRows,
    });
  } catch (err) {
    res.status(500).render("error", { message: err instanceof Error ? err.message : "Unknown error" });
  }
});

// Search page
viewsRouter.get("/search", async (req, res) => {
  try {
    const db = getDb(req);
    const { q } = req.query;

    let results: unknown[] = [];
    if (q && typeof q === "string") {
      const { rows } = await db.query(
        `SELECT id, domain, title, status, tags, source_type, created_by, created_at,
                ts_rank(tsv, websearch_to_tsquery('english', $1)) as rank
         FROM knowledge_items
         WHERE tsv @@ websearch_to_tsquery('english', $1)
         ORDER BY rank DESC
         LIMIT 50`,
        [q]
      );
      results = rows;
    }

    res.render("search", {
      title: "Search",
      query: q || "",
      results,
    });
  } catch (err) {
    res.status(500).render("error", { message: err instanceof Error ? err.message : "Unknown error" });
  }
});
