import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";
import type { Db } from "./types";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * PostgreSQL real en memoria (PGlite) con todas las migraciones aplicadas,
 * incluidas las garantías contables. Solo para tests: no requiere una base instalada.
 */
export async function createTestDb(): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite({ extensions: { btree_gist } });
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, client };
}

/** Mensaje del error de Postgres, aunque Drizzle lo envuelva. */
export async function dbError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const parts: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = (e as Error & { cause?: unknown }).cause) {
      parts.push(e.message);
    }
    return parts.join(" | ");
  }
  throw new Error("Se esperaba un error de la base de datos y no ocurrió");
}
