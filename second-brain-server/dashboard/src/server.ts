import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { apiRouter } from "./routes/api.js";
import { viewsRouter } from "./routes/views.js";
import { publicRouter } from "./routes/public.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("Error: DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 5 });

  // Verify DB connection
  try {
    await pool.query("SELECT 1");
    console.log("Database connected");
  } catch (err) {
    console.error("Database connection failed:", err);
    process.exit(1);
  }

  const app = express();
  const port = parseInt(process.env.PORT || "3000", 10);

  // Basic auth middleware (optional, for VPN deployment)
  const authUser = process.env.DASH_USER;
  const authPass = process.env.DASH_PASS;
  if (authUser && authPass) {
    app.use((req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Basic ")) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Second Brain Dashboard"');
        return res.status(401).send("Authentication required");
      }
      const decoded = Buffer.from(auth.slice(6), "base64").toString();
      const [user, pass] = decoded.split(":");
      if (user === authUser && pass === authPass) {
        return next();
      }
      res.setHeader("WWW-Authenticate", 'Basic realm="Second Brain Dashboard"');
      return res.status(401).send("Invalid credentials");
    });
    console.log("Basic auth enabled");
  }

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/static", express.static(path.join(__dirname, "../static")));

  // View engine
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "../templates"));

  // Make db pool available to routes
  app.locals.db = pool;

  // Routes
  app.use("/api", apiRouter);
  app.use("/content", publicRouter);  // Public-facing CMS content (no auth required)
  app.use("/", viewsRouter);

  app.listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`);
  });

  process.on("SIGINT", async () => {
    await pool.end();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
