import { defineConfig } from "drizzle-kit";

// drizzle-kit no lee .env por sí solo.
try {
  process.loadEnvFile(".env");
} catch {
  // Sin .env: se usan las variables del entorno.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    // En el VPS las migraciones corren como villa_owner (dueño del esquema) y la app como
    // villa_app, que no puede cambiar el esquema (src/db/roles/setup-roles.sql). En desarrollo,
    // con un solo rol, basta DATABASE_URL.
    url: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || "",
  },
  strict: true,
});
