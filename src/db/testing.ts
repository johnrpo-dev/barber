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
export async function createTestDb(opts: { role?: "app" } = {}): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite({ extensions: { btree_gist } });
  const db = drizzle({ client, schema });
  // VILLA_TEST_DB_ROLE=app corre cualquier test como en producción (para revisar los permisos a mano).
  if (opts.role === "app" || process.env.VILLA_TEST_DB_ROLE === "app") {
    await setUpRoles(client);
    await client.exec("SET ROLE villa_owner");
    await migrate(db, { migrationsFolder });
    // SESSION AUTHORIZATION y no SET ROLE: como en el VPS, la sesión ES villa_app y no puede volver atrás.
    await client.exec("RESET ROLE; SET SESSION AUTHORIZATION villa_app");
  } else {
    await migrate(db, { migrationsFolder });
  }
  return { db: db as unknown as Db, client };
}

/**
 * Los mismos roles que src/db/roles/setup-roles.sql crea en el VPS, en el PGlite en memoria:
 * villa_owner es dueño del esquema y migra; villa_app es la app (sin DDL ni UPDATE/DELETE en el libro).
 */
async function setUpRoles(client: PGlite): Promise<void> {
  await client.exec(`
    CREATE ROLE villa_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE ROLE villa_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE EXTENSION IF NOT EXISTS btree_gist;
    ALTER SCHEMA public OWNER TO villa_owner;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT CREATE ON DATABASE postgres TO villa_owner;
    REVOKE CREATE ON DATABASE postgres FROM PUBLIC;
  `);
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
