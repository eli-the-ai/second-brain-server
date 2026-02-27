import pg from "pg";

const { Pool } = pg;

export type DbPool = pg.Pool;

export function createDbPool(connectionString: string): DbPool {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error("Unexpected database pool error:", err.message);
  });

  return pool;
}

export async function validateConnection(pool: DbPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}
