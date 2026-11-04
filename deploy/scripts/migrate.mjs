// Aplica las migraciones en el VPS como villa_owner (lo llama deploy-release.sh).
//
// A propósito sin drizzle-kit ni tsx: la credencial de villa_owner solo la ven drizzle-orm y postgres,
// dependencias de producción fijadas por package-lock.json. Es el mismo migrador, con la misma tabla
// (drizzle.__drizzle_migrations), así que el historial es el de `npm run db:migrate` en desarrollo.
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("migrate: falta MIGRATION_DATABASE_URL");
  process.exit(1);
}

const migrationsFolder = fileURLToPath(new URL("../../src/db/migrations", import.meta.url));
const client = postgres(url, { max: 1, onnotice: () => {} });
let failed = false;
try {
  await migrate(drizzle({ client }), { migrationsFolder });
  console.log("migrate: al día");
} catch (err) {
  failed = true;
  // Sin la URL: el mensaje de Postgres no la incluye, pero el objeto del error sí podría.
  console.error("migrate: falló:", err instanceof Error ? err.message : "error desconocido");
} finally {
  await client.end({ timeout: 5 });
}
process.exit(failed ? 1 : 0);
