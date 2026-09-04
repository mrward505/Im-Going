import { Pool, type PoolConfig } from "pg";
import { getConfig } from "../env";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getConfig().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    } satisfies PoolConfig);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function ping(): Promise<void> {
  await getPool().query("SELECT 1");
}