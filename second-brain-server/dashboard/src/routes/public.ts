import { Router, type Request } from "express";
import type { Pool } from "pg";

export const publicRouter = Router();

function getDb(req: Request): Pool {
  return req.app.locals.db as Pool;
}

// GET /content — published content listing
publicRouter.get("/", async (req, res) => {
  try {
    const db = getDb(req);
    const { domain, page = "1" } = req.query;
    const limit = 20;
    const offset = (Math.max(parseInt(page as string, 10) || 1, 1) - 1) * limit;

    const conditions = ["publish_status = 'published'", "published_at <= now()"];
    const params: unknown[] = [];
    let idx = 1;

    if (domain && typeof domain === "string") {
      conditions.push(`domain = $${idx++}`);
      params.push(domain);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const { rows } = await db.query(
      `SELECT id, domain, title, slug, excerpt, tags, published_at, published_by
       FROM knowledge_items ${where}
       ORDER BY published_at DESC
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

    res.render("public/listing", {
      title: "Published Content",
      articles: rows,
      total,
      currentPage,
      totalPages,
      domain: domain || null,
      domains: ["projects", "people", "ideas", "admin", "ai_best_practices"],
    });
  } catch (err) {
    res.status(500).render("error", { message: err instanceof Error ? err.message : "Unknown error" });
  }
});

// GET /content/:slug — single published article
publicRouter.get("/:slug", async (req, res) => {
  try {
    const db = getDb(req);
    const { rows } = await db.query(
      `SELECT id, domain, title, slug, body, excerpt, tags, metadata,
              published_at, published_by, created_by
       FROM knowledge_items
       WHERE slug = $1 AND publish_status = 'published' AND published_at <= now()`,
      [req.params.slug]
    );

    if (rows.length === 0) {
      return res.status(404).render("error", { message: "Article not found" });
    }

    // Get related published content
    const { rows: related } = await db.query(
      `SELECT ki.id, ki.title, ki.slug, ki.domain, ki.excerpt
       FROM item_relations r
       JOIN knowledge_items ki ON (
         CASE WHEN r.from_id = $1 THEN r.to_id ELSE r.from_id END = ki.id
       )
       WHERE (r.from_id = $1 OR r.to_id = $1)
         AND ki.publish_status = 'published'
       LIMIT 5`,
      [rows[0].id]
    );

    return res.render("public/article", {
      title: rows[0].title,
      article: rows[0],
      related,
    });
  } catch (err) {
    res.status(500).render("error", { message: err instanceof Error ? err.message : "Unknown error" });
  }
});
