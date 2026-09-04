import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool } from "./pool";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/** Applies migrations/<NNN>_*.sql in filename order, tracking them in schema_migrations. */
export async function migrateUp(): Promise<string[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id serial PRIMARY KEY,
      name text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const appliedRows = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(appliedRows.rows.map((r) => r.name));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

    const appliedNow: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await Bun.file(path.join(MIGRATIONS_DIR, file)).text();
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        appliedNow.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return appliedNow;
  } finally {
    client.release();
  }
}

function usage(): void {
  console.log(
    ["usage: bun src/db/migrate.ts <up|status>", "  up       apply pending migrations", "  status   list applied / pending"].join("\n"),
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "up";
  if (cmd === "up") {
    const applied = await migrateUp();
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
  } else if (cmd === "status") {
    const pool = getPool();
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id serial PRIMARY KEY, name text NOT NULL UNIQUE, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await pool.query<{ name: string; applied_at: string }>("SELECT name, applied_at FROM schema_migrations ORDER BY name");
    for (const r of rows) console.log(`${new Date(r.applied_at).toISOString()}  ${r.name}`);
    console.log(rows.length === 0 ? "(no migrations applied)" : `${rows.length} migration(s) applied`);
  } else {
    usage();
    process.exit(1);
  }
  await import("./pool").then((m) => m.closePool());
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}